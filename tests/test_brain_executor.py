from pathlib import Path
import tempfile
import unittest

from brain.errors import InvalidInput, NotFound, PreparationFailure
from brain.executor import DockerExecutor, validate_repository
from sandbox import SandboxBroker


class ExecutorPolicyTests(unittest.TestCase):
    def test_only_exact_demo_repository_urls_are_accepted(self):
        url = 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git'
        self.assertEqual(validate_repository(url), url)
        for forbidden in ['file:///etc', '/home/hx/private',
                          'http://user:secret@127.0.0.1:3000/demo/demo-nova-catalog-api.git',
                          url + '?x=1', url.replace('/demo/', '/private/'),
                          url.replace('127.0.0.1', 'example.com')]:
            with self.assertRaises(InvalidInput):
                validate_repository(forbidden)

    def test_binding_checks_owner_and_running_state_before_docker_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            broker = SandboxBroker(Path(temporary))
            record = broker.registry.allocate('alice', 'task')
            executor = DockerExecutor(broker)
            with self.assertRaises(NotFound):
                executor.validate_binding('bob', record['sandbox_id'])
            with self.assertRaises(InvalidInput):
                executor.validate_binding('alice', record['sandbox_id'])
            broker.registry.transition('alice', record['sandbox_id'], 'running')
            self.assertEqual(executor.validate_binding('alice', record['sandbox_id'])['owner_id'], 'alice')

    def test_post_allocation_preparation_failure_exposes_verifier_for_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            broker = SandboxBroker(Path(temporary))
            source = broker.registry.allocate('alice', 'source')
            broker.registry.transition('alice', source['sandbox_id'], 'running')
            class FailingSetup(DockerExecutor):
                def _inspect(self, item):
                    pass
                def _prepare_verifier(self, operation, source):
                    item = self.broker.registry.allocate('alice', 'verifier')
                    return self.broker.registry.transition('alice', item['sandbox_id'], 'running')
                def _exec(self, item, argv):
                    raise RuntimeError('Filesystem full')
            executor = FailingSetup(broker)
            with self.assertRaises(PreparationFailure) as raised:
                executor.prepare({'ownerId': 'alice', 'sandboxId': source['sandbox_id'], 'kind': 'VERIFY'})
            self.assertNotEqual(raised.exception.runtime['sandboxId'], source['sandbox_id'])
            self.assertTrue(raised.exception.runtime['preparedOnly'])


if __name__ == '__main__':
    unittest.main()
