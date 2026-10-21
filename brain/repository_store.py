"""Repository registry and manual intake transactions, mixed into Store."""
import json
import uuid

from .errors import Conflict, InvalidInput
from .task_spec import normalize_repository, validate_manual_input, validate_task_spec, make_task_spec


class RepositoryStore:
    def register_repository(self, owner, config, key):
        from .store import encoded, identifier, now
        config = normalize_repository(config)
        with self.connection(True) as db:
            retry, digest = self._retry(db, owner, 'register-repository', key, config)
            if retry: return json.loads(retry)
            timestamp = now()
            repository = {'repositoryId': identifier('repo'), 'ownerId': owner, 'revision': 1,
                          'enabled': True, 'config': config, 'createdAt': timestamp, 'updatedAt': timestamp}
            db.execute('INSERT INTO repositories VALUES (?, ?, ?)', (repository['repositoryId'], owner, encoded(repository)))
            self._remember(db, owner, 'register-repository', key, digest, encoded(repository))
            return repository

    def repositories(self, owner):
        with self.connection() as db:
            return [json.loads(row['data']) for row in db.execute('SELECT data FROM repositories WHERE owner=? ORDER BY rowid', (owner,))]

    def repository(self, owner, id):
        with self.connection() as db:
            return self._get(db, 'repositories', id, owner)

    def revise_repository(self, owner, id, body, key):
        from .store import encoded, now
        if (not isinstance(body, dict) or set(body) - {'expectedRevision', 'config', 'enabled'}
                or type(body.get('expectedRevision')) is not int or body['expectedRevision'] < 1
                or not ({'config', 'enabled'} & set(body))
                or ('enabled' in body and type(body['enabled']) is not bool)):
            raise InvalidInput('Revision requires positive expectedRevision and config or enabled')
        body = dict(body)
        if 'config' in body: body['config'] = normalize_repository(body['config'])
        with self.connection(True) as db:
            scope = 'revise-repository:' + id
            retry, digest = self._retry(db, owner, scope, key, body)
            if retry: return json.loads(retry)
            repository = self._get(db, 'repositories', id, owner)
            if repository['revision'] != body['expectedRevision']:
                raise Conflict('Stale repository revision')
            repository.update({k: body[k] for k in ['config', 'enabled'] if k in body})
            repository.update(revision=repository['revision'] + 1, updatedAt=now())
            db.execute('UPDATE repositories SET data=? WHERE id=? AND owner=?', (encoded(repository), id, owner))
            self._remember(db, owner, scope, key, digest, encoded(repository))
            return repository

    def manual_retry(self, owner, input, key):
        value = validate_manual_input(input)
        with self.connection() as db:
            retry, _ = self._retry(db, owner, 'create-manual-task', key, value)
            return json.loads(retry) if retry else None

    def create_manual_task(self, owner, input, spec, key):
        from .store import encoded, identifier, now
        value = validate_manual_input(input)
        spec = validate_task_spec(spec, owner)
        with self.connection(True) as db:
            scope = 'create-manual-task'
            retry, digest = self._retry(db, owner, scope, key, value)
            if retry: return json.loads(retry)
            repo = self._get(db, 'repositories', value['repositoryId'], owner)
            if repo['revision'] != value['repositoryRevision'] or not repo['enabled']:
                raise Conflict('Repository configuration changed or is disabled')
            if make_task_spec(owner, repo, value, spec['baseCommit']) != spec:
                raise Conflict('TaskSpec does not match registered repository')
            source = {'type': 'MANUAL', 'id': 'TASK-' + uuid.uuid4().hex[:12], 'revision': 1}
            source_record = {'id': source['id'], **spec['task'], 'ownerId': owner,
                             'repositoryUrl': spec['repository']['cloneUrl'], 'baseCommit': spec['baseCommit'], 'revision': 1,
                             'sourcePath': '', 'sourcePaths': spec['changePolicy']['allowedPaths']}
            work = {'workItemId': identifier('work'), 'ownerId': owner, 'source': source,
                    'sourceRecord': source_record,
                    'taskSpec': spec, 'sandboxId': None, 'sessionId': None, 'sessionIds': [],
                    'stage': 'CLAIMED', 'status': 'CLAIMED', 'paused': False, 'blocked': False,
                    'workflow': {'phase': 'CLAIMED'}, 'version': 1, 'sequence': 0, 'createdAt': now()}
            db.execute('INSERT INTO work_items VALUES (?, ?, ?, ?)', (work['workItemId'], owner, encoded(source), encoded(work)))
            self._event(db, work['workItemId'], 'work_item.claimed', {'source': source, 'sourceRecord': source_record,
                                                                   'specDigest': spec['specDigest']})
            work = self._work(db, work['workItemId'], owner)
            self._remember(db, owner, scope, key, digest, encoded(work))
            return work
