"""A restartable observer/dispatcher; the container owns command lifetime."""
import base64
import fcntl
import time

from .evidence import passing_junit, summarize_junit


class Worker:
    def __init__(self, store, executor, concurrency=4):
        self.store = store
        self.executor = executor
        self.concurrency = concurrency

    def tick(self):
        for op in self.store.active_operations():
            self._observe(op)
        for op in self.store.pending_cleanup():
            try:
                result = self.executor.cleanup(op)
            except Exception as error:
                result = {'status': 'failed', 'error': str(error)[:500]}
            self.store.record_cleanup(op['operationId'], result)
        if len(self.store.active_operations()) < self.concurrency:
            operation = self.store.claim_next()
            if operation:
                self._start(operation)

    def _start(self, op):
        try:
            runtime = self.executor.prepare(op)
        except Exception as error:
            if getattr(error, 'runtime', None):
                self.store.record_runtime(op['operationId'], error.runtime, started=False)
            self.store.finish(op['operationId'], 'FAILED', reason='Preparation failed: ' + str(error)[:700])
            return
        self.store.record_runtime(op['operationId'], runtime, started=False)
        op['runtime'] = runtime
        try:
            self.executor.start(op)
            self.store.record_runtime(op['operationId'], runtime)
        except Exception as error:
            # The launch may have succeeded. Never replay or cancel by inference.
            self.store.finish(op['operationId'], 'UNKNOWN', reason='Launch acknowledgement lost: ' + str(error)[:700])

    def _observe(self, op):
        if not op['runtime']:
            recover = getattr(self.executor, 'recover_runtime', None)
            try:
                runtime = recover(op) if recover else None
            except Exception:
                runtime = None
            if runtime:
                self.store.record_runtime(op['operationId'], runtime, started=False)
                op['runtime'] = runtime
            else:
                self.store.finish(op['operationId'], 'UNKNOWN', reason='Worker stopped during launch preparation; not replayed')
                return
        try:
            if op['state'] == 'CANCEL_REQUESTED':
                self.executor.cancel(op)
            snapshot = self.executor.poll(op)
            if snapshot['state'] in {'MISSING', 'LOST'}:
                raise RuntimeError('Executor supervisor is ' + snapshot['state'])
            for stream in ['stdout', 'stderr']:
                data = base64.b64decode(snapshot.get(stream, ''))
                self.store.append_log(op['operationId'], stream, op['logOffsets'][stream], data)
            result = snapshot.get('result')
            if result is not None and not snapshot.get('remaining'):
                self._complete(op, result)
        except Exception as error:
            self.store.finish(op['operationId'], 'UNKNOWN', reason='Executor observation lost: ' + str(error)[:700])

    def _complete(self, op, result):
        code = result['exitCode']
        junit = summarize_junit(result.get('reports', []))
        reason = result.get('reason')
        if code is None or result.get('containmentConfirmed') is False:
            state = 'UNKNOWN'
            reason = result.get('error') or reason or 'Descendant termination could not be confirmed'
        elif code == 0:
            state = 'SUCCEEDED'
            if op['kind'] in {'UNIT_TEST', 'VERIFY'} and not passing_junit(junit):
                state, reason = 'FAILED', 'Exit 0 but passing JUnit evidence is missing or invalid'
        elif reason == 'cancelled':
            state = 'CANCELLED'
        else:
            state = 'FAILED'
        evidence = {'sourceCommit': result.get('sourceCommit'), 'sourceDirty': result.get('sourceDirty'),
                    'expectedSourceCommit': op['sourceCommit'], 'command': op['command'], 'exitCode': code,
                    'kind': op['kind'], 'sandboxId': op['runtime']['sandboxId'],
                    'junit': junit, 'truncated': result.get('truncated', {})}
        self.store.finish(op['operationId'], state, exit_code=code, evidence=evidence, reason=reason)

    def run(self, stop=None, interval=.25):
        with (self.store.root / 'worker.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('A worker already owns this data directory')
            while stop is None or not stop.is_set():
                self.tick()
                if stop is None:
                    time.sleep(interval)
                else:
                    stop.wait(interval)
