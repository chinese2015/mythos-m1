import concurrent.futures
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from brain.api import make_server
from brain.executor import DockerExecutor
from brain.store import Store
from sandbox import SandboxBroker


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name + '/brain')
        broker = SandboxBroker(self.temp.name + '/sandboxes')
        item = broker.registry.allocate('alice', 'task')
        broker.registry.transition('alice', item['sandbox_id'], 'running')
        self.sandbox_id = item['sandbox_id']
        self.executor = DockerExecutor(broker)
        self.tokens = {'alice': 'alice-test-token', 'bob': 'bob-test-token'}
        self.server = self.start_server()
        self.addCleanup(self.stop_server)

    def start_server(self):
        server = make_server(self.store, self.executor, self.tokens, ('127.0.0.1', 0))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.url = 'http://127.0.0.1:' + str(server.server_port)
        return server

    def stop_server(self):
        self.server.shutdown(); self.server.server_close()

    def request(self, method, path, body=None, owner='alice', key=None):
        headers = {'Content-Type': 'application/json'}
        if owner:
            headers['Authorization'] = 'Bearer ' + self.tokens[owner]
        if key is not None:
            headers['Idempotency-Key'] = key
        request = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                                         method=method, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def create(self):
        code, work = self.request('POST', '/api/brain/work-items',
                                  {'source': {'type': 'ARGON', 'id': 'FND-00009', 'revision': 2}, 'sandboxId': self.sandbox_id}, key='create')
        self.assertEqual(code, 201)
        return work

    def test_authentication_and_body_owner_cannot_override_identity(self):
        self.assertEqual(self.request('GET', '/api/brain/work-items', owner=None)[0], 401)
        body = {'source': {'type': 'ARGON', 'id': 'FND', 'revision': 1}, 'sandboxId': self.sandbox_id, 'ownerId': 'bob'}
        self.assertEqual(self.request('POST', '/api/brain/work-items', body, key='bad')[0], 400)
        body.pop('ownerId')
        self.assertEqual(self.request('POST', '/api/brain/work-items', body, owner='bob', key='bad-owner')[0], 404)

    def test_async_enqueue_is_idempotent_and_survives_http_restart(self):
        work = self.create(); path = '/api/brain/work-items/' + work['workItemId']
        body = {'expectedVersion': 1, 'command': 'sleep 30'}
        code, operation = self.request('POST', path + '/operations', body, key='run')
        self.assertEqual((code, operation['state']), (202, 'QUEUED'))
        duplicate = self.request('POST', path + '/operations', body, key='run')[1]
        self.assertEqual(operation['operationId'], duplicate['operationId'])
        self.stop_server(); self.server = self.start_server()
        snapshot = self.request('GET', path)[1]
        self.assertEqual(snapshot['operations'][0]['state'], 'QUEUED')
        events = self.request('GET', path + '/events?after=1')[1]
        self.assertEqual([e['type'] for e in events['events']], ['execution.queued'])

    def test_owner_isolation_also_covers_events_logs_operations_and_cancel(self):
        work = self.create(); path = '/api/brain/work-items/' + work['workItemId']
        operation = self.request('POST', path + '/operations', {'expectedVersion': 1, 'command': 'true'}, key='run')[1]
        op_path = '/api/brain/operations/' + operation['operationId']
        for target in [path, path + '/events', path + '/operations', op_path, op_path + '/logs']:
            self.assertEqual(self.request('GET', target, owner='bob')[0], 404, target)
        self.assertEqual(self.request('POST', op_path + '/cancel', {'expectedVersion': 1}, owner='bob', key='cancel')[0], 404)
        self.assertEqual(self.request('GET', '/api/brain/work-items', owner='bob')[1]['workItems'], [])

    def test_versions_cancellation_and_missing_idempotency_key(self):
        work = self.create(); path = '/api/brain/work-items/' + work['workItemId']
        self.assertEqual(self.request('POST', path + '/operations', {'command': 'true', 'expectedVersion': 1})[0], 400)
        op = self.request('POST', path + '/operations', {'command': 'true', 'expectedVersion': 1}, key='run')[1]
        self.assertEqual(self.request('POST', path + '/pause', {'expectedVersion': 1}, key='pause')[0], 409)
        self.assertEqual(self.request('POST', path + '/pause', {'expectedVersion': 2}, key='pause')[0], 200)
        cancel_path = '/api/brain/operations/' + op['operationId'] + '/cancel'
        code, cancelled = self.request('POST', cancel_path, {'expectedVersion': 1}, key='cancel')
        self.assertEqual((code, cancelled['state']), (200, 'CANCELLED'))

    def test_invalid_cursor_and_unknown_fields_are_rejected(self):
        work = self.create(); path = '/api/brain/work-items/' + work['workItemId']
        self.assertEqual(self.request('GET', path + '/events?after=-1')[0], 400)
        self.assertEqual(self.request('GET', path + '/events?limit=999999')[0], 400)
        self.assertEqual(self.request('POST', path + '/operations', {'command': 'true', 'expectedVersion': 1, 'cwd': '/etc'}, key='bad')[0], 400)

    def test_task_claim_endpoint_uses_authenticated_owner_and_starts_without_workspace(self):
        source = {'id': 'FND-00009', 'title': 'Nova', 'risk': 'HIGH', 'ownerId': 'alice',
                  'repositoryUrl': 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git',
                  'baseCommit': 'a' * 40, 'sourcePath': 'src/main/java/demo/CatalogService.java',
                  'revision': '2'}
        code, item = self.request('POST', '/api/brain/tasks/claim',
                                  {'sourceRecord': source, 'expectedRevision': '2', 'ownerId': 'bob'}, key='claim')
        self.assertEqual(code, 400)
        code, item = self.request('POST', '/api/brain/tasks/claim',
                                  {'sourceRecord': source, 'expectedRevision': '2'}, key='claim')
        self.assertEqual(code, 202)
        self.assertEqual(item['ownerId'], 'alice')
        self.assertIsNone(item['sandboxId'])
        self.assertEqual(item['sourceRecord'], source)
        self.assertEqual(self.request('POST', '/api/brain/work-items/' + item['workItemId'] + '/operations',
                                      {'expectedVersion': item['version'], 'command': 'true'}, key='run')[0], 409)


if __name__ == '__main__':
    unittest.main()
