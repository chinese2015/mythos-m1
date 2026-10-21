import copy
import json
from pathlib import Path
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import tempfile

from brain.publication import delivery_id, publication_branch
from brain.task_spec import make_task_spec
from live_generic_intake import assess_work, loopback_origin, ReadClient, ProbeError, console_client


class GenericEvidenceProbeTests(unittest.TestCase):
    def fixtures(self, command=False):
        fixture = json.loads((Path(__file__).parent / 'fixtures/generic-task-spec.json').read_text())
        config = copy.deepcopy(fixture['repositoryConfig']); config['changePolicy']['allowTestChanges'] = True
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
                'base': {'ref': 'main', 'repo': {'full_name': config['fullName']}}, 'body': '<!-- mythos-delivery:' + identity + ' -->'}
        return work, op, git, [pull]

    def test_actual_four_test_two_file_customer_evidence_and_cleanup_pass(self):
        work, op, git, pulls = self.fixtures()
        result = assess_work(work, op, git, pulls, 'alice', registry={op['runtime']['sandboxId']: 'stopped'}, operations=[op])
        self.assertEqual(result['status'], 'PASSED')
        self.assertTrue(all(check['status'] == 'PASS' for check in result['checks']))

    def test_missing_or_wrong_gates_never_claim_a_pass(self):
        for change in ['missing-verify', 'wrong-owner', 'wrong-approval', 'dirty', 'three-tests', 'one-file', 'duplicate-pr', 'wrong-head', 'wrong-branch', 'no-pr', 'no-cleanup']:
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
            elif change == 'wrong-branch': work['workflow']['delivery']['headBranch'] = 'mythos/other'; pulls[0]['head']['ref'] = 'mythos/other'
            elif change == 'no-pr': pulls = []
            elif change == 'no-cleanup': registry = None
            with self.subTest(change=change):
                result = assess_work(work, op, git, pulls, owner, registry=registry, operations=[op] if op else [])
                self.assertEqual(result['status'], 'NOT_READY')
                self.assertTrue(any(check['status'] != 'PASS' for check in result['checks']))

    def test_command_evidence_requires_explicit_junit_null_and_real_exit_zero(self):
        work, op, git, pulls = self.fixtures(command=True); registry = {op['runtime']['sandboxId']: 'stopped'}
        self.assertEqual(assess_work(work, op, git, pulls, 'alice', registry=registry, operations=[op] if op else [])['status'], 'PASSED')
        op['evidence']['junit'] = {'tests': 0}
        self.assertEqual(assess_work(work, op, git, pulls, 'alice', registry=registry, operations=[op] if op else [])['status'], 'NOT_READY')

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
