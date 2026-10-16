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
                CREATE TABLE IF NOT EXISTS task_claims (
                    source_id TEXT PRIMARY KEY, owner TEXT NOT NULL, work_id TEXT NOT NULL UNIQUE REFERENCES work_items(id));
                CREATE TABLE IF NOT EXISTS work_sessions (
                    owner TEXT NOT NULL, session_id TEXT NOT NULL, work_id TEXT NOT NULL REFERENCES work_items(id),
                    role TEXT NOT NULL, PRIMARY KEY(owner, session_id));
                CREATE TABLE IF NOT EXISTS source_intakes (
                    finding_id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL,
                    state TEXT NOT NULL, triage TEXT NOT NULL, notified_at TEXT, last_error TEXT,
                    decision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
        # Optimistic version is an admission precondition, not the identity of
        # a command. A plugin recovering a lost acknowledgement may reread it.
        business = {k: v for k, v in body.items() if k != 'expectedVersion'}
        digest = hashlib.sha256(encoded(business).encode()).hexdigest()
        row = db.execute('SELECT hash, entity FROM idempotency WHERE owner=? AND scope=? AND key=?',
                         (owner, scope, key)).fetchone()
        legacy_digest = hashlib.sha256(encoded(body).encode()).hexdigest()
        if row and row['hash'] not in {digest, legacy_digest}:
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
                        'sessionIds': [body['sessionId']] if body.get('sessionId') else [],
                        'stage': 'PLANNING', 'status': 'PLANNING', 'paused': False, 'blocked': False,
                        'version': 1, 'sequence': 0, 'createdAt': now()}
                db.execute('INSERT INTO work_items VALUES (?, ?, ?, ?)',
                           (work['workItemId'], owner, source_key, encoded(work)))
                self._event(db, work['workItemId'], 'work_item.created', {'source': source})
                work = self._work(db, work['workItemId'])
            self._remember(db, owner, scope, key, digest, work['workItemId'])
            return work

    def claim_task(self, owner, source_record, expected_revision, key):
        required = {'id', 'title', 'risk', 'ownerId', 'repositoryUrl', 'baseCommit', 'sourcePath', 'revision'}
        if not isinstance(source_record, dict) or required - set(source_record) or set(source_record) - required - {'description'}:
            raise InvalidInput('sourceRecord has invalid fields')
        string_fields = required - {'revision'}
        if (not all(isinstance(source_record[k], str) and source_record[k] for k in string_fields)
                or type(source_record['revision']) not in {str, int} or not str(source_record['revision'])
                or ('description' in source_record and not isinstance(source_record['description'], str))):
            raise InvalidInput('sourceRecord fields must be nonempty strings')
        if not isinstance(expected_revision, (str, int)) or isinstance(expected_revision, bool):
            raise InvalidInput('expectedRevision is invalid')
        source_id = source_record['id']
        with self.connection(True) as db:
            scope = 'claim-task:' + source_id
            body = {'sourceRecord': source_record, 'expectedRevision': expected_revision}
            retry, digest = self._retry(db, owner, scope, key, body)
            if retry:
                return self._work(db, retry, owner)
            row = db.execute('SELECT owner, work_id FROM task_claims WHERE source_id=?', (source_id,)).fetchone()
            if row:
                if row['owner'] != owner:
                    raise Conflict('Task is already claimed by another owner')
                self._remember(db, owner, scope, key, digest, row['work_id'])
                return self._work(db, row['work_id'], owner)
            if str(expected_revision) != str(source_record['revision']):
                raise Conflict('Source revision changed')
            work_id = identifier('work')
            source = {'type': 'ARGON', 'id': source_id, 'revision': source_record['revision']}
            work = {'workItemId': work_id, 'ownerId': owner, 'source': source,
                    'sourceRecord': dict(source_record), 'sandboxId': None, 'sessionId': None,
                    'sessionIds': [], 'stage': 'CLAIMED', 'status': 'CLAIMED', 'paused': False,
                    'blocked': False, 'workflow': {'phase': 'CLAIMED'}, 'version': 1,
                    'sequence': 0, 'createdAt': now()}
            db.execute('INSERT INTO work_items VALUES (?, ?, ?, ?)', (work_id, owner, encoded(source), encoded(work)))
            db.execute('INSERT INTO task_claims VALUES (?, ?, ?)', (source_id, owner, work_id))
            self._event(db, work_id, 'work_item.claimed', {'source': source, 'sourceRecord': source_record})
            self._remember(db, owner, scope, key, digest, work_id)
            return self._work(db, work_id, owner)

    def bind_session(self, owner, work_id, session_id, role, version, key):
        if not isinstance(session_id, str) or not 1 <= len(session_id) <= 200 or role not in {'PLAN', 'CODE'}:
            raise InvalidInput('sessionId and role are invalid')
        with self.connection(True) as db:
            work = self._work(db, work_id, owner)
            scope = 'bind-session:' + work_id
            retry, digest = self._retry(db, owner, scope, key, {'sessionId': session_id, 'role': role})
            if retry:
                return self._work(db, retry, owner)
            self._version(work, version)
            row = db.execute('SELECT work_id, role FROM work_sessions WHERE owner=? AND session_id=?', (owner, session_id)).fetchone()
            if row and (row['work_id'] != work_id or row['role'] != role):
                raise Conflict('Session is already bound to another role or Work Item')
            if not row:
                db.execute('INSERT INTO work_sessions VALUES (?, ?, ?, ?)', (owner, session_id, work_id, role))
            sessions = [{'sessionId': r['session_id'], 'role': r['role']} for r in db.execute('SELECT session_id, role FROM work_sessions WHERE work_id=? ORDER BY rowid', (work_id,))]
            work['sessionIds'] = [s['sessionId'] for s in sessions]
            code = next((s['sessionId'] for s in sessions if s['role'] == 'CODE'), None)
            work['sessionId'] = code or (sessions[0]['sessionId'] if sessions else None)
            work['version'] += 1
            self._save_work(db, work)
            self._event(db, work_id, 'work_item.session_bound', {'sessionId': session_id, 'role': role})
            self._remember(db, owner, scope, key, digest, work_id)
            return self._work(db, work_id, owner)

    def update_workflow(self, owner, work_id, expected_version, workflow, stage=None, blocked=None, key=None):
        if not isinstance(workflow, dict) or not isinstance(workflow.get('phase'), str):
            raise InvalidInput('workflow must include phase')
        stages = {'CLAIMED','PREPARING','BASELINE','PLANNING','AWAITING_PLAN_APPROVAL','CODING','VERIFYING','AWAITING_REVIEW','PUBLISHING','PR_OPEN','CLOSING','COMPLETED','BLOCKED','PAUSED'}
        if stage is not None and stage not in stages:
            raise InvalidInput('Unsupported workflow stage')
        with self.connection(True) as db:
            work = self._work(db, work_id, owner)
            scope = 'workflow:' + work_id
            retry, digest = self._retry(db, owner, scope, key, {'workflow': workflow, 'stage': stage, 'blocked': blocked})
            if retry:
                return self._work(db, retry, owner)
            self._version(work, expected_version)
            work['workflow'] = dict(workflow)
            if stage is not None:
                work['stage'] = stage
            if blocked is not None:
                if type(blocked) is not bool:
                    raise InvalidInput('blocked must be boolean')
                work['blocked'] = blocked
            work['version'] += 1
            self._save_work(db, work)
            self._event(db, work_id, 'work_item.workflow_updated', {'workflow': workflow, 'stage': stage})
            self._remember(db, owner, scope, key, digest, work_id)
            return self._work(db, work_id, owner)

    def begin_prepare(self, owner, work_id, expected_version):
        with self.connection(True) as db:
            work = self._work(db, work_id, owner)
            if work['sandboxId']:
                return work, False
            provision = work.get('workspaceProvision')
            if provision:
                return work, False
            self._version(work, expected_version)
            work['workspaceProvision'] = {'state': 'PREPARING', 'label': 'task-' + work_id.split('-')[-1], 'startedAt': now()}
            work['stage'] = 'PREPARING'
            work['version'] += 1
            self._save_work(db, work)
            self._event(db, work_id, 'workspace.preparation_started', {'label': work['workspaceProvision']['label']})
            return self._work(db, work_id, owner), True

    def finish_prepare(self, owner, work_id, sandbox_id=None, error=None):
        with self.connection(True) as db:
            work = self._work(db, work_id, owner)
            provision = work.get('workspaceProvision') or {}
            if sandbox_id:
                work['sandboxId'] = sandbox_id
                provision.update(state='READY', sandboxId=sandbox_id, finishedAt=now())
                work['stage'] = 'BASELINE'
            else:
                provision.update(state='FAILED', error=str(error)[:1000], finishedAt=now())
                work['stage'] = 'BLOCKED'
            work['workspaceProvision'] = provision
            work['version'] += 1
            self._save_work(db, work)
            self._event(db, work_id, 'workspace.preparation_' + ('ready' if sandbox_id else 'failed'), provision)
            return work

    def set_provision_state(self, owner, work_id, state, error):
        with self.connection(True) as db:
            work = self._work(db, work_id, owner)
            provision = work.get('workspaceProvision') or {'label': 'task-' + work_id.split('-')[-1]}
            provision.update(state=state, error=str(error)[:1000], updatedAt=now())
            work['workspaceProvision'] = provision
            work['version'] += 1
            self._save_work(db, work)
            self._event(db, work_id, 'workspace.preparation_unknown', {'state': state, 'error': provision['error']})
            return work

    def get_work_item(self, owner, work_id):
        with self.connection() as db:
            return self._work(db, work_id, owner)

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
            if not work.get('sandboxId'):
                raise Conflict('Workspace must be prepared before execution')
            self._version(work, body.get('expectedVersion'))
            op = {'operationId': identifier('exec'), 'workItemId': work_id, 'ownerId': owner,
                  'sandboxId': work['sandboxId'], 'kind': kind, 'command': command,
                  'timeoutSeconds': timeout, 'sourceCommit': commit, 'state': 'QUEUED',
                  'version': 1, 'createdAt': now(), 'startedAt': None, 'finishedAt': None,
                  'exitCode': None, 'reason': None, 'runtime': None, 'logOffsets': {'stdout': 0, 'stderr': 0}}
            db.execute('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)',
                       (op['operationId'], owner, work_id, work['sandboxId'], 'QUEUED', encoded(op)))
            work['version'] += 1
            if not work.get('blocked'):
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
            sessions = [{'sessionId': r['session_id'], 'role': r['role']} for r in db.execute('SELECT session_id, role FROM work_sessions WHERE work_id=? ORDER BY rowid', (work_id,))]
            if not sessions and work.get('sessionId'):
                sessions = [{'sessionId': work['sessionId'], 'role': 'CODE'}]
            return {'workItem': work, 'sessions': sessions, 'operations': ops, 'evidence': evidence, 'cursor': work['sequence']}

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
            if not paused:
                work['blocked'] = False
                if work['stage'] == 'BLOCKED':
                    work['stage'] = 'CODING'
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
            # UNKNOWN may still execute. Keep its source sandbox quarantined,
            # including against other Work Items and explicit workflow resume.
            occupied = {r[0] for r in db.execute("SELECT sandbox_id FROM operations WHERE state IN ('STARTING','RUNNING','CANCEL_REQUESTED','UNKNOWN')")}
            for row in db.execute("SELECT data FROM operations WHERE state='QUEUED' ORDER BY rowid").fetchall():
                op = json.loads(row['data'])
                work = self._work(db, op['workItemId'])
                if op['sandboxId'] in occupied or work['paused'] or work.get('blocked'):
                    continue
                stage = 'CODING' if op['kind'] == 'COMMAND' else 'VERIFYING'
                if work['stage'] != stage:
                    work['stage'] = stage
                    work['version'] += 1
                    self._save_work(db, work)
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
            work['blocked'] = state != 'SUCCEEDED'
            self._save_work(db, work)
            self._event(db, op['workItemId'], 'execution.' + state.lower(), {'status': state, 'exitCode': exit_code, 'reason': reason}, op_id)

    def _intake(self, db, finding_id, owner=None):
        row = db.execute('SELECT * FROM source_intakes WHERE finding_id=?', (finding_id,)).fetchone()
        if row is None or (owner is not None and row['owner'] != owner):
            raise NotFound('Resource unavailable')
        return {'findingId': row['finding_id'], 'owner': row['owner'], 'revision': row['revision'],
                'state': row['state'], 'triage': json.loads(row['triage']),
                'notifiedAt': row['notified_at'], 'lastError': row['last_error'],
                'decision': json.loads(row['decision']) if row['decision'] else None,
                'createdAt': row['created_at'], 'updatedAt': row['updated_at']}

    def record_intake(self, owner, finding_id, revision, triage, state=None, notified=False):
        if not isinstance(finding_id, str) or not finding_id:
            raise InvalidInput('findingId is required')
        if type(revision) is not int or revision < 1:
            raise InvalidInput('revision must be a positive integer')
        if not isinstance(triage, dict) or not isinstance(triage.get('result'), str):
            raise InvalidInput('triage requires a result')
        if state is not None and (not isinstance(state, str) or not state):
            raise InvalidInput('state is invalid')
        if type(notified) is not bool:
            raise InvalidInput('notified must be boolean')
        with self.connection(True) as db:
            row = db.execute('SELECT owner, state FROM source_intakes WHERE finding_id=?', (finding_id,)).fetchone()
            derived = state or ('AWAITING_OWNER' if triage['result'] == 'CONFIRMED' else 'NEEDS_REVIEW')
            at = now()
            if row is None:
                db.execute('INSERT INTO source_intakes VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
                           (finding_id, owner, revision, derived, encoded(triage),
                            at if notified else None, at, at))
            else:
                if row['owner'] != owner:
                    raise Conflict('Intake is owned by another owner')
                if row['state'] in {'APPROVED', 'REJECTED'}:
                    db.execute('UPDATE source_intakes SET revision=?, triage=?, updated_at=? WHERE finding_id=?',
                               (revision, encoded(triage), at, finding_id))
                else:
                    db.execute('UPDATE source_intakes SET revision=?, state=?, triage=?, notified_at=coalesce(notified_at, ?), updated_at=? WHERE finding_id=?',
                               (revision, derived, encoded(triage), at if notified else None, at, finding_id))
            return self._intake(db, finding_id)

    def intakes(self, owner):
        with self.connection() as db:
            return [self._intake(db, r['finding_id']) for r in db.execute('SELECT finding_id FROM source_intakes WHERE owner=? ORDER BY finding_id', (owner,))]

    def decide_intake(self, owner, finding_id, decision, expected_revision, key):
        if decision not in {'APPROVED', 'REJECTED'}:
            raise InvalidInput('decision must be APPROVED or REJECTED')
        with self.connection(True) as db:
            intake = self._intake(db, finding_id, owner)
            scope = 'intake-decide'
            retry, digest = self._retry(db, owner, scope, key,
                                        {'findingId': finding_id, 'expectedRevision': expected_revision, 'decision': decision})
            if retry:
                return self._intake(db, finding_id)
            if str(expected_revision) != str(intake['revision']):
                raise Conflict('Stale expectedRevision')
            if intake['state'] != 'AWAITING_OWNER':
                raise Conflict('Intake is not awaiting owner decision')
            decision_doc = {'by': owner, 'at': now(), 'key': key}
            db.execute('UPDATE source_intakes SET state=?, decision=?, updated_at=? WHERE finding_id=?',
                       (decision, encoded(decision_doc), now(), finding_id))
            self._remember(db, owner, scope, key, digest, finding_id)
            return self._intake(db, finding_id)
