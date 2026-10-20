import tempfile
import unittest
from types import SimpleNamespace

from brain.store import Store
from brain.errors import Conflict, InvalidInput
from brain.workspace import TaskWorkspace


SOURCE = {
    'id': 'FND-00009', 'title': 'Nova regression', 'risk': 'HIGH', 'ownerId': 'alice',
    'repositoryUrl': 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git',
    'baseCommit': 'a' * 40, 'sourcePath': 'src/main/java/demo/CatalogService.java',
    'revision': '2', 'description': 'Task source snapshot',
}


class TaskStoreContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)

    def test_claim_is_global_immutable_and_does_not_allocate_resources(self):
        item = self.store.claim_task('alice', SOURCE, '2', 'claim-a')
        replay = self.store.claim_task('alice', dict(SOURCE, title='changed'), 'wrong', 'claim-b')
        self.assertEqual(item['workItemId'], replay['workItemId'])
        self.assertEqual(item['sourceRecord'], SOURCE)
        self.assertIsNone(item['sandboxId'])
        self.assertIsNone(item['sessionId'])
        self.assertEqual(item['sessionIds'], [])
        self.assertEqual(item['workflow']['phase'], 'CLAIMED')
        with self.assertRaises(Conflict):
            self.store.claim_task('bob', SOURCE, '2', 'claim-c')

    def test_claim_checks_revision_for_a_new_source(self):
        with self.assertRaises(Conflict):
            self.store.claim_task('alice', SOURCE, '1', 'claim-a')

    def test_claim_accepts_integer_revision_when_expected_revision_is_integer(self):
        source = dict(SOURCE, revision=2)
        item = self.store.claim_task('alice', source, 2, 'claim-a')
        self.assertEqual(item['sourceRecord']['revision'], 2)

    def test_task_sessions_are_roles_and_workflow_uses_cas(self):
        item = self.store.claim_task('alice', SOURCE, '2', 'claim-a')
        item = self.store.bind_session('alice', item['workItemId'], 'plan-1', 'PLAN', item['version'], 'bind-plan')
        item = self.store.bind_session('alice', item['workItemId'], 'code-1', 'CODE', item['version'], 'bind-code')
        snap = self.store.snapshot('alice', item['workItemId'])
        self.assertEqual(snap['sessions'], [{'sessionId': 'plan-1', 'role': 'PLAN'}, {'sessionId': 'code-1', 'role': 'CODE'}])
        self.assertEqual(snap['workItem']['sessionId'], 'code-1')
        updated = self.store.update_workflow('alice', item['workItemId'], item['version'], {'phase': 'PLANNING'}, 'PLANNING', None, 'wf-1')
        self.assertEqual(updated['workflow']['phase'], 'PLANNING')
        with self.assertRaises(Conflict):
            self.store.update_workflow('alice', item['workItemId'], item['version'], {'phase': 'CODING'}, 'CODING', None, 'wf-2')

    def test_task_cannot_queue_execution_until_workspace_bound(self):
        item = self.store.claim_task('alice', SOURCE, '2', 'claim-a')
        with self.assertRaises(Conflict):
            self.store.submit('alice', item['workItemId'], {'expectedVersion': item['version'], 'command': 'true'}, 'run')

    def test_preparation_intent_is_durable_and_replay_does_not_reallocate(self):
        item = self.store.claim_task('alice', SOURCE, '2', 'claim-a')
        prepared, acquired = self.store.begin_prepare('alice', item['workItemId'], item['version'])
        self.assertTrue(acquired)
        self.assertEqual(prepared['workspaceProvision']['state'], 'PREPARING')
        replay, acquired_again = Store(self.temp.name).begin_prepare('alice', item['workItemId'], item['version'])
        self.assertFalse(acquired_again)
        self.assertEqual(replay['workspaceProvision']['label'], prepared['workspaceProvision']['label'])
        self.assertEqual(replay['version'], prepared['version'])

    def test_active_preparation_reentry_returns_intent_before_registry_reconciliation(self):
        work_id = 'work-abc123'
        current = {'workItemId': work_id, 'workspaceProvision': {'state': 'PREPARING', 'label': 'task-abc123'}}
        class FakeStore:
            def begin_prepare(self, *_):
                return current, False
            def set_provision_state(self, *args):
                raise AssertionError('active preparation must not be marked UNKNOWN')
        class FakeRegistry:
            def list_owned(self, owner):
                return [{'workspace_id': 'task-abc123', 'sandbox_id': 'sb-x'}]
        class WorkspaceUnderTest(TaskWorkspace):
            def _ready(self, *_):
                return False
        workspace = WorkspaceUnderTest(FakeStore(), SimpleNamespace(broker=SimpleNamespace(registry=FakeRegistry())))
        workspace._active.add(work_id)
        self.assertIs(workspace.prepare('alice', work_id, 1), current)

    def test_failed_preparation_can_be_retried_after_the_cause_is_cleared(self):
        item = self.store.claim_task('alice', SOURCE, '2', 'claim-a')
        prepared, acquired = self.store.begin_prepare('alice', item['workItemId'], item['version'])
        self.assertTrue(acquired)
        failed = self.store.finish_prepare('alice', item['workItemId'], error='Sandbox concurrency quota exhausted')
        self.assertEqual(failed['workspaceProvision']['state'], 'FAILED')
        retry, acquired_again = Store(self.temp.name).begin_prepare('alice', item['workItemId'], failed['version'])
        self.assertTrue(acquired_again)
        self.assertEqual(retry['workspaceProvision']['state'], 'PREPARING')
        self.assertNotIn('error', retry['workspaceProvision'])

    def test_prepare_retry_ignores_dead_sandbox_rows_from_the_failed_attempt(self):
        from unittest.mock import patch
        item = self.store.claim_task('alice', SOURCE, '2', 'claim-a')
        prepared, _ = self.store.begin_prepare('alice', item['workItemId'], item['version'])
        label = prepared['workspaceProvision']['label']
        failed = self.store.finish_prepare('alice', item['workItemId'], error='docker failed')
        dead = {'workspace_id': label, 'sandbox_id': 'sb-dead', 'state': 'failed'}
        created = []
        class FakeRegistry:
            def list_owned(self, owner):
                return [dead]
            def get(self, owner, sandbox_id):
                return {'workspace_path': '/tmp/ws', 'container_name': 'c-' + sandbox_id}
        class FakeBroker:
            registry = FakeRegistry()
            def create(self, owner, workspace, source):
                created.append((owner, workspace))
                return {'sandbox_id': 'sb-new'}
            def execute_capture(self, owner, sandbox_id, argv, timeout=None):
                if argv[:2] == ['git', 'rev-parse'] and argv[-1] == 'HEAD':
                    return {'stdout': SOURCE['baseCommit'] + '\n', 'stderr': '', 'exitCode': 0}
                return {'stdout': '', 'stderr': '', 'exitCode': 0}
        workspace = TaskWorkspace(self.store, SimpleNamespace(broker=FakeBroker()))
        workspace._ready = lambda *args: True
        with patch('brain.workspace.subprocess.run', return_value=SimpleNamespace(returncode=0)):
            result = workspace.prepare('alice', item['workItemId'], failed['version'])
        self.assertEqual(created, [('alice', label)])
        self.assertEqual(result['sandboxId'], 'sb-new')

    def test_session_cannot_be_claimed_by_another_work_item(self):
        a = self.store.claim_task('alice', SOURCE, '2', 'claim-a')
        other_source = dict(SOURCE, id='FND-00010')
        b = self.store.claim_task('alice', other_source, '2', 'claim-b')
        self.store.bind_session('alice', a['workItemId'], 'shared', 'PLAN', a['version'], 'bind-a')
        with self.assertRaises(Conflict):
            self.store.bind_session('alice', b['workItemId'], 'shared', 'PLAN', b['version'], 'bind-b')


if __name__ == '__main__':
    unittest.main()
