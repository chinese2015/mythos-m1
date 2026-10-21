import unittest

from brain.evidence import summarize_junit
from brain.store import Store
from brain.workspace import TaskWorkspace, parse_diff_names


class EvidenceTests(unittest.TestCase):
    def test_junit_summary_names_failed_tests(self):
        xml = '<testsuite tests="2" failures="1" errors="0"><testcase classname="demo.NovaTest" name="maliciousInputReturnsNothing"><failure/></testcase><testcase classname="demo.NovaTest" name="safeInputWorks"/></testsuite>'
        summary = summarize_junit([{'path': 'TEST-demo.NovaTest.xml', 'xml': xml}])
        self.assertEqual(summary['failedTests'], ['demo.NovaTest.maliciousInputReturnsNothing'])
        self.assertEqual((summary['tests'], summary['failures'], summary['errors']), (2, 1, 0))


class DiffNameTests(unittest.TestCase):
    def test_nul_separated_names_handle_rename_delete_and_unusual_filenames(self):
        raw = 'src/main/java/demo/App.java\0src/main/java/demo/Widget renamed.java\0src/main/java/demo/\u2206delta.java\0'
        self.assertEqual(parse_diff_names(raw),
                         ['src/main/java/demo/App.java',
                          'src/main/java/demo/Widget renamed.java',
                          'src/main/java/demo/\u2206delta.java'])

    def test_workspace_evidence_reads_nul_separated_change_names(self):
        import tempfile
        base = 'a' * 40
        names = ['src/main/java/demo/A.java', 'src/main/java/demo/B Test.java']
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(temporary)
            source_record = {'id': 'FND-00011', 'title': 'Names', 'risk': 'LOW', 'ownerId': 'alice',
                             'repositoryUrl': 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git',
                             'baseCommit': base, 'sourcePath': 'src/main/java/demo/A.java', 'revision': '1'}
            work = store.claim_task('alice', source_record, '1', 'claim-names')
            store.finish_prepare('alice', work['workItemId'], 'sb-names')

            class BrokerStub:
                registry = type('RegistryStub', (), {
                    'get': lambda self, owner, sandbox: {'workspace_path': '/tmp/ws'}})()
                def execute_capture(self, owner, sandbox, argv, timeout=None):
                    if argv[:3] == ['git', 'diff', '--name-only']:
                        return {'exitCode': 0, 'stdout': '\0'.join(names) + '\0', 'stderr': ''}
                    if argv[:2] == ['git', 'rev-parse']:
                        return {'exitCode': 0, 'stdout': base, 'stderr': ''}
                    if argv[:2] == ['git', 'branch']:
                        return {'exitCode': 0, 'stdout': 'mythos/names', 'stderr': ''}
                    if argv[:2] == ['git', 'status']:
                        return {'exitCode': 0, 'stdout': '', 'stderr': ''}
                    if argv[:3] == ['git', 'diff', '--no-ext-diff']:
                        return {'exitCode': 0, 'stdout': 'binary diff', 'stderr': ''}
                    raise AssertionError('Unexpected command: ' + repr(argv))

            workspace = TaskWorkspace(store, type('ExecutorStub', (), {'broker': BrokerStub()})())
            evidence = workspace.evidence('alice', work['workItemId'])
            self.assertEqual(evidence['git']['changedFiles'], names)
            self.assertEqual(evidence['git']['headCommit'], base)


if __name__ == '__main__':
    unittest.main()
