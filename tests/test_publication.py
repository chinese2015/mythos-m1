import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest

from brain.errors import Conflict, NotFound
from brain.publication import delivery_id, publication_branch, GitPublisher
from brain.store import Store


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        self.source = {
            'id': 'FND-00009', 'title': 'Nova', 'risk': 'HIGH', 'ownerId': 'alice',
            'repositoryUrl': 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git',
            'baseCommit': 'a' * 40, 'sourcePath': 'src/main/java/demo/CatalogService.java', 'revision': '2'}
        self.work = self.store.claim_task('alice', self.source, '2', 'claim')

    def test_delivery_identity_and_branch_are_derived_from_stable_inputs(self):
        commit, verify = 'b' * 40, 'exec-1234567890abcdef'
        expected = hashlib.sha256(f"{self.work['workItemId']}:{commit}:{verify}".encode()).hexdigest()
        self.assertEqual(delivery_id(self.work['workItemId'], commit, verify), expected)
        self.assertEqual(publication_branch(self.source['id'], self.work['workItemId'], commit),
                         f"mythos/{self.source['id'].lower()}-{self.work['workItemId'].split('-')[-1][:8]}-{commit[:12]}")

    def test_rejects_delivery_id_that_does_not_match_durable_intent(self):
        candidate, verify = 'b' * 40, 'exec-1234567890abcdef'
        branch = publication_branch(self.source['id'], self.work['workItemId'], candidate)
        intent = {'id': 'wrong', 'candidateCommit': candidate, 'verificationOperationId': verify,
                  'headBranch': branch, 'repositoryUrl': self.source['repositoryUrl'],
                  'step': 'PUSH_PENDING', 'policy': {}}
        self.store.update_workflow('alice', self.work['workItemId'], self.work['version'],
                                   {'phase': 'PUBLISHING', 'delivery': intent}, 'PUBLISHING', key='intent')
        executor = type('ExecutorStub', (), {'broker': object()})()
        with self.assertRaises(Conflict):
            GitPublisher(self.store, executor).publish('alice', self.work['workItemId'], '0' * 64, 'request-1',
                                                       self.store.get_work_item('alice', self.work['workItemId'])['version'])

    def test_private_bare_staging_imports_exact_bundle_commit_without_checkout(self):
        publisher = object.__new__(GitPublisher)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            bare = root / 'staging.git'
            bundle = root / 'candidate.bundle'

            def git(*args):
                subprocess.run(['git', *args], check=True, capture_output=True)

            git('init', str(source))
            git('-C', str(source), 'config', 'user.name', 'Test')
            git('-C', str(source), 'config', 'user.email', 'test@example.invalid')
            (source / 'source.txt').write_text('verified candidate')
            git('-C', str(source), 'add', 'source.txt')
            git('-C', str(source), 'commit', '-m', 'candidate')
            candidate = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
            git('-C', str(source), 'bundle', 'create', str(bundle), 'HEAD')
            publisher._git(root, ['init', '--bare', str(bare)])
            publisher._git(bare, ['fetch', '--no-tags', str(bundle), 'HEAD'])
            self.assertEqual(publisher._git(bare, ['rev-parse', 'FETCH_HEAD']).strip(), candidate)
            self.assertFalse((bare / 'source.txt').exists())

    def test_workflow_stage_set_accepts_publication_lifecycle_values(self):
        for stage in ['PUBLISHING', 'PR_OPEN', 'CLOSING', 'COMPLETED']:
            with self.subTest(stage=stage):
                work = self.store.get_work_item('alice', self.work['workItemId'])
                result = self.store.update_workflow('alice', work['workItemId'], work['version'],
                                                    {'phase': stage}, stage, key='stage-' + stage)
                self.assertEqual(result['stage'], stage)

    def test_rejects_verification_with_skipped_tests_before_any_git_publication_io(self):
        source = dict(self.source)
        work = self.store.claim_task('alice', source, '2', 'claim-complete')
        work = self.store.finish_prepare('alice', work['workItemId'], 'source-sandbox')
        candidate = 'b' * 40
        work = self.store.update_workflow('alice', work['workItemId'], work['version'],
                                          {'phase': 'AWAITING_REVIEW', 'candidateCommit': candidate,
                                           'approval': {'actor': 'alice'}}, 'AWAITING_REVIEW', key='ready')
        op = self.store.submit('alice', work['workItemId'],
                               {'expectedVersion': work['version'], 'kind': 'VERIFY',
                                'command': 'mvn verify', 'sourceCommit': candidate}, 'verify')
        self.store.claim_next()
        self.store.record_runtime(op['operationId'], {'sandboxId': 'verify-sandbox', 'freshTargetAbsent': True})
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0, evidence={
            'kind': 'VERIFY', 'sandboxId': 'verify-sandbox', 'sourceCommit': candidate, 'sourceDirty': False,
            'junit': {'reports': [{'path': 'TEST-Nova.xml'}], 'invalidReports': [], 'tests': 2,
                      'failures': 0, 'errors': 0, 'skipped': 1, 'failedTests': []}})
        current = self.store.get_work_item('alice', work['workItemId'])
        verify_id = op['operationId']
        intent_id = delivery_id(work['workItemId'], candidate, verify_id)
        branch = publication_branch(source['id'], work['workItemId'], candidate)
        workflow = dict(current['workflow'], phase='PUBLISHING', delivery={
            'id': intent_id, 'candidateCommit': candidate, 'verificationOperationId': verify_id,
            'headBranch': branch, 'repositoryUrl': source['repositoryUrl'], 'step': 'PUSH_PENDING', 'policy': {}})
        current = self.store.update_workflow('alice', work['workItemId'], current['version'],
                                             workflow, 'PUBLISHING', key='intent-complete')
        publisher = GitPublisher(self.store, type('ExecutorStub', (), {'broker': object()})())
        with self.assertRaises(Conflict):
            publisher.publish('alice', work['workItemId'], intent_id, 'publish', current['version'])

    def test_finding_owner_is_distinct_from_authenticated_operator_and_ref_reconciles(self):
        source = dict(self.source, id='FND-NOVA-OWNER', ownerId='owner-nova-01')
        work = self.store.claim_task('alice', source, '2', 'claim-owner-separated')
        work = self.store.finish_prepare('alice', work['workItemId'], 'source-sandbox')
        candidate = 'b' * 40
        work = self.store.update_workflow('alice', work['workItemId'], work['version'],
                                          {'phase': 'AWAITING_REVIEW', 'candidateCommit': candidate,
                                           'approval': {'actor': 'alice'}}, 'AWAITING_REVIEW', key='owner-ready')
        op = self.store.submit('alice', work['workItemId'],
                               {'expectedVersion': work['version'], 'kind': 'VERIFY',
                                'command': 'mvn verify', 'sourceCommit': candidate}, 'owner-verify')
        self.store.claim_next()
        self.store.record_runtime(op['operationId'],
                                  {'sandboxId': 'verify-sandbox', 'freshTargetAbsent': True})
        junit = {'reports': [{'path': 'TEST-Nova.xml'}], 'invalidReports': [], 'tests': 2,
                 'failures': 0, 'errors': 0, 'skipped': 0, 'failedTests': []}
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0, evidence={
            'kind': 'VERIFY', 'sandboxId': 'verify-sandbox', 'sourceCommit': candidate,
            'sourceDirty': False, 'exitCode': 0, 'junit': junit})
        current = self.store.get_work_item('alice', work['workItemId'])
        intent_id = delivery_id(work['workItemId'], candidate, op['operationId'])
        branch = publication_branch(source['id'], work['workItemId'], candidate)
        current = self.store.update_workflow('alice', work['workItemId'], current['version'], {
            'phase': 'PUBLISHING', 'candidateCommit': candidate, 'approval': {'actor': 'alice'},
            'delivery': {'id': intent_id, 'candidateCommit': candidate,
                         'verificationOperationId': op['operationId'], 'headBranch': branch,
                         'repositoryUrl': source['repositoryUrl'], 'step': 'PUSH_PENDING', 'policy': {}}},
            'PUBLISHING', key='owner-publish-intent')

        class BrokerStub:
            def execute_capture(self, owner, sandbox_id, argv, timeout=None):
                if argv == ['git', 'remote', 'get-url', 'origin']:
                    return {'exitCode': 0, 'stdout': source['repositoryUrl']}
                if argv == ['git', 'merge-base', '--is-ancestor', source['baseCommit'], candidate]:
                    return {'exitCode': 0, 'stdout': ''}
                if argv == ['git', 'rev-parse', candidate + '^{tree}']:
                    return {'exitCode': 0, 'stdout': 'c' * 40}
                self.fail('Unexpected container command: ' + repr(argv))

        publisher = GitPublisher(self.store, type('ExecutorStub', (), {'broker': BrokerStub()})())
        publisher.workspace.evidence = lambda owner, work_id: {'git': {
            'headCommit': candidate, 'status': '', 'diffTruncated': False,
            'changedFiles': [source['sourcePath']], 'testsChanged': []}}
        publisher._remote_commit = lambda repository, head, item: candidate
        result = publisher.publish('alice', work['workItemId'], intent_id, 'publish-owner-separated', current['version'])
        self.assertEqual(result['remoteCommit'], candidate)
        self.assertEqual(result['candidateTree'], 'c' * 40)
        self.assertTrue(result['reconciled'])
        with self.assertRaises(NotFound):
            publisher.publish('owner-nova-01', work['workItemId'], intent_id,
                              'wrong-authenticated-owner', current['version'])


if __name__ == '__main__':
    unittest.main()
