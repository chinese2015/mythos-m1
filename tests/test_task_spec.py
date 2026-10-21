import copy
import hashlib
import json
from pathlib import Path
import unittest

from brain.errors import InvalidInput
from brain.task_spec import (normalize_repository, make_task_spec, validate_task_spec,
                             is_manual, change_allowed, verification_passes, repository_config_from_spec)


def config():
    return {'displayName': '客户 API', 'connectionId': 'local-gitea', 'fullName': 'demo/customer-api',
            'defaultBranch': 'main', 'runtimeProfile': 'java17-maven-offline-v1',
            'execution': {'baselineCommand': 'mvn test', 'verificationCommand': 'mvn test',
                          'baselineMode': 'record', 'timeoutSeconds': 300,
                          'evidence': {'format': 'junit', 'reportDirs': ['target/surefire-reports'],
                                       'minTests': 1, 'allowSkipped': False}},
            'changePolicy': {'allowedPaths': ['src/'], 'allowTestChanges': False, 'maxFiles': 100}}


def repository():
    return {'repositoryId': 'repo-' + '1' * 32, 'ownerId': 'alice', 'revision': 1,
            'enabled': True, 'config': config()}


def task_input():
    return {'repositoryId': 'repo-' + '1' * 32, 'repositoryRevision': 1,
            'title': '修复客户', 'description': 'Support multiple files', 'acceptanceCriteria': 'Tests pass'}


def spec():
    return make_task_spec('alice', repository(), task_input(), 'a' * 40)


