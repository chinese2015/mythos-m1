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
from brain.errors import InvalidInput
from brain.publication import delivery_id, publication_branch
from brain.task_spec import change_allowed, relative_path, repository_config_from_spec, validate_task_spec, verification_passes

WORK = re.compile(r'work-[a-f0-9]{32}')
SHA = re.compile(r'[a-f0-9]{40}')
MAX_BYTES = 4 * 1024 * 1024
LEGACY_SOURCES = {'FND-00003', 'FND-00009', 'FND-00015'}
LEGACY_REPOSITORIES = {'demo-orion-notes-api', 'demo-nova-catalog-api', 'demo-pixel-reports-batch'}
RESTART_SERVICES = {'api', 'worker', 'dsh'}


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
        marker = '<!-- mythos-delivery:' + str(delivery.get('id')) + ' -->'
        matched = [row for row in rows if marker in str(row.get('body') or '') or row.get('head', {}).get('ref') == delivery.get('headBranch')]
        result = []
        for row in matched:
            number = row.get('number')
            if type(number) is not int or number < 1: raise ProbeError('Independent PR number is invalid')
            result.append(self.client.get(prefix + '/pulls/' + str(number)))
        return result

    def pull(self, repository, number):
        if repository not in LEGACY_REPOSITORIES or type(number) is not int or number < 1:
            raise ProbeError('Legacy pull target is outside the fixed acceptance set')
        return self.client.get('/api/v1/repos/demo/' + repository + '/pulls/' + str(number))


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
    add('deliveryReconciled', None if not d else d.get('lastError') is None and d.get('nextAttemptAt') is None)
    marker = '<!-- mythos-delivery:' + str(identity) + ' -->'
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


def baseline_evidence_ready(spec, work, operation):
    """Require the frozen baseline command and real evidence before the live receipt can pass."""
    try:
        validate_task_spec(spec, work.get('ownerId'))
        execution = spec['execution']; policy = execution['evidence']; wf = work.get('workflow') or {}
        evidence = (operation or {}).get('evidence') or {}; base = spec['baseCommit']
        if (not operation or operation.get('operationId') != wf.get('baselineOperationId')
                or operation.get('workItemId') != work.get('workItemId')
                or operation.get('ownerId') != work.get('ownerId')
                or operation.get('sandboxId') != work.get('sandboxId')
                or operation.get('kind') != 'UNIT_TEST'
                or operation.get('command') != execution['baselineCommand']
                or type(operation.get('timeoutSeconds')) is not int
                or not 1 <= operation['timeoutSeconds'] <= execution['timeoutSeconds']
                or operation.get('sourceCommit') != base or operation.get('reason') is not None
                or operation.get('state') not in {'SUCCEEDED', 'FAILED'}
                or type(operation.get('exitCode')) is not int
                or evidence.get('sourceCommit') != base or evidence.get('expectedSourceCommit') != base
                or evidence.get('sourceDirty') is not False
                or evidence.get('command') != execution['baselineCommand']
                or evidence.get('kind') != 'UNIT_TEST'
                or evidence.get('sandboxId') != work.get('sandboxId')
                or evidence.get('exitCode') != operation['exitCode']):
            return False
        state, code = operation['state'], operation['exitCode']
        if policy['format'] == 'command':
            valid_run = evidence.get('validation') == {'format': 'command', 'exitCode': code} and (
                (state == 'SUCCEEDED' and code == 0) or (state == 'FAILED' and code != 0))
        else:
            junit = evidence.get('junit')
            # Baselines need at least one genuine test; frozen minTests is the
            # final VERIFY threshold and can rise with an approved regression.
            if (not isinstance(junit, dict) or not isinstance(junit.get('reports'), list) or not junit['reports']
                    or junit.get('invalidReports') != []
                    or any(type(junit.get(key)) is not int or junit[key] < 0
                           for key in ['tests', 'failures', 'errors', 'skipped'])
                    or junit['failures'] + junit['errors'] + junit['skipped'] > junit['tests']
                    or junit['tests'] - junit['skipped'] < 1
                    or (junit['skipped'] and not policy['allowSkipped'])):
                return False
            for report in junit['reports']:
                if not isinstance(report, dict) or not isinstance(report.get('path'), str):
                    return False
                path = relative_path(report['path'], directory=False)
                if not any(path.startswith(directory.rstrip('/') + '/') for directory in policy['reportDirs']):
                    return False
            if state == 'SUCCEEDED': valid_run = code == 0 and junit['failures'] == 0 and junit['errors'] == 0
            else: valid_run = code != 0 and junit['failures'] + junit['errors'] > 0
        if not valid_run: return False
        mode = execution['baselineMode']
        if mode == 'must-pass': return state == 'SUCCEEDED' and code == 0
        if mode == 'must-fail': return state == 'FAILED' and code != 0
        return True
    except (InvalidInput, KeyError, TypeError, ValueError):
        return False


