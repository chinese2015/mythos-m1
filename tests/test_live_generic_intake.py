import copy
import json
from pathlib import Path
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import tempfile

from brain.publication import delivery_id, publication_branch
from brain.task_spec import make_task_spec
from live_generic_intake import assess_work, baseline_evidence_ready, loopback_origin, ReadClient, ProbeError, console_client
import live_generic_intake as live_probe


class GenericEvidenceProbeTests(unittest.TestCase):
    def fixtures(self, command=False, min_tests=None):
        fixture = json.loads((Path(__file__).parent / 'fixtures/generic-task-spec.json').read_text())
        config = copy.deepcopy(fixture['repositoryConfig']); config['changePolicy']['allowTestChanges'] = True
        if min_tests is not None: config['execution']['evidence']['minTests'] = min_tests
        if command:
            config['execution']['evidence'] = {'format': 'command', 'reportDirs': [], 'minTests': 0, 'allowSkipped': False}
        repo = {'repositoryId': fixture['manualInput']['repositoryId'], 'ownerId': 'alice', 'revision': 1, 'enabled': True, 'config': config}
        spec = make_task_spec('alice', repo, {**fixture['manualInput'], 'allowTestChanges': True}, 'a' * 40)
        op = copy.deepcopy(fixture['verificationCases'][0]['operation']); op.update(operationId='exec-' + 'b' * 32, ownerId='alice', workItemId='work-' + 'a' * 32)
        op['runtime']['cleanup'] = {'status': 'done'}
        evidence = copy.deepcopy(fixture['verificationCases'][0]['evidence']); evidence['junit']['tests'] = 4
        if command: evidence.update(junit=None, validation={'format': 'command', 'exitCode': 0})
        op['evidence'] = evidence
        wid = 'work-' + 'a' * 32; source = {'type': 'MANUAL', 'id': 'TASK-abcdef123456', 'revision': 1}
        branch = publication_branch(source['id'], wid, 'b' * 40); identity = delivery_id(wid, 'b' * 40, op['operationId'])
        work = {'workItemId': wid, 'ownerId': 'alice', 'version': 20, 'source': source, 'taskSpec': spec, 'sandboxId': op['sandboxId'],
                'sourceRecord': {'id': source['id'], 'ownerId': 'alice', 'repositoryUrl': spec['repository']['cloneUrl'], 'baseCommit': 'a' * 40},
                'workflow': {'phase': 'PR_OPEN', 'candidateCommit': 'b' * 40, 'verificationOperationId': op['operationId'],
                             'approval': {'specDigest': spec['specDigest']}, 'delivery': {'id': identity, 'headBranch': branch, 'baseBranch': 'main',
                             'repository': config['fullName'], 'repositoryUrl': spec['repository']['cloneUrl'], 'candidateCommit': 'b' * 40,
                             'verificationOperationId': op['operationId'], 'pullNumber': 1, 'step': 'PR_OPEN'}}}
        git = {'baseCommit': 'a' * 40, 'headCommit': 'b' * 40, 'status': '', 'diffTruncated': False,
               'changedFiles': ['src/main/A.java', 'src/test/ATest.java'], 'testsChanged': ['src/test/ATest.java']}
        pull = {'number': 1, 'state': 'open', 'merged': False, 'html_url': 'http://127.0.0.1:3000/' + config['fullName'] + '/pulls/1',
                'head': {'sha': 'b' * 40, 'ref': branch, 'repo': {'full_name': config['fullName']}},
                'base': {'ref': 'main', 'repo': {'full_name': config['fullName']}}, 'body': '<!-- argon-delivery:' + identity + ' -->'}
        return work, op, git, [pull]

    def test_actual_four_test_two_file_customer_evidence_and_cleanup_pass(self):
        work, op, git, pulls = self.fixtures()
        result = assess_work(work, op, git, pulls, 'alice', registry={op['runtime']['sandboxId']: 'stopped'}, operations=[op])
        self.assertEqual(result['status'], 'PASSED')
        self.assertTrue(all(check['status'] == 'PASS' for check in result['checks']))

    def test_missing_or_wrong_gates_never_claim_a_pass(self):
        for change in ['missing-verify', 'wrong-owner', 'wrong-approval', 'dirty', 'three-tests', 'one-file', 'duplicate-pr', 'wrong-head', 'wrong-branch', 'no-pr', 'no-cleanup', 'stale-delivery-error', 'pending-delivery-retry']:
            work, op, git, pulls = self.fixtures(); registry = {op['runtime']['sandboxId']: 'stopped'}
            owner = 'alice'
            if change == 'missing-verify': op = None
            elif change == 'wrong-owner': owner = 'bob'
            elif change == 'wrong-approval': work['workflow']['approval']['specDigest'] = '0' * 64
            elif change == 'dirty': git['status'] = ' M src/main/A.java'
            elif change == 'three-tests': op['evidence']['junit']['tests'] = 3
            elif change == 'one-file': git['changedFiles'] = ['src/main/A.java']; git['testsChanged'] = []
            elif change == 'duplicate-pr': pulls.append(copy.deepcopy(pulls[0]))
            elif change == 'wrong-head': pulls[0]['head']['sha'] = 'c' * 40
            elif change == 'wrong-branch': work['workflow']['delivery']['headBranch'] = 'argon/other'; pulls[0]['head']['ref'] = 'argon/other'
            elif change == 'no-pr': pulls = []
            elif change == 'no-cleanup': registry = None
            elif change == 'stale-delivery-error': work['workflow']['delivery']['lastError'] = 'repository denied'
            elif change == 'pending-delivery-retry': work['workflow']['delivery']['nextAttemptAt'] = '2026-10-18T00:00:00Z'
            with self.subTest(change=change):
                result = assess_work(work, op, git, pulls, owner, registry=registry, operations=[op] if op else [])
                self.assertEqual(result['status'], 'NOT_READY')
                self.assertTrue(any(check['status'] != 'PASS' for check in result['checks']))

    def test_command_evidence_requires_explicit_junit_null_and_real_exit_zero(self):
        work, op, git, pulls = self.fixtures(command=True); registry = {op['runtime']['sandboxId']: 'stopped'}
        self.assertEqual(assess_work(work, op, git, pulls, 'alice', registry=registry, operations=[op] if op else [])['status'], 'PASSED')
        op['evidence']['junit'] = {'tests': 0}
        self.assertEqual(assess_work(work, op, git, pulls, 'alice', registry=registry, operations=[op] if op else [])['status'], 'NOT_READY')

    def test_frozen_baseline_evidence_requires_bound_command_and_valid_junit(self):
        work, _, _, _ = self.fixtures(min_tests=4)
        work['workflow']['baselineOperationId'] = 'exec-' + 'c' * 32
        spec = work['taskSpec']
        baseline = {'operationId': work['workflow']['baselineOperationId'], 'workItemId': work['workItemId'],
                    'ownerId': 'alice', 'sandboxId': work['sandboxId'], 'kind': 'UNIT_TEST', 'state': 'FAILED',
                    'exitCode': 1, 'command': spec['execution']['baselineCommand'], 'timeoutSeconds': 60,
                    'sourceCommit': spec['baseCommit'], 'reason': None}
        baseline['evidence'] = {'sourceCommit': spec['baseCommit'], 'expectedSourceCommit': spec['baseCommit'],
                                'sourceDirty': False, 'command': baseline['command'], 'exitCode': 1,
                                'kind': 'UNIT_TEST', 'sandboxId': work['sandboxId'],
                                'junit': {'reports': [{'path': 'target/surefire-reports/TEST-baseline.xml'}],
                                          'invalidReports': [], 'tests': 3, 'failures': 1, 'errors': 0, 'skipped': 0}}
        self.assertTrue(baseline_evidence_ready(spec, work, baseline))
        for mutate in [
            lambda op: op.update(command='mvn -q verify'),
            lambda op: op.update(sourceCommit='d' * 40),
            lambda op: op.update(reason='preflight_or_supervisor_error'),
            lambda op: op['evidence'].update(junit={'reports': [], 'invalidReports': [], 'tests': 0, 'failures': 0, 'errors': 0, 'skipped': 0}),
            lambda op: op['evidence']['junit'].update(invalidReports=[{'path': 'TEST-broken.xml'}]),
            lambda op: op['evidence']['junit'].update(reports=[{'path': 'outside/TEST-pass.xml'}]),
        ]:
            probe = copy.deepcopy(baseline); mutate(probe)
            with self.subTest(probe=probe): self.assertFalse(baseline_evidence_ready(spec, work, probe))

    def test_live_receipt_cannot_pass_without_valid_baseline_observation(self):
        work, op, git, pulls = self.fixtures(min_tests=4)
        work['workflow']['baselineOperationId'] = 'exec-' + 'c' * 32
        baseline = {'operationId': work['workflow']['baselineOperationId'], 'workItemId': work['workItemId'],
                    'ownerId': 'alice', 'sandboxId': work['sandboxId'], 'kind': 'UNIT_TEST', 'state': 'FAILED',
                    'exitCode': 127, 'command': work['taskSpec']['execution']['baselineCommand'], 'timeoutSeconds': 60,
                    'sourceCommit': work['taskSpec']['baseCommit'], 'reason': None,
                    'evidence': {'sourceCommit': work['taskSpec']['baseCommit'], 'expectedSourceCommit': work['taskSpec']['baseCommit'],
                                 'sourceDirty': False, 'command': work['taskSpec']['execution']['baselineCommand'],
                                 'exitCode': 127, 'kind': 'UNIT_TEST', 'sandboxId': work['sandboxId'],
                                 'junit': {'reports': [], 'invalidReports': [], 'tests': 0, 'failures': 0, 'errors': 0, 'skipped': 0}}}
        self.assertFalse(baseline_evidence_ready(work['taskSpec'], work, baseline))

        baseline['evidence']['junit'] = {'reports': [{'path': 'target/surefire-reports/TEST-baseline.xml'}],
                                         'invalidReports': [], 'tests': 3, 'failures': 1, 'errors': 0, 'skipped': 0}
        baseline.update(state='FAILED', exitCode=1)
        baseline['evidence']['exitCode'] = 1

        class Brain:
            def get(self, path):
                if path.endswith('/operations/' + baseline['operationId']): return copy.deepcopy(baseline)
                if path.endswith('/operations/' + op['operationId']): return copy.deepcopy(op)
                if path.endswith('/workspace'): return {'git': copy.deepcopy(git)}
                if path.endswith('/repositories'): return {'repositories': []}
                if path.endswith('/work-items/' + work['workItemId']):
                    return {'workItem': copy.deepcopy(work), 'operations': [copy.deepcopy(op), copy.deepcopy(baseline)]}
                raise AssertionError(path)
        class Console:
            def get(self, path): return {'workItem': copy.deepcopy(work)}
        class Forge:
            def pulls(self, spec, delivery): return copy.deepcopy(pulls)

        registry = {op['runtime']['sandboxId']: 'stopped'}
        valid = live_probe.capture('alice', work['workItemId'], Brain(), Console(), Forge(), registry)
        baseline_check = next(check for check in valid['checks'] if check['name'] == 'frozenBaselineEvidence')
        self.assertEqual(baseline_check['status'], 'PASS')
        self.assertEqual(valid['status'], 'PASSED')

        baseline['evidence']['junit'] = {'reports': [], 'invalidReports': [], 'tests': 0,
                                         'failures': 0, 'errors': 0, 'skipped': 0}
        invalid = live_probe.capture('alice', work['workItemId'], Brain(), Console(), Forge(), registry)
        baseline_check = next(check for check in invalid['checks'] if check['name'] == 'frozenBaselineEvidence')
        self.assertEqual(baseline_check['status'], 'FAIL')
        self.assertEqual(invalid['status'], 'NOT_READY')

    def test_blocked_or_uncertain_work_and_foreign_verify_are_not_ready(self):
        for change in ['blocked', 'paused', 'coding', 'unknown', 'foreign-operation']:
            work, op, git, pulls = self.fixtures(); operations = [op]
            if change == 'blocked': work['blocked'] = True
            elif change == 'paused': work['paused'] = True
            elif change == 'coding': work['workflow']['phase'] = 'CODING'
            elif change == 'unknown': operations = [op, {'state': 'UNKNOWN'}]
            else: op['workItemId'] = 'work-' + 'c' * 32
            with self.subTest(change=change):
                result = assess_work(work, op, git, pulls, 'alice', registry={op['runtime']['sandboxId']: 'stopped'}, operations=operations)
                self.assertEqual(result['status'], 'NOT_READY')

    def test_read_client_uses_real_get_only_and_refuses_redirects(self):
        paths = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                paths.append((self.command, self.path))
                if self.path == '/redirect':
                    self.send_response(302); self.send_header('Location', '/must-not-follow'); self.end_headers(); return
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"readOnly":true}')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        client = ReadClient('http://127.0.0.1:' + str(server.server_port))
        self.assertEqual(client.get('/read'), {'readOnly': True})
        with self.assertRaises(ProbeError): client.get('/redirect')
        with self.assertRaises(ProbeError): client.get('//untrusted.invalid/write')
        self.assertEqual(paths, [('GET', '/read'), ('GET', '/redirect')])

    def test_private_console_login_uses_the_last_startup_token_after_restart(self):
        paths = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                paths.append(self.path)
                if self.path == '/?token=obsolete': self.send_response(403); self.end_headers(); return
                self.send_response(200)
                if self.path == '/?token=current': self.send_header('Set-Cookie', 'session=valid; Path=/')
                self.end_headers()
                self.wfile.write(json.dumps({'authenticated': self.headers.get('Cookie') == 'session=valid'}).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = 'http://127.0.0.1:' + str(server.server_port)
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'dsh.log'; log.write_text(origin + '/?token=obsolete\nrestart\n' + origin + '/?token=current\n'); log.chmod(0o600)
            client = console_client(origin, log)
            self.assertEqual(client.get('/read'), {'authenticated': True})
        self.assertEqual(paths, ['/?token=current', '/read'])

    def test_probe_origins_reject_non_loopback_or_credential_bearing_targets(self):
        self.assertEqual(loopback_origin('http://127.0.0.1:3083'), 'http://127.0.0.1:3083')
        for url in ['https://127.0.0.1:3083', 'http://example.com:3083', 'http://user:secret@127.0.0.1:3083', 'http://@127.0.0.1:3083', 'http://127.0.0.1:3083/path', 'http://127.0.0.1:3083/?token=x']:
            with self.subTest(url=url), self.assertRaises(ValueError): loopback_origin(url)

    def test_restart_receipt_requires_stable_work_identity_and_replaced_live_services(self):
        assess = getattr(live_probe, 'assess_restart_continuity', None)
        self.assertTrue(callable(assess), 'restart continuity validator is missing')
        old = {'workItemId': 'work-' + 'a' * 32, 'phase': 'PR_OPEN', 'sourceType': 'MANUAL',
               'taskId': 'TASK-abcdef123456', 'specDigest': 'b' * 64, 'candidate': 'c' * 40,
               'deliveryId': 'd' * 64, 'verificationOperationId': 'exec-' + 'e' * 32,
               'operations': ['exec-' + 'e' * 32], 'sessionIds': ['session-original']}
        before = {'isolatedBranchCommit': 'f' * 40, 'works': [old],
                  'services': {'api': 100, 'worker': 200, 'dsh': 300},
                  'runningProcesses': {'api': True, 'worker': True, 'dsh': True}}
        after_work = copy.deepcopy(old)
        services = {name: {'beforePid': pid, 'afterPid': pid + 100, 'beforeAlive': False, 'afterAlive': True}
                    for name, pid in before['services'].items()}

        result = assess(before, [after_work], services)
        self.assertEqual('PASS', result['status'])

        changed = copy.deepcopy(after_work)
        changed['sessionIds'].append('session-duplicate')
        self.assertEqual('NOT_READY', assess(before, [changed], services)['status'])
        self.assertEqual('NOT_READY', assess(before, [after_work], {**services, 'worker': {
            **services['worker'], 'beforeAlive': True}})['status'])
        self.assertEqual('NOT_READY', assess(before, [after_work], {**services, 'dsh': {
            **services['dsh'], 'afterAlive': False}})['status'])

    def test_legacy_receipt_requires_before_after_and_current_work_and_pr_equality(self):
        assess = getattr(live_probe, 'assess_legacy_retention', None)
        self.assertTrue(callable(assess), 'legacy retention validator is missing')
        works = [
            {'source': 'FND-00003', 'phase': 'PR_OPEN', 'workItemId': 'work-' + '1' * 32},
            {'source': 'FND-00009', 'phase': 'PR_OPEN', 'workItemId': 'work-' + '2' * 32},
            {'source': 'FND-00015', 'phase': 'PR_OPEN', 'workItemId': 'work-' + '3' * 32},
        ]
        pulls = [
            {'repo': 'demo-orion-notes-api', 'number': 2, 'state': 'open', 'merged': False, 'head': '4' * 40},
            {'repo': 'demo-nova-catalog-api', 'number': 2, 'state': 'open', 'merged': False, 'head': '5' * 40},
            {'repo': 'demo-pixel-reports-batch', 'number': 2, 'state': 'open', 'merged': False, 'head': '6' * 40},
        ]
        before = {'legacyWorks': works, 'legacyPRs': pulls}
        after = {'legacyWorkItems': copy.deepcopy(works), 'legacyPRs': copy.deepcopy(pulls),
                 'identicalToPreDeploymentSnapshot': True, 'mainApiPort': 3081, 'mainDshPort': 3080}

        self.assertEqual('PASS', assess(before, after, works, pulls)['status'])
        changed_pull = copy.deepcopy(pulls)
        changed_pull[0]['head'] = '7' * 40
        self.assertEqual('NOT_READY', assess(before, after, works, changed_pull)['status'])
        changed_work = copy.deepcopy(works)
        changed_work[0]['phase'] = 'BLOCKED'
        self.assertEqual('NOT_READY', assess(before, after, changed_work, pulls)['status'])
        changed_snapshot = copy.deepcopy(after)
        changed_snapshot['legacyWorkItems'][0]['phase'] = 'BLOCKED'
        self.assertEqual('NOT_READY', assess(before, changed_snapshot, works, pulls)['status'])

    def test_browser_receipt_must_bind_the_visible_readonly_workbench_to_the_task_snapshot(self):
        assess = getattr(live_probe, 'assess_browser_entry', None)
        self.assertTrue(callable(assess), 'browser entry validator is missing')
        work_id = 'work-' + 'a' * 32; session_id = 'session-current'
        paths = ['src/main/java/com/example/customer/CustomerSearchService.java',
                 'src/test/java/com/example/customer/CustomerSearchServiceTest.java']
        work = {'workItemId': work_id, 'version': 2537, 'phase': 'PR_OPEN', 'status': 'PASSED',
                'taskSpec': {'baseCommit': 'b' * 40, 'specDigest': 'd' * 64}, 'candidateCommit': 'c' * 40,
                'git': {'changedFiles': paths}, 'restartIdentity': {'sessionIds': [session_id]}}
        receipt = {'filePaneReadOnly': True, 'entryLinkObserved': True, 'runMonitorVisible': True,
                   'entryUrl': 'http://127.0.0.1:3093/?argonVibeTask=' + work_id + '&argonSession=' + session_id + '&argonEmbedded=1',
                   'workItemId': work_id, 'version': 2537, 'phase': 'PR_OPEN', 'sourcePath': paths[0],
                   'taskSpecDigest': 'd' * 64,
                   'files': paths, 'diffBaseCommit': 'b' * 40, 'diffHeadCommit': 'c' * 40,
                   'diffChangedFiles': paths}
        self.assertEqual('PASS', assess(receipt, [work])['status'])
        wrong_session = copy.deepcopy(receipt); wrong_session['entryUrl'] = wrong_session['entryUrl'].replace(session_id, 'session-other')
        self.assertEqual('NOT_READY', assess(wrong_session, [work])['status'])
        wrong_head = copy.deepcopy(receipt); wrong_head['diffHeadCommit'] = 'd' * 40
        self.assertEqual('NOT_READY', assess(wrong_head, [work])['status'])
        lagging_version = copy.deepcopy(receipt); lagging_version['version'] = 2536
        self.assertEqual('PASS', assess(lagging_version, [work])['status'])
        future_version = copy.deepcopy(receipt); future_version['version'] = 2538
        self.assertEqual('NOT_READY', assess(future_version, [work])['status'])
        wrong_digest = copy.deepcopy(receipt); wrong_digest['taskSpecDigest'] = 'e' * 64
        self.assertEqual('NOT_READY', assess(wrong_digest, [work])['status'])
