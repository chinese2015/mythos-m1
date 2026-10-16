import base64
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from brain.container_runner import snapshot, request_cancel
from brain.evidence import summarize_junit, passing_junit


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'runs'
        self.workspace = Path(self.temp.name) / 'workspace'
        self.workspace.mkdir()

    def start(self, command, timeout=5, operation_id=None):
        op_id = operation_id or 'exec-' + uuid.uuid4().hex
        spec = {'root': str(self.root), 'operationId': op_id, 'workspace': str(self.workspace),
                'command': command, 'timeoutSeconds': timeout, 'uid': os.getuid(), 'gid': os.getgid(),
                'sourceCommit': None}
        payload = base64.b64encode(json.dumps(spec).encode()).decode()
        process = subprocess.Popen([sys.executable, '-m', 'brain.container_runner', 'run', payload],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def cleanup():
            if process.poll() is None:
                request_cancel(self.root, op_id)
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.communicate()
        self.addCleanup(cleanup)
        return op_id, process

    def wait_for(self, op_id, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = snapshot(self.root, op_id, {'stdout': 0, 'stderr': 0})
            if predicate(result):
                return result
            time.sleep(.02)
        self.fail('Supervisor did not reach expected state: ' + repr(result))

    def test_real_exit_and_both_streams_are_preserved(self):
        op, process = self.start("printf '你好'; printf 'warning' >&2; exit 7")
        result = self.wait_for(op, lambda r: r.get('result') is not None)
        self.assertEqual(result['result']['exitCode'], 7)
        self.assertEqual(base64.b64decode(result['stdout']), '你好'.encode())
        self.assertEqual(base64.b64decode(result['stderr']), b'warning')
        process.communicate(timeout=2)

    def test_output_is_observable_before_command_completes(self):
        op, _ = self.start('echo started; sleep 1; echo finished')
        result = self.wait_for(op, lambda r: bool(r.get('stdout')))
        self.assertIsNone(result.get('result'))
        self.assertIn(b'started', base64.b64decode(result['stdout']))

    def test_duplicate_launch_does_not_execute_command_twice(self):
        command = 'echo once >> counter; sleep .2'
        op, first = self.start(command)
        self.wait_for(op, lambda r: r.get('state') == 'RUNNING')
        _, duplicate = self.start(command, operation_id=op)
        duplicate.communicate(timeout=2)
        self.wait_for(op, lambda r: r.get('result') is not None)
        first.communicate(timeout=2)
        self.assertEqual((self.workspace / 'counter').read_text(), 'once\n')

    def test_cancel_confirms_termination_of_command_group(self):
        op, process = self.start('sleep 10 & wait')
        self.wait_for(op, lambda r: r.get('state') == 'RUNNING')
        request_cancel(self.root, op)
        result = self.wait_for(op, lambda r: r.get('result') is not None)
        self.assertEqual(result['result']['reason'], 'cancelled')
        self.assertNotEqual(result['result']['exitCode'], 0)
        process.communicate(timeout=2)

    def test_timeout_has_a_real_nonzero_result(self):
        op, _ = self.start('sleep 10', timeout=.2)
        result = self.wait_for(op, lambda r: r.get('result') is not None)
        self.assertEqual(result['result']['reason'], 'timeout')
        self.assertNotEqual(result['result']['exitCode'], 0)

    def test_late_cancel_cannot_change_successful_result(self):
        op, _ = self.start('true')
        result = self.wait_for(op, lambda r: r.get('result') is not None)
        request_cancel(self.root, op)
        final = snapshot(self.root, op, {'stdout': 0, 'stderr': 0})
        self.assertEqual(final['result'], result['result'])
        self.assertEqual(final['result']['exitCode'], 0)

    def test_junit_is_captured_at_exit_and_path_escape_is_rejected(self):
        directory = self.workspace / 'target/surefire-reports'
        directory.mkdir(parents=True)
        (directory / 'TEST-pass.xml').write_text('<testsuite name="suite" tests="2" failures="0" errors="0" skipped="0"/>')
        (directory / 'TEST-escape.xml').symlink_to('/etc/passwd')
        op, _ = self.start('true')
        result = self.wait_for(op, lambda r: r.get('result') is not None)['result']
        reports = result['reports']
        self.assertEqual(len(reports), 2)
        summary = summarize_junit(reports)
        self.assertEqual(summary['tests'], 2)
        self.assertFalse(passing_junit(summary))
        self.assertTrue(summary['invalidReports'])

    def test_missing_or_invalid_junit_is_never_passing(self):
        self.assertFalse(passing_junit(summarize_junit([])))
        self.assertFalse(passing_junit(summarize_junit([{'path': 'TEST.xml', 'xml': 'broken'}])))
        self.assertFalse(passing_junit(summarize_junit([{'path': 'TEST.xml', 'xml': '<testsuite tests="2" failures="1" errors="0" skipped="0"/>'}])))
        self.assertTrue(passing_junit(summarize_junit([{'path': 'TEST.xml', 'xml': '<testsuite tests="2" failures="0" errors="0" skipped="0"/>'}])))


if __name__ == '__main__':
    unittest.main()
