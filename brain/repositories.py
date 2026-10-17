"""Admission service: validate, resolve a real ref, freeze, then CAS in SQLite."""
from .errors import Conflict
from .git_host import GitHostClient
from .task_spec import make_task_spec, normalize_repository, validate_manual_input


class RepositoryService:
    def __init__(self, store, host=None):
        self.store = store
        self.host = host if host is not None else GitHostClient()

    def register(self, owner, body, key):
        return self.store.register_repository(owner, normalize_repository(body), key)

    def revise(self, owner, id, body, key):
        return self.store.revise_repository(owner, id, body, key)

    def check(self, owner, id):
        return self.host.check(self.store.repository(owner, id)['config'])

    def create_task(self, owner, input, key):
        value = validate_manual_input(input)
        retry = self.store.manual_retry(owner, value, key)
        if retry is not None:
            return retry
        repository = self.store.repository(owner, value['repositoryId'])
        if repository['revision'] != value['repositoryRevision'] or not repository['enabled']:
            raise Conflict('Repository configuration changed or is disabled')
        # Validate the full narrowing policy before credential or network I/O.
        provisional = make_task_spec(owner, repository, {k: v for k, v in value.items() if k != 'baseCommit'}, '0' * 40)
        permissions = self.host.check(repository['config'])
        if not isinstance(permissions, dict) or permissions.get('pushPermission') is not True:
            raise Conflict('Repository push permission is required')
        head = self.host.resolve(repository['config'], provisional['repository']['baseBranch'])
        if 'baseCommit' in value and value['baseCommit'] != head:
            raise Conflict('baseCommit must equal current branch HEAD')
        spec = make_task_spec(owner, repository, value, head)
        return self.store.create_manual_task(owner, value, spec, key)
