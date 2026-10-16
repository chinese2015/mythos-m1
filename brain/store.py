"""Transactional facts. No command execution or HTTP lifetime lives here."""
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import uuid

from .errors import Conflict, InvalidInput, NotFound

TERMINAL = {'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'}
ACTIVE = {'STARTING', 'RUNNING', 'CANCEL_REQUESTED'}


def now():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def identifier(prefix):
    return prefix + '-' + uuid.uuid4().hex


def positive_version(value):
    if type(value) is not int or value < 1:
        raise InvalidInput('expectedVersion must be a positive integer')
    return value


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = self.root / 'brain.sqlite3'
        with self.connection(None) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
                INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
                CREATE TABLE IF NOT EXISTS work_items (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_key TEXT NOT NULL,
                    data TEXT NOT NULL, UNIQUE(owner, source_key));
                CREATE TABLE IF NOT EXISTS operations (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                    work_id TEXT NOT NULL REFERENCES work_items(id),
                    sandbox_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS operations_state ON operations(state);
                CREATE TABLE IF NOT EXISTS events (
                    work_id TEXT NOT NULL REFERENCES work_items(id), sequence INTEGER NOT NULL,
                    data TEXT NOT NULL, PRIMARY KEY(work_id, sequence));
                CREATE TABLE IF NOT EXISTS idempotency (
                    owner TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
                    hash TEXT NOT NULL, entity TEXT NOT NULL,
                    PRIMARY KEY(owner, scope, key));
                CREATE TABLE IF NOT EXISTS logs (
                    operation_id TEXT NOT NULL REFERENCES operations(id), sequence INTEGER NOT NULL,
                    stream TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL,
                    PRIMARY KEY(operation_id, sequence), UNIQUE(operation_id, stream, offset));
                CREATE TABLE IF NOT EXISTS evidence (
                    operation_id TEXT PRIMARY KEY REFERENCES operations(id), data TEXT NOT NULL);
            ''')
            if db.execute('SELECT version FROM schema_version').fetchone()[0] != 1:
                raise RuntimeError('Unsupported brain database schema')
        self.database.chmod(0o600)

    @contextmanager
    def connection(self, write=False):
        db = sqlite3.connect(str(self.database), timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        if write is not None:
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _get(self, db, table, entity, owner=None):
        sql = 'SELECT data FROM ' + table + ' WHERE id=?'
        params = [entity]
        if owner is not None:
            sql += ' AND owner=?'
            params.append(owner)
        row = db.execute(sql, params).fetchone()
        if row is None:
            raise NotFound('Resource unavailable')
        return json.loads(row['data'])

    def _work(self, db, entity, owner=None):
        return self._get(db, 'work_items', entity, owner)

    def _op(self, db, entity, owner=None):
        return self._get(db, 'operations', entity, owner)

    def _save_work(self, db, work):
        work['status'] = 'PAUSED' if work['paused'] else work['stage']
        db.execute('UPDATE work_items SET data=? WHERE id=?', (encoded(work), work['workItemId']))

    def _save_op(self, db, op):
        db.execute('UPDATE operations SET state=?, data=? WHERE id=?',
                   (op['state'], encoded(op), op['operationId']))

    def _event(self, db, work_id, event_type, payload, operation_id=None):
        work = self._work(db, work_id)
        work['sequence'] += 1
        self._save_work(db, work)
        event = {'eventId': identifier('evt'), 'schemaVersion': 1, 'workItemId': work_id,
                 'sequence': work['sequence'], 'type': event_type, 'occurredAt': now(),
                 'source': 'argon-workflow' if operation_id is None else 'argon-execution',
                 'correlation': {'operationId': operation_id} if operation_id else {}, 'payload': payload}
        db.execute('INSERT INTO events VALUES (?, ?, ?)', (work_id, work['sequence'], encoded(event)))

    def _retry(self, db, owner, scope, key, body):
        if not isinstance(key, str) or not 1 <= len(key) <= 200:
            raise InvalidInput('Idempotency-Key is required (1..200 characters)')
        digest = hashlib.sha256(encoded(body).encode()).hexdigest()
        row = db.execute('SELECT hash, entity FROM idempotency WHERE owner=? AND scope=? AND key=?',
                         (owner, scope, key)).fetchone()
        if row and row['hash'] != digest:
            raise Conflict('Idempotency key was used with a different request')
        return row['entity'] if row else None, digest

    def _remember(self, db, owner, scope, key, digest, entity):
        db.execute('INSERT INTO idempotency VALUES (?, ?, ?, ?, ?)', (owner, scope, key, digest, entity))

    def _version(self, entity, expected):
        if entity['version'] != positive_version(expected):
            raise Conflict('Stale expectedVersion')

    def create_work_item(self, owner, body, key):
        source = body.get('source')
        if (not isinstance(source, dict) or set(source) != {'type', 'id', 'revision'}
                or source['type'] not in {'ARGON', 'JIRA', 'DIRECT'}
                or not isinstance(source['id'], str) or not 1 <= len(source['id']) <= 200
                or type(source['revision']) not in {str, int} or not str(source['revision'])):
            raise InvalidInput('source requires type, id and revision')
        if not isinstance(body.get('sandboxId'), str) or not body['sandboxId']:
            raise InvalidInput('sandboxId is required')
        with self.connection(True) as db:
            scope = 'create-work-item'
            retry, digest = self._retry(db, owner, scope, key, body)
            if retry:
                return self._work(db, retry, owner)
            source_key = encoded(source)
            existing = db.execute('SELECT id FROM work_items WHERE owner=? AND source_key=?', (owner, source_key)).fetchone()
            if existing:
                work = self._work(db, existing['id'], owner)
                if (work['sandboxId'], work['sessionId']) != (body['sandboxId'], body.get('sessionId')):
                    raise Conflict('Source revision already has a different workspace binding')
            else:
                work = {'workItemId': identifier('work'), 'ownerId': owner, 'source': source,
                        'sandboxId': body['sandboxId'], 'sessionId': body.get('sessionId'),
                        'stage': 'PLANNING', 'status': 'PLANNING', 'paused': False,
                        'version': 1, 'sequence': 0, 'createdAt': now()}
                db.execute('INSERT INTO work_items VALUES (?, ?, ?, ?)',
                           (work['workItemId'], owner, source_key, encoded(work)))
                self._event(db, work['workItemId'], 'work_item.created', {'source': source})
                work = self._work(db, work['workItemId'])
            self._remember(db, owner, scope, key, digest, work['workItemId'])
            return work

    def submit(self, owner, work_id, body, key):
        command = body.get('command')
        kind = body.get('kind', 'COMMAND')
        timeout = body.get('timeoutSeconds', 300)
        commit = body.get('sourceCommit')
        if not isinstance(command, str) or not command.strip() or len(command) > 8192 or '\x00' in command:
            raise InvalidInput('command must contain 1..8192 characters without NUL')
        if kind not in {'COMMAND', 'UNIT_TEST', 'VERIFY'}:
            raise InvalidInput('Unsupported operation kind')
        if type(timeout) is not int or not 1 <= timeout <= 3600:
            raise InvalidInput('timeoutSeconds must be an integer between 1 and 3600')
        if commit is not None and (not isinstance(commit, str) or not re.fullmatch('[0-9a-f]{40}', commit)):
            raise InvalidInput('sourceCommit must be a full lowercase Git SHA')
        if kind == 'VERIFY' and commit is None:
            raise InvalidInput('VERIFY requires sourceCommit')
        with self.connection(True) as db:
            work = self._work(db, work_id, owner)
            scope = 'submit:' + work_id
            retry, digest = self._retry(db, owner, scope, key, body)
            if retry:
                return self._op(db, retry, owner)
            self._version(work, body.get('expectedVersion'))
            op = {'operationId': identifier('exec'), 'workItemId': work_id, 'ownerId': owner,
                  'sandboxId': work['sandboxId'], 'kind': kind, 'command': command,
                  'timeoutSeconds': timeout, 'sourceCommit': commit, 'state': 'QUEUED',
                  'version': 1, 'createdAt': now(), 'startedAt': None, 'finishedAt': None,
                  'exitCode': None, 'reason': None, 'runtime': None, 'logOffsets': {'stdout': 0, 'stderr': 0}}
            db.execute('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)',
                       (op['operationId'], owner, work_id, work['sandboxId'], 'QUEUED', encoded(op)))
            work['version'] += 1
            work['stage'] = 'CODING' if kind == 'COMMAND' else 'VERIFYING'
            self._save_work(db, work)
            self._event(db, work_id, 'execution.queued', {'status': 'QUEUED', 'kind': kind}, op['operationId'])
            self._remember(db, owner, scope, key, digest, op['operationId'])
            return op

    def list_work_items(self, owner):
        with self.connection() as db:
            return [json.loads(r['data']) for r in db.execute('SELECT data FROM work_items WHERE owner=? ORDER BY rowid', (owner,))]

    def snapshot(self, owner, work_id):
        with self.connection() as db:
            work = self._work(db, work_id, owner)
            ops = [json.loads(r['data']) for r in db.execute('SELECT data FROM operations WHERE work_id=? ORDER BY rowid', (work_id,))]
            evidence = [json.loads(r['data']) for r in db.execute('SELECT e.data FROM evidence e JOIN operations o ON e.operation_id=o.id WHERE o.work_id=?', (work_id,))]
            return {'workItem': work, 'operations': ops, 'evidence': evidence, 'cursor': work['sequence']}

    def operation(self, owner, op_id):
        with self.connection() as db:
            op = self._op(db, op_id, owner)
            row = db.execute('SELECT data FROM evidence WHERE operation_id=?', (op_id,)).fetchone()
            op['evidence'] = json.loads(row['data']) if row else None
            return op

    def events(self, owner, work_id, after=0, limit=100):
        with self.connection() as db:
            self._work(db, work_id, owner)
            events = [json.loads(r['data']) for r in db.execute('SELECT data FROM events WHERE work_id=? AND sequence>? ORDER BY sequence LIMIT ?', (work_id, after, limit))]
            return {'events': events, 'nextCursor': events[-1]['sequence'] if events else after}

    def logs(self, owner, op_id, after=0, limit=100):
        with self.connection() as db:
            self._op(db, op_id, owner)
            rows = db.execute('SELECT * FROM logs WHERE operation_id=? AND sequence>? ORDER BY sequence LIMIT ?', (op_id, after, limit)).fetchall()
            logs = [{'sequence': r['sequence'], 'stream': r['stream'], 'offset': r['offset'],
                     'data': base64.b64encode(r['data']).decode(), 'text': r['data'].decode('utf8', errors='replace')}
                    for r in rows]
            return {'logs': logs, 'nextCursor': logs[-1]['sequence'] if logs else after}

    def cancel(self, owner, op_id, version, key):
        with self.connection(True) as db:
            op = self._op(db, op_id, owner)
            scope = 'cancel:' + op_id
            retry, digest = self._retry(db, owner, scope, key, {'expectedVersion': version})
            if retry:
                return op
            self._version(op, version)
            if op['state'] not in TERMINAL:
                queued = op['state'] == 'QUEUED'
                op['state'] = 'CANCELLED' if queued else 'CANCEL_REQUESTED'
                op['version'] += 1
                if queued:
                    op['finishedAt'] = now()
                    op['reason'] = 'Cancelled before dispatch'
                self._save_op(db, op)
                self._event(db, op['workItemId'], 'execution.' + ('cancelled' if queued else 'cancel_requested'), {'status': op['state']}, op_id)
            self._remember(db, owner, scope, key, digest, op_id)
            return op

    def set_paused(self, owner, work_id, paused, version, key):
        with self.connection(True) as db:
            work = self._work(db, work_id, owner)
            scope = ('pause:' if paused else 'resume:') + work_id
            retry, digest = self._retry(db, owner, scope, key, {'expectedVersion': version})
            if retry:
                return work
            self._version(work, version)
            work['paused'] = paused
            work['version'] += 1
            self._save_work(db, work)
            self._event(db, work_id, 'work_item.paused' if paused else 'work_item.resumed', {})
            self._remember(db, owner, scope, key, digest, work_id)
            return self._work(db, work_id)

    def active_operations(self):
        with self.connection() as db:
            return [json.loads(r['data']) for r in db.execute("SELECT data FROM operations WHERE state IN ('STARTING','RUNNING','CANCEL_REQUESTED') ORDER BY rowid")]

    def claim_next(self):
        with self.connection(True) as db:
            occupied = {r[0] for r in db.execute("SELECT sandbox_id FROM operations WHERE state IN ('STARTING','RUNNING','CANCEL_REQUESTED')")}
            for row in db.execute("SELECT data FROM operations WHERE state='QUEUED' ORDER BY rowid").fetchall():
                op = json.loads(row['data'])
                if op['sandboxId'] in occupied or self._work(db, op['workItemId'])['paused']:
                    continue
                op.update(state='STARTING', version=op['version'] + 1, startedAt=now())
                self._save_op(db, op)
                self._event(db, op['workItemId'], 'execution.starting', {'status': 'STARTING'}, op['operationId'])
                return op
            return None

    def record_runtime(self, op_id, runtime, started=True):
        with self.connection(True) as db:
            op = self._op(db, op_id)
            if op['state'] in TERMINAL:
                return
            op['runtime'] = runtime
            if started and op['state'] == 'STARTING':
                op['state'] = 'RUNNING'
            op['version'] += 1
            self._save_op(db, op)
            self._event(db, op['workItemId'], 'execution.started' if started else 'execution.prepared', {'status': op['state'], 'runtime': runtime}, op_id)

    def pending_cleanup(self):
        with self.connection() as db:
            ops = [json.loads(r['data']) for r in db.execute("SELECT data FROM operations WHERE state IN ('SUCCEEDED','FAILED','CANCELLED')")]
            return [op for op in ops if op['runtime'] and not op['runtime'].get('cleanup')]

    def record_cleanup(self, op_id, result):
        with self.connection(True) as db:
            op = self._op(db, op_id)
            op['runtime']['cleanup'] = result
            self._save_op(db, op)
            self._event(db, op['workItemId'], 'execution.cleanup', result, op_id)

    def append_log(self, op_id, stream, offset, data):
        if stream not in {'stdout', 'stderr'} or len(data) > 65536:
            raise InvalidInput('Invalid log chunk')
        if not data:
            return
        with self.connection(True) as db:
            op = self._op(db, op_id)
            current = op['logOffsets'][stream]
            if offset < current:
                return
            if offset != current:
                raise Conflict('Noncontiguous log offset')
            sequence = db.execute('SELECT coalesce(max(sequence),0)+1 FROM logs WHERE operation_id=?', (op_id,)).fetchone()[0]
            db.execute('INSERT INTO logs VALUES (?, ?, ?, ?, ?)', (op_id, sequence, stream, offset, data))
            op['logOffsets'][stream] += len(data)
            self._save_op(db, op)
            self._event(db, op['workItemId'], 'execution.output', {'logCursor': sequence, 'stream': stream}, op_id)

    def finish(self, op_id, state, exit_code=None, evidence=None, reason=None):
        if state not in TERMINAL:
            raise InvalidInput('Not a terminal result')
        with self.connection(True) as db:
            op = self._op(db, op_id)
            if op['state'] in TERMINAL:
                return
            if op['state'] == 'QUEUED':
                raise Conflict('Undispatched operation cannot have an executor result')
            op.update(state=state, exitCode=exit_code, reason=reason, finishedAt=now(), version=op['version'] + 1)
            self._save_op(db, op)
            if evidence is not None:
                evidence = dict(evidence, operationId=op_id, recordedAt=now())
                for stream in ['stdout', 'stderr']:
                    digest = hashlib.sha256()
                    for row in db.execute('SELECT data FROM logs WHERE operation_id=? AND stream=? ORDER BY offset', (op_id, stream)):
                        digest.update(row['data'])
                    evidence[stream + 'Sha256'] = digest.hexdigest()
                db.execute('INSERT INTO evidence VALUES (?, ?)', (op_id, encoded(evidence)))
            work = self._work(db, op['workItemId'])
            work['version'] += 1
            work['stage'] = ('AWAITING_REVIEW' if op['kind'] == 'VERIFY' else 'CODING') if state == 'SUCCEEDED' else 'BLOCKED'
            self._save_work(db, work)
            self._event(db, op['workItemId'], 'execution.' + state.lower(), {'status': state, 'exitCode': exit_code, 'reason': reason}, op_id)
