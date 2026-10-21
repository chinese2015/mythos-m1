"""Read-only acceptance receipt for the FND-00016 tenant-invoice workflow."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.error
import urllib.parse


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from brain.git_host import GitHostClient  # noqa: E402
from brain.task_spec import relative_path  # noqa: E402
from live_generic_intake import ProbeError, ReadClient, console_client, loopback_origin, private_bytes, private_json  # noqa: E402


FINDING_ID = 'FND-00016'
FINDING_TITLE = "Invoice endpoint exposes another tenant's invoice by ID"
OWNER_ID = 'owner-aster-01'
REPOSITORY_ID = 'REPO-demo-tenant-invoice-api'
REPOSITORY_NAME = 'demo-tenant-invoice-api'
FULL_NAME = 'demo/' + REPOSITORY_NAME
REPOSITORY_URL = 'http://127.0.0.1:3000/' + FULL_NAME + '.git'
BASE_COMMIT = '43e06161b97113cecc9282e67c7a634dc825e310'
SOURCE_PATH = 'src/main/java/com/example/invoice/InvoiceController.java'
LINE_RANGE = '51-54'
BASELINE_COMMAND = 'mvn -B -o -s .cache/settings.xml test'
VERIFICATION_COMMAND = 'mvn -B -o -s .cache/settings.xml clean verify'
BASELINE_TEST = 'crossTenantInvoiceReadIsHidden'
SHA = re.compile(r'^[a-f0-9]{40}$')
WORK = re.compile(r'^work-[a-f0-9]{32}$')
OPERATION = re.compile(r'^exec-[a-f0-9]{32}$')
MAX_PULL_PAGES = 20


def _check(name, passed):
    return {'name': name, 'status': 'PASS' if passed else 'FAIL'}


def _valid_expected(expected):
    return isinstance(expected, dict) and all(expected.get(key) == value for key, value in {
        'findingId': FINDING_ID, 'findingTitle': FINDING_TITLE, 'ownerId': OWNER_ID,
        'repositoryId': REPOSITORY_ID, 'repositoryUrl': REPOSITORY_URL,
        'baseCommit': BASE_COMMIT, 'sourcePath': SOURCE_PATH, 'lineRange': LINE_RANGE,
        'baselineCommand': BASELINE_COMMAND, 'verificationCommand': VERIFICATION_COMMAND,
        'baselineTest': BASELINE_TEST,
    }.items())


def _valid_junit(value, *, failures, failed_test=None):
    if not isinstance(value, dict):
        return False
    if (value.get('tests') != 2 or value.get('failures') != failures or value.get('errors') != 0
            or value.get('skipped') != 0 or value.get('invalidReports') != []):
        return False
    reports = value.get('reports')
    if not isinstance(reports, list) or not reports or any(not isinstance(row, dict) or not isinstance(row.get('path'), str) for row in reports):
        return False
    try:
        if any(not relative_path(row['path'], directory=False).startswith('target/surefire-reports/') for row in reports):
            return False
    except (ValueError, TypeError):
        return False
    if failed_test is not None:
        names = value.get('failedTests')
        if not isinstance(names, list) or not any(name == failed_test or (isinstance(name, str) and name.endswith('.' + failed_test)) for name in names):
            return False
    return True


def _finding_matches(finding, work_id, expected):
    return isinstance(finding, dict) and finding.get('id') == FINDING_ID and finding.get('name') == FINDING_TITLE \
        and finding.get('ownerId') == OWNER_ID and finding.get('category') == 'CWE-284' and finding.get('risk') == 'CRITICAL' \
        and finding.get('repositoryId') == REPOSITORY_ID and finding.get('repositoryUrl') == REPOSITORY_URL \
        and finding.get('baseCommit') == BASE_COMMIT and finding.get('sourcePath') == SOURCE_PATH \
        and finding.get('lineRange') == LINE_RANGE and finding.get('status') == 'In Progress' \
        and finding.get('closed') == 'Open' and finding.get('workItemId') == work_id \
        and finding.get('remediationJobId') == work_id and type(finding.get('revision')) is int and finding['revision'] > 0


def _baseline_matches(operation, work, expected):
    wf = work.get('workflow') or {}; evidence = (operation or {}).get('evidence') or {}
    return isinstance(operation, dict) and operation.get('operationId') == wf.get('baselineOperationId') \
        and operation.get('workItemId') == work.get('workItemId') and operation.get('ownerId') == work.get('ownerId') \
        and operation.get('sandboxId') == work.get('sandboxId') and operation.get('kind') == 'UNIT_TEST' \
        and operation.get('command') == BASELINE_COMMAND and operation.get('sourceCommit') == BASE_COMMIT \
        and operation.get('state') == 'FAILED' and type(operation.get('exitCode')) is int and operation['exitCode'] == 1 \
        and operation.get('reason') is None and evidence.get('sourceCommit') == BASE_COMMIT \
        and evidence.get('expectedSourceCommit') == BASE_COMMIT and evidence.get('sourceDirty') is False \
        and evidence.get('command') == BASELINE_COMMAND and evidence.get('kind') == 'UNIT_TEST' \
        and evidence.get('sandboxId') == work.get('sandboxId') and evidence.get('exitCode') == 1 \
        and _valid_junit(evidence.get('junit'), failures=1, failed_test=BASELINE_TEST)


def _candidate_matches(work, git):
    wf = work.get('workflow') or {}; record = work.get('sourceRecord') or {}; candidate = wf.get('candidateCommit')
    return isinstance(git, dict) and isinstance(candidate, str) and SHA.fullmatch(candidate) is not None \
        and record.get('repositoryUrl') == REPOSITORY_URL and record.get('baseCommit') == BASE_COMMIT \
        and record.get('sourcePath') == SOURCE_PATH and git.get('baseCommit') == BASE_COMMIT \
        and git.get('headCommit') == candidate and git.get('status') == '' and git.get('diffTruncated') is False \
        and git.get('changedFiles') == [SOURCE_PATH] and git.get('testsChanged') == []


def _verification_matches(operation, work):
    wf = work.get('workflow') or {}; evidence = (operation or {}).get('evidence') or {}; runtime = (operation or {}).get('runtime') or {}
    candidate = wf.get('candidateCommit')
    return isinstance(operation, dict) and operation.get('operationId') == wf.get('verificationOperationId') \
        and operation.get('workItemId') == work.get('workItemId') and operation.get('ownerId') == work.get('ownerId') \
        and operation.get('sandboxId') == work.get('sandboxId') and operation.get('kind') == 'VERIFY' \
        and operation.get('command') == VERIFICATION_COMMAND and operation.get('state') == 'SUCCEEDED' \
        and type(operation.get('exitCode')) is int and operation['exitCode'] == 0 and operation.get('reason') is None \
        and operation.get('sourceCommit') == candidate and evidence.get('sourceCommit') == candidate \
        and evidence.get('sourceDirty') is False and evidence.get('command') == VERIFICATION_COMMAND \
        and evidence.get('exitCode') == 0 and runtime.get('freshTargetAbsent') is True \
        and isinstance(runtime.get('sandboxId'), str) and runtime['sandboxId'] != work.get('sandboxId') \
        and (runtime.get('cleanup') or {}).get('status') == 'done' \
        and _valid_junit(evidence.get('junit'), failures=0)


def _delivery_identity_matches(work, pulls):
    wf = work.get('workflow') or {}; delivery = wf.get('delivery') or {}; candidate = wf.get('candidateCommit')
    source = work.get('source') or {}; work_id = work.get('workItemId')
    if not isinstance(candidate, str) or SHA.fullmatch(candidate) is None or not isinstance(work_id, str) or WORK.fullmatch(work_id) is None:
        return False
    verify_id = wf.get('verificationOperationId')
    if not isinstance(verify_id, str) or OPERATION.fullmatch(verify_id) is None:
        return False
    delivery_id = hashlib.sha256((work_id + ':' + candidate + ':' + verify_id).encode()).hexdigest()
    head_branch = 'mythos/' + FINDING_ID.lower() + '-' + work_id[5:13] + '-' + candidate[:12]
    if (delivery.get('id') != delivery_id or delivery.get('repository') != FULL_NAME
            or delivery.get('repositoryUrl') != REPOSITORY_URL or delivery.get('candidateCommit') != candidate
            or delivery.get('verificationOperationId') != verify_id or delivery.get('headBranch') != head_branch
            or delivery.get('baseBranch') != 'main' or delivery.get('step') != 'PR_OPEN'
            or type(delivery.get('pullNumber')) is not int or delivery['pullNumber'] < 1
            or delivery.get('lastError') is not None or delivery.get('nextAttemptAt') is not None
            or source.get('id') != FINDING_ID or not isinstance(pulls, list) or len(pulls) != 1):
        return False
    pull = pulls[0]; marker = '<!-- mythos-delivery:' + delivery_id + ' -->'
    return isinstance(pull, dict) and pull.get('number') == delivery['pullNumber'] \
        and pull.get('html_url') == 'http://127.0.0.1:3000/' + FULL_NAME + '/pulls/' + str(delivery['pullNumber']) \
        and pull.get('state') == 'open' and pull.get('merged') is False \
        and (pull.get('head') or {}).get('sha') == candidate and (pull.get('head') or {}).get('ref') == head_branch \
        and ((pull.get('head') or {}).get('repo') or {}).get('full_name') == FULL_NAME \
        and (pull.get('base') or {}).get('ref') == 'main' \
        and ((pull.get('base') or {}).get('repo') or {}).get('full_name') == FULL_NAME \
        and str(pull.get('body') or '').count(marker) == 1


def _restart_identity_matches(identity, work, required_operation_ids):
    if not isinstance(identity, dict):
        return False
    before, after = identity.get('before'), identity.get('after')
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    work_id = work.get('workItemId'); current_sessions = work.get('sessionIds')
    before_sessions = before.get('sessionIds'); after_sessions = after.get('sessionIds')
    before_ops = before.get('operationIds'); after_ops = after.get('operationIds')
    return before.get('workItemId') == work_id == after.get('workItemId') \
        and isinstance(current_sessions, list) and current_sessions and before_sessions == after_sessions == current_sessions \
        and isinstance(before_ops, list) and isinstance(after_ops, list) and set(before_ops).issubset(set(after_ops)) \
        and set(required_operation_ids).issubset(set(after_ops)) \
        and type(before.get('mockPid')) is int and before['mockPid'] > 0 \
        and type(after.get('mockPid')) is int and after['mockPid'] > 0 and before['mockPid'] != after['mockPid']


def assess_bola_browser_entry(receipt, work, expected_origin='http://127.0.0.1:3080'):
    if not isinstance(receipt, dict) or not isinstance(work, dict):
        return {'status': 'NOT_READY', 'checks': [_check('browserReadOnlyEntry', False)]}
    try:
        parsed = urllib.parse.urlsplit(receipt.get('entryUrl', ''))
        origin = loopback_origin(urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')))
        expected = loopback_origin(expected_origin)
        query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
        work_id = work.get('workItemId'); session_ids = work.get('sessionIds') or []
        session_id = query.get('mythosSession', [''])[0]
        url_ok = origin == expected and parsed.path == '/' and not parsed.fragment \
            and set(query) == {'mythosVibeTask', 'mythosSession', 'mythosEmbedded'} \
            and all(len(values) == 1 for values in query.values()) \
            and query.get('mythosVibeTask') == [work_id] and query.get('mythosEmbedded') == ['1'] \
            and session_id in session_ids and receipt.get('sessionId') == session_id
    except (ValueError, TypeError):
        url_ok = False; session_id = None
    source_path = (work.get('sourceRecord') or {}).get('sourcePath')
    base = (work.get('sourceRecord') or {}).get('baseCommit')
    candidate = (work.get('workflow') or {}).get('candidateCommit')
    files_ok = receipt.get('filePaneReadOnly') is True and receipt.get('files') == [SOURCE_PATH] \
        and receipt.get('sourcePath') == SOURCE_PATH and source_path == SOURCE_PATH
    diff_ok = receipt.get('diffBaseCommit') == BASE_COMMIT == base \
        and receipt.get('diffHeadCommit') == candidate and receipt.get('diffChangedFiles') == [SOURCE_PATH]
    observed_version = receipt.get('version'); current_version = work.get('version')
    version_ok = type(observed_version) is int and type(current_version) is int and 0 <= observed_version <= current_version
    page_ok = version_ok and receipt.get('phase') == (work.get('workflow') or {}).get('phase') == 'PR_OPEN' \
        and work.get('status') == 'PASSED' and receipt.get('runMonitorVisible') is True
    checks = [_check('visibleEntryLinkBoundToTaskAndSession', receipt.get('entryLinkObserved') is True and url_ok),
              _check('readOnlyFileTreeMatchesCandidateSource', files_ok),
              _check('diffBaseAndHeadMatchCandidate', diff_ok),
              _check('pageVersionAndRunMonitorMatch', page_ok)]
    return {'status': 'PASS' if all(row['status'] == 'PASS' for row in checks) else 'NOT_READY',
            'checks': checks, 'workItemId': work_id, 'sessionId': session_id,
            'version': observed_version, 'sourcePath': source_path,
            'diffBaseCommit': receipt.get('diffBaseCommit'), 'diffHeadCommit': receipt.get('diffHeadCommit')}


def capture_bola_acceptance(owner, work_id, api, console, forge, expected):
    """Collect bounded GET-only evidence; a missing gate always yields NOT_READY."""
    checks = []
    result = {'schemaVersion': 1, 'capturedAt': datetime.now(timezone.utc).isoformat(),
              'readOnly': True, 'scope': 'bola-fnd-00016-final-acceptance', 'ownerId': owner,
              'workItemId': work_id, 'checks': checks}
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', owner or '') or not isinstance(work_id, str) or WORK.fullmatch(work_id) is None or not _valid_expected(expected):
        checks.append(_check('fixedAcceptanceTarget', False)); result['status'] = 'NOT_READY'; return result
    try:
        snapshot = api.get('/api/brain/work-items/' + work_id)
        work = snapshot.get('workItem') if isinstance(snapshot, dict) else None
        if not isinstance(work, dict): raise ProbeError('Work Item snapshot unavailable')
        wf = work.get('workflow') or {}; record = work.get('sourceRecord') or {}
        finding = api.get_finding(FINDING_ID)
        checks.append(_check('findingBinding', work.get('ownerId') == owner and work.get('source', {}).get('id') == FINDING_ID
                             and record.get('id') == FINDING_ID and record.get('ownerId') == OWNER_ID
                             and record.get('title') == FINDING_TITLE and record.get('repositoryUrl') == REPOSITORY_URL
                             and record.get('baseCommit') == BASE_COMMIT and record.get('sourcePath') == SOURCE_PATH
                             and _finding_matches(finding, work_id, expected)))
        baseline_id = wf.get('baselineOperationId'); baseline = api.get('/api/brain/operations/' + baseline_id) if isinstance(baseline_id, str) and OPERATION.fullmatch(baseline_id) else None
        checks.append(_check('expectedBaselineFailure', _baseline_matches(baseline, work, expected)))
        workspace = api.get('/api/brain/work-items/' + work_id + '/workspace')
        git = workspace.get('git') if isinstance(workspace, dict) else None
        checks.append(_check('singleSourceCandidate', wf.get('phase') == 'PR_OPEN' and _candidate_matches(work, git)))
        verify_id = wf.get('verificationOperationId'); verification = api.get('/api/brain/operations/' + verify_id) if isinstance(verify_id, str) and OPERATION.fullmatch(verify_id) else None
        checks.append(_check('freshIndependentVerification', _verification_matches(verification, work)))
        delivery = wf.get('delivery') or {}
        pulls = forge.pulls(FULL_NAME, delivery) if isinstance(delivery, dict) else None
        checks.append(_check('exactOpenPull', _delivery_identity_matches(work, pulls)))
        detail = console.get('/mythos/api/work-items/' + work_id)
        console_work = detail.get('workItem') if isinstance(detail, dict) else None
        checks.append(_check('authenticatedConsoleBinding', isinstance(console_work, dict)
                             and console_work.get('workItemId') == work_id and console_work.get('ownerId') == owner
                             and (console_work.get('source') or {}).get('id') == FINDING_ID
                             and (console_work.get('workflow') or {}).get('candidateCommit') == wf.get('candidateCommit')
                             and (console_work.get('workflow') or {}).get('phase') == 'PR_OPEN'))
        after = api.get('/api/brain/work-items/' + work_id).get('workItem')
        checks.append(_check('stableReadOnlyCapture', isinstance(after, dict) and after.get('version') == work.get('version')
                             and (after.get('workflow') or {}).get('candidateCommit') == wf.get('candidateCommit')
                             and (after.get('workflow') or {}).get('phase') == wf.get('phase')))
        browser = assess_bola_browser_entry(expected.get('browserReceipt'), work, expected.get('browserOrigin', 'http://127.0.0.1:3080'))
        checks.append(_check('browserEntry', browser.get('status') == 'PASS'))
        required_ops = [value for value in (baseline_id, verify_id) if isinstance(value, str)]
        checks.append(_check('restartIdentityContinuity', _restart_identity_matches(expected.get('restartIdentity'), work, required_ops)))
        result.update({'finding': {'id': FINDING_ID, 'ownerId': OWNER_ID, 'repositoryId': REPOSITORY_ID,
                                   'repositoryUrl': REPOSITORY_URL, 'baseCommit': BASE_COMMIT, 'sourcePath': SOURCE_PATH,
                                   'revision': finding.get('revision') if isinstance(finding, dict) else None},
                       'baseline': None if not isinstance(baseline, dict) else {
                           'operationId': baseline.get('operationId'), 'state': baseline.get('state'),
                           'exitCode': baseline.get('exitCode'), 'sourceCommit': baseline.get('sourceCommit'),
                           'junit': {key: (baseline.get('evidence') or {}).get('junit', {}).get(key)
                                     for key in ('tests', 'failures', 'errors', 'skipped')}
                           if isinstance((baseline.get('evidence') or {}).get('junit'), dict) else None},
                       'candidateCommit': wf.get('candidateCommit'), 'changedFiles': git.get('changedFiles') if isinstance(git, dict) else None,
                       'verification': None if not isinstance(verification, dict) else {
                           'operationId': verification.get('operationId'), 'state': verification.get('state'),
                           'exitCode': verification.get('exitCode'), 'sandboxId': (verification.get('runtime') or {}).get('sandboxId'),
                           'freshTargetAbsent': (verification.get('runtime') or {}).get('freshTargetAbsent')},
                       'pull': {'repository': FULL_NAME, 'number': delivery.get('pullNumber'), 'state': pulls[0].get('state'),
                                'merged': pulls[0].get('merged'), 'head': (pulls[0].get('head') or {}).get('sha')}
                       if isinstance(pulls, list) and len(pulls) == 1 else None,
                       'browser': browser,
                       'restartIdentity': {'workItemId': work_id,
                                            'sessionIds': (expected.get('restartIdentity') or {}).get('after', {}).get('sessionIds', []),
                                            'operationIds': (expected.get('restartIdentity') or {}).get('after', {}).get('operationIds', []),
                                            'mockPidBefore': ((expected.get('restartIdentity') or {}).get('before') or {}).get('mockPid'),
                                            'mockPidAfter': ((expected.get('restartIdentity') or {}).get('after') or {}).get('mockPid')}})
    except Exception:
        # Service text and transport details may contain sensitive data; keep only a fixed failure marker.
        checks.append(_check('readOnlyCaptureCompleted', False))
    result['status'] = 'PASSED' if checks and all(row['status'] == 'PASS' for row in checks) else 'NOT_READY'
    result['complete'] = result['status'] == 'PASSED'
    return result


class AcceptanceAPI:
    def __init__(self, brain, mock): self.brain = brain; self.mock = mock
    def get(self, path): return self.brain.get(path)
    def get_finding(self, finding_id):
        if finding_id != FINDING_ID: raise ProbeError('Only FND-00016 is in scope')
        return self.mock.get('/api/findings/' + FINDING_ID)


class BolaForgeReader:
    def __init__(self, credential_file):
        credentials = GitHostClient(credential_file)._credentials()
        basic = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
        self.client = ReadClient('http://127.0.0.1:3000', {'Authorization': 'Basic ' + basic})

    def pulls(self, repository, delivery):
        if repository != FULL_NAME or not isinstance(delivery, dict):
            raise ProbeError('BOLA pull request target is outside the fixed acceptance set')
        prefix = '/api/v1/repos/' + FULL_NAME
        rows = []
        for page in range(1, MAX_PULL_PAGES + 1):
            value = self.client.get(prefix + '/pulls?state=all&limit=100&page=' + str(page))
            if not isinstance(value, list): raise ProbeError('Independent BOLA PR listing is invalid')
            rows.extend(value)
            if not value: break
        else: raise ProbeError('Independent BOLA PR pagination is incomplete')
        marker = '<!-- mythos-delivery:' + str(delivery.get('id')) + ' -->'
        matched = [row for row in rows if marker in str(row.get('body') or '') or (row.get('head') or {}).get('ref') == delivery.get('headBranch')]
        result = []
        for row in matched:
            number = row.get('number')
            if type(number) is not int or number < 1: raise ProbeError('Independent BOLA PR number is invalid')
            result.append(self.client.get(prefix + '/pulls/' + str(number)))
        return result


def _write_private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink(): raise ProbeError('Private receipt directory must not be a symlink')
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or not stat.S_ISDIR(parent.st_mode) or stat.S_IMODE(parent.st_mode) & 0o077:
        raise ProbeError('Private receipt directory has unsafe ownership or mode')
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', default='alice')
    parser.add_argument('--work-id', required=True)
    parser.add_argument('--runtime-root', type=Path, default=Path.home() / 'mythos-m1')
    parser.add_argument('--data-root', type=Path, default=Path.home() / '.mythos-brain')
    parser.add_argument('--credential-file', type=Path, default=Path.home() / 'gitea/secrets/mythos-agent.json')
    parser.add_argument('--api-origin', default='http://127.0.0.1:3081')
    parser.add_argument('--console-origin', default='http://127.0.0.1:3080')
    parser.add_argument('--mock-origin', default='http://127.0.0.1:8080')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', args.owner) or WORK.fullmatch(args.work_id) is None:
            raise ProbeError('Invalid owner or Work Item identity')
        api_origin = loopback_origin(args.api_origin)
        console_origin = loopback_origin(args.console_origin)
        mock_origin = loopback_origin(args.mock_origin)
        if api_origin != 'http://127.0.0.1:3081' or console_origin != 'http://127.0.0.1:3080' or mock_origin != 'http://127.0.0.1:8080':
            raise ProbeError('Only the configured loopback BOLA endpoints are supported')
        token_file = json.loads(private_bytes(args.data_root / 'tokens.json'))
        token = token_file['owners'][args.owner]
        brain = ReadClient(api_origin, {'Authorization': 'Bearer ' + token})
        mock = ReadClient(mock_origin)
        console = console_client(console_origin, args.runtime_root / 'state/dsh.log')
        forge = BolaForgeReader(args.credential_file)
        expected = {'findingId': FINDING_ID, 'findingTitle': FINDING_TITLE, 'ownerId': OWNER_ID,
                    'repositoryId': REPOSITORY_ID, 'repositoryUrl': REPOSITORY_URL,
                    'baseCommit': BASE_COMMIT, 'sourcePath': SOURCE_PATH, 'lineRange': LINE_RANGE,
                    'baselineCommand': BASELINE_COMMAND, 'verificationCommand': VERIFICATION_COMMAND,
                    'baselineTest': BASELINE_TEST,
                    'browserReceipt': private_json(args.runtime_root / 'state/bola-browser.json'),
                    'browserOrigin': console_origin,
                    'restartIdentity': private_json(args.runtime_root / 'state/bola-restart.json')}
        result = capture_bola_acceptance(args.owner, args.work_id, AcceptanceAPI(brain, mock), console, forge, expected)
        output = args.output or args.runtime_root / 'artifacts' / ('bola-demo-final-' + datetime.now(timezone.utc).strftime('%Y-%m-%d') + '.json')
        _write_private_json(output, result)
        print(json.dumps({'status': result['status'], 'complete': result['complete'], 'readOnly': True,
                          'receipt': str(output), 'workItemId': args.work_id}, ensure_ascii=False))
        return 0 if result['status'] == 'PASSED' else 2
    except Exception:
        print(json.dumps({'status': 'ERROR', 'complete': False, 'readOnly': True,
                          'message': 'Private BOLA acceptance capture failed; no readiness is claimed.'}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
