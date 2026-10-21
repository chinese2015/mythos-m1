import concurrent.futures
import tempfile
import unittest

from brain.store import Store
from brain.errors import Conflict, NotFound, InvalidInput


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        self.body = {'source': {'type': 'MYTHOS', 'id': 'FND-00009', 'revision': 2},
                     'sandboxId': 'sb-alice', 'sessionId': 'session-1'}
        self.work = self.store.create_work_item('alice', self.body, 'create-1')

    def submit(self, key='run-1', command='echo hello', **extra):
        body = {'expectedVersion': self.store.snapshot('alice', self.work['workItemId'])['workItem']['version'],
                'kind': 'COMMAND', 'command': command, 'timeoutSeconds': 30}
        body.update(extra)
        return self.store.submit('alice', self.work['workItemId'], body, key)

    def test_idempotent_creation_and_source_deduplication_survive_reopen(self):
        reopened = Store(self.temp.name)
        self.assertEqual(reopened.create_work_item('alice', self.body, 'create-1'), self.work)
        self.assertEqual(reopened.create_work_item('alice', self.body, 'new-key')['workItemId'], self.work['workItemId'])
        changed = dict(self.body, sandboxId='another')
        with self.assertRaises(Conflict):
            reopened.create_work_item('alice', changed, 'create-1')

    def test_concurrent_retries_create_only_one_operation(self):
        body = {'expectedVersion': 1, 'kind': 'COMMAND', 'command': 'echo once'}
        def submit(_):
            return self.store.submit('alice', self.work['workItemId'], body, 'same')['operationId']
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(submit, range(16)))
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(len(self.store.snapshot('alice', self.work['workItemId'])['operations']), 1)

    def test_stale_version_and_changed_retry_payload_conflict(self):
        op = self.submit()
        with self.assertRaises(Conflict):
            self.store.submit('alice', self.work['workItemId'], {'expectedVersion': 1, 'command': 'other'}, 'other')
        with self.assertRaises(Conflict):
            self.submit(key='run-1', command='different')
        self.assertEqual(self.store.operation('alice', op['operationId'])['state'], 'QUEUED')

    def test_replay_uses_business_identity_when_expected_version_changes(self):
        body = {'expectedVersion': 1, 'kind': 'COMMAND', 'command': 'echo once'}
        first = self.store.submit('alice', self.work['workItemId'], body, 'stable-call')
        replay = self.store.submit('alice', self.work['workItemId'], dict(body, expectedVersion=2), 'stable-call')
        self.assertEqual(first['operationId'], replay['operationId'])
        cancelled = self.store.cancel('alice', first['operationId'], first['version'], 'stable-cancel')
        self.assertEqual(self.store.cancel('alice', first['operationId'], cancelled['version'], 'stable-cancel')['state'], 'CANCELLED')
        version = self.store.snapshot('alice', self.work['workItemId'])['workItem']['version']
        paused = self.store.set_paused('alice', self.work['workItemId'], True, version, 'stable-pause')
        replay = self.store.set_paused('alice', self.work['workItemId'], True, paused['version'], 'stable-pause')
        self.assertEqual(paused['version'], replay['version'])

    def test_other_owner_cannot_read_or_mutate_any_resource(self):
        op = self.submit()
        work_id, op_id = self.work['workItemId'], op['operationId']
        for action in [lambda: self.store.snapshot('bob', work_id),
                       lambda: self.store.events('bob', work_id, 0, 10),
                       lambda: self.store.operation('bob', op_id),
                       lambda: self.store.logs('bob', op_id, 0, 10),
                       lambda: self.store.cancel('bob', op_id, 1, 'cancel'),
                       lambda: self.store.set_paused('bob', work_id, True, 2, 'pause')]:
            with self.assertRaises(NotFound):
                action()
        self.assertEqual(self.store.list_work_items('bob'), [])

    def test_snapshot_cursor_then_replay_has_no_gap_or_duplicates(self):
        snap = self.store.snapshot('alice', self.work['workItemId'])
        op = self.submit()
        self.store.claim_next()
        self.store.record_runtime(op['operationId'], {'sandboxId': 'sb-alice'})
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0)
        events = self.store.events('alice', self.work['workItemId'], snap['cursor'], 100)
        self.assertEqual([e['sequence'] for e in events['events']], [2, 3, 4, 5])
        self.assertEqual(len({e['eventId'] for e in events['events']}), 4)
        self.assertEqual(self.store.events('alice', self.work['workItemId'], events['nextCursor'], 100)['events'], [])

    def test_pause_blocks_dispatch_but_does_not_cancel_active_work(self):
        op = self.submit()
        claimed = self.store.claim_next()
        self.assertEqual(claimed['operationId'], op['operationId'])
        self.store.set_paused('alice', self.work['workItemId'], True, 2, 'pause')
        self.assertEqual(self.store.operation('alice', op['operationId'])['state'], 'STARTING')
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0)
        self.submit(key='second')
        self.assertIsNone(self.store.claim_next())
        snap = self.store.snapshot('alice', self.work['workItemId'])
        self.store.set_paused('alice', self.work['workItemId'], False, snap['workItem']['version'], 'resume')
        self.assertIsNotNone(self.store.claim_next())

    def test_only_one_operation_per_sandbox_can_dispatch(self):
        a = self.submit()
        b = self.submit(key='second')
        self.assertEqual(self.store.claim_next()['operationId'], a['operationId'])
        self.assertIsNone(self.store.claim_next())
        self.store.finish(a['operationId'], 'SUCCEEDED', exit_code=0)
        self.assertEqual(self.store.claim_next()['operationId'], b['operationId'])

    def test_failure_holds_queued_work_until_explicit_resume(self):
        a = self.submit(); self.submit(key='later')
        self.store.claim_next()
        self.store.finish(a['operationId'], 'FAILED', exit_code=2)
        self.assertIsNone(self.store.claim_next())
        work = self.store.snapshot('alice', self.work['workItemId'])['workItem']
        self.store.set_paused('alice', work['workItemId'], False, work['version'], 'resume-after-failure')
        self.assertIsNotNone(self.store.claim_next())

    def test_unknown_quarantines_sandbox_even_across_work_items_and_resume(self):
        a = self.submit(); self.store.claim_next()
        self.store.finish(a['operationId'], 'UNKNOWN')
        other = self.store.create_work_item('alice', {'source': {'type': 'DIRECT', 'id': 'another-task', 'revision': 1}, 'sandboxId': 'sb-alice'}, 'other-work')
        self.store.submit('alice', other['workItemId'], {'expectedVersion': 1, 'command': 'echo unsafe'}, 'other-run')
        work = self.store.snapshot('alice', self.work['workItemId'])['workItem']
        self.store.set_paused('alice', work['workItemId'], False, work['version'], 'resume-unknown')
        self.assertIsNone(self.store.claim_next())

    def test_queued_cancel_never_executes_and_active_cancel_is_only_a_request(self):
        queued = self.submit()
        self.assertEqual(self.store.cancel('alice', queued['operationId'], 1, 'cancel-q')['state'], 'CANCELLED')
        self.assertIsNone(self.store.claim_next())
        op = self.submit(key='active')
        self.store.claim_next()
        op = self.store.operation('alice', op['operationId'])
        cancelled = self.store.cancel('alice', op['operationId'], op['version'], 'cancel-r')
        self.assertEqual(cancelled['state'], 'CANCEL_REQUESTED')
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0)
        self.assertEqual(self.store.operation('alice', op['operationId'])['state'], 'SUCCEEDED')

    def test_log_offsets_are_durable_and_duplicate_poll_is_not_repeated(self):
        op = self.submit(); self.store.claim_next()
        self.store.append_log(op['operationId'], 'stdout', 0, '你好'.encode())
        self.store.append_log(op['operationId'], 'stdout', 0, '你好'.encode())
        self.store.append_log(op['operationId'], 'stderr', 0, b'warning\n')
        result = Store(self.temp.name).logs('alice', op['operationId'], 0, 100)
        self.assertEqual(len(result['logs']), 2)
        self.assertEqual(result['logs'][0]['text'], '你好')
        self.assertEqual(self.store.operation('alice', op['operationId'])['logOffsets'], {'stdout': 6, 'stderr': 8})

    def test_terminal_results_cannot_be_overwritten_or_requeued(self):
        op = self.submit(); self.store.claim_next()
        self.store.finish(op['operationId'], 'UNKNOWN', reason='container disappeared')
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0)
        self.assertEqual(self.store.operation('alice', op['operationId'])['state'], 'UNKNOWN')
        self.assertIsNone(self.store.claim_next())

    def test_invalid_inputs_do_not_create_operations(self):
        for extra in [{'timeoutSeconds': -1}, {'timeoutSeconds': True}, {'kind': 'DANGEROUS'},
                      {'sourceCommit': 'HEAD'}, {'command': ''}]:
            with self.assertRaises(InvalidInput):
                self.submit(key='bad-'+str(extra), **extra)
        self.assertEqual(self.store.snapshot('alice', self.work['workItemId'])['operations'], [])


if __name__ == '__main__':
    unittest.main()
