"""Provision the single local tenant-invoice BOLA demo without exposing credentials."""
import argparse
import base64
from datetime import datetime, timezone
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from brain.git_host import GitHostClient  # noqa: E402


FINDING_ID = 'FND-00016'
OWNER_ID = 'owner-aster-01'
FULL_NAME = 'demo/demo-tenant-invoice-api'
REPOSITORY_NAME = 'demo-tenant-invoice-api'
REPOSITORY_ID = 'REPO-demo-tenant-invoice-api'
GITEA_ORIGIN = 'http://127.0.0.1:3000'
MOCK_ORIGIN = 'http://127.0.0.1:8080'
REPOSITORY_URL = GITEA_ORIGIN + '/' + FULL_NAME + '.git'
SOURCE_PATH = 'src/main/java/com/example/invoice/InvoiceController.java'
LINE_RANGE = '51-54'
PLACEHOLDER_REPOSITORY_ID = 'REPO-demo-aster-ui-service'
PLACEHOLDER_URL = 'https://git.example.test/demo/demo-aster-ui-service.git'
PLACEHOLDER_COMMIT = '6a11c9d2e8f34b0a9d5e7c61f2b8a0d4e6c3f1a2'
PLACEHOLDER_NAME = 'Example multi-user notes view lacks mock tenant scope'
FINDING_NAME = "Invoice endpoint exposes another tenant's invoice by ID"
BASELINE_COMMAND = 'mvn -B -o -s .cache/settings.xml test'
SHA = re.compile(r'^[0-9a-f]{40}$')
MAX_RESPONSE_BYTES = 1024 * 1024
DEFAULT_REPOSITORY_DIR = ROOT / 'samples/security/demo-tenant-invoice-api'


class ProvisionError(RuntimeError):
    """A safe, user-facing provisioning error without raw service output."""


def _read_private_credentials(credential_file):
    try:
        return GitHostClient(credential_file)._credentials()
    except Exception:
        raise ProvisionError('Private Gitea credentials are unavailable') from None


def _read_secure_file(path):
    path = Path(path)
    if path.is_symlink():
        raise ProvisionError('Gitea helper allowlist must not be a symlink')
    fd = None
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) & 0o022 or metadata.st_size > 1024 * 1024):
            raise ProvisionError('Gitea helper allowlist has unsafe ownership, mode, or size')
        with os.fdopen(fd, 'rb') as stream:
            fd = None
            return metadata, stream.read()
    except ProvisionError:
        raise
    except Exception:
        raise ProvisionError('Gitea helper allowlist is unavailable or invalid') from None
    finally:
        if fd is not None:
            os.close(fd)


def _private_backup_directory(directory):
    directory = Path(directory)
    try:
        if not directory.exists():
            directory.mkdir(parents=True, mode=0o700)
        metadata = directory.stat()
        if (directory.is_symlink() or not stat.S_ISDIR(metadata.st_mode)
                or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077):
            raise ProvisionError('Private backup directory has unsafe ownership or mode')
        return directory
    except ProvisionError:
        raise
    except Exception:
        raise ProvisionError('Private backup directory is unavailable') from None


