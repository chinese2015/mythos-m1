#!/usr/bin/env python3
"""Back up and reset Alice's main Argon Task Center demo state.

Run locally from m1. The default invocation is read-only; pass --apply to
perform the reset on the configured Ubuntu host. This file is streamed over
OpenSSH stdin so credentials remain on that host.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
from typing import Any, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


HOST = 'hx@ubuntu.huaxia2002.cn'
OWNER = 'alice'
HOME = Path('/home/hx')
MAIN_ROOT = HOME / 'argon-m1'
BRAIN_ROOT = HOME / '.argon-brain'
BRAIN_DB = BRAIN_ROOT / 'brain.sqlite3'
TOKEN_FILE = BRAIN_ROOT / 'tokens.json'
SANDBOX_ROOT = HOME / 'argon-sandboxes'
SANDBOX_DB = SANDBOX_ROOT / 'sandboxes.sqlite3'
SANDBOX_CLI = MAIN_ROOT / 'sandbox.py'
GITEA_CREDENTIAL_FILE = HOME / 'gitea/secrets/argon-agent.json'
BACKUP_ROOT = HOME / 'backups/argon-main-demo-reset'
GITEA_ORIGIN = 'http://127.0.0.1:13000'
BRAIN_ORIGIN = 'http://127.0.0.1:13081'
FINDING_ORIGIN = 'http://127.0.0.1:18081'
SANDBOX_HELPER_IMAGE = 'argon-dsh-sandbox:0.2.0-rc.2'
ACTIVE_OPERATION_STATES = {'QUEUED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'UNKNOWN'}
ACTIVE_WORKFLOW_PHASES = {'PREPARING', 'BASELINE', 'PLANNING', 'CODING', 'VERIFYING'}
PAUSE_WORKFLOW_PHASES = {'PUBLISHING', 'CLOSING', 'PR_OPEN'}
TASK_IDEMPOTENCY_PREDICATE = (
    "scope IN ('create-work-item','create-manual-task','intake-decide') "
    "OR scope LIKE 'claim-task:%' OR scope LIKE 'bind-session:%' OR scope LIKE 'workflow:%' "
    "OR scope LIKE 'submit:%' OR scope LIKE 'cancel:%' OR scope LIKE 'pause:%' OR scope LIKE 'resume:%'"
)
FINDING_MAPPINGS = {
    'FND-00003': ('http://127.0.0.1:13000/demo/demo-orion-notes-api.git',
                  '2ce309f4dd7a39a22fcce59ad4309a50e1df237e',
                  'src/main/java/com/example/notes/AppConfig.java'),
    'FND-00009': ('http://127.0.0.1:13000/demo/demo-nova-catalog-api.git',
                  '7fd32b0535fac3f6ce105a8494e2dcbba7ce355b',
                  'src/main/java/com/example/catalog/CatalogSearchService.java'),
    'FND-00015': ('http://127.0.0.1:13000/demo/demo-pixel-reports-batch.git',
                  '0a67ffc801aad448a0992ba84aabc5d47d63c478',
                  'src/main/java/com/example/reports/ReportImporter.java'),
}
RESET_FINDING_FIELDS = {
    'status': 'Not Started',
    'closed': 'Open',
    'workItemId': '',
    'remediationJobId': '',
    'triageResult': 'UNTRIAGED',
    'verificationResult': 'NOT_RUN',
    'codeFixCommit': '',
    'prUrl': '',
}
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class ResetFailure(RuntimeError):
    """An expected, redacted failure safe to show to the operator."""

    def __init__(self, stage: str, code: str):
        super().__init__(code)
        self.stage = stage
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


def fail(stage: str, code: str) -> None:
    raise ResetFailure(stage, code)


def _opener():
    return build_opener(ProxyHandler({}), NoRedirect())


def _json_request(url: str, *, stage: str, method: str = 'GET',
                  body: Optional[dict[str, Any]] = None,
                  headers: Optional[dict[str, str]] = None,
                  allow_statuses: Sequence[int] = (200,)) -> tuple[int, Any]:
    request_headers = {'Accept': 'application/json'}
    request_headers.update(headers or {})
    payload = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        request_headers['Content-Type'] = 'application/json'
    request = Request(url, data=payload, method=method, headers=request_headers)
    try:
        with _opener().open(request, timeout=10) as response:
            status = response.status
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        status = error.code
        error.close()
        raw = b''
    except (URLError, TimeoutError, OSError):
        fail(stage, 'service-unavailable')
    if status not in allow_statuses:
        fail(stage, f'http-{status}')
    if status == 204 or not raw:
        return status, None
    if len(raw) > MAX_RESPONSE_BYTES:
        fail(stage, 'response-too-large')
    try:
        return status, json.loads(raw.decode('utf-8'))
    except (UnicodeError, ValueError):
        fail(stage, 'invalid-json')


def _read_private_json(path: Path, *, stage: str, maximum: int) -> dict[str, Any]:
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        fail(stage, 'private-file-unavailable')
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > maximum):
            fail(stage, 'private-file-unsafe')
        with os.fdopen(descriptor, 'r', encoding='utf-8') as stream:
            descriptor = -1
            value = json.load(stream)
        if not isinstance(value, dict):
            fail(stage, 'private-json-invalid')
        return value
    except (OSError, UnicodeError, ValueError):
        fail(stage, 'private-json-invalid')
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def _read_only_connection(path: Path, *, stage: str) -> sqlite3.Connection:
    try:
        uri = 'file:' + quote(str(path), safe='/') + '?mode=ro'
        connection = sqlite3.connect(uri, uri=True, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        return connection
    except sqlite3.Error:
        fail(stage, 'database-unavailable')


def _brain_headers(token: str) -> dict[str, str]:
    return {'Authorization': 'Bearer ' + token}


def _brain_get(inventory: dict[str, Any], path: str) -> Any:
    _, value = _json_request(BRAIN_ORIGIN + path, stage='brain-read',
                             headers=_brain_headers(inventory['brainToken']))
    return value


def _brain_post(inventory: dict[str, Any], path: str, body: dict[str, Any], *, idempotency_key: str) -> Any:
    headers = _brain_headers(inventory['brainToken'])
    headers['Idempotency-Key'] = idempotency_key
    _, value = _json_request(BRAIN_ORIGIN + path, stage='brain-write', method='POST',
                             body=body, headers=headers)
    return value


def _gitea_request(inventory: dict[str, Any], path: str, *, method: str = 'GET',
                   body: Optional[dict[str, Any]] = None,
                   allow_statuses: Sequence[int] = (200,)) -> tuple[int, Any]:
    status, value = _json_request(GITEA_ORIGIN + '/api/v1' + path, stage='gitea', method=method,
                                  body=body, headers={'Authorization': inventory['giteaAuthorization']},
                                  allow_statuses=allow_statuses)
    return status, value


def _repository_from_url(value: Any, *, stage: str) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        fail(stage, 'repository-url-invalid')
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or port != 13000
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not parsed.path.endswith('.git')):
        fail(stage, 'repository-url-invalid')
    repository = parsed.path[1:-4] if parsed.path.startswith('/') else ''
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', repository):
        fail(stage, 'repository-name-invalid')
    return repository


def _parse_pull_url(value: Any, *, stage: str) -> Optional[tuple[str, int]]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        fail(stage, 'pull-url-invalid')
    match = re.fullmatch(r'/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})/pulls/([1-9][0-9]{0,8})', parsed.path)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or port != 13000
            or parsed.username or parsed.password or parsed.query or parsed.fragment or not match):
        fail(stage, 'pull-url-invalid')
    return match.group(1), int(match.group(2))


def _collect_sandbox_ids(value: Any, result: set[str]) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in {'sandboxId', 'sandbox_id'} and isinstance(nested, str):
                result.add(nested)
            _collect_sandbox_ids(nested, result)
    elif isinstance(value, list):
        for nested in value:
            _collect_sandbox_ids(nested, result)


def _repo_url_for_work(work: dict[str, Any], delivery: dict[str, Any]) -> Optional[str]:
    if isinstance(delivery.get('repositoryUrl'), str):
        return delivery['repositoryUrl']
    record = work.get('sourceRecord')
    if isinstance(record, dict) and isinstance(record.get('repositoryUrl'), str):
        return record['repositoryUrl']
    task_spec = work.get('taskSpec')
    if isinstance(task_spec, dict):
        repository = task_spec.get('repository')
        if isinstance(repository, dict) and isinstance(repository.get('cloneUrl'), str):
            return repository['cloneUrl']
    return None


def _validate_pull_detail(candidate: dict[str, Any], pull: Any, *, stage: str) -> None:
    if not isinstance(pull, dict):
        fail(stage, 'gitea-pr-response-invalid')
    expected_url = f'{GITEA_ORIGIN}/{candidate["repository"]}/pulls/{candidate["number"]}'
    if pull.get('html_url') != expected_url or pull.get('number') != candidate['number']:
        fail(stage, 'gitea-pr-url-mismatch')
    head = pull.get('head') or {}
    base = pull.get('base') or {}
    head_repo = head.get('repo') or {}
    base_repo = base.get('repo') or {}
    if head_repo.get('full_name') != candidate['repository'] or base_repo.get('full_name') != candidate['repository']:
        fail(stage, 'gitea-pr-repository-mismatch')
    if candidate.get('candidateCommit') and head.get('sha', '').lower() != candidate['candidateCommit'].lower():
        fail(stage, 'gitea-pr-head-mismatch')
    if candidate.get('headBranch') and head.get('ref') != candidate['headBranch']:
        fail(stage, 'gitea-pr-branch-mismatch')
    if candidate.get('baseBranch') and base.get('ref') != candidate['baseBranch']:
        fail(stage, 'gitea-pr-base-mismatch')
    if candidate.get('identityType') == 'delivery':
        marker = candidate.get('deliveryId')
        candidate_commit = candidate.get('candidateCommit')
        if (not isinstance(marker, str) or not re.fullmatch(r'[a-f0-9]{64}', marker)
                or not isinstance(candidate_commit, str) or not re.fullmatch(r'[a-f0-9]{40}', candidate_commit)
                or not isinstance(candidate.get('headBranch'), str) or not candidate['headBranch']
                or not isinstance(candidate.get('baseBranch'), str) or not candidate['baseBranch']):
            fail(stage, 'linked-delivery-identity-incomplete')
        if f'<!-- mythos-delivery:{marker} -->' not in (pull.get('body') or ''):
            fail(stage, 'gitea-pr-marker-mismatch')


def _list_pull_requests(inventory: dict[str, Any], repository: str) -> list[dict[str, Any]]:
    encoded_repository = quote(repository, safe='/')
    rows: list[dict[str, Any]] = []
    for page in range(1, 21):
        path = f'/repos/{encoded_repository}/pulls?state=all&sort=oldest&limit=100&page={page}'
        _, values = _gitea_request(inventory, path)
        if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
            fail('inventory', 'gitea-pr-list-invalid')
        if not values:
            return rows
        rows.extend(values)
    fail('inventory', 'gitea-pr-list-incomplete')


def _pull_candidates(inventory: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: dict[tuple[str, int], dict[str, Any]] = {}

    def add(candidate: dict[str, Any]) -> None:
        key = (candidate['repository'], candidate['number'])
        prior = candidates.get(key)
        if prior is None:
            candidates[key] = candidate
            return
        for field in ('url', 'candidateCommit', 'headBranch', 'baseBranch', 'deliveryId'):
            left, right = prior.get(field), candidate.get(field)
            if left and right and left != right:
                fail('inventory', 'linked-pr-identity-conflict')
            if not left and right:
                prior[field] = right

    for snapshot in inventory['snapshots'].values():
        work = snapshot['workItem']
        delivery = ((work.get('workflow') or {}).get('delivery') or {})
        pull_number = delivery.get('pullNumber')
        pull_url = delivery.get('pullUrl')
        if pull_number is None and not pull_url:
            repository = delivery.get('repository')
            head_branch = delivery.get('headBranch')
            delivery_id = delivery.get('id')
            if not repository or not head_branch:
                continue
            if (not isinstance(repository, str) or not re.fullmatch(
                    r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', repository)
                    or not isinstance(head_branch, str) or not isinstance(delivery_id, str)):
                fail('inventory', 'pending-delivery-identity-invalid')
            candidate_commit = delivery.get('candidateCommit')
            base_branch = delivery.get('baseBranch')
            if (not re.fullmatch(r'[a-f0-9]{64}', delivery_id)
                    or not re.fullmatch(r'[a-f0-9]{40}', candidate_commit or '')
                    or not isinstance(base_branch, str) or not base_branch):
                fail('inventory', 'pending-delivery-identity-incomplete')
            marker_text = f'<!-- mythos-delivery:{delivery_id} -->'
            matches = [pull for pull in _list_pull_requests(inventory, repository)
                       if (pull.get('head') or {}).get('ref') == head_branch
                       or marker_text in (pull.get('body') or '')]
            if len(matches) > 1:
                fail('inventory', 'pending-delivery-pr-ambiguous')
            if not matches:
                continue
            pull_number = matches[0].get('number')
            pull_url = matches[0].get('html_url')
            if type(pull_number) is not int or not isinstance(pull_url, str):
                fail('inventory', 'pending-delivery-pr-invalid')
            candidate = {
                'repository': repository, 'number': pull_number, 'url': pull_url,
                'candidateCommit': candidate_commit,
                'headBranch': head_branch, 'baseBranch': base_branch,
                'deliveryId': delivery_id, 'identityType': 'delivery',
                'sourceId': (work.get('source') or {}).get('id'),
            }
            parsed = _parse_pull_url(pull_url, stage='inventory')
            if parsed != (repository, pull_number):
                fail('inventory', 'pending-delivery-pr-url-mismatch')
            add(candidate)
            continue
        if type(pull_number) is not int or pull_number < 1 or not isinstance(pull_url, str):
            fail('inventory', 'linked-pr-incomplete')
        parsed = _parse_pull_url(pull_url, stage='inventory')
        repository = delivery.get('repository')
        if not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', repository):
            fail('inventory', 'linked-pr-repository-invalid')
        if parsed != (repository, pull_number):
            fail('inventory', 'linked-pr-url-mismatch')
        repository_url = _repo_url_for_work(work, delivery)
        if repository_url and _repository_from_url(repository_url, stage='inventory') != repository:
            fail('inventory', 'linked-pr-repository-mismatch')
        candidate_commit = delivery.get('candidateCommit')
        head_branch = delivery.get('headBranch')
        base_branch = delivery.get('baseBranch')
        delivery_id = delivery.get('id')
        if (not isinstance(candidate_commit, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', candidate_commit)
                or not isinstance(head_branch, str) or not head_branch
                or not isinstance(base_branch, str) or not base_branch
                or not isinstance(delivery_id, str) or not re.fullmatch(r'[a-f0-9]{64}', delivery_id)):
            fail('inventory', 'linked-delivery-identity-incomplete')
        candidate = {
            'repository': repository, 'number': pull_number, 'url': pull_url,
            'candidateCommit': candidate_commit.lower(),
            'headBranch': head_branch, 'baseBranch': base_branch,
            'deliveryId': delivery_id, 'identityType': 'delivery',
            'sourceId': (work.get('source') or {}).get('id'),
        }
        add(candidate)

    for finding_id, finding in inventory['findings'].items():
        pull_url = finding.get('prUrl')
        if not pull_url:
            continue
        parsed = _parse_pull_url(pull_url, stage='inventory')
        repository = _repository_from_url(finding.get('repositoryUrl'), stage='inventory')
        if parsed is None or parsed[0] != repository:
            fail('inventory', 'finding-pr-repository-mismatch')
        candidate_commit = finding.get('codeFixCommit')
        if not isinstance(candidate_commit, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', candidate_commit):
            fail('inventory', 'finding-pr-commit-missing')
        add({'repository': repository, 'number': parsed[1], 'url': pull_url,
             'candidateCommit': candidate_commit.lower(), 'headBranch': None,
             'baseBranch': None, 'deliveryId': None, 'identityType': 'finding',
             'sourceId': finding_id})

    result = []
    for candidate in candidates.values():
        repository = quote(candidate['repository'], safe='/')
        status, pull = _gitea_request(inventory, f'/repos/{repository}/pulls/{candidate["number"]}',
                                      allow_statuses=(200, 404))
        if status == 404:
            result.append({**candidate, 'state': 'missing', 'merged': False, 'action': 'noop'})
            continue
        _validate_pull_detail(candidate, pull, stage='inventory')
        merged = pull.get('merged') is True
        state = pull.get('state')
        if state not in {'open', 'closed'}:
            fail('inventory', 'gitea-pr-state-invalid')
        action = 'close' if state == 'open' and not merged else 'noop'
        result.append({**candidate, 'state': state, 'merged': merged, 'action': action})
    return result


def _validate_sandbox_row(row: dict[str, Any], root: Path) -> None:
    sandbox_id = row.get('sandbox_id')
    if (not isinstance(sandbox_id, str) or not re.fullmatch(r'sb-[0-9a-f]{16}', sandbox_id)
            or row.get('container_name') != 'argon-' + sandbox_id
            or row.get('owner_id') != OWNER):
        fail('inventory', 'sandbox-identity-invalid')
    expected = root / sandbox_id / 'workspace'
    if Path(row.get('workspace_path', '')) != expected:
        fail('inventory', 'sandbox-path-mismatch')
    parent = root / sandbox_id
    workspace = expected
    if (parent.is_symlink() or (parent.exists() and parent.resolve() != parent)
            or workspace.is_symlink() or (workspace.exists() and workspace.resolve() != workspace)):
        fail('inventory', 'sandbox-path-unsafe')
    if parent.parent.resolve() != root:
        fail('inventory', 'sandbox-path-escape')


def _inspect_container(row: dict[str, Any]) -> Optional[dict[str, Any]]:
    name = row['container_name']
    process = subprocess.run(
        ['docker', 'inspect', '--format', '{{.Id}}|{{.State.Running}}|{{json .Config.Labels}}', name],
        capture_output=True, text=True, timeout=10)
    if process.returncode:
        if 'No such object' in process.stderr or 'no such object' in process.stderr.lower():
            return None
        fail('inventory', 'docker-inspect-failed')
    parts = process.stdout.strip().split('|', 2)
    if len(parts) != 3:
        fail('inventory', 'docker-inspect-invalid')
    try:
        labels = json.loads(parts[2]) or {}
    except ValueError:
        fail('inventory', 'docker-labels-invalid')
    if not re.fullmatch(r'[0-9a-f]{64}', parts[0]) or parts[1] not in {'true', 'false'}:
        fail('inventory', 'docker-inspect-invalid')
    if labels.get('argon.owner') != OWNER or labels.get('argon.sandbox') != row['sandbox_id']:
        fail('inventory', 'docker-owner-label-mismatch')
    return {'containerId': parts[0], 'running': parts[1] == 'true'}


def _run_cleanup_helper(workspace: Path) -> None:
    process = subprocess.run([
        'docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--user', '0:0',
        '--mount', f'type=bind,src={workspace},dst=/wipe',
        '--entrypoint', '/bin/sh', SANDBOX_HELPER_IMAGE,
        '-c', 'find /wipe -mindepth 1 -delete',
    ], capture_output=True, text=True, timeout=60)
    if process.returncode:
        fail('sandboxes', 'workspace-cleanup-failed')


def _check_cleanup_helper() -> None:
    process = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                              '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--user', '0:0',
                              '--entrypoint', '/bin/sh', SANDBOX_HELPER_IMAGE,
                              '-c', 'command -v find >/dev/null'],
                             capture_output=True, timeout=20)
    if process.returncode:
        fail('sandbox-helper', 'cleanup-image-invalid')


def _remove_ssh_include(include_path: Path) -> None:
    config = HOME / '.ssh/config'
    if not config.exists():
        return
    if config.is_symlink() or not config.is_file():
        fail('sandboxes', 'ssh-config-unsafe')
    lock = config.parent / '.argon-ssh-config.lock'
    if lock.is_symlink():
        fail('sandboxes', 'ssh-config-lock-unsafe')
    try:
        with lock.open('a') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            lines = config.read_text(encoding='utf-8').splitlines(keepends=True)
            target = 'Include ' + str(include_path)
            kept = [line for line in lines if line.rstrip('\r\n') != target]
            if len(kept) == len(lines):
                return
            descriptor, temporary = tempfile.mkstemp(prefix='.argon-ssh-config-clean-', dir=config.parent)
            try:
                with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                    output.writelines(kept)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(temporary, stat.S_IMODE(config.stat().st_mode))
                os.replace(temporary, config)
            finally:
                Path(temporary).unlink(missing_ok=True)
    except OSError:
        fail('sandboxes', 'ssh-config-update-failed')


def build_inventory() -> dict[str, Any]:
    stage = 'preflight'
    if Path.home() != HOME:
        fail(stage, 'remote-home-mismatch')
    for port in (13000, 13080, 13081, 18081):
        if not _port_open(port):
            fail(stage, 'expected-port-unavailable')
    for path in (MAIN_ROOT, BRAIN_ROOT, SANDBOX_ROOT):
        if path.is_symlink() or not path.is_dir():
            fail(stage, 'expected-root-unsafe')
    for path in (BRAIN_DB, SANDBOX_DB):
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
            fail(stage, 'expected-database-unsafe')
    if SANDBOX_ROOT.resolve() != SANDBOX_ROOT or not SANDBOX_CLI.is_file() or SANDBOX_CLI.is_symlink():
        fail(stage, 'sandbox-root-mismatch')

    token_data = _read_private_json(TOKEN_FILE, stage=stage, maximum=256 * 1024)
    tokens = token_data.get('owners')
    token = tokens.get(OWNER) if isinstance(tokens, dict) else None
    if not isinstance(token, str) or len(token) < 32:
        fail(stage, 'alice-token-unavailable')
    credential_data = _read_private_json(GITEA_CREDENTIAL_FILE, stage=stage, maximum=64 * 1024)
    username, password = credential_data.get('username'), credential_data.get('password')
    if not isinstance(username, str) or not username or not isinstance(password, str) or len(password) < 16:
        fail(stage, 'gitea-credentials-invalid')
    auth = 'Basic ' + base64.b64encode((username + ':' + password).encode('utf-8')).decode('ascii')
    _, health = _json_request(BRAIN_ORIGIN + '/health', stage=stage)
    if not isinstance(health, dict) or health.get('status') != 'ok':
        fail(stage, 'brain-health-invalid')
    inventory: dict[str, Any] = {
        'owner': OWNER, 'brainToken': token, 'giteaAuthorization': auth,
        'workItems': [], 'snapshots': {}, 'intakes': [], 'findings': {},
        'repositories': [], 'pullRequests': [], 'sandboxes': [],
        'pauseWorkItemIds': [], 'pausedWorkItemIds': [],
        'linkedSandboxIds': [], 'otherSandboxIds': [], 'otherWorkItemIds': [],
        'closedPullRequests': [], 'resetFindingIds': [], 'removedSandboxIds': [],
        'deletedBrain': None, 'backup': None,
    }

    stage = 'inventory'
    work_body = _brain_get(inventory, '/api/brain/work-items')
    intake_body = _brain_get(inventory, '/api/brain/source-intakes')
    repository_body = _brain_get(inventory, '/api/brain/repositories')
    if not isinstance(work_body, dict) or not isinstance(work_body.get('workItems'), list):
        fail(stage, 'brain-work-items-invalid')
    if not isinstance(intake_body, dict) or not isinstance(intake_body.get('intakes'), list):
        fail(stage, 'brain-intakes-invalid')
    if not isinstance(repository_body, dict) or not isinstance(repository_body.get('repositories'), list):
        fail(stage, 'brain-repositories-invalid')
    inventory['workItems'] = work_body['workItems']
    inventory['intakes'] = intake_body['intakes']
    inventory['repositories'] = repository_body['repositories']
    for item in inventory['workItems']:
        if not isinstance(item, dict) or item.get('ownerId') != OWNER or not isinstance(item.get('workItemId'), str):
            fail(stage, 'work-item-owner-or-shape-invalid')
        work_id = item['workItemId']
        if work_id in inventory['snapshots']:
            fail(stage, 'duplicate-work-item')
        safe_id = quote(work_id, safe='')
        snapshot = _brain_get(inventory, '/api/brain/work-items/' + safe_id)
        if not isinstance(snapshot, dict) or snapshot.get('workItem') != item:
            fail(stage, 'work-item-snapshot-mismatch')
        operations = snapshot.get('operations')
        if not isinstance(operations, list):
            fail(stage, 'work-item-operations-invalid')
        workflow = item.get('workflow') or {}
        phase = workflow.get('phase')
        if phase in ACTIVE_WORKFLOW_PHASES:
            fail(stage, 'active-workflow-phase')
        if phase in PAUSE_WORKFLOW_PHASES:
            inventory['pauseWorkItemIds'].append(work_id)
        for operation in operations:
            if (not isinstance(operation, dict) or operation.get('ownerId') != OWNER
                    or operation.get('workItemId') != work_id):
                fail(stage, 'operation-owner-or-binding-invalid')
            if operation.get('state') in ACTIVE_OPERATION_STATES:
                fail(stage, 'active-or-unknown-operation')
        inventory['snapshots'][work_id] = snapshot
    for intake in inventory['intakes']:
        if not isinstance(intake, dict) or not isinstance(intake.get('findingId'), str):
            fail(stage, 'intake-shape-invalid')

    connection = _read_only_connection(BRAIN_DB, stage=stage)
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required_tables = {'schema_version', 'work_items', 'operations', 'events', 'logs',
                           'evidence', 'task_claims', 'work_sessions', 'source_intakes',
                           'idempotency', 'repositories'}
        if not required_tables <= tables or connection.execute('SELECT version FROM schema_version').fetchone()[0] != 1:
            fail(stage, 'brain-schema-unsupported')
        database_items = {row['id']: json.loads(row['data']) for row in connection.execute(
            'SELECT id,data FROM work_items WHERE owner=? ORDER BY id', (OWNER,))}
        api_items = {item['workItemId']: item for item in inventory['workItems']}
        if database_items != api_items:
            fail(stage, 'brain-api-database-work-items-disagree')
        database_intakes = {row['finding_id'] for row in connection.execute(
            'SELECT finding_id FROM source_intakes WHERE owner=?', (OWNER,))}
        api_intakes = {item['findingId'] for item in inventory['intakes']}
        if database_intakes != api_intakes:
            fail(stage, 'brain-api-database-intakes-disagree')
        database_repositories = {row['id'] for row in connection.execute(
            'SELECT id FROM repositories WHERE owner=?', (OWNER,))}
        api_repositories = {item.get('repositoryId') for item in inventory['repositories']
                            if isinstance(item, dict) and item.get('ownerId') == OWNER}
        if database_repositories != api_repositories:
            fail(stage, 'brain-api-database-repositories-disagree')
        inventory['repositoryIds'] = sorted(database_repositories)
        inventory['otherWorkItemIds'] = sorted(row['id'] for row in connection.execute(
            'SELECT id FROM work_items WHERE owner!=?', (OWNER,)))
        linked_sandbox_ids: set[str] = set()
        for snapshot in inventory['snapshots'].values():
            _collect_sandbox_ids(snapshot, linked_sandbox_ids)
        for work_id in database_items:
            for event in connection.execute('SELECT data FROM events WHERE work_id=?', (work_id,)):
                try:
                    _collect_sandbox_ids(json.loads(event['data']), linked_sandbox_ids)
                except (TypeError, ValueError):
                    fail(stage, 'work-item-event-invalid')
        inventory['linkedSandboxIds'] = sorted(linked_sandbox_ids)
    except sqlite3.Error:
        fail(stage, 'brain-database-read-failed')
    finally:
        connection.close()

    for finding_id, expected in FINDING_MAPPINGS.items():
        _, finding = _json_request(FINDING_ORIGIN + '/api/findings/' + finding_id, stage=stage)
        if not isinstance(finding, dict) or finding.get('id') != finding_id:
            fail(stage, 'finding-unavailable')
        observed = (finding.get('repositoryUrl'), finding.get('baseCommit'), finding.get('sourcePath'))
        if observed != expected or type(finding.get('revision')) is not int:
            fail(stage, 'finding-mapping-or-revision-mismatch')
        _, reset_capability = _json_request(
            FINDING_ORIGIN + '/api/findings/' + finding_id + '/reset-demo', stage=stage)
        if (not isinstance(reset_capability, dict) or reset_capability.get('supported') is not True
                or reset_capability.get('revision') != finding['revision']):
            fail(stage, 'finding-reset-cas-unavailable')
        inventory['findings'][finding_id] = finding

    # Gitea credentials are checked here, before any write, and never leave memory.
    status, user = _gitea_request(inventory, '/user')
    if status != 200 or not isinstance(user, dict) or user.get('login') != username:
        fail(stage, 'gitea-authentication-failed')
    inventory['pullRequests'] = _pull_candidates(inventory)

    if subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'],
                      capture_output=True, timeout=10).returncode:
        fail(stage, 'docker-unavailable')
    image = subprocess.run(['docker', 'image', 'inspect', SANDBOX_HELPER_IMAGE],
                           capture_output=True, timeout=10)
    if image.returncode:
        fail(stage, 'sandbox-cleanup-image-unavailable')
    if SANDBOX_DB.is_symlink():
        fail(stage, 'sandbox-database-unsafe')
    registry = _read_only_connection(SANDBOX_DB, stage=stage)
    try:
        columns = {row['name'] for row in registry.execute('PRAGMA table_info(sandboxes)')}
        required_columns = {'sandbox_id', 'owner_id', 'workspace_id', 'workspace_path',
                            'container_name', 'state', 'session_id', 'ssh_port'}
        if not required_columns <= columns:
            fail(stage, 'sandbox-schema-unsupported')
        all_rows = [dict(row) for row in registry.execute('SELECT * FROM sandboxes ORDER BY sandbox_id')]
        row_by_id = {row['sandbox_id']: row for row in all_rows}
        for sandbox_id in linked_sandbox_ids:
            row = row_by_id.get(sandbox_id)
            if row is not None and row.get('owner_id') != OWNER:
                fail(stage, 'linked-sandbox-owner-mismatch')
        selected = [row for row in all_rows if row.get('owner_id') == OWNER and
                    (row.get('workspace_id', '').startswith('task-') or row.get('sandbox_id') in linked_sandbox_ids)]
        for row in selected:
            _validate_sandbox_row(row, SANDBOX_ROOT)
        inventory['sandboxes'] = selected
        selected_ids = {row['sandbox_id'] for row in selected}
        inventory['missingLinkedSandboxIds'] = sorted(linked_sandbox_ids - selected_ids)
        inventory['otherSandboxIds'] = sorted(row['sandbox_id'] for row in all_rows
                                              if row.get('owner_id') != OWNER or row.get('sandbox_id') not in selected_ids)
        known_owned_containers = {row['container_name'] for row in all_rows if row.get('owner_id') == OWNER}
        running = subprocess.run(['docker', 'ps', '--filter', 'label=argon.owner=alice',
                                  '--format', '{{.Names}}'], capture_output=True, text=True, timeout=10)
        if running.returncode or any(name not in known_owned_containers for name in running.stdout.splitlines()):
            fail(stage, 'unregistered-owned-container')
    except sqlite3.Error:
        fail(stage, 'sandbox-database-read-failed')
    finally:
        registry.close()
    inventory['containerStates'] = {}
    for row in inventory['sandboxes']:
        container = _inspect_container(row)
        if container and container['running'] and row.get('state') not in {'running', 'allocated', 'cleanup-pending'}:
            fail(stage, 'sandbox-state-mismatch')
        inventory['containerStates'][row['sandbox_id']] = container
    return inventory


def _manifest(inventory: dict[str, Any]) -> dict[str, Any]:
    return {
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'owner': OWNER,
        'workItemIds': sorted(item['workItemId'] for item in inventory['workItems']),
        'workflowPhases': [{'workItemId': item['workItemId'],
                            'phase': ((item.get('workflow') or {}).get('phase')),
                            'paused': bool(item.get('paused'))} for item in inventory['workItems']],
        'intakes': [{'findingId': row['findingId'], 'state': row.get('state')} for row in inventory['intakes']],
        'findings': {
            finding_id: {key: inventory['findings'][finding_id].get(key) for key in
                         ('revision', 'status', 'closed', 'workItemId', 'remediationJobId',
                          'triageResult', 'verificationResult', 'codeFixCommit', 'prUrl')}
            for finding_id in FINDING_MAPPINGS
        },
        'pullRequests': [{key: row.get(key) for key in
                          ('repository', 'number', 'url', 'state', 'merged', 'action')}
                         for row in inventory['pullRequests']],
        'sandboxRows': [{'sandboxId': row['sandbox_id'], 'workspaceId': row['workspace_id'],
                         'state': row['state']} for row in inventory['sandboxes']],
        'repositoryIdsPreserved': inventory['repositoryIds'],
    }


def create_backup(inventory: dict[str, Any]) -> Path:
    stage = 'backup'
    try:
        os.umask(0o077)
        backup_parent = HOME / 'backups'
        if backup_parent.is_symlink():
            fail(stage, 'backup-parent-unsafe')
        backup_parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if BACKUP_ROOT.is_symlink() or (BACKUP_ROOT.exists() and not BACKUP_ROOT.is_dir()):
            fail(stage, 'backup-root-unsafe')
        BACKUP_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        BACKUP_ROOT.chmod(0o700)
        if BACKUP_ROOT.resolve().parent != backup_parent.resolve():
            fail(stage, 'backup-root-mismatch')
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + os.urandom(3).hex()
        backup_dir = BACKUP_ROOT / stamp
        backup_dir.mkdir(mode=0o700)
        backup_dir.chmod(0o700)
        for source_path, name in ((BRAIN_DB, 'brain.sqlite3'), (SANDBOX_DB, 'sandboxes.sqlite3')):
            source = sqlite3.connect('file:' + quote(str(source_path), safe='/') + '?mode=ro', uri=True, timeout=15)
            destination = sqlite3.connect(str(backup_dir / name), timeout=15)
            try:
                source.backup(destination)
            finally:
                destination.close()
                source.close()
            (backup_dir / name).chmod(0o600)
        manifest_path = backup_dir / 'manifest.json'
        manifest_path.write_text(json.dumps(_manifest(inventory), ensure_ascii=False,
                                            sort_keys=True, indent=2) + '\n', encoding='utf-8')
        manifest_path.chmod(0o600)
        return backup_dir
    except (OSError, sqlite3.Error):
        fail(stage, 'backup-failed')


def _close_pull_requests(inventory: dict[str, Any]) -> None:
    for candidate in inventory['pullRequests']:
        key = (candidate['repository'], candidate['number'])
        repository = quote(candidate['repository'], safe='/')
        path = f'/repos/{repository}/pulls/{candidate["number"]}'
        status, current = _gitea_request(inventory, path, allow_statuses=(200, 404))
        if status == 404:
            candidate.update({'state': 'missing', 'merged': False, 'action': 'noop'})
            continue
        _validate_pull_detail(candidate, current, stage='pull-requests')
        candidate['state'] = current.get('state')
        candidate['merged'] = current.get('merged') is True
        if candidate['merged'] or candidate['state'] == 'closed':
            candidate['action'] = 'noop'
            continue
        if candidate['state'] != 'open':
            fail('pull-requests', 'gitea-pr-state-invalid')
        _gitea_request(inventory, path, method='PATCH', body={'state': 'closed'})
        status, updated = _gitea_request(inventory, path)
        _validate_pull_detail(candidate, updated, stage='pull-requests')
        if status != 200 or updated.get('state') != 'closed' or updated.get('merged') is True:
            fail('pull-requests', 'close-not-confirmed')
        candidate.update({'state': 'closed', 'merged': False, 'action': 'closed'})
        inventory['closedPullRequests'].append({'repository': key[0], 'number': key[1]})


def _pause_pending_deliveries(inventory: dict[str, Any]) -> None:
    for work_id in inventory['pauseWorkItemIds']:
        snapshot = inventory['snapshots'][work_id]
        work = snapshot['workItem']
        if work.get('paused'):
            inventory['pausedWorkItemIds'].append(work_id)
            continue
        version = work.get('version')
        if type(version) is not int or version < 1:
            fail('pause', 'work-item-version-invalid')
        response = _brain_post(inventory, '/api/brain/work-items/' + quote(work_id, safe='') + '/pause',
                               {'expectedVersion': version},
                               idempotency_key='demo-reset-pause-' + secrets.token_hex(16))
        if not isinstance(response, dict) or response.get('paused') is not True:
            fail('pause', 'work-item-pause-not-confirmed')
        inventory['pausedWorkItemIds'].append(work_id)

    latest = _brain_get(inventory, '/api/brain/work-items')
    if not isinstance(latest, dict) or not isinstance(latest.get('workItems'), list):
        fail('pause', 'work-item-refresh-invalid')
    latest_items = {item.get('workItemId'): item for item in latest['workItems'] if isinstance(item, dict)}
    original_ids = {item['workItemId'] for item in inventory['workItems']}
    if set(latest_items) != original_ids:
        fail('pause', 'work-item-inventory-changed')
    refreshed_snapshots = {}
    for work_id in sorted(original_ids):
        snapshot = _brain_get(inventory, '/api/brain/work-items/' + quote(work_id, safe=''))
        if not isinstance(snapshot, dict) or snapshot.get('workItem') != latest_items[work_id]:
            fail('pause', 'work-item-refresh-mismatch')
        refreshed_work = snapshot['workItem']
        original_work = inventory['snapshots'][work_id]['workItem']
        ignored_pause_fields = {'paused', 'status', 'version', 'sequence'}
        original_stable = {key: value for key, value in original_work.items() if key not in ignored_pause_fields}
        refreshed_stable = {key: value for key, value in refreshed_work.items() if key not in ignored_pause_fields}
        if original_stable != refreshed_stable:
            fail('pause', 'work-item-changed-during-pause')
        phase = (refreshed_work.get('workflow') or {}).get('phase')
        if phase in ACTIVE_WORKFLOW_PHASES:
            fail('pause', 'active-workflow-phase')
        if phase in PAUSE_WORKFLOW_PHASES and refreshed_work.get('paused') is not True:
            fail('pause', 'work-item-pause-not-confirmed')
        was_paused = original_work.get('paused') is True
        expected_delta = 0 if was_paused else 1 if phase in PAUSE_WORKFLOW_PHASES else 0
        if (refreshed_work.get('version') != original_work.get('version', 0) + expected_delta
                or refreshed_work.get('sequence') != original_work.get('sequence', 0) + expected_delta
                or refreshed_work.get('paused') is not (was_paused or phase in PAUSE_WORKFLOW_PHASES)):
            fail('pause', 'work-item-pause-transition-invalid')
        operations = snapshot.get('operations')
        if not isinstance(operations, list) or any(
                not isinstance(operation, dict) or operation.get('state') in ACTIVE_OPERATION_STATES
                for operation in operations):
            fail('pause', 'active-or-unknown-operation')
        refreshed_snapshots[work_id] = snapshot
    inventory['workItems'] = [latest_items[item['workItemId']] for item in inventory['workItems']]
    inventory['snapshots'] = refreshed_snapshots
    # Reconcile deliveries after pausing so any late PR create is visible before source reset.
    inventory['pullRequests'] = _pull_candidates(inventory)


def _begin_brain_reset_transaction(inventory: dict[str, Any]) -> sqlite3.Connection:
    """Lock Brain writers and prove the destructive plan still matches the DB."""
    stage = 'brain-guard'
    connection = sqlite3.connect(BRAIN_DB, timeout=15, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('BEGIN IMMEDIATE')
        work_items = {row['id']: json.loads(row['data']) for row in connection.execute(
            'SELECT id,data FROM work_items WHERE owner=? ORDER BY id', (OWNER,))}
        expected_work_items = {item['workItemId']: item for item in inventory['workItems']}
        if work_items != expected_work_items:
            fail(stage, 'brain-work-items-changed')
        for item in work_items.values():
            phase = (item.get('workflow') or {}).get('phase')
            if phase in ACTIVE_WORKFLOW_PHASES:
                fail(stage, 'active-workflow-phase')
            if phase in PAUSE_WORKFLOW_PHASES and item.get('paused') is not True:
                fail(stage, 'pending-workflow-not-paused')

        operation_rows = connection.execute(
            'SELECT id,owner,work_id,kind,state,data FROM operations WHERE owner=? ORDER BY id', (OWNER,)).fetchall()
        expected_operations = {
            operation['operationId']: operation
            for snapshot in inventory['snapshots'].values()
            for operation in snapshot['operations']
        }
        current_operations = {row['id']: json.loads(row['data']) for row in operation_rows}
        if current_operations != expected_operations:
            fail(stage, 'brain-operations-changed')
        if any(row['state'] in ACTIVE_OPERATION_STATES for row in operation_rows):
            fail(stage, 'active-or-unknown-operation')

        intake_rows = connection.execute(
            'SELECT * FROM source_intakes WHERE owner=? ORDER BY finding_id', (OWNER,)).fetchall()
        current_intakes = [{
            'findingId': row['finding_id'], 'owner': row['owner'], 'revision': row['revision'],
            'state': row['state'], 'triage': json.loads(row['triage']), 'notifiedAt': row['notified_at'],
            'lastError': row['last_error'],
            'decision': json.loads(row['decision']) if row['decision'] else None,
            'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
        } for row in intake_rows]
        if current_intakes != inventory['intakes']:
            fail(stage, 'brain-intakes-changed')

        repository_rows = {row['id']: json.loads(row['data']) for row in connection.execute(
            'SELECT id,data FROM repositories WHERE owner=? ORDER BY id', (OWNER,))}
        expected_repositories = {row['repositoryId']: row for row in inventory['repositories']
                                 if isinstance(row, dict) and row.get('ownerId') == OWNER}
        if repository_rows != expected_repositories:
            fail(stage, 'brain-repositories-changed')
        return connection
    except (sqlite3.Error, TypeError, ValueError, KeyError):
        connection.rollback()
        connection.close()
        fail(stage, 'brain-reset-guard-failed')
    except ResetFailure:
        connection.rollback()
        connection.close()
        raise


def _is_finding_reset(row: dict[str, Any]) -> bool:
    return all(row.get(key) == expected for key, expected in RESET_FINDING_FIELDS.items())


def _reset_findings(inventory: dict[str, Any]) -> None:
    for finding_id, expected_mapping in FINDING_MAPPINGS.items():
        old = inventory['findings'][finding_id]
        current_status, current = _json_request(FINDING_ORIGIN + '/api/findings/' + finding_id,
                                                stage='findings')
        if not isinstance(current, dict):
            fail('findings', 'finding-read-invalid')
        if (current.get('repositoryUrl'), current.get('baseCommit'), current.get('sourcePath')) != expected_mapping:
            fail('findings', 'finding-mapping-changed')
        if _is_finding_reset(current):
            inventory['resetFindingIds'].append(finding_id)
            continue
        if current.get('revision') != old.get('revision'):
            fail('findings', 'finding-changed-during-reset')
        _json_request(FINDING_ORIGIN + '/api/findings/' + finding_id, stage='findings',
                      method='PATCH', body=RESET_FINDING_FIELDS)
        _, verified = _json_request(FINDING_ORIGIN + '/api/findings/' + finding_id, stage='findings')
        if not isinstance(verified, dict) or not _is_finding_reset(verified):
            fail('findings', 'finding-reset-not-confirmed')
        inventory['resetFindingIds'].append(finding_id)


def _stop_sandbox(row: dict[str, Any], inventory: dict[str, Any], container: dict[str, Any]) -> dict[str, Any]:
    if not container['running']:
        return row
    process = subprocess.run([sys.executable, str(SANDBOX_CLI), '--root', str(SANDBOX_ROOT),
                              'stop', '--owner', OWNER, row['sandbox_id']],
                            capture_output=True, text=True, timeout=30)
    if process.returncode:
        fail('sandboxes', 'sandbox-stop-not-confirmed')
    stopped = _inspect_container(row)
    if stopped is None or stopped['running']:
        fail('sandboxes', 'sandbox-stop-not-confirmed')
    updated = dict(row)
    updated['state'] = 'stopped'
    return updated


def _remove_sandboxes(inventory: dict[str, Any]) -> None:
    connection = sqlite3.connect(SANDBOX_DB, timeout=15, isolation_level=None)
    connection.row_factory = sqlite3.Row
    for original in inventory['sandboxes']:
        row = dict(original)
        sandbox_id = row['sandbox_id']
        parent = SANDBOX_ROOT / sandbox_id
        workspace = parent / 'workspace'
        container = _inspect_container(row)
        if container is not None and container['running']:
            row = _stop_sandbox(row, inventory, container)
            container = _inspect_container(row)
        if container is not None:
            removed = subprocess.run(['docker', 'rm', container['containerId']],
                                     capture_output=True, text=True, timeout=20)
            if removed.returncode:
                connection.close()
                fail('sandboxes', 'sandbox-container-remove-failed')
        if workspace.exists():
            if workspace.is_symlink() or workspace.resolve() != workspace or workspace.parent.resolve() != parent.resolve():
                connection.close()
                fail('sandboxes', 'workspace-path-unsafe')
            if any(workspace.iterdir()):
                _run_cleanup_helper(workspace)
            if any(workspace.iterdir()):
                connection.close()
                fail('sandboxes', 'workspace-not-empty')
        _remove_ssh_include(parent / 'ssh_config')
        if parent.exists():
            if parent.is_symlink() or parent.resolve() != parent or parent.parent.resolve() != SANDBOX_ROOT:
                connection.close()
                fail('sandboxes', 'sandbox-parent-unsafe')
            try:
                shutil.rmtree(parent)
            except OSError:
                connection.close()
                fail('sandboxes', 'sandbox-directory-remove-failed')

        try:
            connection.execute('BEGIN IMMEDIATE')
            current = connection.execute('SELECT * FROM sandboxes WHERE sandbox_id=? AND owner_id=?',
                                         (sandbox_id, OWNER)).fetchone()
            if current is None:
                connection.commit()
                inventory['removedSandboxIds'].append(sandbox_id)
                continue
            current_row = dict(current)
            expected_row = dict(original)
            if original.get('state') in {'running', 'allocated', 'cleanup-pending'} and current_row.get('state') == 'stopped':
                expected_row['state'] = 'stopped'
            if current_row != expected_row:
                connection.rollback()
                connection.close()
                fail('sandboxes', 'sandbox-registry-changed')
            connection.execute('DELETE FROM sandboxes WHERE sandbox_id=? AND owner_id=?', (sandbox_id, OWNER))
            connection.commit()
            inventory['removedSandboxIds'].append(sandbox_id)
        except sqlite3.Error:
            connection.rollback()
            connection.close()
            fail('sandboxes', 'sandbox-registry-update-failed')
    connection.close()


def _delete_brain_graph(inventory: dict[str, Any]) -> dict[str, int]:
    stage = 'brain'
    try:
        connection = sqlite3.connect(BRAIN_DB, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('BEGIN IMMEDIATE')
        work_ids = sorted(item['workItemId'] for item in inventory['workItems'])
        intake_ids = sorted(item['findingId'] for item in inventory['intakes'])
        current_work_ids = [row['id'] for row in connection.execute(
            'SELECT id FROM work_items WHERE owner=? ORDER BY id', (OWNER,))]
        current_intake_ids = [row['finding_id'] for row in connection.execute(
            'SELECT finding_id FROM source_intakes WHERE owner=? ORDER BY finding_id', (OWNER,))]
        if current_work_ids != work_ids or current_intake_ids != intake_ids:
            connection.rollback()
            connection.close()
            fail(stage, 'brain-inventory-changed')
        active = connection.execute(
            "SELECT id FROM operations WHERE owner=? AND state IN ('QUEUED','STARTING','RUNNING','CANCEL_REQUESTED','UNKNOWN')",
            (OWNER,)).fetchall()
        if active:
            connection.rollback()
            connection.close()
            fail(stage, 'active-or-unknown-operation')
        repository_ids = [row['id'] for row in connection.execute(
            'SELECT id FROM repositories WHERE owner=? ORDER BY id', (OWNER,))]
        if repository_ids != inventory['repositoryIds']:
            connection.rollback()
            connection.close()
            fail(stage, 'repository-inventory-changed')
        operation_ids = [row['id'] for row in connection.execute(
            'SELECT id FROM operations WHERE owner=? AND work_id IN (SELECT id FROM work_items WHERE owner=?)',
            (OWNER, OWNER))]
        counts: dict[str, int] = {}
        if operation_ids:
            placeholders = ','.join('?' for _ in operation_ids)
            counts['logs'] = connection.execute(
                'DELETE FROM logs WHERE operation_id IN (' + placeholders + ')', operation_ids).rowcount
            counts['evidence'] = connection.execute(
                'DELETE FROM evidence WHERE operation_id IN (' + placeholders + ')', operation_ids).rowcount
            counts['operations'] = connection.execute(
                'DELETE FROM operations WHERE owner=? AND id IN (' + placeholders + ')',
                [OWNER] + operation_ids).rowcount
        if work_ids:
            placeholders = ','.join('?' for _ in work_ids)
            counts['events'] = connection.execute(
                'DELETE FROM events WHERE work_id IN (' + placeholders + ')', work_ids).rowcount
            counts['claims'] = connection.execute(
                'DELETE FROM task_claims WHERE owner=? AND work_id IN (' + placeholders + ')',
                [OWNER] + work_ids).rowcount
            counts['sessions'] = connection.execute(
                'DELETE FROM work_sessions WHERE owner=? AND work_id IN (' + placeholders + ')',
                [OWNER] + work_ids).rowcount
        counts['taskIdempotency'] = connection.execute(
            'DELETE FROM idempotency WHERE owner=? AND (' + TASK_IDEMPOTENCY_PREDICATE + ')',
            (OWNER,)).rowcount
        counts['intakes'] = connection.execute('DELETE FROM source_intakes WHERE owner=?', (OWNER,)).rowcount
        if work_ids:
            placeholders = ','.join('?' for _ in work_ids)
            counts['workItems'] = connection.execute(
                'DELETE FROM work_items WHERE owner=? AND id IN (' + placeholders + ')',
                [OWNER] + work_ids).rowcount
        if connection.execute('PRAGMA foreign_key_check').fetchall():
            connection.rollback()
            connection.close()
            fail(stage, 'foreign-key-check-failed')
        connection.commit()
        remaining_work = connection.execute('SELECT count(*) FROM work_items WHERE owner=?', (OWNER,)).fetchone()[0]
        remaining_intakes = connection.execute('SELECT count(*) FROM source_intakes WHERE owner=?', (OWNER,)).fetchone()[0]
        remaining_task_idempotency = connection.execute(
            'SELECT count(*) FROM idempotency WHERE owner=? AND (' + TASK_IDEMPOTENCY_PREDICATE + ')',
            (OWNER,)).fetchone()[0]
        remaining_repositories = [row['id'] for row in connection.execute(
            'SELECT id FROM repositories WHERE owner=? ORDER BY id', (OWNER,))]
        connection.close()
        if remaining_work or remaining_intakes or remaining_task_idempotency or remaining_repositories != repository_ids:
            fail(stage, 'brain-reset-not-confirmed')
        return counts
    except sqlite3.Error:
        fail(stage, 'brain-transaction-failed')


def _verify(inventory: dict[str, Any]) -> dict[str, Any]:
    stage = 'verification'
    work_body = _brain_get(inventory, '/api/brain/work-items')
    intake_body = _brain_get(inventory, '/api/brain/source-intakes')
    repository_body = _brain_get(inventory, '/api/brain/repositories')
    if (not isinstance(work_body, dict) or work_body.get('workItems') != []
            or not isinstance(intake_body, dict) or intake_body.get('intakes') != []
            or not isinstance(repository_body, dict)):
        fail(stage, 'brain-api-verification-failed')
    repository_ids = sorted(row.get('repositoryId') for row in repository_body['repositories']
                            if isinstance(row, dict) and row.get('ownerId') == OWNER)
    if repository_ids != inventory['repositoryIds']:
        fail(stage, 'repository-verification-failed')
    brain_db = _read_only_connection(BRAIN_DB, stage=stage)
    try:
        task_idempotency = brain_db.execute(
            'SELECT count(*) FROM idempotency WHERE owner=? AND (' + TASK_IDEMPOTENCY_PREDICATE + ')',
            (OWNER,)).fetchone()[0]
        if task_idempotency:
            fail(stage, 'task-idempotency-remains')
        other_work_item_ids = sorted(row['id'] for row in brain_db.execute(
            'SELECT id FROM work_items WHERE owner!=?', (OWNER,)))
        if other_work_item_ids != inventory['otherWorkItemIds']:
            fail(stage, 'other-owner-work-items-changed')
    finally:
        brain_db.close()
    for candidate in inventory['pullRequests']:
        repository = quote(candidate['repository'], safe='/')
        path = f'/repos/{repository}/pulls/{candidate["number"]}'
        status, pull = _gitea_request(inventory, path, allow_statuses=(200, 404))
        if status == 404:
            continue
        _validate_pull_detail(candidate, pull, stage=stage)
        if pull.get('merged') is not True and pull.get('state') != 'closed':
            fail(stage, 'linked-pr-still-open')
    findings: dict[str, dict[str, Any]] = {}
    for finding_id in FINDING_MAPPINGS:
        _, row = _json_request(FINDING_ORIGIN + '/api/findings/' + finding_id, stage=stage)
        if not isinstance(row, dict) or not all(row.get(key) == value for key, value in RESET_FINDING_FIELDS.items()):
            fail(stage, 'finding-verification-failed')
        findings[finding_id] = {key: row.get(key) for key in RESET_FINDING_FIELDS}
    registry = _read_only_connection(SANDBOX_DB, stage=stage)
    try:
        task_rows = registry.execute("SELECT sandbox_id FROM sandboxes WHERE owner_id=? AND workspace_id LIKE 'task-%'",
                                     (OWNER,)).fetchall()
        if task_rows:
            fail(stage, 'task-sandbox-registry-not-empty')
        preserved_sandbox_ids = sorted(row['sandbox_id'] for row in registry.execute('SELECT sandbox_id FROM sandboxes'))
        expected_preserved = sorted(inventory['otherSandboxIds'])
        if preserved_sandbox_ids != expected_preserved:
            fail(stage, 'unrelated-sandbox-registry-changed')
        existing_linked = [row['sandbox_id'] for row in registry.execute('SELECT sandbox_id FROM sandboxes')
                           if row['sandbox_id'] in inventory['linkedSandboxIds']]
        if existing_linked:
            fail(stage, 'linked-sandbox-remains')
    finally:
        registry.close()
    for row in inventory['sandboxes']:
        if _inspect_container(row) is not None:
            fail(stage, 'task-container-remains')
    return {'findings': findings, 'repositoryIdsPreserved': repository_ids}


def _planned_actions(inventory: dict[str, Any]) -> list[str]:
    actions = []
    if inventory['workItems']:
        actions.append(f'remove {len(inventory["workItems"])} Alice Work Item(s) and their detail/history')
    pause_needed = sum(1 for item in inventory['workItems']
                       if ((item.get('workflow') or {}).get('phase') in PAUSE_WORKFLOW_PHASES
                           and not item.get('paused')))
    if pause_needed:
        actions.append(f'pause {pause_needed} pending delivery workflow(s) before clearing')
    if inventory['intakes']:
        actions.append(f'remove {len(inventory["intakes"])} Alice source intake row(s)')
    pending_findings = [finding_id for finding_id, row in inventory['findings'].items() if not _is_finding_reset(row)]
    if pending_findings:
        actions.append('reset findings: ' + ', '.join(sorted(pending_findings)))
    close_count = sum(row.get('action') == 'close' for row in inventory['pullRequests'])
    if close_count:
        actions.append(f'close {close_count} linked open, unmerged PR(s)')
    if inventory['sandboxes']:
        actions.append(f'remove {len(inventory["sandboxes"])} Alice task/linked sandbox(s)')
    if not actions:
        actions.append('no changes required; verify the clean state')
    return actions


def _safe_report_inventory(inventory: dict[str, Any]) -> dict[str, Any]:
    return {
        'owner': OWNER,
        'workItemIds': sorted(item['workItemId'] for item in inventory['workItems']),
        'intakeFindingIds': sorted(item['findingId'] for item in inventory['intakes']),
        'findingStates': {finding_id: {key: row.get(key) for key in RESET_FINDING_FIELDS}
                          for finding_id, row in inventory['findings'].items()},
        'pullRequests': [{key: row.get(key) for key in
                          ('repository', 'number', 'state', 'merged', 'action')}
                         for row in inventory['pullRequests']],
        'pausedWorkItemIds': sorted(inventory['pausedWorkItemIds']),
        'sandboxIds': sorted(row['sandbox_id'] for row in inventory['sandboxes']),
        'plannedActions': _planned_actions(inventory),
    }


def apply_reset(inventory: dict[str, Any]) -> dict[str, Any]:
    completed: list[str] = []
    stage = 'backup'
    try:
        backup = create_backup(inventory)
        inventory['backup'] = str(backup)
        completed.append('backup')
        stage = 'sandbox-helper'
        _check_cleanup_helper()
        completed.append('sandbox-helper')
        stage = 'pause'
        _pause_pending_deliveries(inventory)
        completed.append('pause')
        stage = 'pull-requests'
        _close_pull_requests(inventory)
        completed.append('pull-requests')
        stage = 'findings'
        _reset_findings(inventory)
        completed.append('findings')
        # Remove workspaces before Brain rows so linked IDs remain available on retry.
        stage = 'sandboxes'
        _remove_sandboxes(inventory)
        completed.append('sandboxes')
        stage = 'brain'
        inventory['deletedBrain'] = _delete_brain_graph(inventory)
        completed.append('brain')
        stage = 'verification'
        verified = _verify(inventory)
        completed.append('verification')
        report = _safe_report_inventory(inventory)
        report.update({'status': 'succeeded', 'mode': 'apply', 'backup': inventory['backup'],
                       'completedStages': completed, 'remaining': {'workItemIds': [], 'intakeFindingIds': [],
                       'sandboxIds': [], 'pullRequests': []}, 'deletedBrain': inventory['deletedBrain'],
                       'removedSandboxIds': sorted(inventory['removedSandboxIds']), 'verification': verified})
        return report
    except ResetFailure as error:
        report = _safe_report_inventory(inventory)
        completed_findings = set(inventory['resetFindingIds'])
        removed_sandboxes = set(inventory['removedSandboxIds'])
        closed_prs = {(row['repository'], row['number']) for row in inventory['closedPullRequests']}
        remaining_prs = [row for row in inventory['pullRequests']
                         if row.get('action') == 'close' and (row['repository'], row['number']) not in closed_prs]
        report.update({'status': 'partial' if completed else 'failed', 'mode': 'apply',
                       'stage': error.stage or stage, 'errorCode': error.code,
                       'backup': inventory.get('backup'), 'completedStages': completed,
                       'completedFindingIds': sorted(completed_findings),
                       'removedSandboxIds': sorted(removed_sandboxes),
                       'deletedBrain': inventory.get('deletedBrain'),
                       'remaining': {
                           'workItemIds': [] if inventory.get('deletedBrain') is not None else report['workItemIds'],
                           'intakeFindingIds': [] if inventory.get('deletedBrain') is not None else report['intakeFindingIds'],
                           'findingIds': sorted(set(FINDING_MAPPINGS) - completed_findings),
                           'sandboxIds': sorted(set(row['sandbox_id'] for row in inventory['sandboxes']) - removed_sandboxes),
                           'pullRequests': remaining_prs,
                       }})
        return report
    except Exception as error:
        report = _safe_report_inventory(inventory)
        report.update({'status': 'partial' if completed else 'failed', 'mode': 'apply',
                       'stage': stage, 'errorCode': 'unexpected-' + type(error).__name__,
                       'backup': inventory.get('backup'), 'completedStages': completed,
                       'deletedBrain': inventory.get('deletedBrain'),
                       'removedSandboxIds': sorted(inventory['removedSandboxIds']),
                       'remaining': {'workItemIds': [] if inventory.get('deletedBrain') is not None else report['workItemIds'],
                                     'intakeFindingIds': [] if inventory.get('deletedBrain') is not None else report['intakeFindingIds'],
                                     'findingIds': sorted(set(FINDING_MAPPINGS) - set(inventory['resetFindingIds'])),
                                     'sandboxIds': sorted(set(row['sandbox_id'] for row in inventory['sandboxes'])
                                                          - set(inventory['removedSandboxIds']))}})
        return report


def remote_main(apply: bool) -> dict[str, Any]:
    try:
        inventory = build_inventory()
    except ResetFailure as error:
        return {'status': 'failed', 'mode': 'apply' if apply else 'dry-run',
                'owner': OWNER, 'stage': error.stage, 'errorCode': error.code,
                'completedStages': [], 'remaining': {'state': 'not-inventoried'}}
    except Exception as error:
        return {'status': 'failed', 'mode': 'apply' if apply else 'dry-run',
                'owner': OWNER, 'stage': 'inventory', 'errorCode': 'unexpected-' + type(error).__name__,
                'completedStages': [], 'remaining': {'state': 'not-inventoried'}}
    if not apply:
        report = _safe_report_inventory(inventory)
        report.update({'status': 'dry-run', 'mode': 'dry-run', 'backup': None,
                       'completedStages': [], 'remaining': {'state': 'not-applied'}})
        return report
    return apply_reset(inventory)


def run_remote(apply: bool) -> int:
    command = ['python3', '-', '--remote-mode'] + (['--apply'] if apply else [])
    try:
        source = Path(__file__).resolve().read_bytes()
        process = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                  HOST, shlex.join(command)], input=source,
                                 capture_output=True, timeout=900 if apply else 180)
    except (OSError, subprocess.TimeoutExpired):
        print(json.dumps({'status': 'failed', 'mode': 'apply' if apply else 'dry-run',
                          'stage': 'ssh', 'errorCode': 'transport-failed'}, sort_keys=True))
        return 1
    try:
        lines = process.stdout.decode('utf-8', errors='strict').splitlines()
        result = json.loads(lines[-1]) if lines else None
    except (UnicodeError, ValueError, IndexError):
        result = None
    if not isinstance(result, dict):
        result = {'status': 'failed', 'mode': 'apply' if apply else 'dry-run',
                  'stage': 'ssh', 'errorCode': 'remote-result-invalid'}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if process.returncode == 0 and result.get('status') in {'dry-run', 'succeeded'} else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description='Back up and reset the main Argon Task Center demo state')
    parser.add_argument('--apply', action='store_true', help='apply the reset after the inventory')
    parser.add_argument('--remote-mode', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.remote_mode:
        try:
            report = remote_main(args.apply)
        except Exception as error:
            report = {'status': 'failed', 'mode': 'apply' if args.apply else 'dry-run',
                      'owner': OWNER, 'stage': 'internal', 'errorCode': 'unexpected-' + type(error).__name__}
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 0 if report.get('status') in {'dry-run', 'succeeded'} else 1
    return run_remote(args.apply)


if __name__ == '__main__':
    raise SystemExit(main())