class TaskSpecTest(unittest.TestCase):
    def test_freezes_and_validates_canonical_digest(self):
        value = spec()
        self.assertEqual(value['repository']['cloneUrl'], 'http://127.0.0.1:3000/demo/customer-api.git')
        canonical = json.dumps({k: v for k, v in value.items() if k != 'specDigest'},
                               sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        self.assertEqual(value['specDigest'], hashlib.sha256(canonical.encode()).hexdigest())
        self.assertEqual(validate_task_spec(value, 'alice'), value)
        self.assertTrue(is_manual({'source': {'type': 'MANUAL'}, 'taskSpec': value}))
        self.assertFalse(is_manual({'source': {'type': 'MYTHOS'}, 'taskSpec': value}))
        for mutate in [lambda s: s['task'].update(title='changed'),
                       lambda s: s.update(ownerId='bob'), lambda s: s.update(secret='x')]:
            changed = copy.deepcopy(value); mutate(changed)
            with self.assertRaises(InvalidInput): validate_task_spec(changed, 'alice')

    def test_repository_rejects_untrusted_destinations_types_paths_and_fields(self):
        changes = [{'connectionId': 'remote'}, {'fullName': 'http://attacker/x'},
                   {'fullName': '../x'}, {'fullName': 'demo/x.git'}, {'fullName': 'demo/x?x'},
                   {'defaultBranch': '-main'}, {'defaultBranch': 'main..next'},
                   {'runtimeProfile': 'docker-socket'}, {'credentialFile': '/tmp/x'}]
        for patch in changes:
            with self.subTest(patch=patch), self.assertRaises(InvalidInput):
                normalize_repository({**config(), **patch})
        for path in ['/tmp/', '../src/', 'src/../x', 'src//x', '.git/config', 'src/.cache/', 'src/*', 'src\\x', 'src/\x00']:
            value = config(); value['changePolicy']['allowedPaths'] = [path]
            with self.subTest(path=path), self.assertRaises(InvalidInput): normalize_repository(value)
        for part, field, value in [('execution', 'timeoutSeconds', True), ('changePolicy', 'maxFiles', 0),
                                   ('changePolicy', 'allowTestChanges', 'false')]:
            data = config(); data[part][field] = value
            with self.assertRaises(InvalidInput): normalize_repository(data)

    def test_review_policy_defaults_validates_and_freezes_into_digest(self):
        self.assertEqual(normalize_repository(config())['reviewPolicy'], {'minApprovals': 0, 'requiredStatusContexts': []})
        repo = repository(); repo['config']['reviewPolicy'] = {'minApprovals': 2, 'requiredStatusContexts': ['ci/build']}
        value = make_task_spec('alice', repo, task_input(), 'a' * 40)
        self.assertEqual(value['reviewPolicy'], {'minApprovals': 2, 'requiredStatusContexts': ['ci/build']})
        repo['config']['reviewPolicy']['minApprovals'] = 0
        self.assertEqual(value['reviewPolicy']['minApprovals'], 2)
        self.assertNotEqual(value['specDigest'], spec()['specDigest'])
        for policy in [{'minApprovals': True, 'requiredStatusContexts': []}, {'minApprovals': 21, 'requiredStatusContexts': []},
                       {'minApprovals': 0, 'requiredStatusContexts': ['']}, {'minApprovals': 0, 'requiredStatusContexts': ['x' * 201]},
                       {'minApprovals': 0, 'requiredStatusContexts': ['ci'] * 21}, {'minApprovals': 0, 'requiredStatusContexts': 'ci'},
                       {'minApprovals': 0, 'requiredStatusContexts': [], 'skipHumanMerge': True}]:
            with self.subTest(policy=policy), self.assertRaises(InvalidInput): normalize_repository({**config(), 'reviewPolicy': policy})

    def test_malformed_nested_types_are_domain_errors_before_io(self):
        changes = [('runtimeProfile', []), ('connectionId', {}), ('fullName', []),
                   ('execution', []), ('changePolicy', {})]
        for field, value in changes:
            with self.subTest(field=field), self.assertRaises(InvalidInput):
                normalize_repository({**config(), field: value})
        for path in [[{}], [None], [1], ['src/', 'src/']]:
            value = config(); value['changePolicy']['allowedPaths'] = path
            with self.subTest(path=path), self.assertRaises(InvalidInput): normalize_repository(value)
        value = config(); value['execution']['baselineMode'] = []
        with self.assertRaises(InvalidInput): normalize_repository(value)

    def test_test_permission_covers_common_test_names_and_directories(self):
        for path in ['src/TestCustomer.java', 'src/customer_test.py', 'src/test.py', 'src/test.sh',
                     'src/customer.spec.mjs', 'src/__tests__/a.js', 'src/tests/a.py']:
            with self.subTest(path=path): self.assertFalse(change_allowed(spec(), [path]))

    def test_transport_config_reconstructs_only_the_validated_frozen_snapshot(self):
        repo = repository(); repo['config']['reviewPolicy'] = {'minApprovals': 2, 'requiredStatusContexts': ['ci/build']}
        value = make_task_spec('alice', repo, {**task_input(), 'baseBranch': 'feature/fix', 'allowedPaths': ['src/main/']}, 'a' * 40)
        repo['config']['fullName'] = 'other/changed'; repo['config']['execution']['verificationCommand'] = 'true'
        frozen = repository_config_from_spec(value)
        self.assertEqual(frozen['displayName'], 'demo/customer-api')
        self.assertEqual(frozen['fullName'], 'demo/customer-api')
        self.assertEqual(frozen['defaultBranch'], 'feature/fix')
        self.assertEqual(frozen['execution']['verificationCommand'], 'mvn test')
        self.assertEqual(frozen['changePolicy']['allowedPaths'], ['src/main/'])
        self.assertEqual(frozen['reviewPolicy']['minApprovals'], 2)
        frozen['execution']['verificationCommand'] = 'false'
        self.assertEqual(value['execution']['verificationCommand'], 'mvn test')
        value['repository']['origin'] = 'http://attacker'
        with self.assertRaises(InvalidInput): repository_config_from_spec(value)

    def test_scope_only_narrows_and_test_permission_cannot_expand(self):
        data = task_input(); data['allowedPaths'] = ['src/main/']
        narrowed = make_task_spec('alice', repository(), data, 'a' * 40)
        self.assertEqual(narrowed['changePolicy']['allowedPaths'], ['src/main/'])
        for patch in [{'allowedPaths': ['pom.xml']}, {'allowTestChanges': True}, {'baseBranch': '../main'}, {'baseCommit': 'b' * 40}]:
            with self.assertRaises(InvalidInput): make_task_spec('alice', repository(), {**data, **patch}, 'a' * 40)
        with self.assertRaises(InvalidInput): make_task_spec('bob', repository(), data, 'a' * 40)

    def test_task_narrowing_cannot_turn_a_broad_repository_scope_into_build_permission(self):
        repo = repository()
        self.assertFalse(change_allowed(make_task_spec('alice', repo, task_input(), 'a' * 40), ['src/pom.xml']))
        for path in ['src/pom.xml', 'src/package.json', 'src/.github/workflows/', 'src/.github/workflows/build.yml']:
            with self.subTest(path=path), self.assertRaises(InvalidInput):
                make_task_spec('alice', repo, {**task_input(), 'allowedPaths': [path]}, 'a' * 40)
        repo['config']['changePolicy']['allowedPaths'] = ['src/', 'src/pom.xml', 'src/.github/workflows/']
        for scope, changed in [('src/pom.xml', 'src/pom.xml'),
                               ('src/.github/workflows/', 'src/.github/workflows/build.yml'),
                               ('src/.github/workflows/build.yml', 'src/.github/workflows/build.yml')]:
            with self.subTest(scope=scope):
                value = make_task_spec('alice', repo, {**task_input(), 'allowedPaths': [scope]}, 'a' * 40)
                self.assertTrue(change_allowed(value, [changed]))

    def test_malformed_frozen_change_policy_raises_a_domain_error(self):
        for policy in [{}, [], None, {'allowedPaths': ['src/']}]:
            value = spec(); value['changePolicy'] = policy
            with self.subTest(policy=policy), self.assertRaises(InvalidInput): validate_task_spec(value)

    def test_repository_test_permission_is_only_a_ceiling_task_must_opt_in(self):
        repo = repository(); repo['config']['changePolicy']['allowTestChanges'] = True
        default = make_task_spec('alice', repo, task_input(), 'a' * 40)
        self.assertFalse(default['changePolicy']['allowTestChanges'])
        self.assertFalse(change_allowed(default, ['src/test/CustomerTest.java']))
        explicit = make_task_spec('alice', repo, {**task_input(), 'allowTestChanges': True}, 'a' * 40)
        self.assertTrue(change_allowed(explicit, ['src/test/CustomerTest.java']))
        self.assertNotEqual(default['specDigest'], explicit['specDigest'])

    def test_changes_require_finite_safe_nonempty_scope_and_explicit_build_configuration(self):
        value = spec()
        for paths, want in [(['src/main/A.java', 'src/main/B.java'], True), ([], False),
                            (['src/test/ATest.java'], False), (['src/main/A.java', 'pom.xml'], False),
                            (['src/main/.git/config'], False), (['src/main/.cache/x'], False),
                            (['src/main/../x'], False), (['src/main/A.java\nother'], False),
                            (['src/main/pom.xml'], False)]:
            self.assertEqual(change_allowed(value, paths), want, paths)
        repo = repository(); repo['config']['changePolicy'].update(allowedPaths=['src/', 'pom.xml', '.github/workflows/'], allowTestChanges=True, maxFiles=2)
        value = make_task_spec('alice', repo, {**task_input(), 'allowTestChanges': True}, 'a' * 40)
        self.assertTrue(change_allowed(value, ['pom.xml', 'src/test/ATest.java']))
        self.assertTrue(change_allowed(value, ['.github/workflows/test.yml']))
        self.assertFalse(change_allowed(value, ['src/a', 'src/b', 'src/c']))

    def test_verification_requires_real_reports_exact_command_commit_and_fresh_b(self):
        value = spec(); op = {'kind': 'VERIFY', 'state': 'SUCCEEDED', 'exitCode': 0,
            'command': 'mvn test', 'timeoutSeconds': 300, 'sourceCommit': 'b' * 40,
            'sandboxId': 'sandbox-a', 'runtime': {'sandboxId': 'sandbox-b', 'freshTargetAbsent': True}}
        evidence = {'exitCode': 0, 'sourceCommit': 'b' * 40, 'sourceDirty': False, 'sandboxId': 'sandbox-b',
                    'junit': {'reports': [{'path': 'target/surefire-reports/TEST-a.xml'}], 'invalidReports': [],
                              'tests': 3, 'failures': 0, 'errors': 0, 'skipped': 0}}
        self.assertTrue(verification_passes(value, op, evidence))
        for patch in [{'sourceCommit': 'c' * 40}, {'command': 'true'}, {'state': 'UNKNOWN'}, {'exitCode': True},
                      {'runtime': {'sandboxId': 'sandbox-a', 'freshTargetAbsent': True}},
                      {'runtime': {'sandboxId': 'sandbox-b', 'freshTargetAbsent': False}}, {'runtime': None}, {'runtime': {}}]:
            self.assertFalse(verification_passes(value, {**op, **patch}, evidence), patch)
        for patch in [{'sourceDirty': True}, {'sourceCommit': 'c' * 40}, {'exitCode': 1},
                      {'junit': {**evidence['junit'], 'reports': []}}, {'junit': {**evidence['junit'], 'skipped': 1}},
                      {'junit': {**evidence['junit'], 'tests': 0}}, {'junit': {**evidence['junit'], 'invalidReports': ['broken']}}]:
            self.assertFalse(verification_passes(value, op, {**evidence, **patch}), patch)

    def test_command_evidence_is_explicit_and_does_not_fabricate_junit(self):
        repo = repository(); repo['config']['runtimeProfile'] = 'standard-tools-v1'
        repo['config']['execution']['evidence'] = {'format': 'command', 'reportDirs': [], 'minTests': 0, 'allowSkipped': False}
        value = make_task_spec('alice', repo, task_input(), 'a' * 40)
        op = {'kind': 'VERIFY', 'state': 'SUCCEEDED', 'command': 'mvn test', 'timeoutSeconds': 300,
              'exitCode': 0, 'sourceCommit': 'b' * 40, 'sandboxId': 'a',
              'runtime': {'sandboxId': 'b', 'freshTargetAbsent': True}}
        evidence = {'exitCode': 0, 'sourceCommit': 'b' * 40, 'sourceDirty': False, 'sandboxId': 'b'}
        self.assertTrue(verification_passes(value, op, evidence))
        self.assertFalse(verification_passes(value, op, {**evidence, 'exitCode': None}))
        repo['config']['execution']['evidence']['minTests'] = 1
        with self.assertRaises(InvalidInput): normalize_repository(repo['config'])

    def test_shared_json_fixture_has_valid_digest_and_policy_cases(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/generic-task-spec.json').read_text())
        validate_task_spec(fixture['taskSpec'], 'alice')
        for case in fixture['buildPermissionCases']:
            repo = repository(); repo['config'] = case['repositoryConfig']
            with self.subTest(name=case['name']):
                if case['admitted']:
                    value = make_task_spec('alice', repo, case['manualInput'], fixture['taskSpec']['baseCommit'])
                    self.assertEqual(change_allowed(value, case['changedPaths']), case['changeAllowed'])
                else:
                    with self.assertRaises(InvalidInput):
                        make_task_spec('alice', repo, case['manualInput'], fixture['taskSpec']['baseCommit'])
        for case in fixture['testPermissionCases']:
            validate_task_spec(case['taskSpec'], 'alice')
            self.assertEqual(case['taskSpec']['changePolicy']['allowTestChanges'], case['allowTestChanges'])
        for case in fixture['verificationCases']:
            self.assertEqual(verification_passes(fixture['taskSpec'], case['operation'], case['evidence']), case['passes'], case['name'])
        for case in fixture['changeCases']:
            self.assertEqual(change_allowed(fixture['taskSpec'], case['paths']), case['allowed'])


if __name__ == '__main__': unittest.main()