def ensure_repository_allowlisted(allowlist_path, repository_name, backup_dir):
    """Append exactly the BOLA repo, preserving the existing helper allowlist safely."""
    if repository_name != REPOSITORY_NAME:
        raise ProvisionError('Only the tenant invoice demo can be added to the Git helper')
    allowlist_path = Path(allowlist_path)
    metadata, original = _read_secure_file(allowlist_path)
    try:
        entries = json.loads(original)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ProvisionError('Gitea helper allowlist is invalid JSON') from None
    if not isinstance(entries, list) or any(not isinstance(row, dict) or not isinstance(row.get('name'), str) for row in entries):
        raise ProvisionError('Gitea helper allowlist has an unsupported structure')
    names = [row['name'] for row in entries]
    if len(names) != len(set(names)):
        raise ProvisionError('Gitea helper allowlist contains duplicate names')
    if repository_name in names:
        return None

    backup_dir = _private_backup_directory(backup_dir)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_path = backup_dir / f'pre-bola-repositories-{stamp}-{uuid.uuid4().hex[:8]}.json'
    backup_fd = None
    temporary_path = None
    try:
        backup_fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(backup_fd, 'wb') as stream:
            backup_fd = None
            stream.write(original)
            stream.flush()
            os.fsync(stream.fileno())

        entries.append({'name': repository_name})
        updated = (json.dumps(entries, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        temporary_path = allowlist_path.with_name('.' + allowlist_path.name + '.bola-' + uuid.uuid4().hex + '.tmp')
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        temporary_fd = os.open(temporary_path, flags, stat.S_IMODE(metadata.st_mode))
        try:
            os.fchown(temporary_fd, metadata.st_uid, metadata.st_gid)
            os.fchmod(temporary_fd, stat.S_IMODE(metadata.st_mode))
            with os.fdopen(temporary_fd, 'wb') as stream:
                temporary_fd = None
                stream.write(updated)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if temporary_fd is not None:
                os.close(temporary_fd)

        current_metadata, current = _read_secure_file(allowlist_path)
        if (current != original or current_metadata.st_ino != metadata.st_ino
                or current_metadata.st_dev != metadata.st_dev):
            raise ProvisionError('Gitea helper allowlist changed concurrently; reload and retry')
        os.replace(temporary_path, allowlist_path)
        temporary_path = None
        directory_fd = os.open(allowlist_path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        final = allowlist_path.stat()
        if (final.st_uid != metadata.st_uid or final.st_gid != metadata.st_gid
                or stat.S_IMODE(final.st_mode) != stat.S_IMODE(metadata.st_mode)):
            raise ProvisionError('Gitea helper allowlist ownership or mode changed')
        return backup_path
    except ProvisionError:
        raise
    except Exception:
        raise ProvisionError('Unable to update the exact Gitea helper allowlist entry') from None
    finally:
        if backup_fd is not None:
            os.close(backup_fd)
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass


class GiteaProvisioningClient:
    def __init__(self, credential_file=None, helper_path=None, allowlist_path=None, backup_dir=None):
        self.credential_file = Path(credential_file).expanduser() if credential_file else Path.home() / 'gitea/secrets/argon-agent.json'
        self.helper_path = Path(helper_path).expanduser() if helper_path else Path.home() / 'gitea/git-credential-argon.py'
        self.allowlist_path = Path(allowlist_path).expanduser() if allowlist_path else Path.home() / 'gitea/repositories.json'
        self.backup_dir = Path(backup_dir).expanduser() if backup_dir else Path.home() / 'argon-m1-generic/artifacts'
        credentials = _read_private_credentials(self.credential_file)
        authorization = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode('utf-8')).decode('ascii')
        self._authorization = 'Basic ' + authorization

    def _request(self, method, path, payload=None, allowed_statuses=(200,)):
        if not path.startswith('/api/v1/') or '..' in path or '\\' in path:
            raise ProvisionError('Invalid fixed Gitea API route')
        body = None if payload is None else json.dumps(payload, separators=(',', ':')).encode('utf-8')
        headers = {'Authorization': self._authorization, 'Accept': 'application/json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', 3000, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > MAX_RESPONSE_BYTES):
                raise ProvisionError('Gitea response exceeds the size limit')
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise ProvisionError('Gitea response exceeds the size limit')
            if response.status not in allowed_statuses:
                if method == 'POST' and path == '/api/v1/orgs/demo/repos' and response.status == 403:
                    raise ProvisionError('Configured Gitea account cannot create repositories in organization demo')
                raise ProvisionError('Gitea API request failed with HTTP ' + str(response.status))
            if response.status == 404 or not data:
                return response.status, None
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ProvisionError('Gitea returned an invalid repository response')
            return response.status, value
        except ProvisionError:
            raise
        except Exception:
            raise ProvisionError('Gitea API is unavailable or returned invalid JSON') from None
        finally:
            connection.close()

    def ensure_private_repository(self, full_name, default_branch):
        if full_name != FULL_NAME or default_branch != 'main':
            raise ProvisionError('Only the configured tenant invoice repository can be provisioned')
        path = '/api/v1/repos/' + full_name
        status, repository = self._request('GET', path, allowed_statuses=(200, 404))
        if status == 404:
            payload = {'name': REPOSITORY_NAME, 'private': True, 'auto_init': False, 'default_branch': 'main'}
            self._request('POST', '/api/v1/orgs/demo/repos', payload, allowed_statuses=(201, 409))
            status, repository = self._request('GET', path, allowed_statuses=(200, 404))
        if status != 200 or not isinstance(repository, dict):
            raise ProvisionError('The private demo repository could not be verified')
        permissions = repository.get('permissions')
        if (repository.get('full_name') != FULL_NAME or repository.get('clone_url') != REPOSITORY_URL
                or repository.get('private') is not True or repository.get('default_branch') not in {'', 'main'}
                or not isinstance(permissions, dict) or permissions.get('push') is not True):
            raise ProvisionError('An existing Gitea repository conflicts with the demo identity or permissions')
        return repository

    def ensure_repository_push_allowlisted(self, full_name):
        if full_name != FULL_NAME:
            raise ProvisionError('Only the configured tenant invoice repository can be allowlisted')
        ensure_repository_allowlisted(self.allowlist_path, REPOSITORY_NAME, self.backup_dir)

    def seed_or_verify_commit(self, repository_dir, full_name, branch):
        if full_name != FULL_NAME or branch != 'main':
            raise ProvisionError('Invalid demo repository target')
        source = Path(repository_dir)
        if source.is_symlink() or not source.is_dir():
            raise ProvisionError('The vulnerable demo source directory is unavailable')
        if not (source / 'pom.xml').is_file() or not (source / SOURCE_PATH).is_file():
            raise ProvisionError('The vulnerable demo source is incomplete')

        with tempfile.TemporaryDirectory(prefix='argon-bola-repo-') as temporary:
            worktree = Path(temporary) / 'repo'
            shutil.copytree(source, worktree, ignore=shutil.ignore_patterns('.git', '.cache', 'target'))
            self._run_git(worktree, ['init', '--initial-branch=main'])
            self._run_git(worktree, ['config', 'user.name', 'Argon Demo Fixture'])
            self._run_git(worktree, ['config', 'user.email', 'argon-demo@localhost'])
            self._run_git(worktree, ['add', '--all'])
            environment = os.environ.copy()
            environment.update({
                'GIT_AUTHOR_NAME': 'Argon Demo Fixture',
                'GIT_AUTHOR_EMAIL': 'argon-demo@localhost',
                'GIT_AUTHOR_DATE': '2026-10-18T00:00:00+00:00',
                'GIT_COMMITTER_NAME': 'Argon Demo Fixture',
                'GIT_COMMITTER_EMAIL': 'argon-demo@localhost',
                'GIT_COMMITTER_DATE': '2026-10-18T00:00:00+00:00',
            })
            self._run_git(worktree, ['commit', '-m', 'feat: add tenant invoice BOLA demo baseline'], environment=environment)
            base_commit = self._run_git(worktree, ['rev-parse', 'HEAD'])
            if not SHA.fullmatch(base_commit):
                raise ProvisionError('Git did not create a full base commit')

            self._run_git(worktree, ['remote', 'add', 'origin', REPOSITORY_URL])
            remote = self._run_git(worktree, ['ls-remote', '--heads', 'origin', 'refs/heads/main'], credentialed=True)
            remote_sha = self._remote_main_sha(remote)
            if remote_sha is None:
                self._run_git(worktree, ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/main'], credentialed=True)
                remote = self._run_git(worktree, ['ls-remote', '--heads', 'origin', 'refs/heads/main'], credentialed=True)
                remote_sha = self._remote_main_sha(remote)
            if remote_sha != base_commit:
                raise ProvisionError('Remote main does not match the exact vulnerable base commit')
            return base_commit

    def _run_git(self, worktree, arguments, *, environment=None, credentialed=False):
        command = ['git']
        if credentialed:
            helper = str(self.helper_path)
            command.extend(['-c', 'credential.helper=!python3 ' + helper, '-c', 'credential.useHttpPath=true'])
        command.extend(['-C', str(worktree), *arguments])
        env = os.environ.copy() if environment is None else environment.copy()
        env.update({'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull})
        env.pop('GIT_ASKPASS', None)
        env.pop('SSH_ASKPASS', None)
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=60, env=env, check=False)
        except Exception:
            raise ProvisionError('Git operation could not be started') from None
        if result.returncode != 0:
            raise ProvisionError('Git operation failed with exit ' + str(result.returncode))
        return result.stdout.strip()

    @staticmethod
    def _remote_main_sha(output):
        if not output:
            return None
        lines = [line.split() for line in output.splitlines() if line.strip()]
        matches = [parts[0] for parts in lines if len(parts) == 2 and parts[1] == 'refs/heads/main']
        if len(matches) != 1 or not SHA.fullmatch(matches[0]):
            raise ProvisionError('Gitea returned an ambiguous main branch')
        return matches[0]


class MockBindingClient:
    def __init__(self, origin=MOCK_ORIGIN):
        if origin != MOCK_ORIGIN:
            raise ProvisionError('Only the configured local Mock source is supported')

    def _request(self, method, path, payload=None):
        if path not in {'/api/findings/' + FINDING_ID,
                        '/api/findings/' + FINDING_ID + '/bind-demo-repository'}:
            raise ProvisionError('Invalid fixed Mock route')
        body = None if payload is None else json.dumps(payload, separators=(',', ':')).encode('utf-8')
        headers = {'Accept': 'application/json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', 8080, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > MAX_RESPONSE_BYTES):
                raise ProvisionError('Mock response exceeds the size limit')
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise ProvisionError('Mock response exceeds the size limit')
            if response.status != 200:
                raise ProvisionError('Mock binding failed with HTTP ' + str(response.status))
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ProvisionError('Mock returned an invalid Finding record')
            return value
        except ProvisionError:
            raise
        except Exception:
            raise ProvisionError('Mock API is unavailable or returned invalid JSON') from None
        finally:
            connection.close()

    def get_finding(self, finding_id):
        if finding_id != FINDING_ID:
            raise ProvisionError('Only FND-00016 may be provisioned')
        return self._request('GET', '/api/findings/' + FINDING_ID)

    def bind_demo_repository(self, finding_id, body):
        if finding_id != FINDING_ID:
            raise ProvisionError('Only FND-00016 may be provisioned')
        return self._request('POST', '/api/findings/' + FINDING_ID + '/bind-demo-repository', body)


def _valid_placeholder(finding):
    return (finding.get('id') == FINDING_ID and finding.get('name') == PLACEHOLDER_NAME
            and finding.get('ownerId') == OWNER_ID
            and finding.get('repositoryId') == PLACEHOLDER_REPOSITORY_ID
            and finding.get('repositoryUrl') == PLACEHOLDER_URL and finding.get('baseCommit') == PLACEHOLDER_COMMIT
            and finding.get('sourcePath') is None and finding.get('lineRange') is None
            and finding.get('status') == 'Not Started' and finding.get('closed') == 'Open'
            and finding.get('workItemId') is None and finding.get('remediationJobId') is None
            and type(finding.get('revision')) is int and finding['revision'] > 0)


def _bound_identity(finding):
    return (finding.get('id') == FINDING_ID and finding.get('name') == FINDING_NAME
            and finding.get('ownerId') == OWNER_ID
            and finding.get('repositoryId') == REPOSITORY_ID and finding.get('repositoryUrl') == REPOSITORY_URL
            and SHA.fullmatch(str(finding.get('baseCommit', ''))) is not None
            and finding.get('sourcePath') == SOURCE_PATH and finding.get('lineRange') == LINE_RANGE
            and type(finding.get('revision')) is int and finding['revision'] > 0)


def _matches_bound_target(finding, base_commit):
    return (_bound_identity(finding) and finding.get('baseCommit') == base_commit
            and finding.get('status') == 'Not Started' and finding.get('closed') == 'Open'
            and finding.get('workItemId') is None and finding.get('remediationJobId') is None)


def _validate_repository_info(repository):
    permissions = repository.get('permissions') if isinstance(repository, dict) else None
    if (not isinstance(repository, dict) or repository.get('full_name') != FULL_NAME
            or repository.get('clone_url') != REPOSITORY_URL or repository.get('private') is not True
                or repository.get('default_branch') != 'main'
            or not isinstance(permissions, dict) or permissions.get('push') is not True):
        raise ProvisionError('Existing Gitea repository conflicts with the expected private demo identity')


def _validate_template(repository_dir):
    source = Path(repository_dir)
    if source.is_symlink() or not source.is_dir():
        raise ProvisionError('The vulnerable demo source directory is unavailable')
    for relative in ('pom.xml', 'src/test/java/com/example/invoice/InvoiceControllerTest.java', SOURCE_PATH):
        path = source / relative
        if path.is_symlink() or not path.is_file():
            raise ProvisionError('The vulnerable demo source is incomplete')
    return source


def provision(repository_dir, gitea_client, mock_client):
    """Create the exact private repo, seed its vulnerable base, and bind FND-00016."""
    source = _validate_template(repository_dir)
    finding = mock_client.get_finding(FINDING_ID)
    placeholder = _valid_placeholder(finding)
    already_bound = _bound_identity(finding)
    if not placeholder and not already_bound:
        raise ProvisionError('FND-00016 changed or was claimed before provisioning')

    repository = gitea_client.ensure_private_repository(FULL_NAME, 'main')
    _validate_repository_info(repository)
    gitea_client.ensure_repository_push_allowlisted(FULL_NAME)
    base_commit = gitea_client.seed_or_verify_commit(source, FULL_NAME, 'main')
    if not isinstance(base_commit, str) or not SHA.fullmatch(base_commit):
        raise ProvisionError('Gitea did not return the full vulnerable base SHA')

    current = mock_client.get_finding(FINDING_ID)
    if _matches_bound_target(current, base_commit):
        return {'repositoryUrl': REPOSITORY_URL, 'baseCommit': base_commit, 'sourcePath': SOURCE_PATH,
                'revision': current['revision']}
    if not _valid_placeholder(current):
        raise ProvisionError('FND-00016 changed while the repository was being provisioned')

    binding = {'expectedRevision': current['revision'], 'repositoryId': REPOSITORY_ID,
               'repositoryUrl': REPOSITORY_URL, 'baseCommit': base_commit,
               'sourcePath': SOURCE_PATH, 'lineRange': LINE_RANGE, 'findingName': FINDING_NAME}
    try:
        mock_client.bind_demo_repository(FINDING_ID, binding)
    except Exception:
        raise ProvisionError('Mock rejected the FND-00016 compare-and-set binding') from None
    verified = mock_client.get_finding(FINDING_ID)
    if not _matches_bound_target(verified, base_commit):
        raise ProvisionError('FND-00016 binding did not persist the exact repository identity')
    return {'repositoryUrl': REPOSITORY_URL, 'baseCommit': base_commit, 'sourcePath': SOURCE_PATH,
            'revision': verified['revision']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(argv)
    try:
        result = provision(DEFAULT_REPOSITORY_DIR,
                           GiteaProvisioningClient(),
                           MockBindingClient())
        print(json.dumps({'status': 'PASSED', **result}, ensure_ascii=False, sort_keys=True))
        return 0
    except ProvisionError as error:
        print(json.dumps({'status': 'NOT_READY', 'message': str(error)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
