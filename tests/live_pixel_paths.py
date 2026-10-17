"""Operator-host supplemental path acceptance; does not change demo tests or repository files."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

from brain.store import Store
from sandbox import SandboxBroker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['baseline', 'candidate'])
    parser.add_argument('--work-id', default='work-466690061b6c4ed492e2f41ab94f8dda')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    work = Store(Path.home() / '.argon-brain').snapshot('alice', args.work_id)['workItem']
    assert work['source']['id'] == 'FND-00015'
    sandbox_id = work['sandboxId']
    broker = SandboxBroker(Path.home() / 'argon-sandboxes', 4, 5)
    record = broker.registry.get('alice', sandbox_id)
    execute = lambda argv: broker.execute_capture('alice', sandbox_id, argv, timeout=60)
    head = execute(['git', 'rev-parse', 'HEAD'])['stdout'].strip()
    expected = work['sourceRecord']['baseCommit'] if args.stage == 'baseline' else work['workflow']['candidateCommit']
    assert head == expected
    assert execute(['git', 'status', '--porcelain'])['stdout'] == ''
    source = root / 'tests/fixtures/PixelPathProbe.java'
    subprocess.run(['docker', 'exec', '-i', '--user', '1001:1000', record['container_name'],
                    'sh', '-c', 'cat > /tmp/PixelPathProbe.java'], input=source.read_bytes(), check=True, capture_output=True)
    classes = '/tmp/argon-pixel-path-' + uuid.uuid4().hex
    compile_result = execute(['javac', '-d', classes, work['sourceRecord']['sourcePath'], '/tmp/PixelPathProbe.java'])
    assert compile_result['exitCode'] == 0, compile_result
    result = execute(['java', '-cp', classes, 'PixelPathProbe'])
    assert execute(['git', 'status', '--porcelain'])['stdout'] == ''
    evidence = {'stage': args.stage, 'workItemId': args.work_id, 'sandboxId': sandbox_id, 'sourceCommit': head,
                'probeSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'repositoryUnchanged': True, **result}
    path = root / ('state/m3-pixel-paths-' + args.stage + '.json')
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2)); path.chmod(0o600)
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    assert result['exitCode'] == (1 if args.stage == 'baseline' else 0)
    assert ('RESULT passed=4 failed=4' if args.stage == 'baseline' else 'RESULT passed=8 failed=0') in result['stdout']


if __name__ == '__main__':
    main()
