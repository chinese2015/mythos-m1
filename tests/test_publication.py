import hashlib
import copy
from concurrent.futures import ThreadPoolExecutor
import threading
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch
import tempfile
import unittest

from brain.errors import Conflict, InvalidInput, NotFound
from brain.git_host import GitHostClient
from brain.publication import delivery_id, publication_branch, GitPublisher, CREDENTIAL_HELPER
from brain.git_credentials import helper_command
from brain.store import Store
from brain.task_spec import make_task_spec


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
                         f"argon/{self.source['id'].lower()}-{self.work['workItemId'].split('-')[-1][:8]}-{commit[:12]}")

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

    def test_first_push_cannot_fast_forward_a_ref_created_after_the_missing_ref_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';remote=root/'remote.git';source.mkdir()
            def git(*args):return subprocess.check_output(['git',*args],stderr=subprocess.DEVNULL,text=True).strip()
            git('init',str(source));git('-C',str(source),'config','user.name','Test');git('-C',str(source),'config','user.email','test@example.invalid')
            (source/'source.txt').write_text('base');git('-C',str(source),'add','.');git('-C',str(source),'commit','-m','base');base=git('-C',str(source),'rev-parse','HEAD')
            (source/'source.txt').write_text('candidate');git('-C',str(source),'commit','-am','candidate');candidate=git('-C',str(source),'rev-parse','HEAD');tree=git('-C',str(source),'rev-parse','HEAD^{tree}')
            git('init','--bare',str(remote));repository=self.source['repositoryUrl'];branch='argon/create-only-race'
            work={'workItemId':self.work['workItemId'],'version':1,'sandboxId':'source'};intent={'id':'a'*64}
            class RacePublisher(GitPublisher):
                def _validate_intent(inner,*_):return intent,candidate,'exec-'+'b'*32,branch,repository
                def _container_exec(inner,*_):return tree
                def _export_bundle(inner,*_):
                    bundle=root/'candidate.bundle';git('-C',str(source),'bundle','create',str(bundle),'HEAD');return bundle.read_bytes()
                def _git(inner,cwd,args,auth=False):return super()._git(cwd,[str(remote) if a==repository else a for a in args],auth=False)
                def _remote_commit(inner,repo,head,item):
                    if not getattr(inner,'raced',False):
                        inner.raced=True;git('-C',str(source),'push',str(remote),base+':refs/heads/'+branch);return None
                    return super()._remote_commit(repo,head,item)
            publisher=RacePublisher(type('Store',(),{'get_work_item':lambda *_:work})(),type('Executor',(),{'broker':object()})())
            with self.assertRaises(Conflict):publisher.publish('alice',work['workItemId'],intent['id'],'race',1)
            self.assertEqual(git('--git-dir='+str(remote),'rev-parse','refs/heads/'+branch),base)

    def test_legacy_remote_query_keeps_the_existing_helper_and_sanitized_git_environment(self):
        publisher = GitPublisher(self.store, type('ExecutorStub', (), {'broker': object()})())
        real_popen = subprocess.Popen; captured = []
        def transport(command, **kwargs):
            captured.append((command, kwargs))
            return real_popen([sys.executable, '-c', 'print(' + repr('b' * 40 + '\trefs/heads/argon/legacy') + ')'], **kwargs)
        with patch('brain.publication.subprocess.Popen', side_effect=transport):
            result = publisher._remote_commit(self.source['repositoryUrl'], 'argon/legacy', self.work)
        self.assertEqual(result, 'b' * 40)
        command, options = captured[0]
        self.assertIn('credential.helper=' + CREDENTIAL_HELPER, command)
        self.assertEqual(options['env']['GIT_CONFIG_NOSYSTEM'], '1')
        self.assertEqual(options['env']['GIT_CONFIG_GLOBAL'], __import__('os').devnull)
        self.assertEqual(options['env']['GIT_TERMINAL_PROMPT'], '0')
        self.assertIn('core.hooksPath=/dev/null', command)
        self.assertIn('http.followRedirects=false', command)

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


class ManualPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        self.candidate = 'b' * 40
        self.tree = 'c' * 40
        self.secret = Path(self.temp.name) / 'argon-agent.json'
        self.secret.write_text(json.dumps({'username': 'argon-agent', 'password': 'p' * 24}))
        self.secret.chmod(0o600)

    def make_work(self, evidence=None, input_extra=None, change_policy=None):
        config = {'displayName': 'Demo Customer API', 'connectionId': 'local-gitea',
                  'fullName': 'demo/demo-customer-api', 'defaultBranch': 'main',
                  'runtimeProfile': 'java17-maven-offline-v1',
                  'execution': {'baselineCommand': 'mvn -q test', 'verificationCommand': 'mvn -q verify',
                                'baselineMode': 'record', 'timeoutSeconds': 300,
                                'evidence': evidence or {'format': 'junit', 'reportDirs': ['target/surefire-reports'],
                                                         'minTests': 1, 'allowSkipped': False}},
                  'changePolicy': change_policy or {'allowedPaths': ['src/'], 'allowTestChanges': False, 'maxFiles': 100}}
        repo = self.store.register_repository('alice', config, 'register-manual')
        task_input = {'repositoryId': repo['repositoryId'], 'repositoryRevision': repo['revision'],
                      'title': 'Add customer endpoint', 'description': 'Add it', 'acceptanceCriteria': 'Works'}
        task_input.update(input_extra or {})
        spec = make_task_spec('alice', repo, task_input, 'a' * 40)
        work = self.store.create_manual_task('alice', task_input, spec, 'task-manual')
        return spec, self.store.finish_prepare('alice', work['workItemId'], 'sb-a')

    def verify_operation(self, work, command='mvn -q verify', sandbox='sb-fresh-b', command_mode=False,
                         source_commit=None):
        source_commit = source_commit or self.candidate
        version = self.store.get_work_item('alice', work['workItemId'])['version']
        op = self.store.submit('alice', work['workItemId'],
                               {'expectedVersion': version, 'kind': 'VERIFY', 'command': command,
                                'timeoutSeconds': 300, 'sourceCommit': source_commit}, 'verify-' + op_nonce())
        self.store.claim_next()
        self.store.record_runtime(op['operationId'], {'sandboxId': sandbox, 'freshTargetAbsent': True})
        evidence = {'kind': 'VERIFY', 'sandboxId': sandbox, 'sourceCommit': source_commit,
                    'sourceDirty': False, 'exitCode': 0}
        if not command_mode:
            evidence['junit'] = {'reports': [{'path': 'target/surefire-reports/TEST-demo.xml'}],
                                 'invalidReports': [], 'tests': 3, 'failures': 0, 'errors': 0,
                                 'skipped': 0, 'failedTests': []}
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0, evidence=evidence)
        return op['operationId']

    def ready(self, work, spec, verify_id, approval_digest=None, changed=None, tests_changed=None):
        current = self.store.get_work_item('alice', work['workItemId'])
        intent_id = delivery_id(work['workItemId'], self.candidate, verify_id)
        branch = publication_branch(work['source']['id'], work['workItemId'], self.candidate)
        approval = {'actor': 'alice'}
        if approval_digest is not None:
            approval['specDigest'] = approval_digest
        workflow = {'phase': 'PUBLISHING', 'candidateCommit': self.candidate, 'approval': approval,
                    'delivery': {'id': intent_id, 'candidateCommit': self.candidate,
                                 'verificationOperationId': verify_id, 'headBranch': branch,
                                 'repositoryUrl': spec['repository']['cloneUrl'],
                                 'step': 'PUSH_PENDING', 'policy': {}}}
        current = self.store.update_workflow('alice', work['workItemId'], current['version'],
                                             workflow, 'PUBLISHING', key='intent-' + op_nonce())
        publisher = GitPublisher(self.store, self.executor_stub(spec))
        publisher.workspace.evidence = lambda owner, work_id: {'git': {
            'headCommit': self.candidate, 'status': '', 'diffTruncated': False,
            'changedFiles': changed if changed is not None else ['src/main/java/demo/CustomerApi.java'],
            'testsChanged': tests_changed if tests_changed is not None else []}}
        publisher._remote_commit = lambda repository, head, item: self.candidate
        return publisher, intent_id, current['version']

    def executor_stub(self, spec):
        url = spec['repository']['cloneUrl']
        candidate, tree, base = self.candidate, self.tree, 'a' * 40

        class BrokerStub:
            def execute_capture(self, owner, sandbox_id, argv, timeout=None):
                if argv == ['git', 'remote', 'get-url', 'origin']:
                    return {'exitCode': 0, 'stdout': url}
                if argv == ['git', 'merge-base', '--is-ancestor', base, candidate]:
                    return {'exitCode': 0, 'stdout': ''}
                if argv == ['git', 'rev-parse', candidate + '^{tree}']:
                    return {'exitCode': 0, 'stdout': tree}
                raise AssertionError('Unexpected container command: ' + repr(argv))

        return type('ExecutorStub', (), {'broker': BrokerStub(),
                                         'host': GitHostClient(self.secret)})()

    def credential_transport(self, captured, created=None):
        # Replace only HTTP transport. Real git credential fill invokes the actual
        # configured helper; secrets are checked inside the child and never printed.
        real_popen = subprocess.Popen
        script = """import json, subprocess, sys
p = json.loads(sys.argv[1])
r = subprocess.run(p['prefix'] + ['credential', 'fill'], input=p['request'], capture_output=True, text=True)
credentials = dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)
if r.returncode or credentials.get('username') != 'argon-agent' or credentials.get('password') != 'p' * 24:
    raise SystemExit(23)
print(p['output'], end='')
"""
        def transport(command, **kwargs):
            operation = next((arg for arg in command if arg in {'ls-remote', 'push'}), None)
            if operation is None: return real_popen(command, **kwargs)
            captured.append((list(command), kwargs))
            index = command.index(operation); repository = next(arg for arg in command[index + 1:] if arg.startswith('http://'))
            path = repository.removeprefix('http://127.0.0.1:3000/')
            if operation == 'push':
                if created is not None: created[0] = True
                output = ''
            else:
                output = self.candidate + '\t' + command[-1] + '\n' if created is None or created[0] else ''
            payload = {'prefix': command[:index], 'request': 'protocol=http\nhost=127.0.0.1:3000\npath=' + path + '\n', 'output': output}
            return real_popen([sys.executable, '-c', script, json.dumps(payload)], **kwargs)
        return transport

    def test_manual_remote_query_uses_exact_target_helper_from_persisted_work(self):
        spec, work = self.make_work()
        publisher = GitPublisher(self.store, self.executor_stub(spec)); captured = []
        spoofed = dict(work, source={'type': 'ARGON'}, taskSpec={**spec, 'repository': {**spec['repository'], 'cloneUrl': 'http://attacker/'}})
        with patch('brain.publication.subprocess.Popen', side_effect=self.credential_transport(captured)):
            result = publisher._remote_commit(spec['repository']['cloneUrl'], 'argon/scoped-query', spoofed)
        self.assertEqual(result, self.candidate)
        command, options = captured[0]
        self.assertIn('credential.helper=' + helper_command(self.secret, spec['repository']['cloneUrl']), command)
        self.assertNotIn('credential.helper=' + CREDENTIAL_HELPER, command)
        self.assertIn('credential.useHttpPath=true', command)
        self.assertIn('http.followRedirects=false', command)
        self.assertNotIn('p' * 24, json.dumps(command) + json.dumps(options['env']))

    def test_parallel_manual_queries_keep_credentials_scoped_to_each_frozen_repository(self):
        spec, work = self.make_work()
        config = copy.deepcopy(self.store.repository('alice', spec['repository']['repositoryId'])['config'])
        config['fullName'] = 'demo/second-manual-api'
        repo = self.store.register_repository('alice', config, 'register-second-query')
        input = {'repositoryId': repo['repositoryId'], 'repositoryRevision': 1, 'title': 'Second', 'description': 'd', 'acceptanceCriteria': 'a'}
        second_spec = make_task_spec('alice', repo, input, 'a' * 40)
        second = self.store.create_manual_task('alice', input, second_spec, 'second-query-task')
        executor = self.executor_stub(spec); host = executor.host; barrier = threading.Barrier(2)
        class ConcurrentHost:
            def git_context(self, config):
                context = host.git_context(config); barrier.wait(timeout=5); return context
        executor.host = ConcurrentHost(); publisher = GitPublisher(self.store, executor); captured = []
        with patch('brain.publication.subprocess.Popen', side_effect=self.credential_transport(captured)):
            with ThreadPoolExecutor(max_workers=2) as pool:
                calls = [pool.submit(publisher._remote_commit, task['taskSpec']['repository']['cloneUrl'], 'argon/parallel', task) for task in [work, second]]
                self.assertEqual([call.result(timeout=10) for call in calls], [self.candidate, self.candidate])
        self.assertEqual(len(captured), 2)
        for command, _ in captured:
            url = next(arg for arg in command if arg.startswith('http://'))
            self.assertIn('credential.helper=' + helper_command(self.secret, url), command)

    def test_manual_remote_query_rejects_wrong_owner_and_legacy_url_mismatch_before_credentials(self):
        spec, work = self.make_work()
        executor = self.executor_stub(spec); executor.host = GitHostClient(Path(self.temp.name) / 'missing.json')
        publisher = GitPublisher(self.store, executor)
        with patch('brain.publication.subprocess.Popen', side_effect=AssertionError('Git must not start')):
            with self.assertRaises(NotFound):
                publisher._remote_commit(spec['repository']['cloneUrl'], 'argon/no-owner', dict(work, ownerId='bob'))
            with self.assertRaises(InvalidInput) as raised:
                publisher._remote_commit('http://127.0.0.1:3000/demo/demo-nova-catalog-api.git', 'argon/wrong-repo', work)
            self.assertIn('frozen task repository', str(raised.exception))

    def test_manual_publication_query_and_create_only_push_remain_frozen_after_revision_and_disable(self):
        source = Path(self.temp.name) / 'git-source'; source.mkdir()
        def git(*args): return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL, text=True).strip()
        git('init', str(source)); git('-C', str(source), 'config', 'user.name', 'Test'); git('-C', str(source), 'config', 'user.email', 'test@example.invalid')
        (source / 'candidate.txt').write_text('verified candidate')
        git('-C', str(source), 'add', '.'); git('-C', str(source), 'commit', '-m', 'candidate')
        self.candidate = git('-C', str(source), 'rev-parse', 'HEAD'); self.tree = git('-C', str(source), 'rev-parse', 'HEAD^{tree}')
        bundle = Path(self.temp.name) / 'candidate.bundle'; git('-C', str(source), 'bundle', 'create', str(bundle), 'HEAD')
        spec, work = self.make_work(); verify_id = self.verify_operation(work)
        publisher, intent, version = self.ready(work, spec, verify_id, approval_digest=spec['specDigest'])
        repo = self.store.repository('alice', spec['repository']['repositoryId']); changed = dict(repo['config'], fullName='demo/replacement-api', defaultBranch='replacement')
        self.store.revise_repository('alice', repo['repositoryId'], {'expectedRevision': 1, 'config': changed, 'enabled': False}, 'replace-before-publish')
        del publisher._remote_commit
        publisher._export_bundle = lambda *_: bundle.read_bytes()
        captured = []; created = [False]
        with patch('brain.publication.subprocess.Popen', side_effect=self.credential_transport(captured, created)):
            result = publisher.publish('alice', work['workItemId'], intent, 'publish-frozen-transport', version)
        self.assertEqual((result['remoteCommit'], result['candidateTree']), (self.candidate, self.tree))
        self.assertFalse(result['reconciled']); self.assertEqual(len(captured), 3)
        expected = 'credential.helper=' + helper_command(self.secret, spec['repository']['cloneUrl'])
        for command, _ in captured: self.assertIn(expected, command)
        push = next(command for command, _ in captured if 'push' in command)
        self.assertIn('--force-with-lease=refs/heads/' + result['branch'] + ':', push)
        self.assertIn(self.candidate + ':refs/heads/' + result['branch'], push)
        self.assertNotIn('replacement-api', json.dumps(captured))

    def test_manual_multi_file_candidate_publishes_from_frozen_repository(self):
        spec, work = self.make_work()
        verify_id = self.verify_operation(work)
        publisher, intent_id, version = self.ready(
            work, spec, verify_id, approval_digest=spec['specDigest'],
            changed=['src/main/java/demo/CustomerApi.java', 'src/main/java/demo/Store.java'])
        result = publisher.publish('alice', work['workItemId'], intent_id, 'publish-manual', version)
        self.assertEqual((result['remoteCommit'], result['candidateTree']), (self.candidate, self.tree))
        self.assertTrue(result['reconciled'])

    def test_manual_publication_requires_approval_spec_digest(self):
        spec, work = self.make_work()
        verify_id = self.verify_operation(work)
        publisher, intent_id, version = self.ready(work, spec, verify_id, approval_digest='0' * 64)
        with self.assertRaises(Conflict):
            publisher.publish('alice', work['workItemId'], intent_id, 'publish-digest', version)

    def test_manual_publication_rejects_verify_of_a_different_commit_than_the_candidate(self):
        spec, work = self.make_work()
        verify_id = self.verify_operation(work, source_commit='d' * 40)
        publisher, intent_id, version = self.ready(work, spec, verify_id, approval_digest=spec['specDigest'])
        with self.assertRaises(Conflict):
            publisher.publish('alice', work['workItemId'], intent_id, 'publish-wrong-commit', version)

    def test_manual_publication_rejects_verifier_that_is_not_a_fresh_independent_b(self):
        spec, work = self.make_work()
        verify_id = self.verify_operation(work, sandbox='sb-a')
        publisher, intent_id, version = self.ready(work, spec, verify_id, approval_digest=spec['specDigest'])
        with self.assertRaises(Conflict):
            publisher.publish('alice', work['workItemId'], intent_id, 'publish-stale-b', version)

    def test_manual_publication_rejects_tampered_verify_command(self):
        spec, work = self.make_work()
        op = self.store.submit('alice', work['workItemId'],
                               {'expectedVersion': self.store.get_work_item('alice', work['workItemId'])['version'],
                                'kind': 'VERIFY', 'command': 'mvn -q verify', 'timeoutSeconds': 300,
                                'sourceCommit': self.candidate}, 'verify-tamper')
        self.store.claim_next()
        self.store.record_runtime(op['operationId'], {'sandboxId': 'sb-fresh-b', 'freshTargetAbsent': True})
        self.store.finish(op['operationId'], 'SUCCEEDED', exit_code=0, evidence={
            'kind': 'VERIFY', 'sandboxId': 'sb-fresh-b', 'sourceCommit': self.candidate,
            'sourceDirty': False, 'exitCode': 0,
            'junit': {'reports': [{'path': 'target/surefire-reports/TEST-demo.xml'}], 'invalidReports': [],
                      'tests': 3, 'failures': 0, 'errors': 0, 'skipped': 0, 'failedTests': []}})
        with self.store.connection(True) as db:
            tampered = dict(self.store.operation('alice', op['operationId']), command='mvn test')
            db.execute('UPDATE operations SET data=? WHERE id=?',
                       (json.dumps(tampered, sort_keys=True), op['operationId']))
        publisher, intent_id, version = self.ready(work, spec, op['operationId'],
                                                   approval_digest=spec['specDigest'])
        with self.assertRaises(Conflict):
            publisher.publish('alice', work['workItemId'], intent_id, 'publish-tamper', version)

    def test_manual_publication_rejects_changes_outside_the_frozen_scope(self):
        spec, work = self.make_work()
        verify_id = self.verify_operation(work)
        publisher, intent_id, version = self.ready(work, spec, verify_id, approval_digest=spec['specDigest'],
                                                   changed=['src/main/java/demo/CustomerApi.java', 'README.md'])
        with self.assertRaises(Conflict):
            publisher.publish('alice', work['workItemId'], intent_id, 'publish-scope', version)

    def test_manual_publication_rejects_test_changes_without_permission(self):
        spec, work = self.make_work()
        verify_id = self.verify_operation(work)
        publisher, intent_id, version = self.ready(
            work, spec, verify_id, approval_digest=spec['specDigest'],
            changed=['src/main/java/demo/CustomerApi.java', 'src/test/java/demo/CustomerApiTest.java'])
        with self.assertRaises(Conflict):
            publisher.publish('alice', work['workItemId'], intent_id, 'publish-tests', version)

    def test_manual_publication_allows_approved_test_changes(self):
        policy = {'allowedPaths': ['src/'], 'allowTestChanges': True, 'maxFiles': 100}
        spec, work = self.make_work(change_policy=policy, input_extra={'allowTestChanges': True})
        verify_id = self.verify_operation(work)
        publisher, intent_id, version = self.ready(
            work, spec, verify_id, approval_digest=spec['specDigest'],
            changed=['src/main/java/demo/CustomerApi.java', 'src/test/java/demo/CustomerApiTest.java'])
        result = publisher.publish('alice', work['workItemId'], intent_id, 'publish-allowed-tests', version)
        self.assertEqual(result['remoteCommit'], self.candidate)

    def test_manual_command_mode_publishes_without_junit_reports(self):
        command_mode = {'format': 'command', 'reportDirs': [], 'minTests': 0, 'allowSkipped': False}
        spec, work = self.make_work(evidence=command_mode)
        verify_id = self.verify_operation(work, command_mode=True)
        publisher, intent_id, version = self.ready(work, spec, verify_id, approval_digest=spec['specDigest'])
        result = publisher.publish('alice', work['workItemId'], intent_id, 'publish-command', version)
        self.assertEqual(result['remoteCommit'], self.candidate)


_nonce = [0]


def op_nonce():
    _nonce[0] += 1
    return str(_nonce[0])


if __name__ == '__main__':
    unittest.main()
