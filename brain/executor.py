"""Trusted Docker adapter. No user command is ever executed on the host."""
import base64
import json
from pathlib import Path
import re
import subprocess
import time

from registry import AccessDenied
from . import container_runner
from .errors import InvalidInput, NotFound, PreparationFailure
from .git_host import GitHostClient
from .task_spec import frozen_task_spec, repository_config_from_spec

REPOSITORIES = {'http://127.0.0.1:3000/demo/' + name + '.git' for name in [
    'demo-orion-notes-api', 'demo-nova-catalog-api', 'demo-pixel-reports-batch']}
SETTINGS = '<settings><mirrors><mirror><id>aliyun</id><mirrorOf>*</mirrorOf><url>https://maven.aliyun.com/repository/public</url></mirror></mirrors></settings>\n'

_CLONE_URL = re.compile(r'http://127\.0\.0\.1:3000/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})\.git')


def validate_repository(url):
    if url not in REPOSITORIES:
        raise InvalidInput('Repository is not in the demo allowlist')
    return url


def validate_registered_repository(store, owner, url):
    """Task-aware entry point: the legacy allowlist stays, and repositories
    registered by this owner are also accepted. Rejected before any Git,
    Docker, or credential I/O."""
    try:
        return validate_repository(url)
    except InvalidInput:
        pass
    match = _CLONE_URL.fullmatch(url) if isinstance(url, str) else None
    if store is not None and match:
        for repository in store.repositories(owner):
            if repository.get('config', {}).get('fullName') == match.group(1):
                return url
    raise InvalidInput('Repository is not registered for this owner')


