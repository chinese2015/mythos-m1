import base64
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from brain import container_runner
from brain.errors import InvalidInput
from brain.executor import DockerExecutor, validate_registered_repository
from brain.git_host import GitHostClient
from brain.store import Store
from brain.task_spec import make_task_spec
from brain.worker import Worker
from sandbox import SandboxBroker, validate_clone_target


def repository_config(evidence=None, change_policy=None):
    return {'displayName': 'Demo Customer API', 'connectionId': 'local-gitea',
            'fullName': 'demo/demo-customer-api', 'defaultBranch': 'main',
            'runtimeProfile': 'java17-maven-offline-v1',
            'execution': {'baselineCommand': 'mvn -q test', 'verificationCommand': 'mvn -q verify',
                          'baselineMode': 'record', 'timeoutSeconds': 300,
                          'evidence': evidence or {'format': 'junit', 'reportDirs': ['target/surefire-reports'],
                                                   'minTests': 1, 'allowSkipped': False}},
            'changePolicy': change_policy or {'allowedPaths': ['src/'], 'allowTestChanges': False, 'maxFiles': 100}}


def command_evidence():
    return {'format': 'command', 'reportDirs': [], 'minTests': 0, 'allowSkipped': False}


def manual_input(repo, **extra):
    value = {'repositoryId': repo['repositoryId'], 'repositoryRevision': repo['revision'],
             'title': 'Add customer endpoint', 'description': 'Add the endpoint', 'acceptanceCriteria': 'It works'}
    value.update(extra)
    return value


_CALLS = itertools.count()


def make_manual_work(store, owner='alice', config=None, input_extra=None, base_commit='a' * 40):
    suffix = next(_CALLS)
    repo = store.register_repository(owner, config or repository_config(), 'register-%s-%d' % (owner, suffix))
    spec_input = manual_input(repo, **(input_extra or {}))
    spec = make_task_spec(owner, repo, spec_input, base_commit)
    work = store.create_manual_task(owner, spec_input, spec, 'task-%s-%d' % (owner, suffix))
    return repo, spec, store.get_work_item(owner, work['workItemId'])


def write_credentials(path):
    path.write_text(json.dumps({'username': 'argon-agent', 'password': 'p' * 24}))
    path.chmod(0o600)
    return path


class CredentialHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.secret = write_credentials(Path(self.temp.name) / 'argon-agent.json')
        self.url = 'http://127.0.0.1:3000/demo/demo-customer-api.git'
        self.helper = Path(__file__).resolve().parent.parent / 'brain' / 'git_credentials.py'

    def answer(self, stdin_text, credential_file=None, url=None, operation='get'):
        return subprocess.run([sys.executable, str(self.helper), str(credential_file or self.secret),
                               url or self.url, operation],
                              input=stdin_text, capture_output=True, text=True, timeout=10)

    def test_helper_prints_credentials_only_for_the_exact_approved_url(self):
        request = 'protocol=http\nhost=127.0.0.1:3000\npath=demo/demo-customer-api.git\n'
        result = self.answer(request)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, 'username=argon-agent\npassword=' + 'p' * 24 + '\n')

    def test_helper_answers_nothing_and_leaks_nothing_for_unknown_targets(self):
        for request in ['protocol=http\nhost=127.0.0.1:3000\npath=demo/other.git\n',
                        'protocol=http\nhost=example.com:3000\npath=demo/demo-customer-api.git\n',
                        'protocol=https\nhost=127.0.0.1:3000\npath=demo/demo-customer-api.git\n',
                        'protocol=http\nhost=127.0.0.1:3000\n',
                        'not a credential request\n']:
            with self.subTest(request=request):
                result = self.answer(request)
                self.assertEqual((result.returncode, result.stdout), (0, ''))
                self.assertNotIn('p' * 24, result.stderr)

    def test_helper_never_runs_without_exact_arguments_or_get(self):
        request = 'protocol=http\nhost=127.0.0.1:3000\npath=demo/demo-customer-api.git\n'
        result = self.answer(request, operation='store')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('p' * 24, result.stdout + result.stderr)
        bare = subprocess.run([sys.executable, str(self.helper)], capture_output=True, text=True, timeout=10)
        self.assertEqual(bare.returncode, 0)
        self.assertNotIn('p' * 24, bare.stdout + bare.stderr)

    def test_helper_fails_closed_for_unsafe_credential_files(self):
        request = 'protocol=http\nhost=127.0.0.1:3000\npath=demo/demo-customer-api.git\n'
        world_readable = Path(self.temp.name) / 'loose.json'
        world_readable.write_text(json.dumps({'username': 'argon-agent', 'password': 'p' * 24}))
        world_readable.chmod(0o644)
        self.assertEqual(self.answer(request, credential_file=world_readable).stdout, '')
        link = Path(self.temp.name) / 'linked.json'
        link.symlink_to(self.secret)
        self.assertEqual(self.answer(request, credential_file=link).stdout, '')


class TaskAwareValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)

    def test_registered_repository_passes_and_legacy_allowlist_is_kept(self):
        make_manual_work(self.store)
        registered = 'http://127.0.0.1:3000/demo/demo-customer-api.git'
        self.assertEqual(validate_registered_repository(self.store, 'alice', registered), registered)
        legacy = 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git'
        self.assertEqual(validate_registered_repository(self.store, 'alice', legacy), legacy)
        with self.assertRaises(InvalidInput):
            validate_registered_repository(None, 'alice', registered)

    def test_unregistered_wrong_owner_and_malicious_urls_are_rejected(self):
        make_manual_work(self.store)
        registered = 'http://127.0.0.1:3000/demo/demo-customer-api.git'
        for url in ['http://127.0.0.1:3000/demo/other-api.git',
                    'http://127.0.0.1:3000/intruder/demo-customer-api.git',
                    'http://user:secret@127.0.0.1:3000/demo/demo-customer-api.git',
                    registered + '?x=1',
                    'http://127.0.0.1:3000/demo/../secrets.git',
                    'https://127.0.0.1:3000/demo/demo-customer-api.git',
                    'http://127.0.0.1:3001/demo/demo-customer-api.git',
                    'file:///home/hx/private',
                    '/home/hx/gitea/secrets/argon-agent.json']:
            with self.subTest(url=url):
                with self.assertRaises(InvalidInput):
                    validate_registered_repository(self.store, 'alice', url)
        with self.assertRaises(InvalidInput):
            validate_registered_repository(self.store, 'bob', registered)


