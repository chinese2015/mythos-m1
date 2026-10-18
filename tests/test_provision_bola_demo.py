"""Behavioral tests for provisioning the private BOLA training repository."""
import copy
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    provisioner = importlib.import_module('tools.provision_bola_demo')
    import_error = None
except Exception as error:  # Keep the initial TDD red as an assertion, not an import error.
    provisioner = None
    import_error = type(error).__name__ + ': ' + str(error)


REPOSITORY = 'demo/demo-tenant-invoice-api'
REPOSITORY_ID = 'REPO-demo-tenant-invoice-api'
REPOSITORY_URL = 'http://127.0.0.1:3000/demo/demo-tenant-invoice-api.git'
SOURCE_PATH = 'src/main/java/com/example/invoice/InvoiceController.java'
OLD_TITLE = 'Example multi-user notes view lacks mock tenant scope'
NEW_TITLE = "Invoice endpoint exposes another tenant's invoice by ID"
BASE = 'b' * 40


def placeholder_finding():
    return {
        'id': 'FND-00016', 'name': OLD_TITLE, 'ownerId': 'owner-aster-01', 'repositoryId': 'REPO-demo-aster-ui-service',
        'repositoryUrl': 'https://git.example.test/demo/demo-aster-ui-service.git',
        'baseCommit': '6a11c9d2e8f34b0a9d5e7c61f2b8a0d4e6c3f1a2', 'sourcePath': None, 'lineRange': None,
        'status': 'Not Started', 'closed': 'Open', 'workItemId': None, 'remediationJobId': None, 'revision': 1,
    }


class FakeGitea:
    def __init__(self, events=None, repository=None, base_commit=BASE):
        self.events = events if events is not None else []
        self.exists = repository is not None
        self.repository = repository or {
            'full_name': REPOSITORY, 'clone_url': REPOSITORY_URL, 'private': True,
            'default_branch': 'main', 'permissions': {'push': True},
        }
        self.base_commit = base_commit
        self.created = 0
        self.allowlisted = set()
        self.seed_checks = 0

    def ensure_private_repository(self, full_name, default_branch):
        self.events.append(('repo', full_name, default_branch))
        if not self.exists:
            self.created += 1
            self.exists = True
        return copy.deepcopy(self.repository)

    def ensure_repository_push_allowlisted(self, full_name):
        self.events.append(('allowlist', full_name))
        self.allowlisted.add(full_name)

    def seed_or_verify_commit(self, repository_dir, full_name, branch):
        self.events.append(('seed', full_name, branch))
        self.seed_checks += 1
        return self.base_commit


class FakeMock:
    def __init__(self, events=None, finding=None, conflict=False):
        self.events = events if events is not None else []
        self.finding = finding or placeholder_finding()
        self.conflict = conflict
        self.bind_calls = []

    def get_finding(self, finding_id):
        self.events.append(('finding', finding_id))
        if finding_id != 'FND-00016':
            raise RuntimeError('unexpected Finding lookup')
        return copy.deepcopy(self.finding)

    def bind_demo_repository(self, finding_id, body):
        self.events.append(('bind', finding_id))
        self.bind_calls.append(copy.deepcopy(body))
        if self.conflict or body['expectedRevision'] != self.finding['revision']:
            raise RuntimeError('Mock CAS conflict')
        self.finding.update({
            'name': body.get('findingName', self.finding['name']),
            'repositoryId': body['repositoryId'], 'repositoryUrl': body['repositoryUrl'],
            'baseCommit': body['baseCommit'], 'sourcePath': body['sourcePath'],
            'lineRange': body['lineRange'], 'revision': self.finding['revision'] + 1,
        })
        return copy.deepcopy(self.finding)


