"""Pure, fail-closed contracts for registered repositories and immutable tasks."""
import copy
import hashlib
import json
import re

from .errors import InvalidInput

ORIGIN = 'http://127.0.0.1:3000'
PROFILES = {'java17-maven-offline-v1', 'standard-tools-v1'}
SHA = re.compile(r'[a-f0-9]{40}')
REPO_ID = re.compile(r'repo-[a-f0-9]{32}')
FULL_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}')
MANUAL_FIELDS = {'repositoryId', 'repositoryRevision', 'title', 'description', 'acceptanceCriteria',
                 'baseBranch', 'baseCommit', 'allowedPaths', 'allowTestChanges'}


def _object(value, fields, required=None):
    if not isinstance(value, dict) or set(value) - set(fields) or not set(required or fields) <= set(value):
        raise InvalidInput('Missing or unexpected fields')
    return value


def _text(value, limit=8192):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 and c not in '\n\t' for c in value):
        raise InvalidInput('Expected nonempty bounded text')
    return value


def _integer(value, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        raise InvalidInput('Integer outside allowed range')
    return value


def _boolean(value):
    if type(value) is not bool:
        raise InvalidInput('Expected boolean')
    return value


def branch_name(value):
    _text(value, 200)
    if (value.startswith(('-', '/', '.')) or value.endswith(('/', '.', '.lock')) or '..' in value or '@{' in value
            or any(c.isspace() or c in '~^:?*[\\' for c in value) or any(p.startswith('.') or p.endswith('.lock') for p in value.split('/'))
            or '//' in value or value == '@'):
        raise InvalidInput('Unsafe Git branch')
    return value


def relative_path(value, directory=True):
    _text(value, 500)
    if (value.startswith('/') or '\\' in value or any(c.isspace() or c in '*?[]:{}' for c in value)
            or (value.endswith('/') and not directory)):
        raise InvalidInput('Unsafe repository path')
    parts = value.rstrip('/').split('/')
    if any(p in {'', '.', '..', '.git', '.cache'} for p in parts):
        raise InvalidInput('Unsafe or protected repository path')
    return value


def _paths(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 100 or any(not isinstance(p, str) for p in value) or len(set(value)) != len(value):
        raise InvalidInput('Expected 1..100 unique paths')
    return [relative_path(p) for p in value]


def _within(path, scope):
    return path == scope or (scope.endswith('/') and path.startswith(scope))


def normalize_repository(config):
    _object(config, {'displayName', 'connectionId', 'fullName', 'defaultBranch', 'runtimeProfile', 'execution', 'changePolicy', 'reviewPolicy'},
            {'displayName', 'connectionId', 'fullName', 'defaultBranch', 'runtimeProfile', 'execution', 'changePolicy'})
    _text(config['displayName'], 200)
    if config['connectionId'] != 'local-gitea' or not isinstance(config['runtimeProfile'], str) or config['runtimeProfile'] not in PROFILES:
        raise InvalidInput('Unknown connection or runtime profile')
    name = config['fullName']
    if not isinstance(name, str) or not FULL_NAME.fullmatch(name) or name.endswith('.git') or any(p in {'.', '..'} for p in name.split('/')):
        raise InvalidInput('fullName must be an owner/repository path')
    branch_name(config['defaultBranch'])
    execution = _object(config['execution'], {'baselineCommand', 'verificationCommand', 'baselineMode', 'timeoutSeconds', 'evidence'})
    _text(execution['baselineCommand']); _text(execution['verificationCommand'])
    if not isinstance(execution['baselineMode'], str) or execution['baselineMode'] not in {'record', 'must-pass', 'must-fail'}:
        raise InvalidInput('Unsupported baseline mode')
    _integer(execution['timeoutSeconds'], 1, 3600)
    evidence = _object(execution['evidence'], {'format', 'reportDirs', 'minTests', 'allowSkipped'})
    _boolean(evidence['allowSkipped'])
    if evidence['format'] == 'command':
        if evidence['reportDirs'] != [] or type(evidence['minTests']) is not int or evidence['minTests'] != 0:
            raise InvalidInput('Command evidence requires empty reportDirs and minTests=0')
    elif evidence['format'] == 'junit':
        _paths(evidence['reportDirs']); _integer(evidence['minTests'], 1, 1000000)
    else:
        raise InvalidInput('Unsupported evidence format')
    policy = _object(config['changePolicy'], {'allowedPaths', 'allowTestChanges', 'maxFiles'})
    _paths(policy['allowedPaths']); _boolean(policy['allowTestChanges']); _integer(policy['maxFiles'], 1, 10000)
    review = config.get('reviewPolicy', {'minApprovals': 0, 'requiredStatusContexts': []})
    _object(review, {'minApprovals', 'requiredStatusContexts'})
    _integer(review['minApprovals'], 0, 20)
    contexts = review['requiredStatusContexts']
    if not isinstance(contexts, list) or len(contexts) > 20:
        raise InvalidInput('Expected at most 20 required status contexts')
    for context in contexts: _text(context, 200)
    if len(set(contexts)) != len(contexts):
        raise InvalidInput('Required status contexts must be unique')
    result = copy.deepcopy(config)
    result['reviewPolicy'] = copy.deepcopy(review)
    return result


def validate_manual_input(value):
    _object(value, MANUAL_FIELDS, {'repositoryId', 'repositoryRevision', 'title', 'description', 'acceptanceCriteria'})
    if not isinstance(value['repositoryId'], str) or not REPO_ID.fullmatch(value['repositoryId']):
        raise InvalidInput('Invalid repositoryId')
    _integer(value['repositoryRevision'], 1, 2**63 - 1)
    for key, limit in [('title', 300), ('description', 16000), ('acceptanceCriteria', 16000)]:
        _text(value[key], limit)
    if 'baseBranch' in value: branch_name(value['baseBranch'])
    if 'baseCommit' in value and (not isinstance(value['baseCommit'], str) or not SHA.fullmatch(value['baseCommit'])):
        raise InvalidInput('baseCommit must be a full lowercase SHA')
    if 'allowedPaths' in value: _paths(value['allowedPaths'])
    if 'allowTestChanges' in value: _boolean(value['allowTestChanges'])
    return copy.deepcopy(value)


def make_task_spec(owner, repository, input, base_commit):
    value = validate_manual_input(input)
    config = normalize_repository(repository['config'])
    if (repository.get('ownerId') != owner or value['repositoryId'] != repository.get('repositoryId')
            or value['repositoryRevision'] != repository.get('revision') or repository.get('enabled') is not True):
        raise InvalidInput('Repository identity or revision mismatch')
    _text(owner, 200)
    if not isinstance(base_commit, str) or not SHA.fullmatch(base_commit) or value.get('baseCommit', base_commit) != base_commit:
        raise InvalidInput('Verified base commit mismatch')
    policy = config['changePolicy']
    paths = value.get('allowedPaths', policy['allowedPaths'])
    if any(not any(_within(p, parent) for parent in policy['allowedPaths']) for p in paths):
        raise InvalidInput('Task paths must narrow repository policy')
    if any(_build_path(p.rstrip('/')) and not _explicit_build_scope(p, policy['allowedPaths']) for p in paths):
        raise InvalidInput('Task cannot expand repository build configuration permission')
    allow_tests = value.get('allowTestChanges', False)
    if allow_tests and not policy['allowTestChanges']:
        raise InvalidInput('Task cannot expand test permission')
    policy.update(allowedPaths=paths, allowTestChanges=allow_tests)
    result = {'specVersion': 1, 'ownerId': owner,
              'repository': {'repositoryId': repository['repositoryId'], 'revision': repository['revision'],
                  'connectionId': 'local-gitea', 'provider': 'gitea', 'origin': ORIGIN, 'fullName': config['fullName'],
                  'cloneUrl': ORIGIN + '/' + config['fullName'] + '.git',
                  'baseBranch': value.get('baseBranch', config['defaultBranch'])},
              'baseCommit': base_commit, 'task': {k: value[k] for k in ['title', 'description', 'acceptanceCriteria']},
              'runtimeProfile': config['runtimeProfile'], 'execution': config['execution'], 'changePolicy': policy,
              'reviewPolicy': config['reviewPolicy']}
    result['specDigest'] = _digest(result)
    return result


def _digest(spec):
    payload = {k: v for k, v in spec.items() if k != 'specDigest'}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()


def validate_task_spec(spec, owner=None):
    _object(spec, {'specVersion', 'ownerId', 'repository', 'baseCommit', 'task', 'runtimeProfile', 'execution', 'changePolicy', 'reviewPolicy', 'specDigest'})
    if type(spec['specVersion']) is not int or spec['specVersion'] != 1 or (owner is not None and owner != spec['ownerId']):
        raise InvalidInput('TaskSpec version or owner mismatch')
    repo = _object(spec['repository'], {'repositoryId', 'revision', 'connectionId', 'provider', 'origin', 'fullName', 'cloneUrl', 'baseBranch'})
    task = _object(spec['task'], {'title', 'description', 'acceptanceCriteria'})
    _object(spec['changePolicy'], {'allowedPaths', 'allowTestChanges', 'maxFiles'})
    config = {'displayName': 'snapshot', 'connectionId': repo['connectionId'], 'fullName': repo['fullName'],
              'defaultBranch': repo['baseBranch'], 'runtimeProfile': spec['runtimeProfile'],
              'execution': spec['execution'], 'changePolicy': spec['changePolicy'], 'reviewPolicy': spec['reviewPolicy']}
    rebuilt = make_task_spec(spec['ownerId'], {'repositoryId': repo['repositoryId'], 'ownerId': spec['ownerId'],
        'revision': repo['revision'], 'enabled': True, 'config': config},
        {**task, 'repositoryId': repo['repositoryId'], 'repositoryRevision': repo['revision'],
         'allowTestChanges': spec['changePolicy']['allowTestChanges']}, spec['baseCommit'])
    if rebuilt != spec or _digest(spec) != spec['specDigest']:
        raise InvalidInput('TaskSpec identity or digest mismatch')
    return copy.deepcopy(spec)


def repository_config_from_spec(spec):
    """Return transport input from a validated snapshot; never read the registry."""
    spec = validate_task_spec(spec)
    repo = spec['repository']
    return normalize_repository({'displayName': repo['fullName'], 'connectionId': repo['connectionId'],
        'fullName': repo['fullName'], 'defaultBranch': repo['baseBranch'], 'runtimeProfile': spec['runtimeProfile'],
        'execution': spec['execution'], 'changePolicy': spec['changePolicy'], 'reviewPolicy': spec['reviewPolicy']})


def is_manual(work):
    return isinstance(work, dict) and isinstance(work.get('source'), dict) and work['source'].get('type') == 'MANUAL'


def frozen_task_spec(store, op):
    """Frozen TaskSpec of a MANUAL Work Item for an operation, else None.

    The spec always comes from the persisted Work Item, never from the op.
    """
    if store is None:
        return None
    work = store.get_work_item(op['ownerId'], op['workItemId'])
    if not is_manual(work):
        return None
    return validate_task_spec(work['taskSpec'], op['ownerId'])


def _test_path(path):
    return any(p.lower() in {'test', 'tests', '__tests__', 'spec', 'specs'} for p in path.split('/')) or bool(
        re.search(r'(^test[_.]|^Test|^Spec|(_test|_tests|_spec|\.test|\.spec)\.|(Test|Tests|Spec)\.)', path.split('/')[-1]))


def _build_path(path):
    return (path.split('/')[-1] in {'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
            'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pyproject.toml', 'setup.py', 'setup.cfg',
            'requirements.txt', 'Makefile', 'Dockerfile', 'Jenkinsfile', '.gitlab-ci.yml'}
            or any(p in {'.github', '.gitlab', '.circleci', '.mvn'} for p in path.split('/')))


def _explicit_build_scope(path, scopes):
    return any(_within(path, scope) and _build_path(scope.rstrip('/')) for scope in scopes)


def change_allowed(spec, paths):
    try:
        validate_task_spec(spec)
        if not isinstance(paths, list) or not paths or any(not isinstance(p, str) for p in paths): return False
        policy = spec['changePolicy']
        if len(set(paths)) > policy['maxFiles']: return False
        for path in paths:
            relative_path(path, directory=False)
            if not any(_within(path, p) for p in policy['allowedPaths']): return False
            if not policy['allowTestChanges'] and _test_path(path): return False
            if _build_path(path) and not _explicit_build_scope(path, policy['allowedPaths']): return False
        return True
    except (InvalidInput, TypeError, ValueError, KeyError):
        return False


def verification_passes(spec, operation, evidence=None):
    """Validate a completed VERIFY operation and captured evidence from independent B."""
    try:
        validate_task_spec(spec)
        op = operation; evidence = evidence if evidence is not None else op.get('evidence')
        runtime = op.get('runtime') or {}; commit = op.get('sourceCommit')
        if (op.get('kind') != 'VERIFY' or op.get('state') != 'SUCCEEDED' or type(op.get('exitCode')) is not int or op['exitCode'] != 0
                or op.get('command') != spec['execution']['verificationCommand']
                or type(op.get('timeoutSeconds')) is not int or not 1 <= op['timeoutSeconds'] <= spec['execution']['timeoutSeconds']
                or not isinstance(commit, str) or not SHA.fullmatch(commit)
                or not isinstance(op.get('sandboxId'), str) or not op['sandboxId']
                or runtime.get('freshTargetAbsent') is not True or not isinstance(runtime.get('sandboxId'), str)
                or not runtime['sandboxId'] or runtime['sandboxId'] == op['sandboxId']
                or not isinstance(evidence, dict) or evidence.get('sandboxId') != runtime['sandboxId']
                or evidence.get('sourceCommit') != commit or evidence.get('sourceDirty') is not False
                or type(evidence.get('exitCode')) is not int or evidence['exitCode'] != 0):
            return False
        policy = spec['execution']['evidence']
        if policy['format'] == 'command': return True
        junit = evidence.get('junit') or {}
        if (not isinstance(junit.get('reports'), list) or not junit['reports'] or junit.get('invalidReports') != []
                or any(type(junit.get(k)) is not int or junit[k] < 0 for k in ['tests', 'failures', 'errors', 'skipped'])
                or junit['failures'] or junit['errors'] or junit['tests'] - junit['skipped'] < policy['minTests']
                or (junit['skipped'] and not policy['allowSkipped'])):
            return False
        return all(isinstance(r, dict) and isinstance(r.get('path'), str)
                   and any(_within(r['path'], d.rstrip('/') + '/') for d in policy['reportDirs'])
                   and relative_path(r['path'], directory=False) for r in junit['reports'])
    except (InvalidInput, TypeError, ValueError, KeyError, AttributeError):
        return False
