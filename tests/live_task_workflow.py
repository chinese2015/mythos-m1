"""Operator-host acceptance driver for the real authenticated console HTTP API.

No credentials are printed or saved. Approval is an explicit separate command
after inspecting the actual model plan. Run from ~/mythos-m1 on the DSH host.
"""
import argparse
import http.cookiejar
import json
from pathlib import Path
import re
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['tasks', 'start', 'snapshot', 'approve', 'message'])
    parser.add_argument('--work-id')
    parser.add_argument('--text')
    args = parser.parse_args()
    origin = 'http://127.0.0.1:3080'
    log = (Path.home() / 'dsh-run/dsh.log').read_text()
    auth_url = re.search(r'http://127.0.0.1:3080/\?token=[A-Za-z0-9_-]+', log).group()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    opener.open(auth_url).close()
    def call(path, body=None, key=None):
        request = urllib.request.Request(origin + '/mythos/api' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json', 'X-Mythos-Action': '1', 'Origin': origin,
                     'Idempotency-Key': key or str(uuid.uuid4())})
        with opener.open(request, timeout=60) as response:
            return json.load(response)
    if args.action == 'tasks':
        result = call('/tasks')
    elif args.action == 'start':
        task = next(t for t in call('/tasks')['tasks'] if t['id'] == 'FND-00009')
        first = call('/tasks/FND-00009/start', {'expectedRevision': task['revision']}, 'acceptance-start-nova')
        second = call('/tasks/FND-00009/start', {'expectedRevision': task['revision']}, 'acceptance-start-nova-again')
        assert first['workItemId'] == second['workItemId']
        result = {'workItemId': first['workItemId'], 'duplicateStartSameWork': True}
    else:
        snapshot = call('/work-items/' + args.work_id)
        if args.action == 'message':
            result = call('/work-items/' + args.work_id + '/message', {'text': args.text})
        elif args.action == 'approve':
            body = {'expectedVersion': snapshot['workItem']['version'], 'planHash': snapshot['workflow']['planHash']}
            key = 'acceptance-approve-' + snapshot['workflow']['planHash']
            first = call('/work-items/' + args.work_id + '/approve-plan', body, key)
            replay = call('/work-items/' + args.work_id + '/approve-plan', body, key)
            assert first['workflow']['approval'] == replay['workflow']['approval']
            result = {'workItemId': first['workItemId'], 'phase': first['workflow']['phase'], 'duplicateApprovalSameDecision': True}
        else:
            artifact = Path('artifacts/task-acceptance.json'); artifact.parent.mkdir(exist_ok=True)
            artifact.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
            artifact.chmod(0o600)
            result = {'workItemId': snapshot['workItem']['workItemId'], 'version': snapshot['workItem']['version'],
                      'workflow': snapshot['workflow'], 'sessions': snapshot['sessions'], 'git': snapshot.get('git'),
                      'operations': [{'operationId': o['operationId'], 'state': o['state'], 'exitCode': o['exitCode'],
                                      'reason': o['reason'], 'junit': {k:v for k,v in ((o.get('evidence') or {}).get('junit') or {}).items() if k != 'reports'}} for o in snapshot['operations']]}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
