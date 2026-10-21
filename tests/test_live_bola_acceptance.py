"""Pure and fake-client tests for the read-only BOLA acceptance receipt."""
import copy
import hashlib
import importlib
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
try:
    probe = importlib.import_module('live_bola_acceptance')
    import_error = None
except Exception as error:  # Keep the initial TDD red as an assertion, not an import failure.
    probe = None
    import_error = type(error).__name__ + ': ' + str(error)


WORK_ID = 'work-' + 'a' * 32
BASE = '43e06161b97113cecc9282e67c7a634dc825e310'
CANDIDATE = 'c' * 40
REPOSITORY_URL = 'http://127.0.0.1:3000/demo/demo-tenant-invoice-api.git'
SOURCE_PATH = 'src/main/java/com/example/invoice/InvoiceController.java'
SESSION = 'session-bola-demo'


def fixture():
    baseline_id = 'exec-' + 'b' * 32
    verify_id = 'exec-' + 'c' * 32
    delivery_id = hashlib.sha256(f'{WORK_ID}:{CANDIDATE}:{verify_id}'.encode()).hexdigest()
    branch = 'mythos/fnd-00016-' + 'a' * 8 + '-' + CANDIDATE[:12]
    delivery = {'id': delivery_id, 'repository': 'demo/demo-tenant-invoice-api', 'repositoryUrl': REPOSITORY_URL,
                'candidateCommit': CANDIDATE, 'verificationOperationId': verify_id, 'headBranch': branch,
                'baseBranch': 'main', 'pullNumber': 1, 'step': 'PR_OPEN', 'lastError': None, 'nextAttemptAt': None}
    work = {'workItemId': WORK_ID, 'ownerId': 'alice', 'version': 50, 'status': 'PASSED', 'sandboxId': 'sb-source',
            'sessionIds': [SESSION],
            'source': {'id': 'FND-00016', 'type': 'FINDING'},
            'sourceRecord': {'id': 'FND-00016', 'title': "Invoice endpoint exposes another tenant's invoice by ID",
                             'ownerId': 'owner-aster-01', 'repositoryUrl': REPOSITORY_URL, 'baseCommit': BASE,
                             'sourcePath': SOURCE_PATH, 'lineRange': '51-54'},
            'workflow': {'phase': 'PR_OPEN', 'baselineOperationId': baseline_id,
                         'verificationOperationId': verify_id, 'candidateCommit': CANDIDATE,
                         'delivery': delivery}}
    finding = {'id': 'FND-00016', 'name': work['sourceRecord']['title'], 'ownerId': 'owner-aster-01',
               'category': 'CWE-284', 'risk': 'CRITICAL', 'repositoryId': 'REPO-demo-tenant-invoice-api',
               'repositoryUrl': REPOSITORY_URL, 'baseCommit': BASE, 'sourcePath': SOURCE_PATH,
               'lineRange': '51-54', 'status': 'In Progress', 'closed': 'Open', 'workItemId': WORK_ID,
               'remediationJobId': WORK_ID, 'revision': 3}
    baseline = {'operationId': baseline_id, 'workItemId': WORK_ID, 'ownerId': 'alice', 'sandboxId': 'sb-source',
                'kind': 'UNIT_TEST', 'command': 'mvn -B -o -s .cache/settings.xml test',
                'state': 'FAILED', 'exitCode': 1, 'reason': None, 'sourceCommit': BASE,
                'evidence': {'sourceCommit': BASE, 'expectedSourceCommit': BASE, 'sourceDirty': False,
                             'command': 'mvn -B -o -s .cache/settings.xml test', 'kind': 'UNIT_TEST',
                             'sandboxId': 'sb-source', 'exitCode': 1,
                             'junit': {'reports': [{'path': 'target/surefire-reports/TEST-com.example.invoice.InvoiceControllerTest.xml'}],
                                       'invalidReports': [], 'tests': 2, 'failures': 1, 'errors': 0, 'skipped': 0,
                                       'failedTests': ['crossTenantInvoiceReadIsHidden']}}}
    verification = {'operationId': verify_id, 'workItemId': WORK_ID, 'ownerId': 'alice', 'sandboxId': 'sb-source',
                    'kind': 'VERIFY', 'command': 'mvn -B -o -s .cache/settings.xml clean verify',
                    'state': 'SUCCEEDED', 'exitCode': 0, 'reason': None, 'sourceCommit': CANDIDATE,
                    'runtime': {'sandboxId': 'sb-fresh', 'freshTargetAbsent': True, 'cleanup': {'status': 'done'}},
                    'evidence': {'sourceCommit': CANDIDATE, 'sourceDirty': False,
                                 'command': 'mvn -B -o -s .cache/settings.xml clean verify',
                                 'sandboxId': 'sb-fresh', 'exitCode': 0,
                                 'junit': {'reports': [{'path': 'target/surefire-reports/TEST-com.example.invoice.InvoiceControllerTest.xml'}],
                                           'invalidReports': [], 'tests': 2, 'failures': 0, 'errors': 0, 'skipped': 0}}}
    git = {'baseCommit': BASE, 'headCommit': CANDIDATE, 'status': '', 'diffTruncated': False,
           'changedFiles': [SOURCE_PATH], 'testsChanged': []}
    pull = {'number': 1, 'html_url': 'http://127.0.0.1:3000/demo/demo-tenant-invoice-api/pulls/1',
            'state': 'open', 'merged': False,
            'head': {'sha': CANDIDATE, 'ref': branch, 'repo': {'full_name': 'demo/demo-tenant-invoice-api'}},
            'base': {'ref': 'main', 'repo': {'full_name': 'demo/demo-tenant-invoice-api'}},
            'body': f'Fix BOLA.\n<!-- mythos-delivery:{delivery_id} -->'}
    browser = {'workItemId': WORK_ID, 'version': 50, 'phase': 'PR_OPEN', 'sessionId': SESSION,
               'entryLinkObserved': True, 'entryUrl': f'http://127.0.0.1:3080/?mythosVibeTask={WORK_ID}&mythosSession={SESSION}&mythosEmbedded=1',
               'filePaneReadOnly': True, 'files': [SOURCE_PATH], 'sourcePath': SOURCE_PATH,
               'diffBaseCommit': BASE, 'diffHeadCommit': CANDIDATE, 'diffChangedFiles': [SOURCE_PATH],
               'runMonitorVisible': True}
    restart = {'before': {'workItemId': WORK_ID, 'sessionIds': [SESSION], 'operationIds': [baseline_id], 'mockPid': 100},
               'after': {'workItemId': WORK_ID, 'sessionIds': [SESSION], 'operationIds': [baseline_id, verify_id], 'mockPid': 200}}
    expected = {'findingId': 'FND-00016', 'findingTitle': work['sourceRecord']['title'], 'ownerId': 'owner-aster-01',
                'repositoryId': 'REPO-demo-tenant-invoice-api', 'repositoryUrl': REPOSITORY_URL,
                'baseCommit': BASE, 'sourcePath': SOURCE_PATH, 'lineRange': '51-54',
                'baselineCommand': 'mvn -B -o -s .cache/settings.xml test',
                'verificationCommand': 'mvn -B -o -s .cache/settings.xml clean verify',
                'baselineTest': 'crossTenantInvoiceReadIsHidden', 'restartIdentity': restart,
                'browserReceipt': browser, 'browserOrigin': 'http://127.0.0.1:3080'}
    return {'work': work, 'finding': finding, 'baseline': baseline, 'verification': verification,
            'git': git, 'pull': pull, 'expected': expected}


