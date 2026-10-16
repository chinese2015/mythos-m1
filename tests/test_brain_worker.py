import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from brain import container_runner
from brain.store import Store
from brain.worker import Worker
from brain.errors import PreparationFailure


class ProcessExecutor:
    """Real detached processes, replacing only the unavailable Docker boundary."""
    def __init__(self, root, workspace):
        self.root = root
        self.workspace = workspace
        self.processes = []
        self.lost = False

    def prepare(self, operation):
        return {'sandboxId': operation['sandboxId'], 'workspace': str(self.workspace)}

    def start(self, operation):
        spec = {'root': str(self.root), 'operationId': operation['operationId'],
                'workspace': str(self.workspace), 'command': operation['command'],
                'timeoutSeconds': operation['timeoutSeconds'], 'uid': os.getuid(), 'gid': os.getgid(),
                'sourceCommit': operation['sourceCommit']}
        payload = base64.b64encode(json.dumps(spec).encode()).decode()
        self.processes.append(subprocess.Popen([sys.executable, '-m', 'brain.container_runner', 'run', payload]))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if (self.root / operation['operationId'] / 'meta.json').exists():
                return
            time.sleep(.01)
        raise RuntimeError('No supervisor')

    def poll(self, operation):
        if self.lost:
            raise RuntimeError('container transport disappeared')
        return container_runner.snapshot(self.root, operation['operationId'], operation['logOffsets'])

    def cancel(self, operation):
        return container_runner.request_cancel(self.root, operation['operationId'])

    def cleanup(self, operation):
        return {'status': 'done'}

    def close(self):
        for path in self.root.glob('exec-*'):
            container_runner.request_cancel(self.root, path.name)
        for process in self.processes:
            process.wait(timeout=3)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root / 'store')
        self.work = self.store.create_work_item('alice', {'source': {'type': 'DIRECT', 'id': 'test', 'revision': 1}, 'sandboxId': 'sb-a'}, 'work')
        self.workspace = self.root / 'workspace'; self.workspace.mkdir()
        self.executor = ProcessExecutor(self.root / 'runs', self.workspace)
        self.addCleanup(self.executor.close)
        self.worker = Worker(self.store, self.executor)

    def submit(self, command, kind='COMMAND'):
        version = self.store.snapshot('alice', self.work['workItemId'])['workItem']['version']
        return self.store.submit('alice', self.work['workItemId'], {'command': command, 'kind': kind, 'expectedVersion': version}, command)

    def complete(self, operation, worker=None):
        worker = worker or self.worker
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            worker.tick()
            result = self.store.operation('alice', operation['operationId'])
            if result['state'] in {'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'}:
                return result
            time.sleep(.02)
        self.fail('Operation did not finish')

    def test_worker_replacement_observes_same_process_without_reexecution(self):
        op = self.submit('echo once >> counter; echo started; sleep .3; echo done')
        self.worker.tick()
        replacement = Worker(Store(self.root / 'store'), self.executor)
        result = self.complete(op, replacement)
        self.assertEqual(result['state'], 'SUCCEEDED')
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual((self.workspace / 'counter').read_text(), 'once\n')
        logs = self.store.logs('alice', op['operationId'], 0, 100)['logs']
        self.assertEqual(''.join(x['text'] for x in logs if x['stream'] == 'stdout'), 'started\ndone\n')
        self.assertTrue(result['evidence']['stdoutSha256'])

    def test_worker_marks_transport_loss_unknown_and_never_replays_it(self):
        op = self.submit('echo once >> counter; sleep .5')
        self.worker.tick(); self.executor.lost = True
        self.worker.tick()
        self.assertEqual(self.store.operation('alice', op['operationId'])['state'], 'UNKNOWN')
        self.executor.lost = False
        for _ in range(3):
            self.worker.tick()
        self.assertEqual(len(self.executor.processes), 1)

    def test_interrupted_preparation_is_unknown_without_restarting_a_command(self):
        op = self.submit('echo should-not-run')
        self.store.claim_next()
        self.worker.tick()
        self.assertEqual(self.store.operation('alice', op['operationId'])['state'], 'UNKNOWN')
        self.assertEqual(self.executor.processes, [])

    def test_active_cancel_is_confirmed_by_supervisor(self):
        op = self.submit('sleep 10')
        self.worker.tick()
        current = self.store.operation('alice', op['operationId'])
        result = self.store.cancel('alice', op['operationId'], current['version'], 'cancel')
        self.assertEqual(result['state'], 'CANCEL_REQUESTED')
        result = self.complete(op)
        self.assertEqual(result['state'], 'CANCELLED')
        self.assertNotEqual(result['exitCode'], 0)

    def test_nonzero_exit_is_failed_with_actual_code(self):
        result = self.complete(self.submit('echo failure >&2; exit 13'))
        self.assertEqual((result['state'], result['exitCode']), ('FAILED', 13))

    def test_zero_exit_without_reports_does_not_pass_a_test_operation(self):
        result = self.complete(self.submit('true', 'UNIT_TEST'))
        self.assertEqual(result['state'], 'FAILED')
        self.assertEqual(result['exitCode'], 0)
        self.assertIn('JUnit', result['reason'])

    def test_missing_launch_acknowledgement_is_unknown_not_retried(self):
        original = self.executor.start
        def start(operation):
            original(operation)
            raise RuntimeError('Lost acknowledgement')
        self.executor.start = start
        result = self.complete(self.submit('echo once >> counter; sleep .1'))
        self.assertEqual(result['state'], 'UNKNOWN')
        self.worker.tick()
        self.assertEqual(len(self.executor.processes), 1)

    def test_preparation_failure_records_owned_environment_and_cleanup(self):
        def fail(operation):
            raise PreparationFailure('Cannot write settings', {'sandboxId': 'sb-owned-verifier', 'preparedOnly': True})
        self.executor.prepare = fail
        op = self.submit('true')
        result = self.complete(op)
        self.assertEqual(result['state'], 'FAILED')
        self.assertEqual(result['runtime']['sandboxId'], 'sb-owned-verifier')
        self.worker.tick()
        self.assertEqual(self.store.operation('alice', op['operationId'])['runtime']['cleanup']['status'], 'done')


if __name__ == '__main__':
    unittest.main()
