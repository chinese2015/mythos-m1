import concurrent.futures
from pathlib import Path
import tempfile
import unittest

from ssh_config import register_include


class SshConfigTests(unittest.TestCase):
    def test_concurrent_registration_preserves_all_hosts_and_existing_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'config'
            original = 'Host existing\n  HostName example.test\n'
            config.write_text(original)
            paths = [Path(temporary) / ('sandbox-' + str(i)) / 'ssh_config' for i in range(16)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda path: register_include(config, path), paths))
            text = config.read_text()
            self.assertIn(original, text)
            for path in paths:
                self.assertEqual(text.count('Include ' + str(path) + '\n'), 1)
            register_include(config, paths[0])
            self.assertEqual(config.read_text(), text)


if __name__ == '__main__':
    unittest.main()