class DockerExecutor:
    def __init__(self, broker, store=None, host=None):
        self.broker = broker
        self.store = store
        self.host = host if host is not None else GitHostClient() if store is not None else None
        self.script = Path(container_runner.__file__).read_text()

    def validate_binding(self, owner, sandbox_id):
        try:
            item = self.broker.registry.get(owner, sandbox_id)
        except AccessDenied:
            raise NotFound('Resource unavailable')
        if item['state'] != 'running':
            raise InvalidInput('Sandbox is not running')
        return item

    def _inspect(self, item):
        result = subprocess.run(['docker', 'inspect', item['container_name']], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            raise RuntimeError('Registered container is unavailable')
        actual = json.loads(result.stdout)[0]
        labels = actual['Config'].get('Labels', {})
        if labels.get('argon.owner') != item['owner_id'] or labels.get('argon.sandbox') != item['sandbox_id']:
            raise RuntimeError('Container ownership labels do not match registry')
        if not actual['State']['Running']:
            raise RuntimeError('Registered container is stopped')

    def _exec(self, item, argv):
        result = self.broker.execute_capture(item['owner_id'], item['sandbox_id'], argv, timeout=30)
        if result['exitCode'] != 0:
            raise RuntimeError(result['stderr'][-1000:] or result['stdout'][-1000:])
        return result['stdout'].strip()

    def _runtime(self, item, fresh=False):
        return {'sandboxId': item['sandbox_id'], 'containerName': item['container_name'],
                'workspace': item['workspace_path'], 'freshTargetAbsent': fresh}

    def _work_spec(self, op):
        """Frozen TaskSpec from the persisted Work Item; never from the op."""
        return frozen_task_spec(self.store, op)

    def _verifier_context(self, op, remote):
        """Resolve the clone origin, branch, and credential context for fresh B.

        Raises InvalidInput for unregistered or malicious remotes before any
        verifier sandbox is created.
        """
        spec = self._work_spec(op)
        if spec is None:
            return validate_repository(remote), 'main', None
        if remote != spec['repository']['cloneUrl']:
            raise InvalidInput('Verification remote does not match the frozen task repository')
        validate_registered_repository(self.store, op['ownerId'], remote)
        context = self.host.git_context(repository_config_from_spec(spec))
        return context['url'], spec['repository']['baseBranch'], context

    def _report_dirs(self, op):
        spec = self._work_spec(op)
        if spec is None:
            return None
        return list(spec['execution']['evidence']['reportDirs'])

    def prepare(self, op):
        item = self.validate_binding(op['ownerId'], op['sandboxId'])
        self._inspect(item)
        if op['kind'] == 'VERIFY':
            item = self._prepare_verifier(op, item)
        try:
            # Seed selection remains an image concern. Missing plugins fail truthfully.
            self._exec(item, ['mkdir', '-p', '.cache/jansi'])
            subprocess.run(['docker', 'exec', '-i', '--user', '1001:1000', '-w', item['workspace_path'],
                            item['container_name'], 'sh', '-c', 'cat > .cache/settings.xml'],
                           input=SETTINGS.encode(), capture_output=True, check=True, timeout=10)
        except Exception as error:
            if op['kind'] == 'VERIFY':
                raise PreparationFailure(str(error), self._runtime(item, fresh=True)) from error
            raise
        return self._runtime(item, fresh=op['kind'] == 'VERIFY')

    def _prepare_verifier(self, op, source):
        origin, branch, context = self._verifier_context(op, self._exec(source, ['git', 'remote', 'get-url', 'origin']))
        if self._exec(source, ['git', 'rev-parse', 'HEAD']) != op['sourceCommit']:
            raise InvalidInput('Verification source HEAD does not match sourceCommit')
        label = 'verify-' + op['operationId'][5:]
        existing = [x for x in self.broker.registry.list_owned(op['ownerId']) if x['workspace_id'] == label]
        if existing:
            raise RuntimeError('Verification environment already exists; reconcile without replay')
        bundle = '.cache/' + op['operationId'] + '.bundle'
        self._exec(source, ['git', 'bundle', 'create', bundle, 'HEAD'])
        payload = subprocess.check_output(['docker', 'exec', '--user', '1001:1000', '-w', source['workspace_path'],
                                           source['container_name'], 'cat', bundle], timeout=20)
        item = self.broker.create(op['ownerId'], label, origin, branch=branch, git_context=context)
        try:
            subprocess.run(['docker', 'exec', '-i', '--user', '1001:1000', '-w', item['workspace_path'],
                            item['container_name'], 'sh', '-c', 'cat > .cache/candidate.bundle'],
                           input=payload, capture_output=True, check=True, timeout=20)
            self._exec(item, ['git', 'fetch', './.cache/candidate.bundle', 'HEAD'])
            self._exec(item, ['git', 'checkout', '--detach', 'FETCH_HEAD'])
            if self._exec(item, ['git', 'rev-parse', 'HEAD']) != op['sourceCommit']:
                raise RuntimeError('Verifier commit mismatch')
            self._exec(item, ['test', '!', '-e', 'target'])
            return item
        except Exception as error:
            raise PreparationFailure(str(error), self._runtime(item, fresh=True)) from error

    def recover_runtime(self, op):
        if op['kind'] != 'VERIFY':
            return None
        label = 'verify-' + op['operationId'][5:]
        existing = [x for x in self.broker.registry.list_owned(op['ownerId']) if x['workspace_id'] == label]
        return self._runtime(existing[0]) if len(existing) == 1 else None

    def _runner(self, op, action, detached=False):
        runtime = op['runtime']
        spec = {'operationId': op['operationId'], 'offsets': op['logOffsets']}
        if action == 'run':
            workspace = runtime['workspace']
            spec.update(workspace=workspace, command=op['command'], timeoutSeconds=op['timeoutSeconds'],
                        sourceCommit=op['sourceCommit'], uid=1001, gid=1000,
                        mavenOpts='-Dmaven.repo.local=' + workspace + '/.cache/m2/repository -Djansi.tmpdir=' + workspace + '/.cache/jansi')
            report_dirs = self._report_dirs(op)
            if report_dirs is not None:
                spec['reportDirs'] = report_dirs
        payload = base64.b64encode(json.dumps(spec).encode()).decode()
        argv = ['docker', 'exec'] + (['-d'] if detached else [])
        argv += ['--user', '0', runtime['containerName'], 'python3', '-c', self.script, action, payload]
        result = subprocess.run(argv, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            raise RuntimeError('Container supervisor unavailable: ' + result.stderr[-500:])
        return json.loads(result.stdout) if result.stdout.strip() else None

    def start(self, op):
        self._runner(op, 'run', detached=True)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = self.poll(op)['state']
            if state != 'MISSING':
                return
            time.sleep(.05)
        raise RuntimeError('Supervisor did not acknowledge launch')

    def poll(self, op):
        item = self.broker.registry.get(op['ownerId'], op['runtime']['sandboxId'])
        self._inspect(item)
        return self._runner(op, 'poll')

    def cancel(self, op):
        return self._runner(op, 'cancel')

    def cleanup(self, op):
        if not op['runtime'].get('preparedOnly'):
            result = self._runner(op, 'cleanup')
            if not result['cleaned']:
                raise RuntimeError('Supervisor has no confirmed result; cleanup refused')
        if op['kind'] == 'VERIFY':
            item = self.broker.registry.get(op['ownerId'], op['runtime']['sandboxId'])
            if item['state'] == 'running':
                self.broker.stop(op['ownerId'], item['sandbox_id'])
            subprocess.run(['docker', 'rm', '-v', item['container_name']], capture_output=True, check=True, timeout=20)
        return {'status': 'done'}
