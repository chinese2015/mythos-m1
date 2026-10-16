"""Authenticated loopback API. Requests enqueue facts, never own jobs."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
from urllib.parse import parse_qs, urlsplit

from .errors import BrainError, InvalidInput, NotFound, Unauthorized
from .publication import GitPublisher
from .workspace import TaskWorkspace


def make_server(store, executor, tokens, address=('127.0.0.1', 3081), publisher=None):
    if not tokens or len(set(tokens.values())) != len(tokens):
        raise ValueError('Each owner must have a distinct bearer token')
    task_workspace = TaskWorkspace(store, executor)
    publication = publisher or GitPublisher(store, executor)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            # Authorization, source context and command text never enter access logs.
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def respond(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)

        def owner(self):
            auth = self.headers.get('Authorization', '')
            if auth.startswith('Bearer '):
                candidate = auth[7:]
                for owner, token in tokens.items():
                    if hmac.compare_digest(candidate.encode(), token.encode()):
                        return owner
            raise Unauthorized('A valid bearer token is required')

        def body(self, allowed):
            if self.headers.get('Transfer-Encoding'):
                raise InvalidInput('Transfer-Encoding is unsupported')
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 65536:
                raise InvalidInput('JSON body must be between 1 byte and 64 KiB')
            if self.headers.get_content_type() != 'application/json':
                raise InvalidInput('Content-Type must be application/json')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or set(data) - set(allowed):
                raise InvalidInput('Unexpected JSON fields')
            return data

        def page(self, query):
            if set(query) - {'after', 'limit'} or any(len(v) != 1 for v in query.values()):
                raise InvalidInput('Invalid pagination parameters')
            after = int(query.get('after', ['0'])[0])
            limit = int(query.get('limit', ['100'])[0])
            if not 0 <= after <= 2**63 - 1 or not 1 <= limit <= 200:
                raise InvalidInput('Cursor must be nonnegative and limit 1..200')
            return after, limit

        def dispatch(self):
            url = urlsplit(self.path)
            path = url.path.rstrip('/')
            if self.command == 'GET' and path == '/health':
                return 200, {'service': 'argon-brain', 'status': 'ok', 'schemaVersion': 1}
            owner = self.owner()
            key = self.headers.get('Idempotency-Key')
            segments = path.split('/')[1:]
            if segments[:2] != ['api', 'brain']:
                raise NotFound('Route unavailable')
            route = segments[2:]
            query = parse_qs(url.query, keep_blank_values=True)
            if route == ['tasks', 'claim'] and self.command == 'POST':
                body = self.body({'sourceRecord', 'expectedRevision'})
                result = store.claim_task(owner, body.get('sourceRecord'), body.get('expectedRevision'), key)
                return 202, result
            if route == ['work-items']:
                if self.command == 'GET':
                    return 200, {'workItems': store.list_work_items(owner)}
                if self.command == 'POST':
                    body = self.body({'source', 'sandboxId', 'sessionId'})
                    sandbox_id = body.get('sandboxId')
                    if not isinstance(sandbox_id, str):
                        raise InvalidInput('sandboxId is required')
                    session = body.get('sessionId')
                    if session is not None and (not isinstance(session, str) or len(session) > 200):
                        raise InvalidInput('Invalid sessionId')
                    executor.validate_binding(owner, sandbox_id)
                    return 201, store.create_work_item(owner, body, key)
            if len(route) in {2, 3} and route[0] == 'work-items':
                work_id = route[1]
                if self.command == 'GET':
                    if len(route) == 2:
                        return 200, store.snapshot(owner, work_id)
                    if route[2] == 'workspace':
                        return 200, task_workspace.evidence(owner, work_id)
                    if route[2] == 'events':
                        return 200, store.events(owner, work_id, *self.page(query))
                    if route[2] == 'operations':
                        return 200, {'operations': store.snapshot(owner, work_id)['operations']}
                if self.command == 'POST' and len(route) == 3:
                    if route[2] == 'prepare':
                        body = self.body({'expectedVersion'})
                        return 200, task_workspace.prepare(owner, work_id, body.get('expectedVersion'))
                    if route[2] == 'sessions':
                        body = self.body({'sessionId', 'role', 'expectedVersion'})
                        return 200, store.bind_session(owner, work_id, body.get('sessionId'), body.get('role'), body.get('expectedVersion'), key)
                    if route[2] == 'workflow':
                        body = self.body({'expectedVersion', 'workflow', 'stage', 'blocked'})
                        return 200, store.update_workflow(owner, work_id, body.get('expectedVersion'), body.get('workflow'), body.get('stage'), body.get('blocked'), key)
                    if route[2] == 'publish-branch':
                        body = self.body({'expectedVersion', 'deliveryId'})
                        if not isinstance(key, str) or not 1 <= len(key) <= 200:
                            raise InvalidInput('Idempotency-Key is required (1..200 characters)')
                        return 200, publication.publish(owner, work_id, body.get('deliveryId'), key,
                                                        body.get('expectedVersion'))
                    if route[2] == 'operations':
                        body = self.body({'expectedVersion', 'command', 'kind', 'timeoutSeconds', 'sourceCommit'})
                        return 202, store.submit(owner, work_id, body, key)
                    if route[2] in {'pause', 'resume'}:
                        body = self.body({'expectedVersion'})
                        return 200, store.set_paused(owner, work_id, route[2] == 'pause', body.get('expectedVersion'), key)
            if len(route) in {2, 3} and route[0] == 'operations':
                op_id = route[1]
                if self.command == 'GET':
                    if len(route) == 2:
                        return 200, store.operation(owner, op_id)
                    if route[2] == 'logs':
                        return 200, store.logs(owner, op_id, *self.page(query))
                if self.command == 'POST' and len(route) == 3 and route[2] == 'cancel':
                    body = self.body({'expectedVersion'})
                    return 200, store.cancel(owner, op_id, body.get('expectedVersion'), key)
            if route == ['source-intakes'] and self.command == 'GET':
                return 200, {'intakes': store.intakes(owner)}
            if len(route) in {2, 3} and route[0] == 'source-intakes':
                finding_id = route[1]
                if not re.fullmatch(r'FND-[0-9]{5}', finding_id):
                    raise InvalidInput('findingId must match ^FND-[0-9]{5}$')
                if self.command == 'PUT' and len(route) == 2:
                    body = self.body({'revision', 'triage'})
                    return 200, store.record_intake(owner, finding_id, body.get('revision'), body.get('triage'))
                if self.command == 'POST' and len(route) == 3 and route[2] == 'decide':
                    body = self.body({'expectedRevision', 'decision'})
                    return 200, store.decide_intake(owner, finding_id, body.get('decision'),
                                                   body.get('expectedRevision'), key)
            raise NotFound('Route unavailable')

        def handle_request(self):
            try:
                status, response = self.dispatch()
            except BrainError as error:
                status, response = error.status, {'error': {'code': error.code, 'message': str(error)}}
            except (ValueError, TypeError, UnicodeError):
                status, response = 400, {'error': {'code': 'INVALID_INPUT', 'message': 'Malformed request'}}
            except Exception:
                status, response = 500, {'error': {'code': 'INTERNAL', 'message': 'Internal backend error'}}
            try:
                self.respond(status, response)
            except (BrokenPipeError, ConnectionResetError):
                pass

        do_GET = handle_request
        do_POST = handle_request
        do_PUT = handle_request

    return ThreadingHTTPServer(address, Handler)
