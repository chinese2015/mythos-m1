"""Contract check for the intentionally vulnerable BOLA training repository."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / 'samples/security/demo-tenant-invoice-api'
REPORT_RELATIVE = Path('target/surefire-reports/TEST-com.example.invoice.InvoiceControllerTest.xml')


@unittest.skipUnless(shutil.which('mvn'), 'Maven is required to verify the offline demo fixture')
class BolaDemoFixtureContractTests(unittest.TestCase):
    def test_baseline_fails_only_cross_tenant(self):
        self.assertTrue(PROJECT.is_dir(), 'the vulnerable project template is missing')
        with tempfile.TemporaryDirectory(prefix='mythos-bola-fixture-') as temporary:
            project = Path(temporary) / 'project'
            shutil.copytree(PROJECT, project, ignore=shutil.ignore_patterns('.cache', 'target'))
            cache = project / '.cache'
            cache.mkdir()
            (cache / 'settings.xml').write_text(
                '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n',
                encoding='utf-8',
            )
            result = subprocess.run(
                ['mvn', '-B', '-o', '-s', '.cache/settings.xml', 'test'],
                cwd=project,
                text=True,
                capture_output=True,
                timeout=180,
                check=False,
            )
            report = project / REPORT_RELATIVE
            details = (result.stdout + result.stderr)[-1600:]
            self.assertTrue(report.is_file(), 'Maven did not produce the fresh Surefire report.\n' + details)

            suite = ET.parse(report).getroot()
            self.assertEqual(suite.attrib.get('tests'), '2')
            self.assertEqual(suite.attrib.get('failures'), '1')
            self.assertEqual(suite.attrib.get('errors'), '0')
            self.assertEqual(suite.attrib.get('skipped'), '0')
            failed = [case.attrib.get('name') for case in suite.findall('testcase') if case.find('failure') is not None]
            self.assertEqual(failed, ['crossTenantInvoiceReadIsHidden'])
            self.assertEqual(result.returncode, 1, 'the vulnerable base must fail only its cross-tenant security regression')


if __name__ == '__main__':
    unittest.main()
