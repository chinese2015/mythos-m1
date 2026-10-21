"""Task workspace preparation and read-only Git evidence."""
import re
import subprocess
import threading

from .errors import Conflict, InvalidInput
from .executor import SETTINGS, validate_repository

MAX_DIFF = 128 * 1024


class TaskWorkspace:
    def __init__(self, store, executor):
        self.store = store
        self.executor = executor
        self.broker = executor.broker
        self._active_lock = threading.Lock()
        self._active = set()

    def prepare(self, owner, work_id, expected_version):
        work, acquired = self.store.begin_prepare(owner, work_id, expected_version)
        if work.get('sandboxId'):
            return work
        provision = work.get('workspaceProvision') or {}
        label = provision.get('label')
        if not acquired:
            with self._active_lock:
                in_process = work_id in self._active
            if in_process:
                return work
        matches = [r for r in self.broker.registry.list_owned(owner) if r['workspace_id'] == label]
        if not acquired:
            if len(matches) == 1:
                record = matches[0]
                if self._ready(owner, record, work):
                    return self.store.finish_prepare(owner, work_id, record['sandbox_id'])
                return self._unknown(owner, work_id, 'Registered workspace failed baseline reconciliation')
            if provision.get('state') in {'PREPARING', 'UNKNOWN'}:
                return self._unknown(owner, work_id, 'Preparation outcome is unknown; no second sandbox was allocated')
            return work
        if matches:
            if len(matches) == 1 and self._ready(owner, matches[0], work):
                return self.store.finish_prepare(owner, work_id, matches[0]['sandbox_id'])
            return self._unknown(owner, work_id, 'Task workspace label is ambiguous or incomplete')
        record = None
        with self._active_lock:
            self._active.add(work_id)
        try:
            source = work['sourceRecord']
            validate_repository(source['repositoryUrl'])
            if not re.fullmatch(r'[0-9a-f]{40}', source['baseCommit']):
                raise InvalidInput('baseCommit must be a full lowercase Git SHA')
            record = self.broker.create(owner, label, source['repositoryUrl'])
            sandbox_id = record['sandbox_id']
            self._exec(owner, sandbox_id, ['git', 'checkout', '--detach', source['baseCommit']])
            actual = self._exec(owner, sandbox_id, ['git', 'rev-parse', 'HEAD'])
            if actual != source['baseCommit']:
                raise RuntimeError('Baseline SHA mismatch')
            branch = 'mythos/' + source['id'].lower()
            self._exec(owner, sandbox_id, ['git', 'checkout', '-b', branch])
            self._exec(owner, sandbox_id, ['git', 'config', 'user.name', 'Mythos Demo Operator'])
            self._exec(owner, sandbox_id, ['git', 'config', 'user.email', 'mythos-demo@localhost'])
            item = self.broker.registry.get(owner, sandbox_id)
            subprocess.run(['docker', 'exec', '-i', '--user', '1001:1000', '-w', item['workspace_path'],
                            item['container_name'], 'sh', '-c', 'mkdir -p .cache && cat > .cache/settings.xml'],
                           input=SETTINGS.encode(), capture_output=True, check=True, timeout=10)
            if not self._ready(owner, item, work):
                raise RuntimeError('Prepared workspace validation failed')
            return self.store.finish_prepare(owner, work_id, sandbox_id)
        except Exception as error:
            return self.store.finish_prepare(owner, work_id, error=str(error))
        finally:
            with self._active_lock:
                self._active.discard(work_id)

    def _unknown(self, owner, work_id, message):
        return self.store.set_provision_state(owner, work_id, 'UNKNOWN', message)

    def _exec(self, owner, sandbox_id, argv):
        result = self.broker.execute_capture(owner, sandbox_id, argv, timeout=30)
        if result['exitCode']:
            raise RuntimeError((result.get('stderr') or result.get('stdout'))[-1000:])
        return result['stdout'].strip()

    def _ready(self, owner, record, work):
        if record['state'] != 'running':
            return False
        source = work['sourceRecord']
        try:
            self.executor._inspect(record)
            head = self._exec(owner, record['sandbox_id'], ['git', 'rev-parse', 'HEAD'])
            branch = self._exec(owner, record['sandbox_id'], ['git', 'branch', '--show-current'])
            baseline = self._exec(owner, record['sandbox_id'], ['git', 'rev-parse', source['baseCommit']])
            self._exec(owner, record['sandbox_id'], ['test', '-s', '.cache/settings.xml'])
            status = self._exec(owner, record['sandbox_id'], ['git', 'status', '--porcelain'])
            return (head == baseline == source['baseCommit'] and branch == 'mythos/' + source['id'].lower()
                    and not status)
        except Exception:
            return False

    def evidence(self, owner, work_id):
        work = self.store.get_work_item(owner, work_id)
        if not work.get('sandboxId'):
            raise Conflict('Workspace has not been prepared')
        sandbox_id = work['sandboxId']
        source = work['sourceRecord']
        git = lambda *args: self._exec(owner, sandbox_id, ['git', *args])
        base = git('rev-parse', source['baseCommit'])
        if base != source['baseCommit']:
            raise Conflict('Immutable task baseline is unavailable')
        head = git('rev-parse', 'HEAD')
        branch = git('branch', '--show-current')
        status = git('status', '--short')
        names = git('diff', '--name-only', source['baseCommit']).splitlines()
        tests = [name for name in names if re.search(r'(^|/)(test|tests)(/|$)|Test[^/]*\.java$', name, re.I)]
        raw = self.broker.execute_capture(owner, sandbox_id,
            ['git', 'diff', '--no-ext-diff', '--no-color', '--binary', source['baseCommit']], timeout=30)
        if raw['exitCode']:
            raise RuntimeError('Unable to read task diff')
        diff_bytes = raw['stdout'].encode()
        truncated = len(diff_bytes) > MAX_DIFF
        diff = diff_bytes[:MAX_DIFF].decode('utf8', errors='replace')
        return {'sandboxId': sandbox_id, 'workspacePath': self.broker.registry.get(owner, sandbox_id)['workspace_path'],
                'git': {'baseCommit': source['baseCommit'], 'headCommit': head, 'branch': branch,
                        'status': status, 'diff': diff, 'changedFiles': names,
                        'testsChanged': tests, 'diffTruncated': truncated}}
