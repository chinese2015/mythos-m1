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


class SourceIntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name + '/brain')
        broker = SandboxBroker(self.temp.name + '/sandboxes')
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

    def put_intake(self, finding_id, revision, result='CONFIRMED', key=None):
        return self.request('PUT', '/api/brain/source-intakes/' + finding_id,
                            {'revision': revision, 'triage': {'result': result, 'score': 0.9}}, key=key)

    def test_registration_is_idempotent_and_sorted_by_finding_id(self):
        code, first = self.put_intake('FND-00002', 1)
        self.assertEqual(code, 200)
        self.assertEqual(first['state'], 'AWAITING_OWNER')
        code, again = self.put_intake('FND-00002', 1)
        self.assertEqual(code, 200)
        self.assertEqual(again['findingId'], first['findingId'])
        self.put_intake('FND-00001', 3)
        code, listed = self.request('GET', '/api/brain/source-intakes')
        self.assertEqual(code, 200)
        self.assertEqual([i['findingId'] for i in listed['intakes']], ['FND-00001', 'FND-00002'])

    def test_state_derivation_confirmed_becomes_awaiting_owner_else_needs_review(self):
        self.assertEqual(self.put_intake('FND-00010', 1)[1]['state'], 'AWAITING_OWNER')
        self.assertEqual(self.put_intake('FND-00011', 1, result='SUSPICIOUS')[1]['state'], 'NEEDS_REVIEW')

    def test_revision_change_preserves_approved_decision(self):
        intake = self.put_intake('FND-00020', 1)[1]
        code, decided = self.request('POST', '/api/brain/source-intakes/FND-00020/decide',
                                     {'expectedRevision': 1, 'decision': 'APPROVED'}, key='approve-1')
        self.assertEqual((code, decided['state']), (200, 'APPROVED'))
        self.assertEqual(decided['decision']['by'], 'alice')
        code, updated = self.put_intake('FND-00020', 2)
        self.assertEqual(code, 200)
        self.assertEqual(updated['revision'], 2)
        self.assertEqual(updated['state'], 'APPROVED')
        self.assertEqual(updated['decision']['by'], 'alice')
        self.assertEqual(updated['triage']['result'], 'CONFIRMED')

    def test_revision_change_preserves_rejected_decision(self):
        self.put_intake('FND-00021', 1)
        self.request('POST', '/api/brain/source-intakes/FND-00021/decide',
                     {'expectedRevision': 1, 'decision': 'REJECTED'}, key='reject-1')
        updated = self.put_intake('FND-00021', 5)[1]
        self.assertEqual((updated['state'], updated['revision']), ('REJECTED', 5))

    def test_decide_is_idempotent_replay_and_requires_key(self):
        intake = self.put_intake('FND-00030', 1)[1]
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-00030/decide',
                                      {'expectedRevision': 1, 'decision': 'APPROVED'})[0], 400)
        body = {'expectedRevision': 1, 'decision': 'APPROVED'}
        first = self.request('POST', '/api/brain/source-intakes/FND-00030/decide', body, key='approve-1')
        replay = self.request('POST', '/api/brain/source-intakes/FND-00030/decide', body, key='approve-1')
        self.assertEqual(first[1]['decision'], replay[1]['decision'])
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-00030/decide',
                                      {'expectedRevision': 1, 'decision': 'REJECTED'}, key='approve-1')[0], 409)

    def test_decide_only_when_awaiting_owner(self):
        self.put_intake('FND-00040', 1, result='SUSPICIOUS')
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-00040/decide',
                                      {'expectedRevision': 1, 'decision': 'APPROVED'}, key='nope')[0], 409)
        self.put_intake('FND-00041', 1)
        self.request('POST', '/api/brain/source-intakes/FND-00041/decide',
                     {'expectedRevision': 1, 'decision': 'APPROVED'}, key='approve-1')
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-00041/decide',
                                      {'expectedRevision': 1, 'decision': 'APPROVED'}, key='approve-2')[0], 409)
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-99999/decide',
                                      {'expectedRevision': 1, 'decision': 'APPROVED'}, key='ghost')[0], 404)

    def test_store_record_intake_explicit_state_and_notified(self):
        intake = self.store.record_intake('alice', 'FND-00050', 1, {'result': 'CONFIRMED'},
                                          state='APPROVED', notified=True)
        self.assertEqual(intake['state'], 'APPROVED')
        self.assertIsNotNone(intake['notifiedAt'])
        direct = self.store.record_intake('alice', 'FND-00051', 1, {'result': 'LOW'})
        self.assertEqual(direct['state'], 'NEEDS_REVIEW')
        self.assertIsNone(direct['notifiedAt'])

    def test_route_auth_and_validation(self):
        self.assertEqual(self.request('GET', '/api/brain/source-intakes', owner=None)[0], 401)
        self.assertEqual(self.request('PUT', '/api/brain/source-intakes/FND-1',
                                      {'revision': 1, 'triage': {'result': 'CONFIRMED'}})[0], 400)
        self.assertEqual(self.request('PUT', '/api/brain/source-intakes/FND-00060',
                                      {'revision': 1})[0], 400)
        self.put_intake('FND-00061', 1)
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-00061/decide',
                                      {'expectedRevision': 1, 'decision': 'MAYBE'}, key='bad')[0], 400)
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-00061/decide',
                                      {'expectedRevision': 9, 'decision': 'APPROVED'}, key='stale')[0], 409)

    def test_owner_isolation(self):
        self.put_intake('FND-00070', 1)
        code, listed = self.request('GET', '/api/brain/source-intakes', owner='bob')
        self.assertEqual((code, listed['intakes']), (200, []))
        self.assertEqual(self.request('PUT', '/api/brain/source-intakes/FND-00070',
                                      {'revision': 2, 'triage': {'result': 'CONFIRMED'}}, owner='bob')[0], 409)
        self.assertEqual(self.request('POST', '/api/brain/source-intakes/FND-00070/decide',
                                      {'expectedRevision': 1, 'decision': 'APPROVED'}, owner='bob', key='bob')[0], 404)

    def test_notification_metadata_survives_decision_and_restart(self):
        path = '/api/brain/source-intakes/FND-00080'
        body = {'revision': 1, 'triage': {'result': 'CONFIRMED'}, 'lastError': 'outbox unavailable'}
        self.assertEqual(self.request('PUT', path, body)[1]['lastError'], 'outbox unavailable')
        self.request('POST', path + '/decide', {'expectedRevision': 1, 'decision': 'APPROVED'}, key='metadata')
        code, saved = self.request('PUT', path, {**body, 'notified': True, 'lastError': None})
        self.assertEqual(code, 200)
        self.assertEqual(saved['state'], 'APPROVED')
        self.assertIsNotNone(saved['notifiedAt'])
        self.assertIsNone(saved['lastError'])
        self.assertEqual(Store(self.temp.name + '/brain').intakes('alice')[0]['notifiedAt'], saved['notifiedAt'])

    def test_grandfather_state_route_and_stale_poll_cannot_rewind_revision(self):
        path = '/api/brain/source-intakes/FND-00081'
        body = {'revision': 3, 'triage': {'result': 'CONFIRMED'}, 'state': 'APPROVED'}
        self.assertEqual(self.request('PUT', path, body)[1]['state'], 'APPROVED')
        self.assertEqual(self.request('PUT', path, {**body, 'revision': 2})[0], 409)
        self.assertEqual(self.request('PUT', path, {**body, 'state': 'TYPO'})[0], 400)

    def test_inflight_poll_cannot_rebind_an_approval_and_notifications_follow_binding(self):
        original = {'result': 'CONFIRMED', 'binding': 'owner-a'}
        self.store.record_intake('alice', 'FND-00090', 1, original, notified=True)
        decided = self.store.decide_intake('alice', 'FND-00090', 'APPROVED', 1, 'bind-approval')
        updated = self.store.record_intake('alice', 'FND-00090', 2, {**original, 'binding': 'owner-b'})
        self.assertEqual(updated['state'], 'APPROVED')
        self.assertEqual(updated['decision'].get('binding'), 'owner-a')
        self.assertEqual(updated['decision'], decided['decision'])
        self.assertIsNone(updated['notifiedAt'])


if __name__ == '__main__':
    unittest.main()
