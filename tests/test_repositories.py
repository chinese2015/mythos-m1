import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection
from unittest.mock import patch

from brain.api import make_server
from brain.errors import Conflict, InvalidInput, NotFound
from brain.git_host import GitHostClient
from brain.repositories import RepositoryService
from brain.store import Store
from brain.task_spec import make_task_spec, change_allowed
from test_task_spec import config, task_input


class Host:
    def __init__(self): self.head = 'a' * 40; self.available = True; self.on_resolve = None
    def check(self, value):
        if not self.available: raise Conflict('Host unavailable')
        return {'fullName': value['fullName'], 'defaultBranch': 'main', 'pushPermission': True}
    def resolve(self, value, branch):
        self.check(value)
        if self.on_resolve: self.on_resolve()
        return self.head


class RepositoriesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name); self.host = Host(); self.service = RepositoryService(self.store, self.host)
    def register(self): return self.service.register('alice', config(), 'repo')
    def input(self, repo): return {**task_input(), 'repositoryId': repo['repositoryId']}

    def test_register_revision_disable_and_owner_isolation_persist(self):
        repo = self.register()
        self.assertEqual(repo['revision'], 1); self.assertTrue(repo['enabled'])
        self.assertRegex(repo['repositoryId'], '^repo-[a-f0-9]{32}$')
        self.assertEqual(self.register(), repo)
        self.assertEqual(self.store.repositories('bob'), [])
        with self.assertRaises(NotFound): self.store.repository('bob', repo['repositoryId'])
        with self.assertRaises(NotFound): self.service.revise('bob', repo['repositoryId'], {'expectedRevision': 1, 'enabled': False}, 'bob')
        with self.assertRaises(NotFound): self.service.check('bob', repo['repositoryId'])
        changed = self.service.revise('alice', repo['repositoryId'], {'expectedRevision': 1, 'enabled': False}, 'disable')
        self.assertEqual(changed['revision'], 2); self.assertFalse(changed['enabled'])
        self.assertEqual(Store(self.temp.name).repositories('alice'), [changed])
        with self.assertRaises(Conflict): self.service.create_task('alice', {**self.input(repo), 'repositoryRevision': 2}, 'task')
        with self.assertRaises(Conflict): self.service.revise('alice', repo['repositoryId'], {'expectedRevision': 1, 'enabled': True}, 'stale')
        self.assertEqual(self.service.revise('alice', repo['repositoryId'], {'expectedRevision': 1, 'enabled': False}, 'disable'), changed)

    def test_manual_create_freezes_snapshot_without_allocating_resources_and_replays_before_host(self):
        repo = self.register(); body = self.input(repo)
        work = self.service.create_task('alice', body, 'task')
        self.assertEqual(work['source']['type'], 'MANUAL'); self.assertRegex(work['source']['id'], '^TASK-[a-f0-9]{12}$')
        self.assertEqual(work['sourceRecord']['sourcePath'], ''); self.assertEqual(work['sourceRecord']['sourcePaths'], ['src/'])
        self.assertIsNone(work['sandboxId']); self.assertEqual(work['sessionIds'], [])
        self.assertEqual(work['taskSpec']['baseCommit'], 'a' * 40)
        self.assertEqual(work['sourceRecord']['repositoryUrl'], 'http://127.0.0.1:3000/demo/customer-api.git')
        changed_config = config(); changed_config['execution']['verificationCommand'] = 'echo new-policy'
        self.service.revise('alice', repo['repositoryId'], {'expectedRevision': 1, 'enabled': False, 'config': changed_config}, 'disable')
        self.assertEqual(self.store.get_work_item('alice', work['workItemId'])['taskSpec']['execution']['verificationCommand'], 'mvn test')
        self.host.head = 'b' * 40; self.host.available = False
        self.assertEqual(self.service.create_task('alice', body, 'task'), work)
        self.assertEqual(Store(self.temp.name).get_work_item('alice', work['workItemId'])['taskSpec'], work['taskSpec'])
        self.assertEqual(self.store.snapshot('alice', work['workItemId'])['operations'], [])
        with self.assertRaises(Conflict): self.service.create_task('alice', {**body, 'title': 'different'}, 'task')
        with self.assertRaises(NotFound): self.service.create_task('bob', body, 'other')

    def test_pre_io_validation_stale_sha_and_transactional_revision_race(self):
        repo = self.register(); body = self.input(repo); self.host.available = False
        for patch_body in [{'title': []}, {'allowedPaths': ['/tmp/']}, {'baseBranch': '-main'}, {'baseCommit': 'bad'}]:
            with self.subTest(patch=patch_body), self.assertRaises(InvalidInput): self.service.create_task('alice', {**body, **patch_body}, 'bad')
        with self.assertRaises(InvalidInput): self.service.create_task('alice', body, None)
        self.host.available = True
        with self.assertRaises(Conflict): self.service.create_task('alice', {**body, 'baseCommit': 'b' * 40}, 'stale-sha')
        self.host.on_resolve = lambda: self.service.revise('alice', repo['repositoryId'], {'expectedRevision': 1, 'enabled': False}, 'race')
        with self.assertRaises(Conflict): self.service.create_task('alice', body, 'race-task')
        self.assertEqual(self.store.list_work_items('alice'), [])

    def test_build_permission_cannot_expand_during_admission_or_direct_store_create(self):
        repo = self.register(); body = {**self.input(repo), 'allowedPaths': ['src/pom.xml']}
        class NoIOHost:
            def check(self, config): raise AssertionError('Build scope must be validated before host I/O')
            def resolve(self, config, branch): raise AssertionError('Build scope must be validated before ref I/O')
        service = RepositoryService(self.store, NoIOHost())
        with self.assertRaises(InvalidInput): service.create_task('alice', body, 'no-build-expansion')
        self.assertEqual(self.store.list_work_items('alice'), [])
        approved_copy = copy.deepcopy(repo)
        approved_copy['config']['changePolicy']['allowedPaths'].append('src/pom.xml')
        forged = make_task_spec('alice', approved_copy, body, 'a' * 40)
        with self.assertRaises(InvalidInput): self.store.create_manual_task('alice', body, forged, 'direct-no-expansion')
        revised = self.service.revise('alice', repo['repositoryId'],
            {'expectedRevision': 1, 'config': approved_copy['config']}, 'approve-build')
        accepted = self.service.create_task('alice', {**body, 'repositoryRevision': revised['revision']}, 'approved-build')
        self.assertTrue(change_allowed(accepted['taskSpec'], ['src/pom.xml']))

    def test_new_task_requires_push_permission_before_ref_lookup(self):
        repo = self.register()
        class ReadOnlyHost:
            def check(self, config): return {'fullName': config['fullName'], 'defaultBranch': 'main', 'pushPermission': False}
            def resolve(self, config, branch): raise AssertionError('Ref lookup must follow permission check')
        service = RepositoryService(self.store, ReadOnlyHost())
        with self.assertRaises(Conflict): service.create_task('alice', self.input(repo), 'no-push')
        self.assertEqual(self.store.list_work_items('alice'), [])

    def test_revision_cas_race_has_one_winner(self):
        repo = self.register(); results = []; barrier = threading.Barrier(2)
        def revise(i):
            barrier.wait()
            try: self.service.revise('alice', repo['repositoryId'], {'expectedRevision': 1, 'enabled': False}, 'cas-' + str(i)); results.append('ok')
            except Conflict: results.append('conflict')
        threads = [threading.Thread(target=revise, args=(i,)) for i in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(results, ['ok', 'conflict'])

    def test_http_routes_auth_bad_json_types_conflicts_and_existing_positional_publisher(self):
        server = make_server(self.store, SimpleNamespace(broker=None), {'alice': 'token-a', 'bob': 'token-b'}, ('127.0.0.1', 0), object(), self.service)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        def request(method, route, body=None, key='request', token='token-a', raw=None):
            headers = {'Content-Type': 'application/json', 'Idempotency-Key': key, 'Authorization': 'Bearer ' + token}
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            req = urllib.request.Request('http://127.0.0.1:' + str(server.server_port) + '/api/brain/' + route, data=data, headers=headers, method=method)
            try: response = urllib.request.urlopen(req, timeout=3)
            except urllib.error.HTTPError as error: response = error
            with response: return response.status, json.load(response)
        self.assertEqual(request('GET', 'repositories', token='bad')[0], 401)
        self.assertEqual(request('POST', 'repositories', raw=b'{bad')[0], 400)
        self.assertEqual(request('POST', 'repositories', body=[])[0], 400)
        code, repo = request('POST', 'repositories', config()); self.assertEqual(code, 201)
        self.assertEqual(request('GET', 'repositories')[1]['repositories'], [repo])
        self.assertEqual(request('GET', 'repositories', token='token-b')[1]['repositories'], [])
        self.assertEqual(request('POST', 'repositories/' + repo['repositoryId'] + '/check', {})[1]['pushPermission'], True)
        self.assertEqual(request('POST', 'tasks/manual', self.input(repo), key='task')[0], 202)
        self.assertEqual(request('POST', 'repositories/' + repo['repositoryId'] + '/revisions', {'expectedRevision': 1, 'enabled': False}, key='disable')[0], 200)
        self.assertEqual(request('POST', 'tasks/manual', self.input(repo), key='task')[0], 202)


class GitHostTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.credentials = Path(self.temp.name) / 'credentials.json'
        self.credentials.write_text(json.dumps({'username': 'mythos-agent', 'password': 'private-password-fixture'})); self.credentials.chmod(0o600)
    def test_private_lazy_credentials_and_no_untrusted_context(self):
        client = GitHostClient(self.credentials)
        self.assertEqual(client.git_context(config()), {'url': 'http://127.0.0.1:3000/demo/customer-api.git', 'credentialFile': str(self.credentials)})
        self.credentials.chmod(0o644)
        with self.assertRaises(InvalidInput): client.git_context(config())
        self.credentials.unlink()
        client = GitHostClient(self.credentials)
        with self.assertRaises(InvalidInput): client.git_context({**config(), 'fullName': 'http://attacker/repo'})
        with self.assertRaises(InvalidInput): client.check(config())

    def test_real_http_get_basic_permission_ref_redirect_and_response_bound(self):
        paths = []; mode = {'value': 'ok'}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                paths.append((self.path, self.headers.get('Authorization')))
                if mode['value'] == 'redirect':
                    self.send_response(302); self.send_header('Location', '/stolen'); self.end_headers(); return
                value = {'full_name': 'demo/customer-api', 'default_branch': 'main', 'permissions': {'push': True}}
                if '/branches/' in self.path: value = {'commit': {'id': 'c' * 40}}
                if mode['value'] == 'big': value = {'data': 'x' * 1048577}
                data = json.dumps(value).encode(); self.send_response(200); self.end_headers(); self.wfile.write(data)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        transport = patch('brain.git_host.HTTPConnection', side_effect=lambda host, port, timeout: HTTPConnection('127.0.0.1', server.server_port, timeout=timeout))
        transport.start(); self.addCleanup(transport.stop)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        client = GitHostClient(self.credentials)
        self.assertEqual(client.check(config()), {'fullName': 'demo/customer-api', 'defaultBranch': 'main', 'pushPermission': True})
        self.assertEqual(client.resolve(config(), 'feature/a'), 'c' * 40)
        self.assertEqual(paths[-1][0], '/api/v1/repos/demo/customer-api/branches/feature%2Fa')
        self.assertTrue(paths[0][1].startswith('Basic '))
        mode['value'] = 'redirect'
        with self.assertRaises(Conflict): client.check(config())
        self.assertFalse(any(path == '/stolen' for path, _ in paths))
        mode['value'] = 'big'
        with self.assertRaises(Conflict): client.check(config())


if __name__ == '__main__': unittest.main()
