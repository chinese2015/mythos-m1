"""Explicit Docker acceptance probe; never included in the offline unit suite.

Run on the existing operator host from the m1 checkout. Starts temporary API
and worker processes, preserves their durable evidence under state/, and
cleans up only containers/workspace artifacts created by this invocation.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

from sandbox import SandboxBroker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-sandbox', default='sb-f4a61d0b6a3648c1')
    parser.add_argument('--port', type=int, default=13081)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    run_id = uuid.uuid4().hex[:12]
    data = root / 'state' / ('m2-smoke-' + run_id)
    data.mkdir(parents=True, mode=0o700)
    broker = SandboxBroker(Path.home() / 'mythos-sandboxes')
    source = broker.registry.get('alice', args.source_sandbox)
    commit = broker.execute_capture('alice', args.source_sandbox, ['git', 'rev-parse', 'HEAD'])['stdout'].strip()
    base = [sys.executable, '-m', 'brain', '--data-dir', str(data)]
    subprocess.run(base + ['init-config'], cwd=root, check=True, capture_output=True)
    tokens = json.loads((data / 'tokens.json').read_text())['owners']
    processes = {}
    report = {'dataDirectory': str(data), 'candidateCommit': commit, 'checks': {}}
    lost_sandbox = None
    log = (data / 'services.log').open('ab')

    def start(name):
        tail = ['api', '--port', str(args.port)] if name == 'api' else ['worker']
        processes[name] = subprocess.Popen(base + tail, cwd=root, stdin=subprocess.DEVNULL,
                                           stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

    def stop(name, kill=False):
        process = processes.get(name)
        if process and process.poll() is None:
            process.kill() if kill else process.terminate()
            process.wait(timeout=5)

    def request(method, path, body=None, owner='alice', key=None):
        headers = {'Authorization': 'Bearer ' + tokens[owner], 'Content-Type': 'application/json'}
        if key:
            headers['Idempotency-Key'] = key
        req = urllib.request.Request('http://127.0.0.1:' + str(args.port) + path,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     method=method, headers=headers)
        try:
            response = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def wait(predicate, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.1)
        raise RuntimeError('Acceptance condition timed out; inspect ' + str(data))

    def ready():
        try:
            return request('GET', '/health')[0] == 200
        except OSError:
            return False

    def create(owner, sandbox, source_id):
        status, work = request('POST', '/api/brain/work-items',
                               {'source': {'type': 'DIRECT', 'id': source_id, 'revision': 1}, 'sandboxId': sandbox},
                               owner=owner, key='create-' + source_id)
        assert status == 201, work
        return work['workItemId']

    def submit(work_id, command, kind='COMMAND', owner='alice', source_commit=None):
        work = request('GET', '/api/brain/work-items/' + work_id, owner=owner)[1]['workItem']
        if work.get('blocked'):
            status, work = request('POST', '/api/brain/work-items/' + work_id + '/resume',
                                   {'expectedVersion': work['version']}, owner=owner, key='resume-' + uuid.uuid4().hex)
            assert status == 200, work
        body = {'expectedVersion': work['version'], 'command': command, 'kind': kind, 'timeoutSeconds': 60}
        if source_commit:
            body['sourceCommit'] = source_commit
        status, op = request('POST', '/api/brain/work-items/' + work_id + '/operations', body,
                             owner=owner, key=uuid.uuid4().hex)
        assert status == 202, op
        return op['operationId']

    def operation(op_id, owner='alice'):
        return request('GET', '/api/brain/operations/' + op_id, owner=owner)[1]

    def terminal(op_id, owner='alice', cleanup=False):
        def done():
            result = operation(op_id, owner)
            if result['state'] not in {'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'}:
                return None
            if cleanup and not (result.get('runtime') or {}).get('cleanup'):
                return None
            return result
        return wait(done)

    def has_output(op_id, owner='alice'):
        return request('GET', '/api/brain/operations/' + op_id + '/logs', owner=owner)[1]['logs']

    try:
        start('api'); start('worker'); wait(ready, timeout=10)
        work_id = create('alice', args.source_sandbox, 'm2-smoke-' + run_id)
        counter = '.cache/m2-restart-counter-' + run_id
        op_id = submit(work_id, 'echo once >> ' + counter + '; echo restart-start; sleep 5; echo restart-finish')
        wait(lambda: has_output(op_id))
        cursor = request('GET', '/api/brain/work-items/' + work_id)[1]['cursor']
        stop('api'); stop('worker', kill=True)
        start('worker'); start('api'); wait(ready, timeout=10)
        result = terminal(op_id)
        assert result['state'] == 'SUCCEEDED', result
        count = broker.execute_capture('alice', args.source_sandbox, ['cat', counter])
        assert count['stdout'] == 'once\n', count
        events = request('GET', '/api/brain/work-items/' + work_id + '/events?after=' + str(cursor))[1]['events']
        assert events and all(e['sequence'] > cursor for e in events)
        report['checks']['apiAndWorkerRestartNoReplay'] = {'operationId': op_id, 'state': result['state'], 'executionCount': 1}
        broker.execute_capture('alice', args.source_sandbox, ['rm', counter])

        assert request('GET', '/api/brain/operations/' + op_id, owner='bob')[0] == 404
        assert request('GET', '/api/brain/operations/' + op_id + '/logs', owner='bob')[0] == 404
        report['checks']['crossOwnerDenied'] = True

        op_id = submit(work_id, 'echo cancel-start; sleep 20')
        wait(lambda: has_output(op_id))
        current = operation(op_id)
        status, cancelled = request('POST', '/api/brain/operations/' + op_id + '/cancel',
                                    {'expectedVersion': current['version']}, key='cancel-' + op_id)
        assert status == 200 and cancelled['state'] == 'CANCEL_REQUESTED', cancelled
        result = terminal(op_id)
        assert result['state'] == 'CANCELLED' and result['exitCode'] != 0, result
        report['checks']['confirmedCancel'] = {'operationId': op_id, 'exitCode': result['exitCode']}

        op_id = submit(work_id, 'echo deliberate-failure >&2; exit 23')
        result = terminal(op_id)
        assert (result['state'], result['exitCode']) == ('FAILED', 23), result
        report['checks']['nonzeroExitPreserved'] = 23

        op_id = submit(work_id, 'mvn -B -o -s .cache/settings.xml test', 'VERIFY', source_commit=commit)
        result = terminal(op_id, cleanup=True)
        assert result['state'] == 'SUCCEEDED', result
        assert result['runtime']['freshTargetAbsent'] and result['runtime']['sandboxId'] != args.source_sandbox
        assert result['evidence']['sourceCommit'] == commit and result['evidence']['junit']['tests'] == 2
        report['checks']['freshVerifier'] = {'operationId': op_id, 'state': result['state'], 'tests': result['evidence']['junit']['tests'],
                                            'sandboxId': result['runtime']['sandboxId'], 'cleanup': result['runtime']['cleanup']}

        op_id = submit(work_id, 'mvn -B -o -s .cache/settings.xml clean verify', 'VERIFY', source_commit=commit)
        result = terminal(op_id, cleanup=True)
        assert result['state'] in {'SUCCEEDED', 'FAILED'}, result
        if result['state'] == 'FAILED':
            assert result['exitCode'] != 0, result
        report['checks']['cleanVerifyActualOutcome'] = {'operationId': op_id, 'state': result['state'], 'exitCode': result['exitCode']}

        lost_sandbox = broker.create('bob', 'm2-lost-' + run_id)
        lost_work = create('bob', lost_sandbox['sandbox_id'], 'm2-lost-' + run_id)
        op_id = submit(lost_work, 'echo loss-start; sleep 30', owner='bob')
        wait(lambda: has_output(op_id, 'bob'))
        broker.stop('bob', lost_sandbox['sandbox_id'])
        result = terminal(op_id, owner='bob')
        assert result['state'] == 'UNKNOWN' and result['exitCode'] is None, result
        report['checks']['lostContainerUnknown'] = {'operationId': op_id, 'state': result['state']}
        print(json.dumps(report, indent=2), flush=True)
    finally:
        stop('api'); stop('worker')
        if lost_sandbox:
            item = broker.registry.get('bob', lost_sandbox['sandbox_id'])
            if item['state'] == 'running':
                broker.stop('bob', item['sandbox_id'])
            subprocess.run(['docker', 'rm', '-v', item['container_name']], capture_output=True)
        log.close()
        (data / 'acceptance.json').write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
