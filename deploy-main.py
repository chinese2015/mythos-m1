#!/usr/bin/env python3
"""Safely deploy the current Mythos main Brain/DSH source to the operator host.

The local command builds an allowlisted source archive, transfers this script and
the archive over the user's configured OpenSSH connection, and asks the remote
copy to back up, deploy and restart only the main instance. It never transfers
state, credentials, tests, dependencies, generic-instance data or PR state.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


HOST = 'hx@ubuntu.huaxia2002.cn'
MAIN_PORTS = {'dsh': 13080, 'brain': 13081, 'gitea': 13000}
PROFILE_RELATIVE = '.dsh/profiles/web/cordis.patch.yml'
TOKEN_RELATIVE = '.mythos-brain/tokens.json'
CREDENTIAL_RELATIVE = 'gitea/secrets/mythos-agent.json'
CLONE_FILES = ('sandbox.py', 'registry.py', 'ssh_config.py', 'host-changes.mjs', 'restart-dsh.py')
EXCLUDED_PARTS = {'.git', '__pycache__', 'node_modules', 'tests', 'state', 'artifacts', '.cache'}
ACTIVE_OPERATIONS = {'QUEUED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'UNKNOWN'}
ACTIVE_PHASES = {'PREPARING', 'BASELINE', 'PLANNING', 'CODING', 'VERIFYING', 'PUBLISHING', 'CLOSING'}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def source_files(root):
    result = []
    for base in ('brain', 'plugins'):
        directory = root / base
        for path in sorted(directory.rglob('*')):
            if not path.is_file() or path.is_symlink() or any(part in EXCLUDED_PARTS for part in path.relative_to(root).parts):
                continue
            if path.suffix == '.pyc':
                continue
            if base == 'brain' and path.suffix != '.py':
                continue
            result.append(path)
    for name in CLONE_FILES:
        path = root / name
        if path.is_file() and not path.is_symlink():
            result.append(path)
    return sorted(set(result), key=lambda path: path.relative_to(root).as_posix())


def build_archive(root, destination):
    entries = []
    with tarfile.open(destination, 'w:gz') as archive:
        for path in source_files(root):
            relative = path.relative_to(root).as_posix()
            archive.add(path, arcname=relative, recursive=False)
            entries.append({'path': relative, 'sha256': sha256(path), 'size': path.stat().st_size})
    manifest = json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()
    return entries, hashlib.sha256(manifest).hexdigest()


def git_context(root):
    def git(*args):
        return subprocess.run(['git', *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
    head = git('rev-parse', 'HEAD')
    branch = git('branch', '--show-current')
    deployed = {path.relative_to(root).as_posix() for path in source_files(root)}
    tracked = set(git('diff', '--name-only', 'HEAD', '--', 'brain', 'plugins', 'sandbox.py',
                      'registry.py', 'ssh_config.py', 'host-changes.mjs', 'restart-dsh.py').splitlines())
    untracked = set(git('ls-files', '--others', '--exclude-standard', '--', 'brain', 'plugins', 'sandbox.py',
                        'registry.py', 'ssh_config.py', 'host-changes.mjs', 'restart-dsh.py').splitlines())
    dirty = sorted((tracked | untracked) & deployed)
    return {'branch': branch, 'head': head, 'dirtyRuntimeFiles': dirty}


def safe_remote_command(*args):
    return ' '.join(shlex.quote(str(part)) for part in args)


def local_deploy(root):
    context = git_context(root)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + os.urandom(3).hex()
    with tempfile.TemporaryDirectory(prefix='mythos-main-deploy-') as temporary:
        temp = Path(temporary)
        archive = temp / 'mythos-main-source.tar.gz'
        entries, manifest_digest = build_archive(root, archive)
        script = Path(__file__).resolve()
        remote_archive = '/tmp/mythos-main-' + stamp + '.tar.gz'
        remote_script = '/tmp/mythos-main-' + stamp + '.py'
        ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST]
        scp = ['scp', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
        try:
            subprocess.run(scp + [str(archive), HOST + ':' + remote_archive], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            subprocess.run(scp + [str(script), HOST + ':' + remote_script], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            subprocess.run(ssh + [safe_remote_command('chmod', '600', remote_archive, remote_script)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            command = safe_remote_command('python3', remote_script, '--remote-apply',
                                          '--archive', remote_archive, '--stamp', stamp,
                                          '--source-head', context['head'],
                                          '--source-branch', context['branch'],
                                          '--source-dirty-files', json.dumps(context['dirtyRuntimeFiles'], separators=(',', ':')),
                                          '--manifest-digest', manifest_digest)
            completed = subprocess.run(ssh + [command], capture_output=True, text=True, timeout=300)
            try:
                result = json.loads(completed.stdout.strip().splitlines()[-1])
            except Exception:
                result = {'status': 'failed', 'reason': 'Remote deploy returned no safe result record'}
            result['source'] = context
            result['files'] = len(entries)
            if completed.returncode:
                result['status'] = result.get('status', 'failed')
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return completed.returncode
        except subprocess.TimeoutExpired:
            print(json.dumps({'status': 'failed', 'reason': 'SSH deployment command timed out',
                              'source': context, 'files': len(entries)}, ensure_ascii=False))
            return 1
        except subprocess.CalledProcessError:
            print(json.dumps({'status': 'failed', 'reason': 'SSH/SCP deployment transport failed',
                              'source': context, 'files': len(entries)}, ensure_ascii=False))
            return 1
        finally:
            try:
                subprocess.run(ssh + [safe_remote_command('rm', '-f', remote_archive, remote_script)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)
            except (subprocess.TimeoutExpired, OSError):
                pass


def _http_status(url, token=None, timeout=3):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    opener = build_opener(ProxyHandler({}))
    request = Request(url, headers=headers)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read()
    except HTTPError as error:
        error.close()
        return error.code, b''
    except URLError:
        return 0, b''


def _port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def _proc_rows():
    rows = []
    proc = Path('/proc')
    for item in proc.iterdir():
        if not item.name.isdigit():
            continue
        try:
            args = [part.decode(errors='replace') for part in (item / 'cmdline').read_bytes().split(b'\0') if part]
            cwd = os.readlink(item / 'cwd')
        except OSError:
            continue
        if args:
            rows.append((int(item.name), args, cwd))
    return rows


def _process_map(home):
    main_root = str(home / 'mythos-m1')
    dsh_root = str(home / 'dsh-run')
    generic_root = str(home / 'mythos-m1-generic')
    generic_dsh = []
    result = {'api': [], 'worker': [], 'dsh': []}
    for pid, args, cwd in _proc_rows():
        if cwd == main_root and len(args) >= 4 and '-m' in args and args[args.index('-m') + 1:args.index('-m') + 3] == ['brain', 'api']:
            result['api'].append(pid)
        if cwd == main_root and len(args) >= 4 and '-m' in args and args[args.index('-m') + 1:args.index('-m') + 3] == ['brain', 'worker']:
            result['worker'].append(pid)
        if cwd == dsh_root and len(args) >= 3 and Path(args[0]).name == 'node' and Path(args[1]).name in {'dsh', 'bin.js'} and \
                'web' in args and '--port' in args and args[args.index('--port') + 1] == '13080':
            result['dsh'].append(pid)
        if cwd == generic_root and '-m' in args and args[args.index('-m') + 1:args.index('-m') + 2] == ['brain']:
            generic_dsh.append(pid)
        if cwd == dsh_root and len(args) >= 3 and Path(args[0]).name == 'node' and Path(args[1]).name in {'dsh', 'bin.js'} and \
                '--port' in args and args[args.index('--port') + 1] == '13093':
            generic_dsh.append(pid)
    result['generic'] = sorted(set(generic_dsh))
    return result


def _proc_alive(pid):
    try:
        raw = (Path('/proc') / str(pid) / 'stat').read_text()
        state = raw.rsplit(')', 1)[1].strip().split()[0]
        return state != 'Z'
    except OSError:
        return False


def _stop(pid, timeout=20):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _proc_alive(pid):
            return
        time.sleep(.1)
    raise RuntimeError('Owned service did not stop after SIGTERM')


def _stop_main(home):
    processes = _process_map(home)
    for role in ('worker', 'api', 'dsh'):
        if len(processes[role]) > 1:
            raise RuntimeError('Multiple main ' + role + ' processes found')
        for pid in processes[role]:
            _stop(pid)
    return processes


def _active_state(home):
    database = home / '.mythos-brain/brain.sqlite3'
    connection = sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True, timeout=5)
    try:
        states = [row[0] for row in connection.execute('SELECT state FROM operations')]
        rows = [row[0] for row in connection.execute('SELECT data FROM work_items')]
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        phases = []
        for value in rows:
            try:
                phases.append((json.loads(value).get('workflow') or {}).get('phase'))
            except Exception:
                raise RuntimeError('Main Brain contains an unreadable Work Item')
        active_ops = sum(state in ACTIVE_OPERATIONS for state in states)
        active_tasks = sum(phase in ACTIVE_PHASES for phase in phases)
        repositories_table = 'repositories' in tables
        repositories = connection.execute('SELECT count(*) FROM repositories').fetchone()[0] if repositories_table else 0
        return {'workItems': len(rows), 'repositories': repositories, 'repositoriesTable': repositories_table,
                'activeOperations': active_ops, 'activeWorkflowPhases': active_tasks}
    finally:
        connection.close()


def _profile_paths(home):
    profile = home / PROFILE_RELATIVE
    if not profile.is_file() or profile.is_symlink():
        raise RuntimeError('Main DSH profile is unavailable')
    content = profile.read_text(errors='strict')
    required = [
        'baseUrl: http://127.0.0.1:13081',
        'baseUrl: http://127.0.0.1:13000',
        'sourceUrl: http://127.0.0.1:18081',
        str(home / 'mythos-m1/plugins/mythos-workflow/service.mjs'),
        str(home / 'mythos-m1/plugins/mythos-console/index.mjs'),
        str(home / 'mythos-m1/plugins/mythos-vibe/service.mjs'),
    ]
    if not all(value in content for value in required):
        raise RuntimeError('Main DSH profile does not match the approved 13080/13081/13000/18081 deployment')
    token_match = re.search(r'(?m)^\s*tokenFile:\s*(\S+)', content)
    if not token_match:
        raise RuntimeError('Main DSH profile has no Brain tokenFile')
    token_file = Path(token_match.group(1)).expanduser()
    if not token_file.is_absolute():
        token_file = home / token_file
    return profile, token_file


def _private_file(path, maximum=16 * 1024 * 1024):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('Expected private file is unavailable')
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > maximum:
        raise RuntimeError('Private file ownership or mode is unsafe')


def _preflight(home):
    main_root = home / 'mythos-m1'
    dsh_root = home / 'dsh-run'
    database = home / '.mythos-brain/brain.sqlite3'
    profile, token_file = _profile_paths(home)
    credential_file = home / CREDENTIAL_RELATIVE
    if not main_root.is_dir() or not dsh_root.is_dir() or main_root.is_symlink() or dsh_root.is_symlink():
        raise RuntimeError('Main DSH/Brain runtime directory is unavailable')
    dsh_log = dsh_root / 'dsh.log'
    if dsh_log.is_symlink():
        raise RuntimeError('Main DSH log path is a symlink')
    _private_file(database, 1024 * 1024 * 1024)
    _private_file(token_file, 256 * 1024)
    _private_file(credential_file, 64 * 1024)
    for port in MAIN_PORTS.values():
        if not _port_open(port):
            raise RuntimeError('Expected main/Gitea port is not listening')
    processes = _process_map(home)
    if any(len(processes[name]) != 1 for name in ('api', 'worker', 'dsh')):
        raise RuntimeError('Expected exactly one main Brain API, Worker and DSH process')
    if not _http_status('http://127.0.0.1:13081/health')[0] == 200:
        raise RuntimeError('Main Brain API health endpoint is unavailable')
    state = _active_state(home)
    if state['activeOperations'] or state['activeWorkflowPhases']:
        raise RuntimeError('Main work is active; defer restart until it reaches a safe phase')
    api_state = _private_api_state(home, token_file, allow_missing_repositories=True)
    if api_state['workItems'] != state['workItems']:
        raise RuntimeError('Main Brain database and authenticated API disagree about Work Items')
    if state['repositoriesTable'] and api_state['repositories'] != state['repositories']:
        raise RuntimeError('Main Brain database and authenticated API disagree about repositories')
    if not state['repositoriesTable'] and api_state['repositories'] != 0:
        raise RuntimeError('Main Brain returned repository rows without the repository table')
    return {'processes': processes, 'state': state, 'profile': profile, 'profileHash': sha256(profile),
            'tokenFile': token_file, 'database': database, 'mainRoot': main_root, 'dshRoot': dsh_root}


def _extract_archive(archive_path, destination):
    allowed_roots = {'brain', 'plugins'}
    allowed_files = set(CLONE_FILES)
    entries = []
    total = 0
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        if not members or len(members) > 1000:
            raise RuntimeError('Deployment archive manifest is out of range')
        for member in members:
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or any(part in {'', '.', '..'} for part in relative.parts):
                raise RuntimeError('Deployment archive contains an unsafe path')
            if not member.isfile() or member.issym() or member.islnk():
                raise RuntimeError('Deployment archive contains a non-regular file')
            if relative.parts[0] not in allowed_roots and member.name not in allowed_files:
                raise RuntimeError('Deployment archive contains an unapproved root path')
            if any(part in EXCLUDED_PARTS for part in relative.parts) or relative.suffix == '.pyc':
                raise RuntimeError('Deployment archive contains excluded runtime data')
            total += member.size
            if member.size > 32 * 1024 * 1024 or total > 128 * 1024 * 1024:
                raise RuntimeError('Deployment archive exceeds size limits')
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError('Deployment archive member is unreadable')
            with source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            entries.append({'path': member.name, 'sha256': sha256(target), 'size': member.size})
    return entries


def _backup_files(main_root, entries, backup_dir):
    code_backup = backup_dir / 'overwritten-code.tar.gz'
    existed = []
    with tarfile.open(code_backup, 'w:gz') as archive:
        for entry in entries:
            relative = entry['path']
            path = main_root / relative
            if path.exists() and not path.resolve().is_relative_to(main_root.resolve()):
                raise RuntimeError('Remote backup target escapes the main runtime root')
            if path.is_symlink():
                raise RuntimeError('Remote target contains a symlink at an approved code path')
            if path.is_file():
                archive.add(path, arcname=relative, recursive=False)
                existed.append(relative)
    code_backup.chmod(0o600)
    return code_backup, set(existed)


def _restore_files(main_root, entries, existed, code_backup, stamp):
    restore_root = Path(tempfile.mkdtemp(prefix='mythos-main-rollback-'))
    try:
        _extract_archive(code_backup, restore_root)
        for entry in entries:
            relative = entry['path']
            target = main_root / relative
            if relative in existed:
                source = restore_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(target.name + '.rollback-' + stamp)
                shutil.copyfile(source, temporary)
                temporary.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)
                os.replace(temporary, target)
            elif target.exists():
                if target.is_symlink():
                    raise RuntimeError('Refusing to remove a rollback target symlink')
                target.unlink()
    finally:
        shutil.rmtree(restore_root, ignore_errors=True)


def _apply_files(main_root, staging, entries, stamp):
    for entry in entries:
        relative = entry['path']
        source = staging / relative
        target = main_root / relative
        if target.is_symlink() or not target.resolve().is_relative_to(main_root.resolve()):
            raise RuntimeError('Remote code destination escapes the main runtime root')
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        temporary = target.with_name(target.name + '.deploy-' + stamp)
        shutil.copyfile(source, temporary)
        temporary.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)
        os.replace(temporary, target)
        if sha256(target) != entry['sha256']:
            raise RuntimeError('Deployed file hash does not match the source manifest')


def _api_request(url, token=None, allow_missing=False):
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    opener = build_opener(ProxyHandler({}))
    request = Request(url, headers=headers)
    try:
        with opener.open(request, timeout=5) as response:
            status = response.status
            payload = response.read(2 * 1024 * 1024 + 1)
    except HTTPError as error:
        status = error.code
        error.close()
        if allow_missing and status == 404:
            return None
        payload = b''
    except URLError:
        status, payload = 0, b''
    if status != 200 or len(payload) > 2 * 1024 * 1024:
        raise RuntimeError('Authenticated main Brain API read failed')
    try:
        return json.loads(payload.decode('utf-8'))
    except Exception:
        raise RuntimeError('Authenticated main Brain API response was invalid') from None


def _private_api_state(home, token_file, *, allow_missing_repositories=False):
    tokens = json.loads(token_file.read_text())
    owners = tokens.get('owners')
    if not isinstance(owners, dict) or not owners:
        raise RuntimeError('Main Brain token file has no owners')
    work_count = 0
    repository_count = 0
    for token in owners.values():
        if not isinstance(token, str) or len(token) < 32:
            raise RuntimeError('Main Brain token file has an unusable owner entry')
        work = _api_request('http://127.0.0.1:13081/api/brain/work-items', token)
        repositories = _api_request('http://127.0.0.1:13081/api/brain/repositories', token,
                                    allow_missing=allow_missing_repositories)
        if not isinstance(work.get('workItems'), list) or (repositories is not None and not isinstance(repositories.get('repositories'), list)):
            raise RuntimeError('Main Brain API returned an unexpected read response')
        work_count += len(work['workItems'])
        repository_count += len(repositories['repositories']) if repositories is not None else 0
    return {'workItems': work_count, 'repositories': repository_count}


def _log_directory(home, stamp):
    path = home / 'mythos-m1/state' / ('deploy-main-' + stamp)
    path.mkdir(parents=True, exist_ok=False, mode=0o700)
    path.chmod(0o700)
    return path


def _service_environment(home):
    env = os.environ.copy()
    additions = [home / 'tools/node/bin', home / 'tools/maven/bin', home / 'tools/jdk/bin']
    env['PATH'] = ':'.join([str(path) for path in additions] + [env.get('PATH', '/usr/bin:/bin')])
    env['JAVA_HOME'] = str(home / 'tools/jdk')
    return env


def _start_service(role, home, log_dir):
    main_root = home / 'mythos-m1'
    dsh_root = home / 'dsh-run'
    if role == 'api':
        argv = [sys.executable, '-m', 'brain', 'api', '--host', '127.0.0.1', '--port', '13081',
                '--per-owner-limit', '4', '--global-limit', '5']
        cwd, log = main_root, log_dir / 'api.log'
    elif role == 'worker':
        argv = [sys.executable, '-m', 'brain', 'worker', '--per-owner-limit', '4', '--global-limit', '5']
        cwd, log = main_root, log_dir / 'worker.log'
    elif role == 'dsh':
        argv = [str(dsh_root / 'node_modules/.bin/dsh'), 'web', '--no-open', '--host', '127.0.0.1',
                '--port', '13080', '--trusted-host', 'ubuntu.huaxia2002.cn:13080']
        cwd, log = dsh_root, dsh_root / 'dsh.log'
    else:
        raise RuntimeError('Unknown main service role')
    if role != 'dsh':
        with log.open('ab') as output:
            log.chmod(0o600)
            return subprocess.Popen(argv, cwd=cwd, env=_service_environment(home), stdin=subprocess.DEVNULL,
                                    stdout=output, stderr=subprocess.STDOUT, start_new_session=True).pid
    start_offset = log.stat().st_size if log.exists() else 0
    with log.open('ab') as output:
        log.chmod(0o600)
        process = subprocess.Popen(argv, cwd=cwd, env=_service_environment(home), stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if not _proc_alive(process.pid):
            raise RuntimeError('Main DSH exited during startup')
        if _port_open(13080) and log.exists():
            with log.open('rb') as stream:
                stream.seek(start_offset)
                if b'dsh web:' in stream.read():
                    return process.pid
        time.sleep(.25)
    raise RuntimeError('Main DSH did not become ready within 30 seconds')


def _ensure_services(home, log_dir):
    processes = _process_map(home)
    result = {}
    for role in ('api', 'worker', 'dsh'):
        pids = processes[role]
        if len(pids) > 1:
            raise RuntimeError('Multiple main ' + role + ' processes found')
        result[role] = pids[0] if pids else _start_service(role, home, log_dir)
    return result


def _wait_health(home, expected_state, processes, token_file):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if not _proc_alive(processes['api']) or not _proc_alive(processes['worker']) or not _proc_alive(processes['dsh']):
            raise RuntimeError('A main service exited during startup')
        api, _ = _http_status('http://127.0.0.1:13081/health')
        if api == 200 and _port_open(13080):
            break
        time.sleep(.25)
    else:
        raise RuntimeError('Main API or DSH did not become ready')
    unauthenticated = _http_status('http://127.0.0.1:13080/mythos/')[0]
    if unauthenticated != 401:
        raise RuntimeError('Main Console authentication gate changed')
    after_state = _private_api_state(home, token_file)
    if after_state['workItems'] < expected_state['workItems'] or after_state['repositories'] < expected_state['repositories']:
        raise RuntimeError('Existing main Work Items or repositories disappeared during deployment')
    if _http_status('http://127.0.0.1:13080/mythos/intake-view.js')[0] != 401:
        raise RuntimeError('Main Console authentication gate changed for the intake asset')
    return {'api': api, 'unauthenticatedConsole': unauthenticated,
            'workItems': after_state['workItems'], 'repositories': after_state['repositories']}


def _remote_preflight():
    home = Path.home()
    preflight = _preflight(home)
    return {'status': 'ready', 'ports': MAIN_PORTS, 'processes': preflight['processes'],
            'workItems': preflight['state']['workItems'], 'repositories': preflight['state']['repositories'],
            'profileHash': preflight['profileHash']}


def _remote_apply(archive_path, stamp, source):
    home = Path.home()
    backup_dir = home / 'backups/mythos-main-deploy' / stamp
    stopped = False
    files_applied = False
    code_backup = None
    existed = set()
    entries = []
    stage = Path(tempfile.mkdtemp(prefix='mythos-main-stage-'))
    original = None
    try:
        os.umask(0o077)
        original = _preflight(home)
        _private_file(archive_path, 128 * 1024 * 1024)
        entries = _extract_archive(archive_path, stage)
        if not entries:
            raise RuntimeError('Deployment archive is empty')
        digest = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if digest != source.get('manifestDigest'):
            raise RuntimeError('Deployment archive manifest digest mismatch')
        backup_parent = backup_dir.parent
        backup_parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup_parent.chmod(0o700)
        backup_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        backup_dir.chmod(0o700)
        code_backup, existed = _backup_files(original['mainRoot'], entries, backup_dir)
        shutil.copy2(original['profile'], backup_dir / 'cordis.patch.yml')
        (backup_dir / 'cordis.patch.yml').chmod(0o600)
        manifest = {'stamp': stamp, 'source': source, 'files': entries,
                    'preflight': original['state'], 'profileSha256': original['profileHash'],
                    'profileChanged': False}
        manifest_path = backup_dir / 'deployment.json'
        manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2))
        manifest_path.chmod(0o600)
        stopped = True
        _stop_main(home)
        database_backup = backup_dir / 'brain.sqlite3'
        source_db = sqlite3.connect('file:' + str(original['database']) + '?mode=ro', uri=True, timeout=10)
        destination_db = sqlite3.connect(str(database_backup), timeout=10)
        try:
            source_db.backup(destination_db)
        finally:
            destination_db.close()
            source_db.close()
        database_backup.chmod(0o600)
        files_applied = True
        _apply_files(original['mainRoot'], stage, entries, stamp)
        log_dir = _log_directory(home, stamp)
        pids = _ensure_services(home, log_dir)
        state = _wait_health(home, {'workItems': original['state']['workItems'],
                                    'repositories': original['state']['repositories']}, pids, original['tokenFile'])
        if sha256(original['profile']) != original['profileHash']:
            raise RuntimeError('Main DSH profile changed during deployment')
        after_processes = _process_map(home)
        if after_processes['generic'] != original['processes']['generic']:
            raise RuntimeError('Generic DSH/Brain processes changed during main deployment')
        return {'status': 'deployed', 'backup': str(backup_dir), 'files': len(entries),
                'source': source, 'health': state, 'processes': pids,
                'profileChanged': False, 'genericProcessesUnchanged': True}
    except Exception as error:
        rollback_complete = False
        rollback_error = None
        if stopped and original is not None:
            try:
                _stop_main(home)
                if files_applied and code_backup is not None:
                    _restore_files(original['mainRoot'], entries, existed, code_backup, stamp)
                log_dir = _log_directory(home, stamp + '-rollback')
                _ensure_services(home, log_dir)
                rollback_complete = True
            except Exception as rollback_exception:
                rollback_error = type(rollback_exception).__name__
        return {'status': 'rolled_back' if rollback_complete else 'failed',
                'backup': str(backup_dir) if backup_dir.exists() else None,
                'errorType': type(error).__name__, 'rollbackComplete': rollback_complete,
                'rollbackErrorType': rollback_error}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description='Allowlisted backup/deploy/restart for main Mythos only')
    parser.add_argument('--apply', action='store_true', help='deploy to hx@ubuntu.huaxia2002.cn')
    parser.add_argument('--remote-apply', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--remote-preflight', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--stamp')
    parser.add_argument('--source-head')
    parser.add_argument('--source-branch')
    parser.add_argument('--source-dirty-files')
    parser.add_argument('--manifest-digest')
    args = parser.parse_args()
    if args.remote_preflight:
        try:
            print(json.dumps(_remote_preflight(), sort_keys=True))
            return 0
        except Exception as error:
            print(json.dumps({'status': 'failed', 'errorType': type(error).__name__}))
            return 1
    if args.remote_apply:
        if not args.archive or not args.stamp:
            print(json.dumps({'status': 'failed', 'errorType': 'MissingInput'}))
            return 1
        source = {'head': args.source_head, 'branch': args.source_branch,
                  'dirtyRuntimeFiles': json.loads(args.source_dirty_files or '[]'),
                  'manifestDigest': args.manifest_digest}
        result = _remote_apply(args.archive, args.stamp, source)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0 if result['status'] == 'deployed' else 1
    if not args.apply:
        parser.error('Use --apply to deploy after reviewing the source manifest')
    return local_deploy(Path(__file__).resolve().parent)


if __name__ == '__main__':
    raise SystemExit(main())
