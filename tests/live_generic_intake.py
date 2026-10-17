"""Read-only operator receipt for existing MANUAL works; never admits mutations.

Run on the isolated operator host, e.g.:
  python3 tests/live_generic_intake.py --owner alice --work-id work-... --allow-in-progress
Exit 0 means all gates passed; 3 is an explicitly incomplete capture, 2 not ready.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.git_host import GitHostClient
from brain.publication import delivery_id, publication_branch
from brain.task_spec import change_allowed, repository_config_from_spec, validate_task_spec, verification_passes

WORK = re.compile(r'work-[a-f0-9]{32}')
SHA = re.compile(r'[a-f0-9]{40}')
MAX_BYTES = 4 * 1024 * 1024


class ProbeError(ValueError):
    pass


def loopback_origin(value):
    url = urllib.parse.urlsplit(value)
    try: local = url.hostname == 'localhost' or ipaddress.ip_address(url.hostname).is_loopback
    except ValueError: local = False
    if (url.scheme != 'http' or not local or url.username is not None or url.password is not None or url.path not in {'', '/'}
            or url.query or url.fragment or url.port is None):
        raise ValueError('Only credential-free loopback HTTP origins with explicit ports are allowed')
    return urllib.parse.urlunsplit((url.scheme, url.netloc, '', '', ''))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProbeError('Read-only endpoint redirected; capture stopped')


class LoginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin): self.origin = origin
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urllib.parse.urlsplit(newurl)
        if req.get_method() != 'GET' or url.username or url.password or url.scheme + '://' + url.netloc != self.origin:
            raise ProbeError('Console login redirected outside its loopback origin')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ReadClient:
    """GET-only, bounded, proxy-free transport; never prints URLs or headers."""
    def __init__(self, origin, headers=None, cookies=None):
        self.origin = loopback_origin(origin); self.headers = headers or {}
        handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
        if cookies is not None: handlers.append(urllib.request.HTTPCookieProcessor(cookies))
        self.opener = urllib.request.build_opener(*handlers)

    def get(self, path):
        if not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or any(c in path for c in '\r\n#'):
            raise ProbeError('Invalid read-only endpoint path')
        request = urllib.request.Request(self.origin + path, headers={'Accept': 'application/json', **self.headers}, method='GET')
        try:
            with self.opener.open(request, timeout=60) as response:
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES: raise ProbeError('Read-only response exceeded its limit')
                return json.loads(data)
        except urllib.error.HTTPError as error:
            raise ProbeError('Read-only GET failed (HTTP %d)' % error.code) from None
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            raise ProbeError('Read-only service response unavailable or invalid') from None


def private_bytes(path, maximum=MAX_BYTES):
    descriptor = None
    try:
        descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > maximum:
            raise ProbeError('Operator input must be a bounded private regular file')
        with os.fdopen(descriptor, 'rb') as stream:
            descriptor = None; data = stream.read(maximum + 1)
        if len(data) > maximum: raise ProbeError('Operator input exceeded its limit')
        return data
    except OSError:
        raise ProbeError('Private operator input unavailable') from None
    finally:
        if descriptor is not None: os.close(descriptor)


def console_client(origin, log_path):
    # Read only the private startup log. The URL is used in memory and never
    # included in errors, stdout, the receipt or docs.
    log = private_bytes(log_path, 16 * 1024 * 1024).decode('utf-8', errors='replace')
    port = urllib.parse.urlsplit(origin).port
    matches = re.findall(r'http://(?:127\.0\.0\.1|localhost|\[::1\]):' + str(port) + r'/\?token=([A-Za-z0-9_-]+)', log)
    if not matches: raise ProbeError('Private console startup login unavailable; use --console-log')
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), LoginRedirect(origin), urllib.request.HTTPCookieProcessor(cookies))
    try:
        with opener.open(urllib.request.Request(origin + '/?token=' + matches[-1], method='GET'), timeout=30): pass
    except (urllib.error.URLError, OSError):
        raise ProbeError('Private console login failed') from None
    return ReadClient(origin, cookies=cookies)


class ForgeReader:
    def __init__(self, credential_file):
        credentials = GitHostClient(credential_file)._credentials()
        basic = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
        self.client = ReadClient('http://127.0.0.1:3000', {'Authorization': 'Basic ' + basic})

    def pulls(self, spec, delivery):
        config = repository_config_from_spec(spec)
        prefix = '/api/v1/repos/' + config['fullName']
        rows = []
        # Continue to an empty page, including when Gitea caps below limit=100.
        for page in range(1, 21):
            value = self.client.get(prefix + '/pulls?state=all&limit=100&page=' + str(page))
            if not isinstance(value, list): raise ProbeError('Independent PR listing is invalid')
            rows.extend(value)
            if not value: break
        else: raise ProbeError('Independent PR pagination is incomplete')
        marker = '<!-- argon-delivery:' + str(delivery.get('id')) + ' -->'
        matched = [row for row in rows if marker in str(row.get('body') or '') or row.get('head', {}).get('ref') == delivery.get('headBranch')]
        result = []
        for row in matched:
            number = row.get('number')
            if type(number) is not int or number < 1: raise ProbeError('Independent PR number is invalid')
            result.append(self.client.get(prefix + '/pulls/' + str(number)))
        return result


def assess_work(work, operation, git, pulls, owner, registry=None, expected_digest=None, operations=None):
    """Pure evidence gate; model text and missing checks cannot grant readiness."""
    checks = []
    def add(name, value): checks.append({'name': name, 'status': 'NOT_RUN' if value is None else 'PASS' if value else 'FAIL'})
    spec = work.get('taskSpec')
    try:
        spec = validate_task_spec(spec, owner); valid = True
    except Exception:
        # No raw service/model/credential text enters this diagnostic.
        spec = None; valid = False
    add('frozenTaskSpec', valid)
    source = work.get('source') or {}; record = work.get('sourceRecord') or {}; wf = work.get('workflow') or {}; d = wf.get('delivery') or {}
    add('manualOwnerBinding', valid and work.get('ownerId') == owner and source.get('type') == 'MANUAL'
        and record.get('ownerId') == owner and record.get('id') == source.get('id'))
    if spec is None:
        return {'workItemId': work.get('workItemId'), 'status': 'NOT_READY', 'checks': checks}
    if expected_digest: add('expectedDigest', spec['specDigest'] == expected_digest)
    add('workReady', wf.get('phase') == 'PR_OPEN' and not work.get('paused') and not work.get('blocked'))
    add('noUncertainOperations', None if operations is None else all(op.get('state') in {'SUCCEEDED', 'FAILED', 'CANCELLED'} for op in operations))
    add('sourceBinding', record.get('repositoryUrl') == spec['repository']['cloneUrl'] and record.get('baseCommit') == spec['baseCommit'])
    add('approvalDigest', (wf.get('approval') or {}).get('specDigest') == spec['specDigest'])
    candidate = wf.get('candidateCommit'); candidate_valid = isinstance(candidate, str) and bool(SHA.fullmatch(candidate))
    add('cleanCommittedCandidate', None if git is None else candidate_valid and git.get('headCommit') == candidate
        and git.get('baseCommit') == spec['baseCommit'] and git.get('status') == '' and git.get('diffTruncated') is False)
    add('frozenChangePolicy', None if git is None else change_allowed(spec, git.get('changedFiles')))
    evidence = (operation or {}).get('evidence') or {}; runtime = (operation or {}).get('runtime') or {}
    add('exactFreshVerification', None if operation is None else operation.get('operationId') == wf.get('verificationOperationId') and operation.get('workItemId') == work.get('workItemId') and operation.get('ownerId') == owner
        and operation.get('sourceCommit') == candidate and operation.get('sandboxId') == work.get('sandboxId')
        and verification_passes(spec, operation, evidence))
    policy = spec['execution']['evidence']; junit = evidence.get('junit')
    if policy['format'] == 'junit':
        add('customerFourTestsAndRegression', None if operation is None or git is None else isinstance(junit, dict)
            and type(junit.get('tests')) is int and type(junit.get('skipped')) is int and junit['tests'] - junit['skipped'] >= max(4, policy['minTests'])
            and len(set(git.get('changedFiles') or [])) >= 2 and bool(git.get('testsChanged')))
    else:
        add('commandExitWithoutJUnit', None if operation is None else 'junit' in evidence and junit is None
            and evidence.get('validation') == {'format': 'command', 'exitCode': 0} and type(evidence.get('exitCode')) is int and evidence['exitCode'] == 0)
    add('verifierCleanup', None if registry is None or operation is None else (runtime.get('cleanup') or {}).get('status') == 'done'
        and registry.get(runtime.get('sandboxId')) == 'stopped')
    identity = delivery_id(work['workItemId'], candidate, wf.get('verificationOperationId')) if candidate_valid else None
    head_branch = publication_branch(source['id'], work['workItemId'], candidate) if candidate_valid and isinstance(source.get('id'), str) else None
    add('durableDelivery', d.get('headBranch') == head_branch and head_branch is not None and d.get('id') == identity and identity is not None and d.get('candidateCommit') == candidate
        and d.get('verificationOperationId') == wf.get('verificationOperationId') and d.get('repository') == spec['repository']['fullName']
        and d.get('repositoryUrl') == spec['repository']['cloneUrl'] and d.get('baseBranch') == spec['repository']['baseBranch'] and d.get('step') == 'PR_OPEN')
    marker = '<!-- argon-delivery:' + str(identity) + ' -->'
    add('oneIndependentPull', None if pulls is None or not d else len(pulls) == 1)
    pull = pulls[0] if pulls and len(pulls) == 1 else None
    add('openExactPullWithOneMarker', None if pull is None else pull.get('state') == 'open' and pull.get('merged') is False
        and pull.get('number') == d.get('pullNumber') and pull.get('html_url') == spec['repository']['origin'] + '/' + spec['repository']['fullName'] + '/pulls/' + str(pull.get('number'))
        and pull.get('head', {}).get('sha') == candidate and pull.get('head', {}).get('ref') == d.get('headBranch')
        and pull.get('head', {}).get('repo', {}).get('full_name') == spec['repository']['fullName']
        and pull.get('base', {}).get('ref') == spec['repository']['baseBranch'] and pull.get('base', {}).get('repo', {}).get('full_name') == spec['repository']['fullName']
        and str(pull.get('body') or '').count(marker) == 1)
    summary = {'workItemId': work['workItemId'], 'sourceId': source.get('id'), 'phase': wf.get('phase'), 'version': work.get('version'),
        'taskSpec': spec, 'candidateCommit': candidate, 'git': git, 'checks': checks,
        'verification': None if operation is None else {'operationId': operation.get('operationId'), 'state': operation.get('state'), 'exitCode': operation.get('exitCode'),
            'sourceCommit': operation.get('sourceCommit'), 'sandboxA': operation.get('sandboxId'), 'sandboxB': runtime.get('sandboxId'), 'cleanup': runtime.get('cleanup'),
            'junit': None if junit is None else {key: value for key, value in junit.items() if key != 'reports'},
            'reports': [] if junit is None else [{key: report.get(key) for key in ['path', 'sha256', 'tests', 'failures', 'errors', 'skipped']} for report in junit.get('reports', [])]},
        'pull': None if pull is None else {key: pull.get(key) for key in ['number', 'html_url', 'state', 'merged']}}
    summary['status'] = 'PASSED' if all(check['status'] == 'PASS' for check in checks) else 'NOT_READY'
    return summary


def registry_states(root, owner):
    database = root / 'sandboxes.sqlite3'
    if not database.is_file(): return None
    try:
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
            return dict(db.execute('SELECT sandbox_id, state FROM sandboxes WHERE owner_id=?', (owner,)))
    except sqlite3.Error: return None


def receipt_reference(path):
    data = private_bytes(path)
    return {'file': path.name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def receipt_work_ids(value):
    found = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {'workItemId', 'workId'} and isinstance(child, str) and WORK.fullmatch(child): found.add(child)
            else: found.update(receipt_work_ids(child))
    elif isinstance(value, list):
        for child in value: found.update(receipt_work_ids(child))
    return found


def capture(owner, work_id, brain, console, forge, registry, expected=None):
    snap = brain.get('/api/brain/work-items/' + work_id); work = snap['workItem']; wf = work.get('workflow') or {}
    spec = validate_task_spec(work.get('taskSpec'), owner)
    op_id = wf.get('verificationOperationId'); operation = None
    if isinstance(op_id, str) and re.fullmatch(r'exec-[a-f0-9]{32}', op_id): operation = brain.get('/api/brain/operations/' + op_id)
    git = None
    if work.get('sandboxId'):
        git = brain.get('/api/brain/work-items/' + work_id + '/workspace').get('git')
    pulls = forge.pulls(spec, wf['delivery']) if wf.get('delivery') else None
    result = assess_work(work, operation, git, pulls, owner, registry, expected, snap.get('operations'))
    baseline_id = wf.get('baselineOperationId')
    baseline = brain.get('/api/brain/operations/' + baseline_id) if isinstance(baseline_id, str) and re.fullmatch(r'exec-[a-f0-9]{32}', baseline_id) else None
    result['baselineObservation'] = None if baseline is None else {'operationId': baseline['operationId'], 'state': baseline['state'], 'exitCode': baseline.get('exitCode'),
        'command': baseline.get('command'), 'junit': None if (baseline.get('evidence') or {}).get('junit') is None else {key: value for key, value in baseline['evidence']['junit'].items() if key not in {'reports', 'failedTests'}}}
    detail = console.get('/argon/api/work-items/' + work_id)
    console_work = detail.get('workItem') or {}
    result['checks'].append({'name': 'authenticatedConsoleBinding', 'status': 'PASS' if console_work.get('workItemId') == work_id
        and (console_work.get('taskSpec') or {}).get('specDigest') == spec['specDigest'] else 'FAIL'})
    after = brain.get('/api/brain/work-items/' + work_id)['workItem']
    result['checks'].append({'name': 'stableCapture', 'status': 'PASS' if after.get('version') == work.get('version')
        and (after.get('taskSpec') or {}).get('specDigest') == spec['specDigest'] and (after.get('workflow') or {}).get('candidateCommit') == wf.get('candidateCommit') else 'FAIL'})
    latest = next((repo for repo in brain.get('/api/brain/repositories')['repositories'] if repo['repositoryId'] == spec['repository']['repositoryId']), None)
    result['latestRepositoryObservation'] = None if latest is None else {'revision': latest['revision'], 'enabled': latest['enabled'],
        'fullName': latest['config']['fullName'], 'verificationCommand': latest['config']['execution']['verificationCommand']}
    result['status'] = 'PASSED' if all(check['status'] == 'PASS' for check in result['checks']) else 'NOT_READY'
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', default='alice'); parser.add_argument('--work-id', action='append', default=[])
    parser.add_argument('--state-receipt', type=Path, action='append', default=[], help='Private existing receipt containing a workItemId')
    parser.add_argument('--expected-digest', action='append', default=[], metavar='WORK_ID=SHA256')
    parser.add_argument('--runtime-root', type=Path, default=Path.home() / 'argon-m1-generic')
    parser.add_argument('--data-root', type=Path, default=Path.home() / '.argon-brain-generic')
    parser.add_argument('--sandbox-root', type=Path, default=Path.home() / 'argon-sandboxes-generic')
    parser.add_argument('--console-log', type=Path); parser.add_argument('--credential-file', type=Path, default=Path.home() / 'gitea/secrets/argon-agent.json')
    parser.add_argument('--api-origin', default='http://127.0.0.1:3083'); parser.add_argument('--console-origin', default='http://127.0.0.1:3093')
    parser.add_argument('--output', type=Path); parser.add_argument('--allow-in-progress', action='store_true')
    args = parser.parse_args(argv); os.umask(0o077)
    try:
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', args.owner): raise ProbeError('Invalid owner')
        api_origin = loopback_origin(args.api_origin); ui_origin = loopback_origin(args.console_origin)
        work_ids = set(args.work_id)
        for path in args.state_receipt: work_ids.update(receipt_work_ids(json.loads(private_bytes(path))))
        if not work_ids or any(not WORK.fullmatch(value) for value in work_ids): raise ProbeError('Explicit valid work IDs or receipt IDs are required')
        expected = {}
        for value in args.expected_digest:
            work_id, digest = value.split('=', 1)
            if not WORK.fullmatch(work_id) or not re.fullmatch(r'[a-f0-9]{64}', digest): raise ProbeError('Invalid expected digest binding')
            expected[work_id] = digest
        token = json.loads(private_bytes(args.data_root / 'tokens.json'))['owners'][args.owner]
        brain = ReadClient(api_origin, {'Authorization': 'Bearer ' + token})
        console = console_client(ui_origin, args.console_log or args.runtime_root / 'state/dsh.log')
        forge = ForgeReader(args.credential_file); registry = registry_states(args.sandbox_root.resolve(), args.owner)
        works = []
        for work_id in sorted(work_ids):
            try: works.append(capture(args.owner, work_id, brain, console, forge, registry, expected.get(work_id)))
            except Exception:
                works.append({'workItemId': work_id, 'status': 'NOT_READY', 'checks': [{'name': 'readOnlyCapture', 'status': 'FAIL'}]})
        references = []
        names = ['customer-fixture.json', 'command-fixture.json', 'customer-admission.json', 'command-admission.json',
                 'customer-plan-approval.json', 'command-plan-approval.json', 'customer-known-failure-resume.json', 'customer-original-config.json',
                 'customer-pr-confirmation.json', 'command-pr-confirmation.json', 'customer-regression-red.json',
                 'legacy-before-generic.json', 'legacy-after-generic.json', 'generic-restart.json', 'services.json', 'deployment.json']
        for path in [args.runtime_root / 'state' / name for name in names] + args.state_receipt:
            if path.is_file(): references.append(receipt_reference(path))
        status = 'PASSED' if all(work['status'] == 'PASSED' for work in works) else 'IN_PROGRESS' if args.allow_in_progress else 'NOT_READY'
        result = {'schemaVersion': 1, 'capturedAt': datetime.now(timezone.utc).isoformat(), 'readOnly': True, 'status': status,
                  'scope': 'existing-work-verification-and-open-PR', 'task5Complete': False, 'ownerId': args.owner, 'works': works, 'receiptReferences': references,
                  'legacyRetention': {'status': 'NOT_RUN', 'note': 'Receipt references are observations; independent before/after retention proof is required.'}}
        output = args.output or args.runtime_root / 'artifacts' / ('generic-intake-' + uuid.uuid4().hex[:12] + '.json')
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as stream: json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
        print(json.dumps({'status': status, 'readOnly': True, 'receipt': str(output), 'works': [work['workItemId'] for work in works]}))
        return 0 if status == 'PASSED' else 3 if status == 'IN_PROGRESS' else 2
    except Exception:
        print(json.dumps({'status': 'ERROR', 'readOnly': True, 'message': 'Private read-only capture failed; no readiness is claimed. Check local arguments, permissions and service availability.'}))
        return 1


if __name__ == '__main__': sys.exit(main())