class SandboxCloneTargetTests(unittest.TestCase):
    def test_clone_target_accepts_exact_scoped_context(self):
        url = 'http://127.0.0.1:3000/demo/demo-customer-api.git'
        context = {'url': url, 'credentialFile': '/private/argon-agent.json'}
        self.assertEqual(validate_clone_target(url, 'main', context), (url, 'main', context))

    def test_clone_target_rejects_unsafe_branch_url_and_context(self):
        url = 'http://127.0.0.1:3000/demo/demo-customer-api.git'
        context = {'url': url, 'credentialFile': '/private/argon-agent.json'}
        for branch in ['../escape', '-unsafe', 'a..b', 'x@{y}', 'with space']:
            with self.assertRaises(InvalidInput):
                validate_clone_target(url, branch, context)
        for bad_url in ['http://user:secret@127.0.0.1:3000/demo/demo-customer-api.git',
                        'http://127.0.0.1:3000/demo/demo-customer-api.git/../x.git',
                        'file:///etc']:
            with self.assertRaises(InvalidInput):
                validate_clone_target(bad_url, 'main', {'url': bad_url, 'credentialFile': '/private/x.json'})
        with self.assertRaises(InvalidInput):
            validate_clone_target(url, 'main', {'url': url + '.git', 'credentialFile': '/private/x.json'})
        with self.assertRaises(InvalidInput):
            validate_clone_target(url, 'main', {'url': url, 'credentialFile': '/private/x.json', 'extra': 1})
        with self.assertRaises(InvalidInput):
            validate_clone_target(url, 'main', {'url': url})

    def test_broker_create_keeps_legacy_three_argument_contract(self):
        import inspect
        parameters = inspect.signature(SandboxBroker.create).parameters
        self.assertEqual(list(parameters)[:3], ['self', 'owner', 'workspace'])
        self.assertEqual(parameters['source'].default, None)
        self.assertEqual(parameters['branch'].kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertEqual(parameters['branch'].default, 'main')
        self.assertEqual(parameters['git_context'].kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertEqual(parameters['git_context'].default, None)


class VerifierContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        self.broker = SandboxBroker(Path(self.temp.name) / 'sandboxes')
        self.secret = write_credentials(Path(self.temp.name) / 'argon-agent.json')
        self.repo, self.spec, self.work = make_manual_work(self.store)
        self.url = self.spec['repository']['cloneUrl']

    def executor(self, with_store=True):
        host = GitHostClient(self.secret)
        return DockerExecutor(self.broker, self.store if with_store else None, host)

    def test_manual_verifier_uses_frozen_branch_and_scoped_git_context(self):
        executor = self.executor()
        origin, branch, context = executor._verifier_context(
            {'ownerId': 'alice', 'workItemId': self.work['workItemId']}, self.url)
        self.assertEqual((origin, branch), (self.url, 'main'))
        self.assertEqual(context['url'], self.url)
        self.assertEqual(context['credentialFile'], str(self.secret.absolute()))

    def test_unregistered_remote_is_rejected_before_any_verifier_io(self):
        executor = self.executor()
        with self.assertRaises(InvalidInput):
            executor._verifier_context(
                {'ownerId': 'alice', 'workItemId': self.work['workItemId']},
                'http://127.0.0.1:3000/demo/unregistered-api.git')

    def test_unregistered_remote_is_rejected_before_the_credential_file_is_opened(self):
        missing = Path(self.temp.name) / 'missing' / 'argon-agent.json'
        executor = DockerExecutor(self.broker, self.store, GitHostClient(missing))
        with self.assertRaises(InvalidInput) as raised:
            executor._verifier_context(
                {'ownerId': 'alice', 'workItemId': self.work['workItemId']},
                'http://127.0.0.1:3000/demo/unregistered-api.git')
        self.assertIn('frozen task repository', str(raised.exception))

    def test_legacy_operation_keeps_demo_allowlist_and_default_branch(self):
        executor = self.executor(with_store=False)
        legacy = 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git'
        self.assertEqual(executor._verifier_context({'ownerId': 'alice', 'workItemId': 'work-x'}, legacy),
                         (legacy, 'main', None))
        with self.assertRaises(InvalidInput):
            executor._verifier_context({'ownerId': 'alice', 'workItemId': 'work-x'}, self.url)


class ProcessExecutor:
    """Real detached supervisors, replacing only the unavailable Docker boundary."""
    def __init__(self, root, workspace, store=None):
        self.root = root
        self.workspace = workspace
        self.store = store
        self.processes = []
        self.fresh = False

    def prepare(self, operation):
        runtime = {'sandboxId': operation['sandboxId'], 'workspace': str(self.workspace)}
        if self.fresh:
            runtime.update(sandboxId='sb-fresh-b', freshTargetAbsent=True)
        return runtime

    def start(self, operation):
        spec = {'root': str(self.root), 'operationId': operation['operationId'],
                'workspace': str(self.workspace), 'command': operation['command'],
                'timeoutSeconds': operation['timeoutSeconds'], 'uid': os.getuid(), 'gid': os.getgid(),
                'sourceCommit': operation['sourceCommit']}
        payload = base64.b64encode(json.dumps(spec).encode()).decode()
        self.processes.append(subprocess.Popen([sys.executable, '-m', 'brain.container_runner', 'run', payload]))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if (self.root / operation['operationId'] / 'meta.json').exists():
                return
            time.sleep(.01)
        raise RuntimeError('No supervisor')

    def poll(self, operation):
        return container_runner.snapshot(self.root, operation['operationId'], operation['logOffsets'])

    def cancel(self, operation):
        return container_runner.request_cancel(self.root, operation['operationId'])

    def cleanup(self, operation):
        return {'status': 'done'}

    def close(self):
        for path in self.root.glob('exec-*'):
            container_runner.request_cancel(self.root, path.name)
        for process in self.processes:
            process.wait(timeout=3)


class WorkerPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root / 'store')
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.workspace)], check=True)
        subprocess.run(['git', '-C', str(self.workspace), 'config', 'user.name', 'Test'], check=True)
        subprocess.run(['git', '-C', str(self.workspace), 'config', 'user.email', 'test@example.invalid'], check=True)
        subprocess.run(['git', '-C', str(self.workspace), 'commit', '-q', '--allow-empty', '-m', 'base'], check=True)
        self.base = subprocess.check_output(['git', '-C', str(self.workspace), 'rev-parse', 'HEAD'],
                                            text=True).strip()

    def make_work(self, evidence=None, input_extra=None, config=None):
        _, spec, work = make_manual_work(self.store,
                                         config=config or repository_config(evidence=evidence),
                                         input_extra=input_extra, base_commit=self.base)
        return self.store.finish_prepare('alice', work['workItemId'], 'sb-a')

    def run_worker(self, work, command, kind, fresh=False, timeout=300, run='run'):
        executor = ProcessExecutor(self.root / ('runs-' + run), self.workspace, store=self.store)
        executor.fresh = fresh
        self.addCleanup(executor.close)
        worker = Worker(self.store, executor)
        version = self.store.get_work_item('alice', work['workItemId'])['version']
        body = {'command': command, 'kind': kind, 'timeoutSeconds': timeout, 'expectedVersion': version}
        if kind == 'VERIFY':
            body['sourceCommit'] = self.base
        op = self.store.submit('alice', work['workItemId'], body, 'submit-' + run)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            worker.tick()
            result = self.store.operation('alice', op['operationId'])
            if result['state'] in {'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'}:
                return result
            time.sleep(.02)
        self.fail('Operation did not finish')

    def reports(self, count, skipped=0):
        cases = ''.join('<testcase classname="demo.T" name="t%d"/>' % i for i in range(count - skipped))
        cases += '<testcase classname="demo.T" name="skip"><skipped/></testcase>' * skipped
        return ("mkdir -p target/surefire-reports; printf '%s' '" +
                '<testsuite tests="%d" failures="0" errors="0" skipped="%d">' % (count, skipped) + cases +
                '</testsuite>' + "' > target/surefire-reports/TEST-demo.xml")

    def test_command_mode_success_has_null_junit_and_command_validation(self):
        work = self.make_work(evidence=command_evidence())
        result = self.run_worker(work, 'true', 'UNIT_TEST', run='cmd-ok')
        self.assertEqual((result['state'], result['exitCode']), ('SUCCEEDED', 0))
        self.assertIsNone(result['evidence']['junit'])
        self.assertEqual(result['evidence']['validation'], {'format': 'command', 'exitCode': 0})

    def test_command_mode_nonzero_exit_fails_without_fabricated_counts(self):
        work = self.make_work(evidence=command_evidence())
        result = self.run_worker(work, 'make build; exit 3', 'UNIT_TEST', run='cmd-fail')
        self.assertEqual((result['state'], result['exitCode']), ('FAILED', 3))
        self.assertIsNone(result['evidence']['junit'])
        self.assertEqual(result['evidence']['validation'], {'format': 'command', 'exitCode': 3})

    def test_junit_mode_requires_configured_minimum_count(self):
        policy = {'format': 'junit', 'reportDirs': ['target/surefire-reports'], 'minTests': 3, 'allowSkipped': False}
        passed = self.run_worker(self.make_work(evidence=policy), self.reports(3), 'UNIT_TEST', run='min-ok')
        self.assertEqual(passed['state'], 'SUCCEEDED')
        self.assertEqual(passed['evidence']['junit']['tests'], 3)
        failed = self.run_worker(self.make_work(evidence=policy), self.reports(2), 'UNIT_TEST', run='min-fail')
        self.assertEqual(failed['state'], 'FAILED')

    def test_junit_mode_rejects_skipped_when_policy_forbids_them(self):
        policy = {'format': 'junit', 'reportDirs': ['target/surefire-reports'], 'minTests': 1, 'allowSkipped': False}
        work = self.make_work(evidence=policy)
        result = self.run_worker(work, self.reports(2, skipped=1), 'UNIT_TEST', run='skip')
        self.assertEqual(result['state'], 'FAILED')

    def verify_command(self):
        return ("mkdir -p target/surefire-reports; printf '<testsuite tests=\"1\" failures=\"0\" "
                "errors=\"0\" skipped=\"0\"/>' > target/surefire-reports/TEST-demo.xml")

    def verify_work(self):
        config = repository_config()
        config['execution']['verificationCommand'] = self.verify_command()
        return self.make_work(config=config)

    def test_manual_verify_rejects_a_runtime_that_is_not_a_fresh_independent_b(self):
        work = self.verify_work()
        result = self.run_worker(work, self.verify_command(), 'VERIFY', fresh=False, run='stale-b')
        self.assertEqual(result['state'], 'FAILED')

    def test_manual_verify_succeeds_only_from_a_fresh_independent_b(self):
        work = self.verify_work()
        result = self.run_worker(work, self.verify_command(), 'VERIFY', fresh=True, run='fresh-b')
        self.assertEqual(result['state'], 'SUCCEEDED')

    def test_submit_gate_requires_frozen_command_and_timeout_for_manual_verify(self):
        work = self.make_work()
        version = self.store.get_work_item('alice', work['workItemId'])['version']
        for body in [{'command': 'mvn test', 'kind': 'VERIFY', 'timeoutSeconds': 300},
                     {'command': 'mvn -q verify', 'kind': 'VERIFY', 'timeoutSeconds': 301}]:
            with self.subTest(body=body):
                with self.assertRaises(InvalidInput):
                    self.store.submit('alice', work['workItemId'],
                                      dict(body, expectedVersion=version,
                                           sourceCommit='a' * 40), 'gate-' + body['command'])
        ok = self.store.submit('alice', work['workItemId'],
                               {'command': 'mvn -q verify', 'kind': 'VERIFY', 'timeoutSeconds': 300,
                                'expectedVersion': version, 'sourceCommit': 'a' * 40}, 'gate-ok')
        self.assertEqual(ok['kind'], 'VERIFY')

    def test_model_passed_task_spec_is_ignored_and_frozen_spec_still_gates(self):
        work = self.make_work()
        version = self.store.get_work_item('alice', work['workItemId'])['version']
        forged = json.loads(json.dumps(work['taskSpec']))
        forged['execution']['verificationCommand'] = 'mvn test'
        with self.assertRaises(InvalidInput):
            self.store.submit('alice', work['workItemId'],
                              {'command': 'mvn test', 'kind': 'VERIFY', 'timeoutSeconds': 300,
                               'expectedVersion': version, 'taskSpec': forged}, 'forged')

    def test_repository_revision_does_not_change_existing_task_execution(self):
        repo, spec, work = make_manual_work(self.store, config=repository_config())
        work = self.store.finish_prepare('alice', work['workItemId'], 'sb-a')
        changed = repository_config()
        changed['execution']['verificationCommand'] = 'mvn -q clean verify'
        self.store.revise_repository('alice', repo['repositoryId'],
                                     {'expectedRevision': repo['revision'], 'config': changed}, 'revise')
        version = self.store.get_work_item('alice', work['workItemId'])['version']
        with self.assertRaises(InvalidInput):
            self.store.submit('alice', work['workItemId'],
                              {'command': 'mvn -q clean verify', 'kind': 'VERIFY', 'timeoutSeconds': 300,
                               'expectedVersion': version, 'sourceCommit': 'a' * 40}, 'new-command')
        op = self.store.submit('alice', work['workItemId'],
                               {'command': 'mvn -q verify', 'kind': 'VERIFY', 'timeoutSeconds': 300,
                                'expectedVersion': version, 'sourceCommit': 'a' * 40}, 'frozen-command')
        self.assertEqual(op['command'], 'mvn -q verify')


class FrozenReportDirTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()

    def report(self, directory, name, tests=1):
        folder = self.workspace / directory
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text('<testsuite tests="%d" failures="0" errors="0" skipped="0"/>' % tests)
        return folder

    def test_frozen_directories_are_captured_and_default_is_preserved(self):
        self.report('target/surefire-reports', 'TEST-default.xml')
        self.report('build/test-results', 'TEST-frozen.xml', tests=2)
        frozen = container_runner.capture_reports(str(self.workspace), ['build/test-results'])
        self.assertEqual([r['path'] for r in frozen], ['build/test-results/TEST-frozen.xml'])
        self.assertEqual(frozen[0]['xml'].count('tests="2"'), 1)
        default = container_runner.capture_reports(str(self.workspace))
        self.assertEqual([r['path'] for r in default], ['target/surefire-reports/TEST-default.xml'])

    def test_clear_reports_supports_frozen_directories_and_keeps_default(self):
        self.report('target/surefire-reports', 'TEST-default.xml')
        self.report('build/test-results', 'TEST-frozen.xml')
        container_runner.clear_reports(str(self.workspace), ['build/test-results'])
        self.assertFalse((self.workspace / 'build/test-results/TEST-frozen.xml').exists())
        self.assertTrue((self.workspace / 'target/surefire-reports/TEST-default.xml').exists())
        container_runner.clear_reports(str(self.workspace))
        self.assertFalse((self.workspace / 'target/surefire-reports/TEST-default.xml').exists())

    def test_report_count_cap_and_escape_protection_apply_to_frozen_directories(self):
        folder = self.workspace / 'limit/reports'
        folder.mkdir(parents=True)
        for i in range(9):
            (folder / ('TEST-%d.xml' % i)).write_text('<testsuite tests="1" failures="0" errors="0" skipped="0"/>')
        reports = container_runner.capture_reports(str(self.workspace), ['limit/reports'])
        self.assertEqual(len([r for r in reports if 'error' not in r]), 8)
        self.assertIn('exceeds', [r.get('error', '') for r in reports if r['path'] == '*'][0])
        with self.assertRaises(ValueError):
            container_runner.capture_reports(str(self.workspace), ['../outside'])
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'TEST-out.xml').write_text('<testsuite tests="1" failures="0" errors="0" skipped="0"/>')
        link = self.workspace / 'limit/link'
        link.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            container_runner.capture_reports(str(self.workspace), ['limit/link'])
        with self.assertRaises(ValueError):
            container_runner.clear_reports(str(self.workspace), ['limit/../escape'])


if __name__ == '__main__':
    unittest.main()
