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


class FakePublisher:
    def __init__(self):
        self.calls = []

    def publish(self, owner, work_id, delivery_id, key, expected_version):
        self.calls.append((owner, work_id, delivery_id, key, expected_version))
        return {'deliveryId': delivery_id, 'owner': owner}


class PublicationApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name + '/brain')
        broker = SandboxBroker(self.temp.name + '/sandboxes')
        self.executor = DockerExecutor(broker)
        self.publisher = FakePublisher()
        self.server = make_server(self.store, self.executor, {'alice': 'alice-token'},
                                  ('127.0.0.1', 0), self.publisher)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.stop_server)
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, body, key='delivery-1', auth=True):
        headers = {'Content-Type': 'application/json', 'Idempotency-Key': key}
        if auth:
            headers['Authorization'] = 'Bearer alice-token'
        req = urllib.request.Request(self.url + '/api/brain/work-items/work-123/publish-branch',
                                     data=json.dumps(body).encode(), method='POST', headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_authenticated_endpoint_forwards_version_delivery_and_idempotency_key(self):
        body = {'expectedVersion': 7, 'deliveryId': 'a' * 64}
        status, result = self.request(body)
        self.assertEqual(status, 200)
        self.assertEqual(result['deliveryId'], body['deliveryId'])
        self.assertEqual(self.publisher.calls, [('alice', 'work-123', 'a' * 64, 'delivery-1', 7)])

    def test_endpoint_requires_private_owner_authentication(self):
        self.assertEqual(self.request({'expectedVersion': 7, 'deliveryId': 'a' * 64}, auth=False)[0], 401)

    def test_endpoint_rejects_missing_idempotency_key(self):
        self.assertEqual(self.request({'expectedVersion': 7, 'deliveryId': 'a' * 64}, key='')[0], 400)


if __name__ == '__main__':
    unittest.main()