def registry_states(root, owner):
    database = root / 'sandboxes.sqlite3'
    if not database.is_file(): return None
    try:
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
            return dict(db.execute('SELECT sandbox_id, state FROM sandboxes WHERE owner_id=?', (owner,)))
    except sqlite3.Error: return None


def restart_identity(work, operations):
    workflow = work.get('workflow') or {}; source = work.get('source') or {}; delivery = workflow.get('delivery') or {}
    operation_ids = sorted(op.get('operationId') for op in (operations or [])
                           if isinstance(op, dict) and isinstance(op.get('operationId'), str))
    session_ids = sorted(value for value in (work.get('sessionIds') or []) if isinstance(value, str))
    return {'workItemId': work.get('workItemId'), 'phase': workflow.get('phase'), 'sourceType': source.get('type'),
            'taskId': source.get('id'), 'specDigest': (work.get('taskSpec') or {}).get('specDigest'),
            'candidate': workflow.get('candidateCommit'), 'deliveryId': delivery.get('id'),
            'verificationOperationId': workflow.get('verificationOperationId'), 'operations': operation_ids,
            'sessionIds': session_ids}


def assess_restart_continuity(before, current_works, services):
    checks = []
    if not isinstance(before, dict) or not isinstance(current_works, list):
        checks.append({'name': 'sameWorkInventory', 'status': 'NOT_RUN'})
        checks.append({'name': 'stableTaskSessionOperationAndPRIdentity', 'status': 'NOT_RUN'})
    else:
        prior = before.get('works'); current_ids = [row.get('workItemId') for row in current_works if isinstance(row, dict)]
        prior_ids = [row.get('workItemId') for row in prior if isinstance(row, dict)] if isinstance(prior, list) else []
        unique = len(current_ids) == len(set(current_ids)) and len(prior_ids) == len(set(prior_ids))
        inventory_matches = unique and bool(prior_ids) and sorted(prior_ids) == sorted(current_ids)
        checks.append({'name': 'sameWorkInventory', 'status': 'PASS' if inventory_matches else 'FAIL'})
        before_by_id = {row.get('workItemId'): row for row in prior if isinstance(row, dict)} if isinstance(prior, list) else {}
        after_by_id = {row.get('workItemId'): row for row in current_works if isinstance(row, dict)}
        def normalize(row):
            if not isinstance(row, dict): return None
            result = dict(row)
            for key in ('operations', 'sessionIds'):
                values = result.get(key)
                if not isinstance(values, list) or any(not isinstance(value, str) for value in values): return None
                if len(values) != len(set(values)): return None
                result[key] = sorted(values)
            return result
        stable = inventory_matches and all(normalize(before_by_id[work_id]) is not None
            and normalize(before_by_id[work_id]) == normalize(after_by_id[work_id]) for work_id in prior_ids)
        checks.append({'name': 'stableTaskSessionOperationAndPRIdentity', 'status': 'PASS' if stable else 'FAIL'})
    if not isinstance(services, dict):
        checks.append({'name': 'oldServicesExitedAndNewServicesAlive', 'status': 'NOT_RUN'})
    else:
        prior_running = before.get('runningProcesses') if isinstance(before, dict) else None
        valid_names = set(services) == RESTART_SERVICES
        valid_processes = valid_names and isinstance(prior_running, dict) and all(prior_running.get(name) is True for name in RESTART_SERVICES)
        for name in RESTART_SERVICES:
            state = services.get(name) if isinstance(services, dict) else None
            valid_processes = valid_processes and isinstance(state, dict) and type(state.get('beforePid')) is int and state['beforePid'] > 0
            valid_processes = valid_processes and type(state.get('afterPid')) is int and state['afterPid'] > 0
            valid_processes = valid_processes and state.get('beforePid') != state.get('afterPid')
            valid_processes = valid_processes and state.get('beforeAlive') is False and state.get('afterAlive') is True
        checks.append({'name': 'oldServicesExitedAndNewServicesAlive', 'status': 'PASS' if valid_processes else 'FAIL'})
    return {'status': 'PASS' if checks and all(check['status'] == 'PASS' for check in checks) else 'NOT_READY', 'checks': checks,
            'beforeCommit': before.get('isolatedBranchCommit') if isinstance(before, dict) else None,
            'workItems': current_works if isinstance(current_works, list) else []}


