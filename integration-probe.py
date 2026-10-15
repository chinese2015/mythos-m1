"""Live isolation probe for operator-created containers; produces factual JSON."""
import json
import os
from pathlib import Path
import subprocess
import time

from registry import AccessDenied
from sandbox import SandboxBroker

root = Path(__file__).resolve().parent
records = json.loads((root / 'state/sandboxes.json').read_text())
broker = SandboxBroker(Path.home() / 'argon-sandboxes')
report = {'containers': [], 'checks': {}}

for owner, item in records.items():
    other = records['bob' if owner == 'alice' else 'alice']
    inspection = json.loads(subprocess.check_output(['docker', 'inspect', item['container_name']]))[0]
    host = inspection['HostConfig']
    assert host['NetworkMode'] == 'none' and host['ReadonlyRootfs'] and not host['Privileged']
    assert host['Memory'] == 2 * 1024**3 and host['NanoCpus'] == 10**9 and host['PidsLimit'] == 256
    binds = [mount for mount in inspection['Mounts'] if mount['Type'] == 'bind']
    assert len(binds) == 2
    assert not any(m['Destination'] in ['/var/run/docker.sock', '/home/hx', '/root'] for m in inspection['Mounts'])
    for forbidden in ['/home/hx/.dsh/.credentials.yaml', '/home/hx/gitea/secrets/argon-agent.json',
                      '/var/run/docker.sock', other['workspace_path']]:
        broker.execute(owner, item['sandbox_id'], ['test', '!', '-e', forbidden])
    assert broker.execute(owner, item['sandbox_id'], ['ls', '/sys/class/net']).strip() == 'lo'
    report['containers'].append({'owner': owner, 'sandboxId': item['sandbox_id'], 'network': 'none',
                                 'memoryBytes': host['Memory'], 'cpu': 1, 'pidsLimit': host['PidsLimit'],
                                 'privateVolumes': [m.get('Name') for m in inspection['Mounts'] if m['Type'] == 'volume']})
volumes = [set(c['privateVolumes']) for c in report['containers']]
assert not volumes[0].intersection(volumes[1]), 'Container private volumes were shared'
try:
    broker.stop('bob', records['alice']['sandbox_id'])
    raise AssertionError('Cross-owner stop was allowed')
except AccessDenied:
    report['checks']['crossOwnerStopDenied'] = True

probe = broker.create('bob', 'cancellation-probe')
command = ['sh', '-c', 'i=0; while [ "$i" -lt 30 ]; do echo tick; i=$((i+1)); sleep 0.1; done']
def start(item):
    return subprocess.Popen(['docker', 'exec', '--user', '1001:1000', item['container_name'], *command],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
unrelated = start(records['bob'])
cancelled = start(probe)
time.sleep(.5)
broker.stop('bob', probe['sandbox_id'])
stdout, stderr = unrelated.communicate(timeout=10)
cancelled.communicate(timeout=10)
assert unrelated.returncode == 0 and stdout.count('tick') == 30, stderr
report['checks']['stoppingOneSandboxPreservesAnotherRunningJob'] = True
report['checks']['multipleSandboxesForOneOwner'] = True
report['checks']['hostCredentialsDockerSocketAndOtherWorkspaceAbsent'] = True
(root / 'state/integration-probe.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
