"""Self-contained supervisor, sent verbatim to Python inside a container.

The supervisor and its result directory are root-owned. The child command
drops to runner. Worker/API disconnection does not signal either process.
"""
import base64
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time

MAX_LOG_BYTES = 2 * 1024 * 1024


def operation_path(root, op_id):
    if not isinstance(op_id, str) or not re.fullmatch(r'exec-[0-9a-f]{32}', op_id):
        raise ValueError('Invalid operation ID')
    return Path(root) / op_id


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    temporary.replace(path)


def process_identity(pid):
    try:
        # Field 22 follows a parenthesized process name that may contain spaces.
        return (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except OSError:
        return None


def alive(meta):
    try:
        os.kill(meta['pid'], 0)
        return meta.get('identity') is None or process_identity(meta['pid']) == meta['identity']
    except (OSError, KeyError):
        return False


def _report_directories(workspace, report_dirs):
    workspace = Path(workspace).resolve()
    if report_dirs is None:
        report_dirs = ['target/surefire-reports']
    if not isinstance(report_dirs, list) or len(report_dirs) > 100:
        raise ValueError('Invalid report directories')
    directories = []
    seen_directories = set()
    for name in report_dirs:
        if (not isinstance(name, str) or not name or name.startswith('/') or '\\' in name
                or any(part in {'', '.', '..'} for part in Path(name).parts)):
            raise ValueError('Report directory escapes workspace or is unsafe')
        directory = (workspace / name).resolve()
        if not directory.is_relative_to(workspace):
            raise ValueError('Report directory escapes workspace')
        if directory in seen_directories:
            raise ValueError('Duplicate report directories after canonicalization')
        seen_directories.add(directory)
        directories.append(directory)
    return workspace, directories


def capture_reports(workspace, report_dirs=None):
    workspace, directories = _report_directories(workspace, report_dirs)
    paths = []
    seen_paths = set()
    for directory in directories:
        for path in sorted(directory.glob('TEST-*.xml')):
            canonical = path.resolve()
            if canonical not in seen_paths:
                seen_paths.add(canonical)
                paths.append(path)
    reports = []
    for path in paths[:8]:
        name = str(path.relative_to(workspace))
        try:
            if not path.resolve().is_relative_to(workspace) or path.is_symlink():
                raise ValueError('Report path escapes workspace or is a symlink')
            fd = os.open(str(path), os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('JUnit report is not a regular file')
                if info.st_size > 256 * 1024:
                    raise ValueError('Report exceeds 256 KiB')
                with os.fdopen(fd, 'rb', closefd=False) as stream:
                    content = stream.read(256 * 1024 + 1)
                if len(content) > 256 * 1024:
                    raise ValueError('Report exceeds 256 KiB')
                reports.append({'path': name, 'xml': content.decode()})
            finally:
                os.close(fd)
        except (OSError, ValueError, UnicodeError) as error:
            reports.append({'path': name, 'error': str(error)[:300]})
    if len(paths) > 8:
        reports.append({'path': '*', 'error': 'Report count exceeds 8'})
    return reports


def clear_reports(workspace, report_dirs=None):
    workspace, directories = _report_directories(workspace, report_dirs)
    for directory in directories:
        for path in directory.glob('TEST-*.xml'):
            path.unlink()


def commit_state(workspace, expected):
    git = ['git', '-c', 'safe.directory=' + workspace, '-C', workspace]
    result = subprocess.run(git + ['rev-parse', 'HEAD'], capture_output=True, text=True)
    commit = result.stdout.strip() if result.returncode == 0 else None
    dirty = subprocess.run(git + ['status', '--porcelain', '--untracked-files=all'], capture_output=True, text=True)
    lines = dirty.stdout.splitlines() if dirty.returncode == 0 else []
    generated = ('.cache/', 'target/')
    changed = [line for line in lines if not line[3:].startswith(generated)]
    if expected and (expected != commit or dirty.returncode != 0 or changed):
        raise ValueError('Commit-bound execution requires exact HEAD and a clean source tree')
    return {'sourceCommit': commit, 'sourceDirty': bool(changed)}


def send_signal(pid, group, spec):
    try:
        (os.killpg if group else os.kill)(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        # These containers deliberately omit CAP_KILL. Signal as the command
        # user rather than broadening container capabilities.
        code = 'import os,signal,sys\ntry:\n (os.killpg if sys.argv[2]=="group" else os.kill)(int(sys.argv[1]),signal.SIGKILL)\nexcept ProcessLookupError: pass\n'
        identity = {'user': spec['uid'], 'group': spec['gid'], 'extra_groups': [spec['gid']]} if os.getuid() == 0 else {}
        subprocess.run([sys.executable, '-c', code, str(pid), 'group' if group else 'pid'],
                       capture_output=True, check=True, timeout=2, **identity)


def kill_group(process, spec):
    send_signal(process.pid, True, spec)


def enable_subreaper():
    if sys.platform.startswith('linux'):
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Cannot establish child subreaper')


def descendants():
    if not sys.platform.startswith('linux'):
        return {}
    processes = {}
    for path in Path('/proc').iterdir():
        if path.name.isdigit():
            try:
                fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                processes[int(path.name)] = (int(fields[1]), fields[0])
            except (OSError, ValueError, IndexError):
                pass
    selected = {os.getpid()}
    while True:
        children = {pid for pid, (parent, _) in processes.items() if parent in selected}
        if children.issubset(selected):
            break
        selected.update(children)
    return {pid: processes[pid] for pid in selected if pid != os.getpid()}


def terminate_tree(process, spec):
    kill_group(process, spec)
    process.wait(timeout=2)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        children = descendants()
        if not children:
            return True
        for pid, (parent, state) in children.items():
            if state == 'Z' and parent == os.getpid():
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
            else:
                send_signal(pid, False, spec)
        time.sleep(.02)
    return not descendants()


def supervise(root, spec):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    folder = operation_path(root, spec['operationId'])
    folder.mkdir(mode=0o700, exist_ok=True)
    with (folder / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if (folder / 'meta.json').exists() or (folder / 'result.json').exists():
            return
        meta = {'pid': os.getpid(), 'identity': process_identity(os.getpid()), 'startedAt': time.time()}
        atomic_json(folder / 'meta.json', meta)
        result = {'exitCode': None, 'reason': None, 'reports': [], 'truncated': {'stdout': False, 'stderr': False}}
        process = None
        try:
            enable_subreaper()
            result.update(commit_state(spec['workspace'], spec.get('sourceCommit')))
            clear_reports(spec['workspace'], spec.get('reportDirs'))
            environment = os.environ.copy()
            environment.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='safe.directory',
                               GIT_CONFIG_VALUE_0=spec['workspace'])
            if spec.get('mavenOpts'):
                environment['MAVEN_OPTS'] = spec['mavenOpts']
            identity = {}
            if os.getuid() == 0:
                identity = {'user': spec['uid'], 'group': spec['gid'], 'extra_groups': [spec['gid']]}
            process = subprocess.Popen(['/bin/sh', '-c', spec['command']], cwd=spec['workspace'],
                                       env=environment, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True, **identity)
            deadline = time.monotonic() + spec['timeoutSeconds']
            selector = selectors.DefaultSelector()
            files = {name: (folder / (name + '.log')).open('wb') for name in ['stdout', 'stderr']}
            sizes = {'stdout': 0, 'stderr': 0}
            containment = None
            for name in ['stdout', 'stderr']:
                pipe = getattr(process, name)
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, name)
            try:
                while selector.get_map() or process.poll() is None:
                    # Once the command has actually completed, a late cancel loses.
                    if containment is None and process.poll() is None:
                        if (folder / 'cancel').exists():
                            result['reason'] = 'cancelled'
                            containment = terminate_tree(process, spec)
                        elif time.monotonic() >= deadline:
                            result['reason'] = 'timeout'
                            containment = terminate_tree(process, spec)
                    if containment is None and process.poll() is not None:
                        # Background descendants cannot outlive a completed command.
                        containment = terminate_tree(process, spec)
                    for key, _ in selector.select(.05):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                            continue
                        name = key.data
                        keep = chunk[:max(0, MAX_LOG_BYTES - sizes[name])]
                        files[name].write(keep)
                        files[name].flush()
                        sizes[name] += len(keep)
                        result['truncated'][name] |= len(keep) != len(chunk)
                    if containment is False:
                        break
                if containment is None:
                    containment = terminate_tree(process, spec)
                result['exitCode'] = process.wait()
                result['containmentConfirmed'] = containment is True
            finally:
                selector.close()
                for stream in files.values():
                    stream.close()
            result['reports'] = capture_reports(spec['workspace'], spec.get('reportDirs'))
        except Exception as error:
            if process is not None:
                try:
                    result['containmentConfirmed'] = terminate_tree(process, spec)
                    result['exitCode'] = process.returncode
                except Exception:
                    result['containmentConfirmed'] = False
            result.update(reason='preflight_or_supervisor_error', error=str(error)[:1000])
        finally:
            result['finishedAt'] = time.time()
            atomic_json(folder / 'result.json', result)


def snapshot(root, op_id, offsets):
    folder = operation_path(root, op_id)
    meta_path = folder / 'meta.json'
    if not meta_path.exists():
        return {'state': 'MISSING'}
    meta = json.loads(meta_path.read_text())
    result_path = folder / 'result.json'
    result = json.loads(result_path.read_text()) if result_path.exists() else None
    state = 'FINISHED' if result is not None else ('RUNNING' if alive(meta) else 'LOST')
    data = {'state': state, 'result': result, 'remaining': False}
    for name in ['stdout', 'stderr']:
        path = folder / (name + '.log')
        offset = offsets.get(name, 0)
        chunk = b''
        if path.exists():
            with path.open('rb') as stream:
                stream.seek(offset)
                chunk = stream.read(65536)
            data['remaining'] |= offset + len(chunk) < path.stat().st_size
        data[name] = base64.b64encode(chunk).decode()
    return data


def request_cancel(root, op_id):
    folder = operation_path(root, op_id)
    if not folder.exists():
        return False
    (folder / 'cancel').touch(mode=0o600, exist_ok=True)
    return True


def main():
    action, payload = sys.argv[1:3]
    spec = json.loads(base64.b64decode(payload))
    root = spec.get('root', '/run/mythos-operations')
    if action == 'run':
        supervise(root, spec)
    elif action == 'poll':
        print(json.dumps(snapshot(root, spec['operationId'], spec['offsets'])))
    elif action == 'cancel':
        print(json.dumps({'requested': request_cancel(root, spec['operationId'])}))
    elif action == 'cleanup':
        folder = operation_path(root, spec['operationId'])
        if (folder / 'result.json').exists():
            shutil.rmtree(folder)
        print(json.dumps({'cleaned': not folder.exists()}))
    else:
        raise ValueError('Unsupported supervisor action')


if __name__ == '__main__':
    main()
