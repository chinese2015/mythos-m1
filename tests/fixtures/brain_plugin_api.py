"""Real API/store fixture. Docker is excluded; terminal facts are controlled by stdin."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import time

from brain.api import make_server
from brain.executor import DockerExecutor
from brain.store import Store
from sandbox import SandboxBroker

with tempfile.TemporaryDirectory(prefix='mythos-plugin-') as temporary:
    root = Path(temporary)
    store = Store(root / 'brain')
    broker = SandboxBroker(root / 'sandboxes')
    records = {}
    for owner in ['alice', 'bob']:
        item = broker.registry.allocate(owner, 'plugin-test')
        records[owner] = broker.registry.transition(owner, item['sandbox_id'], 'running')
    tokens = {'alice': 'alice-private-fixture-token', 'bob': 'bob-private-fixture-token'}
    token_file = root / 'tokens.json'
    token_file.write_text(json.dumps({'owners': tokens})); token_file.chmod(0o600)
    server = make_server(store, DockerExecutor(broker), tokens, ('127.0.0.1', 0))
    respond = server.RequestHandlerClass.respond
    faults = {'session': None, 'remaining': 0}
    def delayed_respond(self, status, body):
        if status == 202 and body.get('command') == 'echo delayed-ack':
            time.sleep(.4)
        if status == 200 and body.get('workItem', {}).get('sessionId') == faults['session'] and faults['remaining']:
            body = dict(body, cursor='bad'); faults['remaining'] -= 1
        return respond(self, status, body)
    server.RequestHandlerClass.respond = delayed_respond
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    print(json.dumps({'baseUrl': 'http://127.0.0.1:' + str(server.server_port),
                      'tokenFile': str(token_file), 'records': records}), flush=True)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            if request['action'] == 'finish':
                op = store.claim_next()
                if not op or op['operationId'] != request['operationId']:
                    raise RuntimeError('Unexpected fixture dispatch order')
                store.record_runtime(op['operationId'], {'sandboxId': op['sandboxId']})
                store.append_log(op['operationId'], 'stdout', 0, b'actual fixture output\n')
                store.finish(op['operationId'], 'SUCCEEDED', exit_code=0)
            elif request['action'] == 'bad-cursor':
                faults.update(session=request['sessionId'], remaining=1)
            print(json.dumps({'id': request['id'], 'ok': True}), flush=True)
    finally:
        server.shutdown(); server.server_close()
