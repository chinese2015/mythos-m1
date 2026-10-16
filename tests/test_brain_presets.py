import unittest
from configure_presets import make_preset, make_brain_service


class BrainPresetTests(unittest.TestCase):
    def setUp(self):
        self.records = {owner: {'sandbox_id': 'sb-' + owner, 'workspace_path': '/home/hx/argon-sandboxes/sb-' + owner + '/workspace',
                                'helper_hash': '0' * 64} for owner in ['alice', 'bob']}

    def test_each_preset_injects_only_its_operator_configured_owner(self):
        preset = make_preset('alice', self.records['alice'])
        plugins = preset['config']['plugins'][1]['config']
        brain = next(item for item in plugins if item['id'] == 'brain')
        self.assertEqual(brain['config'], {'owner': 'alice'})
        self.assertTrue(brain['name'].endswith('/plugins/argon-brain/index.mjs'))

    def test_global_service_maps_sandboxes_and_private_credential_file(self):
        service = make_brain_service(self.records)
        self.assertEqual(service['id'], 'argon-brain-service')
        self.assertEqual(service['config']['owners']['alice']['sandboxId'], 'sb-alice')
        self.assertEqual(service['config']['owners']['bob']['workspacePath'], self.records['bob']['workspace_path'])
        self.assertEqual(service['config']['owners']['alice']['preset'], 'argon-alice')
        self.assertIn('tokenFile', service['config'])
        self.assertNotIn('token', service['config']['owners']['alice'])


if __name__ == '__main__':
    unittest.main()