def assess_legacy_retention(before, after, current_work_items, current_pulls):
    checks = []
    if not isinstance(before, dict) or not isinstance(after, dict):
        checks.append({'name': 'beforeAfterSnapshots', 'status': 'NOT_RUN'})
        expected_works = []; expected_pulls = []
    else:
        expected_works = before.get('legacyWorks')
        expected_pulls = before.get('legacyPRs')
        same_snapshot = after.get('identicalToPreDeploymentSnapshot') is True
        checks.append({'name': 'deploymentSnapshotMatched', 'status': 'PASS' if same_snapshot else 'FAIL'})
        checks.append({'name': 'workItemsUnchangedSinceDeployment', 'status': 'PASS' if expected_works == after.get('legacyWorkItems') else 'FAIL'})
        checks.append({'name': 'pullRequestsUnchangedSinceDeployment', 'status': 'PASS' if expected_pulls == after.get('legacyPRs') else 'FAIL'})
    valid_inventory = isinstance(expected_works, list) and len(expected_works) == 3 and {
        row.get('source') for row in expected_works if isinstance(row, dict)} == LEGACY_SOURCES and all(
        isinstance(row, dict) and row.get('phase') == 'PR_OPEN' and WORK.fullmatch(str(row.get('workItemId', '')))
        for row in expected_works)
    valid_inventory = valid_inventory and isinstance(expected_pulls, list) and len(expected_pulls) == 3 and {
        row.get('repo') for row in expected_pulls if isinstance(row, dict)} == LEGACY_REPOSITORIES and all(
        isinstance(row, dict) and row.get('state') == 'open' and row.get('merged') is False
        and type(row.get('number')) is int and row['number'] > 0 and SHA.fullmatch(str(row.get('head', '')))
        for row in expected_pulls)
    checks.append({'name': 'expectedLegacyInventory', 'status': 'PASS' if valid_inventory else 'FAIL'})
    checks.append({'name': 'currentWorkItemsUnchanged', 'status': 'NOT_RUN' if current_work_items is None else
                   'PASS' if valid_inventory and current_work_items == expected_works else 'FAIL'})
    checks.append({'name': 'currentPullRequestsUnchanged', 'status': 'NOT_RUN' if current_pulls is None else
                   'PASS' if valid_inventory and current_pulls == expected_pulls else 'FAIL'})
    return {'status': 'PASS' if checks and all(check['status'] == 'PASS' for check in checks) else 'NOT_READY', 'checks': checks,
            'workItems': current_work_items if isinstance(current_work_items, list) else [],
            'pullRequests': current_pulls if isinstance(current_pulls, list) else []}


