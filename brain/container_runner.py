"""Self-contained supervisor, sent verbatim to Python inside a container.

The supervisor and its result directory are root-owned. The child command
drops to runner. Worker/API disconnection does not signal either process.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
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


def capture_reports(workspace):
    workspace = Path(workspace).resolve()
    paths = sorted((workspace / 'target/surefire-reports').glob('TEST-*.xml'))
    reports = []
    for path in paths[:8]:
        name = str(path.relative_to(workspace))
        try:
            if not path.resolve().is_relative_to(workspace) or path.is_symlink():
                raise ValueError('Report path escapes workspace or is a symlink')
            if path.stat().st_size > 256 * 1024:
                raise ValueError('Report exceeds 256 KiB')
            reports.append({'path': name, 'xml': path.read_text()})
        except (OSError, ValueError, UnicodeError) as error:
            reports.append({'path': name, 'error': str(error)[:300]})
    if len(paths) > 8:
        reports.append({'path': '*', 'error': 'Report count exceeds 8'})
    return reports


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


def kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


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
            result.update(commit_state(spec['workspace'], spec.get('sourceCommit')))
            environment = os.environ.copy()
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
            for name in ['stdout', 'stderr']:
                pipe = getattr(process, name)
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, name)
            try:
                while selector.get_map() or process.poll() is None:
                    # Once the command has actually completed, a late cancel loses.
                    if process.poll() is None:
                        if (folder / 'cancel').exists():
                            result['reason'] = 'cancelled'
                            kill_group(process)
                        elif time.monotonic() >= deadline:
                            result['reason'] = 'timeout'
                            kill_group(process)
                    else:
                        # Background descendants cannot outlive a completed command.
                        kill_group(process)
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
                result['exitCode'] = process.wait()
            finally:
                selector.close()
                for stream in files.values():
                    stream.close()
            result['reports'] = capture_reports(spec['workspace'])
        except Exception as error:
            if process is not None:
                kill_group(process)
                process.wait()
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
    root = spec.get('root', '/run/argon-operations')
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
