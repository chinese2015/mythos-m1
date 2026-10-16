import unittest

from brain.evidence import summarize_junit


class EvidenceTests(unittest.TestCase):
    def test_junit_summary_names_failed_tests(self):
        xml = '<testsuite tests="2" failures="1" errors="0"><testcase classname="demo.NovaTest" name="maliciousInputReturnsNothing"><failure/></testcase><testcase classname="demo.NovaTest" name="safeInputWorks"/></testsuite>'
        summary = summarize_junit([{'path': 'TEST-demo.NovaTest.xml', 'xml': xml}])
        self.assertEqual(summary['failedTests'], ['demo.NovaTest.maliciousInputReturnsNothing'])
        self.assertEqual((summary['tests'], summary['failures'], summary['errors']), (2, 1, 0))


if __name__ == '__main__':
    unittest.main()