def assess_browser_entry(receipt, works, expected_origin='http://127.0.0.1:3093'):
    if not isinstance(receipt, dict):
        return {'status': 'NOT_READY', 'checks': [{'name': 'browserReadOnlyEntry', 'status': 'NOT_RUN'}]}
    work = next((row for row in works if isinstance(row, dict) and row.get('workItemId') == receipt.get('workItemId')), None)
    checks = []
    if not work:
        return {'status': 'NOT_READY', 'checks': [{'name': 'browserReadOnlyEntry', 'status': 'FAIL'}]}
    try:
        parsed = urllib.parse.urlsplit(receipt.get('entryUrl', ''))
        origin = loopback_origin(urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')))
        query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
        url_bound = origin == loopback_origin(expected_origin) and parsed.path == '/' and not parsed.fragment and set(query) == {
            'mythosVibeTask', 'mythosSession', 'mythosEmbedded'} and all(len(value) == 1 for value in query.values())
        restart = work.get('restartIdentity') or {}; session_id = query.get('mythosSession', [''])[0]
        url_bound = url_bound and query.get('mythosVibeTask') == [work['workItemId']] and query.get('mythosEmbedded') == ['1']
        url_bound = url_bound and session_id in (restart.get('sessionIds') or [])
    except (ValueError, TypeError):
        url_bound = False; session_id = None
    checks.append({'name': 'visibleEntryLinkBoundToTaskAndSession', 'status': 'PASS' if receipt.get('entryLinkObserved') is True and url_bound else 'FAIL'})
    spec = work.get('taskSpec') or {}; git = work.get('git') or {}; expected_files = git.get('changedFiles')
    files_match = isinstance(expected_files, list) and receipt.get('files') == expected_files and receipt.get('sourcePath') in expected_files
    checks.append({'name': 'readOnlyFileTreeMatchesTaskDiff', 'status': 'PASS' if receipt.get('filePaneReadOnly') is True and files_match else 'FAIL'})
    diff_match = receipt.get('diffBaseCommit') == spec.get('baseCommit') and receipt.get('diffHeadCommit') == work.get('candidateCommit')
    diff_match = diff_match and receipt.get('diffChangedFiles') == expected_files and receipt.get('taskSpecDigest') == spec.get('specDigest')
    checks.append({'name': 'taskScopedDiffMatchesVerifiedCandidate', 'status': 'PASS' if diff_match else 'FAIL'})
    observed_version = receipt.get('version'); current_version = work.get('version')
    version_valid = type(observed_version) is int and type(current_version) is int and 0 <= observed_version <= current_version
    checks.append({'name': 'snapshotVersionNotAhead', 'status': 'PASS' if version_valid else 'FAIL'})
    page_match = version_valid and receipt.get('phase') == work.get('phase') == 'PR_OPEN'
    page_match = page_match and receipt.get('runMonitorVisible') is True and work.get('status') == 'PASSED'
    checks.append({'name': 'monitorAndSnapshotStayedReadOnly', 'status': 'PASS' if page_match else 'FAIL'})
    return {'status': 'PASS' if all(check['status'] == 'PASS' for check in checks) else 'NOT_READY',
            'checks': checks, 'workItemId': work['workItemId'], 'sessionId': session_id,
            'version': receipt.get('version'), 'files': receipt.get('files') if isinstance(receipt.get('files'), list) else []}


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
    baseline_id = wf.get('baselineOperationId')
    baseline = brain.get('/api/brain/operations/' + baseline_id) if isinstance(baseline_id, str) and re.fullmatch(r'exec-[a-f0-9]{32}', baseline_id) else None
    result = assess_work(work, operation, git, pulls, owner, registry, expected, snap.get('operations'))
    result['checks'].append({'name': 'frozenBaselineEvidence', 'status': 'PASS' if baseline_evidence_ready(spec, work, baseline) else 'FAIL'})
    result['baselineObservation'] = None if baseline is None else {'operationId': baseline['operationId'], 'state': baseline['state'], 'exitCode': baseline.get('exitCode'),
        'kind': baseline.get('kind'), 'sourceCommit': baseline.get('sourceCommit'), 'timeoutSeconds': baseline.get('timeoutSeconds'),
        'reason': baseline.get('reason'), 'command': baseline.get('command'),
        'junit': None if (baseline.get('evidence') or {}).get('junit') is None else {key: value for key, value in baseline['evidence']['junit'].items() if key not in {'reports', 'failedTests'}}}
    detail = console.get('/mythos/api/work-items/' + work_id)
    console_work = detail.get('workItem') or {}
    result['checks'].append({'name': 'authenticatedConsoleBinding', 'status': 'PASS' if console_work.get('workItemId') == work_id
        and (console_work.get('taskSpec') or {}).get('specDigest') == spec['specDigest'] else 'FAIL'})
    after = brain.get('/api/brain/work-items/' + work_id)['workItem']
    result['checks'].append({'name': 'stableCapture', 'status': 'PASS' if after.get('version') == work.get('version')
        and (after.get('taskSpec') or {}).get('specDigest') == spec['specDigest'] and (after.get('workflow') or {}).get('candidateCommit') == wf.get('candidateCommit') else 'FAIL'})
    latest = next((repo for repo in brain.get('/api/brain/repositories')['repositories'] if repo['repositoryId'] == spec['repository']['repositoryId']), None)
    result['latestRepositoryObservation'] = None if latest is None else {'revision': latest['revision'], 'enabled': latest['enabled'],
        'fullName': latest['config']['fullName'], 'verificationCommand': latest['config']['execution']['verificationCommand']}
    result['restartIdentity'] = restart_identity(work, snap.get('operations'))
    result['status'] = 'PASSED' if all(check['status'] == 'PASS' for check in result['checks']) else 'NOT_READY'
    return result


def private_json(path):
    try: return json.loads(private_bytes(path))
    except (ProbeError, json.JSONDecodeError): return None


def pid_is_alive(pid):
    if type(pid) is not int or pid < 1: return False
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True
    except OSError: return False


def capture_restart_continuity(runtime_root, works):
    before = private_json(runtime_root / 'state/restart-before.json')
    current = private_json(runtime_root / 'state/services.json')
    if not isinstance(before, dict) or not isinstance(current, dict):
        return assess_restart_continuity(None, None, None)
    prior_services = before.get('services') or {}
    states = {}
    for name in RESTART_SERVICES:
        before_pid = prior_services.get(name); after_pid = current.get(name)
        states[name] = {'beforePid': before_pid, 'afterPid': after_pid,
                        'beforeAlive': pid_is_alive(before_pid), 'afterAlive': pid_is_alive(after_pid)}
    identities = [work.get('restartIdentity') for work in works if isinstance(work, dict) and work.get('restartIdentity')]
    return assess_restart_continuity(before, identities, states)


def capture_legacy_retention(runtime_root, legacy_data_root, owner, forge):
    before = private_json(runtime_root / 'state/legacy-before-generic.json')
    after = private_json(runtime_root / 'state/legacy-after-generic.json')
    if not isinstance(before, dict) or not isinstance(after, dict):
        return assess_legacy_retention(before, after, None, None)
    port = after.get('mainApiPort')
    if type(port) is not int or port != 3081:
        return assess_legacy_retention(before, after, None, None)
    try:
        token = json.loads(private_bytes(legacy_data_root / 'tokens.json'))['owners'][owner]
        legacy = ReadClient('http://127.0.0.1:' + str(port), {'Authorization': 'Bearer ' + token})
        current_works = []
        for old in before.get('legacyWorks', []):
            work_id = old.get('workItemId') if isinstance(old, dict) else None
            if not isinstance(work_id, str) or not WORK.fullmatch(work_id): raise ProbeError('Invalid legacy Work Item identity')
            snapshot = legacy.get('/api/brain/work-items/' + work_id); work = snapshot['workItem']
            source = work.get('source') or {}; workflow = work.get('workflow') or {}
            current_works.append({'source': source.get('id'), 'phase': workflow.get('phase'), 'workItemId': work.get('workItemId')})
        current_pulls = []
        for old in before.get('legacyPRs', []):
            if not isinstance(old, dict): raise ProbeError('Invalid legacy pull request receipt')
            pull = forge.pull(old.get('repo'), old.get('number'))
            current_pulls.append({'repo': old['repo'], 'number': pull.get('number'), 'state': pull.get('state'),
                                  'merged': pull.get('merged'), 'head': (pull.get('head') or {}).get('sha')})
        return assess_legacy_retention(before, after, current_works, current_pulls)
    except Exception:
        return assess_legacy_retention(before, after, None, None)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', default='alice'); parser.add_argument('--work-id', action='append', default=[])
    parser.add_argument('--state-receipt', type=Path, action='append', default=[], help='Private existing receipt containing a workItemId')
    parser.add_argument('--expected-digest', action='append', default=[], metavar='WORK_ID=SHA256')
    parser.add_argument('--runtime-root', type=Path, default=Path.home() / 'mythos-m1-generic')
    parser.add_argument('--data-root', type=Path, default=Path.home() / '.mythos-brain-generic')
    parser.add_argument('--legacy-data-root', type=Path, default=Path.home() / '.mythos-brain')
    parser.add_argument('--sandbox-root', type=Path, default=Path.home() / 'mythos-sandboxes-generic')
    parser.add_argument('--console-log', type=Path); parser.add_argument('--credential-file', type=Path, default=Path.home() / 'gitea/secrets/mythos-agent.json')
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
        restart = capture_restart_continuity(args.runtime_root, works)
        legacy = capture_legacy_retention(args.runtime_root, args.legacy_data_root, args.owner, forge)
        browser_receipt = private_json(args.runtime_root / 'state/coding-readonly-browser.json')
        browser = assess_browser_entry(browser_receipt, works, ui_origin)
        references = []
        names = ['customer-fixture.json', 'command-fixture.json', 'customer-admission.json', 'command-admission.json',
                 'customer-plan-approval.json', 'command-plan-approval.json', 'customer-known-failure-resume.json', 'customer-original-config.json',
                 'customer-pr-confirmation.json', 'command-pr-confirmation.json', 'customer-regression-red.json',
                 'legacy-before-generic.json', 'legacy-after-generic.json', 'restart-before.json', 'services.json',
                 'coding-readonly-browser.json', 'deployment.json']
        for path in [args.runtime_root / 'state' / name for name in names] + args.state_receipt:
            if path.is_file(): references.append(receipt_reference(path))
        complete = all(work['status'] == 'PASSED' for work in works) and restart['status'] == 'PASS' \
            and legacy['status'] == 'PASS' and browser['status'] == 'PASS'
        status = 'PASSED' if complete else 'IN_PROGRESS' if args.allow_in_progress else 'NOT_READY'
        result = {'schemaVersion': 1, 'capturedAt': datetime.now(timezone.utc).isoformat(), 'readOnly': True, 'status': status,
                  'scope': 'generic-task-intake-final-acceptance', 'task5Complete': complete, 'ownerId': args.owner,
                  'works': works, 'restartContinuity': restart, 'legacyRetention': legacy, 'browserEntry': browser,
                  'receiptReferences': references}
        output = args.output or args.runtime_root / 'artifacts' / ('generic-intake-' + uuid.uuid4().hex[:12] + '.json')
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as stream: json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
        print(json.dumps({'status': status, 'task5Complete': complete, 'readOnly': True, 'receipt': str(output), 'works': [work['workItemId'] for work in works]}))
        return 0 if status == 'PASSED' else 3 if status == 'IN_PROGRESS' else 2
    except Exception:
        print(json.dumps({'status': 'ERROR', 'readOnly': True, 'message': 'Private read-only capture failed; no readiness is claimed. Check local arguments, permissions and service availability.'}))
        return 1


if __name__ == '__main__': sys.exit(main())
