import concurrent.futures
from pathlib import Path
import tempfile
import unittest

from registry import Registry, AccessDenied, QuotaExceeded


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.registry = Registry(Path(self.temp.name), per_owner_limit=2, global_limit=4)

    def test_other_owner_cannot_access_or_stop_sandbox(self):
        item = self.registry.allocate('alice', 'nova')
        with self.assertRaises(AccessDenied):
            self.registry.get('bob', item['sandbox_id'])
        with self.assertRaises(AccessDenied):
            self.registry.transition('bob', item['sandbox_id'], 'stopped')
        self.assertEqual(self.registry.get('alice', item['sandbox_id'])['state'], 'allocated')

    def test_owner_quota_is_checked_atomically_under_concurrent_requests(self):
        def allocate(i):
            try:
                return self.registry.allocate('alice', 'task-' + str(i))
            except QuotaExceeded:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            items = list(pool.map(allocate, range(8)))
        self.assertEqual(sum(x is not None for x in items), 2)

    def test_global_quota_and_stopped_capacity(self):
        first = self.registry.allocate('alice', 'a')
        self.registry.allocate('alice', 'b')
        self.registry.allocate('bob', 'a')
        self.registry.allocate('bob', 'b')
        with self.assertRaises(QuotaExceeded):
            self.registry.allocate('charlie', 'a')
        self.registry.transition('alice', first['sandbox_id'], 'stopped')
        self.assertEqual(self.registry.allocate('charlie', 'a')['owner_id'], 'charlie')

    def test_unconfirmed_cleanup_retains_admission_capacity(self):
        first = self.registry.allocate('alice', 'a')
        self.registry.allocate('alice', 'b')
        self.registry.transition('alice', first['sandbox_id'], 'cleanup-pending')
        with self.assertRaises(QuotaExceeded):
            self.registry.allocate('alice', 'c')
        self.registry.transition('alice', first['sandbox_id'], 'failed')
        self.assertEqual(self.registry.allocate('alice', 'c')['state'], 'allocated')

    def test_identifiers_cannot_escape_storage_paths(self):
        for owner, workspace in [('../bob', 'a'), ('alice', '../b'), ('a;b', 'b')]:
            with self.assertRaises(ValueError):
                self.registry.allocate(owner, workspace)

    def test_listing_is_scoped_to_owner(self):
        a = self.registry.allocate('alice', 'a')
        self.registry.allocate('bob', 'b')
        self.assertEqual([item['sandbox_id'] for item in self.registry.list_owned('alice')], [a['sandbox_id']])

    def test_workspace_and_container_are_unique_for_each_owner_and_task(self):
        a = self.registry.allocate('alice', 'same')
        b = self.registry.allocate('bob', 'same')
        self.assertNotEqual(a['container_name'], b['container_name'])
        self.assertNotEqual(a['workspace_path'], b['workspace_path'])
        self.assertTrue(Path(a['workspace_path']).is_relative_to(Path(self.temp.name).resolve()))


if __name__ == '__main__':
    unittest.main()