class BolaProvisioningTests(unittest.TestCase):
    def require_provisioner(self):
        self.assertIsNotNone(provisioner, f'provisioner module is missing or failed to import: {import_error}')
        return provisioner

    def sample_directory(self, root):
        project = Path(root) / 'sample'
        (project / 'src/main/java/com/example/invoice').mkdir(parents=True)
        (project / 'pom.xml').write_text('<project/>\n', encoding='utf-8')
        (project / SOURCE_PATH).write_text('class InvoiceController {}\n', encoding='utf-8')
        test = project / 'src/test/java/com/example/invoice/InvoiceControllerTest.java'
        test.parent.mkdir(parents=True)
        test.write_text('class InvoiceControllerTest {}\n', encoding='utf-8')
        return project

    def test_create_push_and_bind_in_order(self):
        module = self.require_provisioner()
        events = []
        mock = FakeMock(events)
        with tempfile.TemporaryDirectory() as root:
            result = module.provision(self.sample_directory(root), FakeGitea(events), mock)

        event_names = [event[0] for event in events]
        self.assertLess(event_names.index('repo'), event_names.index('allowlist'))
        self.assertLess(event_names.index('allowlist'), event_names.index('seed'))
        self.assertLess(event_names.index('seed'), event_names.index('bind'))
        self.assertEqual(result, {
            'repositoryUrl': REPOSITORY_URL, 'baseCommit': BASE, 'sourcePath': SOURCE_PATH, 'revision': 2,
        })
        self.assertEqual(mock.finding.get('name'), NEW_TITLE)
        self.assertEqual(mock.bind_calls[0].get('findingName'), NEW_TITLE)

    def test_exact_rerun_is_a_noop_for_repository_commit_and_finding_revision(self):
        module = self.require_provisioner()
        events = []
        gitea = FakeGitea(events)
        mock = FakeMock(events)
        with tempfile.TemporaryDirectory() as root:
            project = self.sample_directory(root)
            first = module.provision(project, gitea, mock)
            second = module.provision(project, gitea, mock)

        self.assertEqual(first, second)
        self.assertEqual(gitea.created, 1)
        self.assertEqual(len(mock.bind_calls), 1)
        self.assertEqual(mock.finding['revision'], 2)

    def test_conflicting_existing_gitea_repository_stops_before_push_or_binding(self):
        module = self.require_provisioner()
        events = []
        gitea = FakeGitea(events, repository={
            'full_name': REPOSITORY, 'clone_url': REPOSITORY_URL, 'private': False,
            'default_branch': 'main', 'permissions': {'push': True},
        })
        mock = FakeMock(events)
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(module.ProvisionError):
                module.provision(self.sample_directory(root), gitea, mock)

        self.assertNotIn('seed', [event[0] for event in events])
        self.assertEqual(mock.bind_calls, [])

    def test_repository_without_main_default_branch_conflicts(self):
        module = self.require_provisioner()
        gitea = FakeGitea(repository={
            'full_name': REPOSITORY, 'clone_url': REPOSITORY_URL, 'private': True,
            'default_branch': '', 'permissions': {'push': True},
        })
        mock = FakeMock()
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(module.ProvisionError):
                module.provision(self.sample_directory(root), gitea, mock)

    def test_changed_finding_stops_before_repository_changes(self):
        module = self.require_provisioner()
        events = []
        gitea = FakeGitea(events)
        finding = placeholder_finding()
        finding.update(status='In Progress', workItemId='work-11111111111111111111111111111111')
        mock = FakeMock(events, finding=finding)
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(module.ProvisionError):
                module.provision(self.sample_directory(root), gitea, mock)

        self.assertNotIn('repo', [event[0] for event in events])
        self.assertEqual(mock.bind_calls, [])

    def test_mock_cas_conflict_is_not_reported_as_success(self):
        module = self.require_provisioner()
        events = []
        mock = FakeMock(events, conflict=True)
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(module.ProvisionError):
                module.provision(self.sample_directory(root), FakeGitea(events), mock)

    def test_gitea_org_create_permission_failure_is_actionable_and_redacted(self):
        module = self.require_provisioner()
        class DeniedResponse:
            status = 403
            def getheader(self, _name): return '34'
            def read(self, _maximum): return b'{"message":"permission denied; private-token-detail"}'
        class DeniedConnection:
            def __init__(self, *_args, **_kwargs): pass
            def request(self, *_args, **_kwargs): pass
            def getresponse(self): return DeniedResponse()
            def close(self): pass
        client = object.__new__(module.GiteaProvisioningClient)
        client._authorization = 'Basic private-token-detail'
        with patch.object(module.http.client, 'HTTPConnection', DeniedConnection):
            with self.assertRaises(module.ProvisionError) as raised:
                client._request('POST', '/api/v1/orgs/demo/repos', {'name': 'demo-tenant-invoice-api'}, allowed_statuses=(201, 409))
        self.assertIn('cannot create repositories in organization demo', str(raised.exception))
        self.assertNotIn('private-token-detail', str(raised.exception))

    def test_helper_allowlist_preserves_entries_mode_and_private_backup(self):
        module = self.require_provisioner()
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            allowlist = root / 'repositories.json'
            backup_dir = root / 'artifacts'
            original = json.dumps([
                {'name': 'demo-orion-notes-api'}, {'name': 'demo-nova-catalog-api'},
                {'name': 'demo-pixel-reports-batch'},
            ], indent=2) + '\n'
            allowlist.write_text(original, encoding='utf-8')
            allowlist.chmod(0o644)

            module.ensure_repository_allowlisted(allowlist, 'demo-tenant-invoice-api', backup_dir)
            updated = json.loads(allowlist.read_text())
            self.assertEqual([row['name'] for row in updated], [
                'demo-orion-notes-api', 'demo-nova-catalog-api', 'demo-pixel-reports-batch', 'demo-tenant-invoice-api',
            ])
            self.assertEqual(allowlist.stat().st_mode & 0o777, 0o644)
            backups = list(backup_dir.glob('pre-bola-repositories-*.json'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), original)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

            module.ensure_repository_allowlisted(allowlist, 'demo-tenant-invoice-api', backup_dir)
            self.assertEqual(len(list(backup_dir.glob('pre-bola-repositories-*.json'))), 1)


if __name__ == '__main__':
    unittest.main()