class FakeApi:
    def __init__(self, data):
        self.data = data
        self.calls = []

    def get_finding(self, finding_id):
        self.calls.append(('finding', finding_id))
        return copy.deepcopy(self.data['finding'])

    def get(self, path):
        self.calls.append(('GET', path))
        work = self.data['work']; wf = work['workflow']
        if path == '/api/brain/work-items/' + WORK_ID:
            return {'workItem': copy.deepcopy(work), 'operations': [copy.deepcopy(self.data['baseline']), copy.deepcopy(self.data['verification'])]}
        if path == '/api/brain/work-items/' + WORK_ID + '/workspace':
            return {'git': copy.deepcopy(self.data['git'])}
        if path == '/api/brain/operations/' + wf['baselineOperationId']:
            return copy.deepcopy(self.data['baseline'])
        if path == '/api/brain/operations/' + wf['verificationOperationId']:
            return copy.deepcopy(self.data['verification'])
        raise AssertionError('unexpected GET path: ' + path)


class FakeConsole:
    def __init__(self, work): self.work = work
    def get(self, path): return {'workItem': copy.deepcopy(self.work)}


class FakeForge:
    def __init__(self, pulls): self.rows = pulls
    def pulls(self, repository, delivery): return copy.deepcopy(self.rows)


class BolaAcceptanceTests(unittest.TestCase):
    def require_probe(self):
        self.assertIsNotNone(probe, f'BOLA acceptance module is missing or failed to import: {import_error}')
        return probe

    def capture(self, data=None):
        data = data or fixture()
        return self.require_probe().capture_bola_acceptance(
            'alice', WORK_ID, FakeApi(data), FakeConsole(data['work']), FakeForge([data['pull']]), data['expected'])

    def test_valid_exact_source_baseline_single_file_fresh_verify_and_open_pr_pass(self):
        result = self.capture()
        self.assertEqual(result['status'], 'PASSED')
        checks = {row['name']: row['status'] for row in result['checks']}
        self.assertTrue({'findingBinding', 'expectedBaselineFailure', 'singleSourceCandidate',
                         'freshIndependentVerification', 'exactOpenPull', 'browserEntry',
                         'restartIdentityContinuity'} <= set(checks))
        self.assertEqual(result['workItemId'], WORK_ID)

    def test_finding_binding_or_baseline_failure_mismatch_fails_closed(self):
        data = fixture(); data['finding']['sourcePath'] = 'src/other.java'
        self.assertEqual(self.capture(data)['status'], 'NOT_READY')
        data = fixture(); data['baseline']['evidence']['junit']['failedTests'] = ['sameTenantAdminAndAnonymousAccessRemainCorrect']
        self.assertEqual(self.capture(data)['status'], 'NOT_READY')

    def test_dirty_or_multi_file_candidate_and_nonfresh_verify_fail_closed(self):
        data = fixture(); data['git']['changedFiles'] = [SOURCE_PATH, 'pom.xml']
        self.assertEqual(self.capture(data)['status'], 'NOT_READY')
        data = fixture(); data['verification']['runtime']['freshTargetAbsent'] = False
        self.assertEqual(self.capture(data)['status'], 'NOT_READY')

    def test_closed_or_wrong_head_pull_fails_closed(self):
        data = fixture(); data['pull']['state'] = 'closed'
        self.assertEqual(self.capture(data)['status'], 'NOT_READY')
        data = fixture(); data['pull']['head']['sha'] = 'd' * 40
        self.assertEqual(self.capture(data)['status'], 'NOT_READY')

    def test_browser_version_or_path_mismatch_fails_closed(self):
        self.require_probe()
        data = fixture(); receipt = copy.deepcopy(data['expected']['browserReceipt'])
        example = json.loads((ROOT / 'tests/fixtures/bola-browser-receipt.example.json').read_text())
        self.assertEqual(self.require_probe().assess_bola_browser_entry(example, data['work'], data['expected']['browserOrigin'])['status'], 'PASS')
        receipt['version'] = data['work']['version'] + 1
        self.assertEqual(self.require_probe().assess_bola_browser_entry(receipt, data['work'], data['expected']['browserOrigin'])['status'], 'NOT_READY')
        receipt = copy.deepcopy(data['expected']['browserReceipt']); receipt['sourcePath'] = 'src/other.java'
        self.assertEqual(self.require_probe().assess_bola_browser_entry(receipt, data['work'], data['expected']['browserOrigin'])['status'], 'NOT_READY')

    def test_missing_restart_identity_cannot_produce_pass(self):
        data = fixture(); data['expected']['restartIdentity'] = None
        self.assertEqual(self.capture(data)['status'], 'NOT_READY')

    def test_receipt_writer_uses_private_mode_and_never_overwrites(self):
        module = self.require_probe()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'artifacts' / 'bola.json'
            module._write_private_json(output, {'status': 'PASSED'})
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(json.loads(output.read_text()), {'status': 'PASSED'})
            with self.assertRaises(FileExistsError):
                module._write_private_json(output, {'status': 'NOT_READY'})


if __name__ == '__main__':
    unittest.main()
