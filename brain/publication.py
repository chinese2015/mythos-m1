"""Fixed, bounded Git publication for a Cordis-owned durable delivery intent."""
import hashlib
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import time

from .errors import Conflict, InvalidInput
from .evidence import passing_junit
from .executor import validate_repository
from .store import ACTIVE, TERMINAL
from .workspace import TaskWorkspace

MAX_BUNDLE = 32 * 1024 * 1024
CREDENTIAL_HELPER = '/home/hx/gitea/git-credential-argon.py'
SHA = re.compile(r'^[0-9a-f]{40}$')


def delivery_id(work_item_id, candidate_commit, verification_operation_id):
    value = f'{work_item_id}:{candidate_commit}:{verification_operation_id}'.encode('utf-8')
    return hashlib.sha256(value).hexdigest()


def publication_branch(finding_id, work_item_id, candidate_commit):
    return f"argon/{finding_id.lower()}-{work_item_id.split('-')[-1][:8]}-{candidate_commit[:12]}"


class GitPublisher:
    """Validates stored M2 evidence, exports a bundle, then pushes one immutable ref."""

    def __init__(self, store, executor):
        self.store = store
        self.executor = executor
        self.workspace = TaskWorkspace(store, executor)

    def publish(self, owner, work_id, requested_delivery_id, idempotency_key, expected_version=None):
        if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 200:
            raise InvalidInput('Idempotency-Key is required (1..200 characters)')
        if type(expected_version) is not int or expected_version < 1:
            raise InvalidInput('expectedVersion must be a positive integer')
        if not isinstance(requested_delivery_id, str) or not re.fullmatch(r'[0-9a-f]{64}', requested_delivery_id):
            raise InvalidInput('deliveryId must be a SHA-256 hex digest')
        work = self.store.get_work_item(owner, work_id)
        if expected_version is not None and work['version'] != expected_version:
            raise Conflict('Stale expectedVersion')
        intent, candidate, verify_id, branch, repository = self._validate_intent(
            owner, work, requested_delivery_id)
        tree = self._container_exec(owner, work['sandboxId'], ['git', 'rev-parse', candidate + '^{tree}'])
        if not SHA.fullmatch(tree):
            raise Conflict('Task workspace cannot resolve the verified candidate tree')

        remote = self._remote_commit(repository, branch, work)
        if remote:
            if remote != candidate:
                raise Conflict('Publication branch already exists with a different commit')
            return self._report(intent, repository, branch, candidate, remote, True, tree)

        bundle = self._export_bundle(owner, work, candidate, intent['id'])
        with tempfile.TemporaryDirectory(prefix='argon-publish-') as temp:
            temp_path = Path(temp)
            bare = temp_path / 'staging.git'
            self._git(temp_path, ['init', '--bare', str(bare)], auth=False)
            bundle_file = temp_path / 'candidate.bundle'
            bundle_file.write_bytes(bundle)
            self._git(bare, ['fetch', '--no-tags', str(bundle_file), 'HEAD'], auth=False)
            imported = self._git(bare, ['rev-parse', 'FETCH_HEAD'], auth=False).strip()
            if imported != candidate:
                raise Conflict('Imported bundle does not contain the exact verified candidate')
            imported_tree = self._git(bare, ['rev-parse', candidate + '^{tree}'], auth=False).strip()
            if imported_tree != tree:
                raise Conflict('Imported bundle tree differs from verified candidate tree')
            try:
                self._git(bare, ['push', repository, candidate + ':refs/heads/' + branch], auth=True)
            except RuntimeError:
                # A lost acknowledgement or concurrent create is resolved only by
                # authoritative ref state; never retry with force.
                remote = self._remote_commit(repository, branch, work)
                if remote == candidate:
                    return self._report(intent, repository, branch, candidate, remote, True, tree)
                if remote:
                    raise Conflict('Publication branch was concurrently created with another commit')
                raise
        remote = self._remote_commit(repository, branch, work)
        if remote != candidate:
            raise Conflict('Remote did not confirm the exact candidate commit')
        return self._report(intent, repository, branch, candidate, remote, False, tree)

    def _validate_intent(self, owner, work, requested_delivery_id):
        source = work.get('sourceRecord')
        workflow = work.get('workflow') or {}
        intent = workflow.get('delivery')
        if (work.get('ownerId') != owner or work.get('source', {}).get('type') != 'ARGON'
                or not isinstance(source, dict) or not source.get('ownerId')
                or work.get('source', {}).get('id') != source.get('id')):
            raise Conflict('Publication requires an owner-bound Argon task')
        repository = validate_repository(source.get('repositoryUrl'))
        if not isinstance(intent, dict) or workflow.get('phase') != 'PUBLISHING':
            raise Conflict('No active durable publication intent')
        candidate = intent.get('candidateCommit')
        verify_id = intent.get('verificationOperationId')
        branch = publication_branch(source['id'], work['workItemId'], candidate) if isinstance(candidate, str) else ''
        if (not isinstance(candidate, str) or not SHA.fullmatch(candidate)
                or not isinstance(verify_id, str) or not re.fullmatch(r'exec-[a-f0-9]{32}', verify_id)
                or intent.get('id') != delivery_id(work['workItemId'], candidate, verify_id)
                or requested_delivery_id != intent['id']
                or intent.get('headBranch') != branch
                or intent.get('repositoryUrl') != repository
                or intent.get('step') != 'PUSH_PENDING'
                or workflow.get('candidateCommit') != candidate):
            raise Conflict('Publication request does not match the durable delivery intent')
        if work.get('stage') != 'PUBLISHING' or work.get('paused') or not workflow.get('approval'):
            raise Conflict('Task is not approved and ready for publication')
        snapshot = self.store.snapshot(owner, work['workItemId'])
        operations = snapshot['operations']
        if any(op['state'] in ACTIVE or op['state'] == 'UNKNOWN' or op['state'] not in TERMINAL
               for op in operations):
            raise Conflict('Task has an active, uncertain, or queued operation')
        verify = next((op for op in operations if op['operationId'] == verify_id), None)
        if (not verify or verify.get('kind') != 'VERIFY' or verify.get('state') != 'SUCCEEDED'
                or verify.get('sourceCommit') != candidate or verify.get('sandboxId') != work.get('sandboxId')
                or type(verify.get('exitCode')) is not int or verify.get('exitCode') != 0):
            raise Conflict('Fresh successful verification for the exact candidate is required')
        verified = self.store.operation(owner, verify_id)
        evidence = verified.get('evidence') or {}
        runtime = verified.get('runtime') or {}
        junit = evidence.get('junit') or {}
        if (evidence.get('sourceCommit') != candidate or evidence.get('sourceDirty') is not False
                or type(evidence.get('exitCode')) is not int or evidence.get('exitCode') != 0
                or evidence.get('sandboxId') != runtime.get('sandboxId')
                or not passing_junit(junit) or junit.get('tests') != 2 or junit.get('failures') != 0
                or junit.get('errors') != 0 or junit.get('skipped') != 0 or junit.get('invalidReports')
                or runtime.get('freshTargetAbsent') is not True
                or runtime.get('sandboxId') in {None, work.get('sandboxId')}):
            raise Conflict('Verification evidence is incomplete or does not match publication policy')
        git = self.workspace.evidence(owner, work['workItemId'])['git']
        if (git['headCommit'] != candidate or git['status'] or git['diffTruncated']
                or git['changedFiles'] != [source['sourcePath']] or git['testsChanged']):
            raise Conflict('Source workspace is not the clean exact verified candidate')
        self._container_exec(owner, work['sandboxId'],
                             ['git', 'merge-base', '--is-ancestor', source['baseCommit'], candidate])
        remote = self._container_exec(owner, work['sandboxId'], ['git', 'remote', 'get-url', 'origin'])
        if validate_repository(remote) != repository:
            raise Conflict('Task workspace repository binding changed')
        return intent, candidate, verify_id, branch, repository

    def _export_bundle(self, owner, work, candidate, delivery):
        sandbox = work.get('sandboxId')
        if not sandbox:
            raise Conflict('Task workspace is not bound')
        item = self.executor.validate_binding(owner, sandbox)
        self.executor._inspect(item)
        bundle_path = '.cache/publish-' + delivery + '.bundle'
        try:
            self._container_exec(owner, sandbox, ['git', 'bundle', 'create', bundle_path, 'HEAD'])
            process = subprocess.Popen(['docker', 'exec', '--user', '1001:1000', '-w', item['workspace_path'],
                                        item['container_name'], 'cat', bundle_path],
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            chunks = []
            length = 0
            deadline = time.monotonic() + 30
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while selector.get_map():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            raise RuntimeError('Registered container bundle read timed out')
                        chunk = os.read(process.stdout.fileno(), min(65536, MAX_BUNDLE - length + 1))
                        if not chunk:
                            selector.unregister(process.stdout)
                            continue
                        length += len(chunk)
                        if length > MAX_BUNDLE:
                            raise Conflict('Publication bundle exceeds the 32 MiB limit')
                        chunks.append(chunk)
                code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired as error:
                process.kill()
                process.wait()
                raise RuntimeError('Registered container bundle read timed out') from error
            except (RuntimeError, Conflict):
                process.kill()
                process.wait()
                raise
            finally:
                if process.stdout:
                    process.stdout.close()
            if code != 0:
                raise RuntimeError('Unable to read publication bundle from registered container')
            payload = b''.join(chunks)
            if not payload:
                raise Conflict('Publication bundle is empty')
            return payload
        finally:
            try:
                self._container_exec(owner, sandbox, ['rm', '-f', bundle_path])
            except Exception:
                pass

    def _container_exec(self, owner, sandbox, argv):
        result = self.executor.broker.execute_capture(owner, sandbox, argv, timeout=30)
        if result['exitCode']:
            raise Conflict('Registered task container rejected fixed Git operation')
        return result['stdout'].strip()

    def _git(self, cwd, args, auth=False):
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(cwd),
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
               'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/false'}
        command = ['git', '-c', 'core.hooksPath=/dev/null']
        if auth:
            command += ['-c', 'credential.helper=' + CREDENTIAL_HELPER,
                        '-c', 'credential.useHttpPath=true']
        command += args
        process = subprocess.Popen(command, cwd=str(cwd), env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
        chunks = []
        length = 0
        deadline = time.monotonic() + 30
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise RuntimeError('Trusted Git publication command timed out')
                    chunk = os.read(process.stdout.fileno(), min(8192, 65536 - length + 1))
                    if not chunk:
                        selector.unregister(process.stdout)
                        continue
                    length += len(chunk)
                    if length > 65536:
                        raise RuntimeError('Trusted Git publication response exceeded its limit')
                    chunks.append(chunk)
            code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.wait()
            raise RuntimeError('Trusted Git publication command timed out') from error
        except RuntimeError:
            process.kill()
            process.wait()
            raise
        finally:
            if process.stdout:
                process.stdout.close()
        if code:
            # Git diagnostics can include a remote URL or helper output. Keep all
            # transport output private and return a fixed message to API callers.
            raise RuntimeError('Trusted Git publication command failed')
        return b''.join(chunks).decode('utf-8', errors='replace')

    def _remote_commit(self, repository, branch, work):
        validate_repository(repository)
        # A private temporary directory provides a sanitized HOME and Git config.
        with tempfile.TemporaryDirectory(prefix='argon-publish-query-') as temp:
            output = self._git(Path(temp), ['ls-remote', '--heads', repository,
                                            'refs/heads/' + branch], auth=True)
        rows = [line.split('\t', 1) for line in output.splitlines() if '\t' in line]
        if not rows:
            return None
        if len(rows) != 1 or rows[0][1] != 'refs/heads/' + branch or not SHA.fullmatch(rows[0][0]):
            raise Conflict('Remote returned an ambiguous publication ref')
        return rows[0][0]

    @staticmethod
    def _report(intent, repository, branch, candidate, remote, reconciled, tree=None):
        return {'deliveryId': intent['id'], 'repositoryUrl': repository, 'branch': branch,
                'candidateCommit': candidate, 'candidateTree': tree, 'remoteCommit': remote,
                'reconciled': reconciled}
