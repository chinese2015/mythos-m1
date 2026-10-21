"""Transfer only a model-created Commit into a new verification container."""
import json
from pathlib import Path
import subprocess

from sandbox import SandboxBroker

root = Path(__file__).resolve().parent
records = json.loads((root / 'state/sandboxes.json').read_text())
broker = SandboxBroker(Path.home() / 'mythos-sandboxes')
candidate = records['alice']
def git(item, *args):
    return broker.execute(item['owner_id'], item['sandbox_id'], ['git', '-c', 'safe.directory=' + item['workspace_path'], *args])
commit = git(candidate, 'rev-parse', 'HEAD')
assert commit != '7fd32b0535fac3f6ce105a8494e2dcbba7ce355b'
assert git(candidate, 'diff', '7fd32b0535fac3f6ce105a8494e2dcbba7ce355b', commit, '--name-only') == 'src/main/java/com/example/catalog/CatalogSearchService.java'
archive = candidate['workspace_path'] + '/.cache/candidate.bundle'
git(candidate, 'bundle', 'create', archive, 'HEAD')
bundle = root / 'state/candidate.bundle'
payload = subprocess.check_output(['docker', 'exec', '--user', '1001:1000', candidate['container_name'], 'cat', archive])
bundle.write_bytes(payload)
existing = [item for item in broker.registry.list_owned('alice') if item['workspace_id'] == 'nova-independent-verification' and item['state'] == 'running']
if len(existing) > 1:
    raise RuntimeError('Ambiguous verifier ownership')
verifier = existing[0] if existing else broker.create('alice', 'nova-independent-verification', 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git')
verifier['helper_hash'] = broker.execute('alice', verifier['sandbox_id'], ['sha256sum', '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js']).split()[0]
subprocess.run(['docker', 'exec', '-i', '--user', '1001:1000', '-w', verifier['workspace_path'],
                verifier['container_name'], 'sh', '-c', 'cat > .cache/candidate.bundle'], input=payload, check=True)
git(verifier, 'fetch', './.cache/candidate.bundle', 'HEAD')
git(verifier, 'checkout', '--detach', 'FETCH_HEAD')
assert git(verifier, 'rev-parse', 'HEAD') == commit
broker.execute('alice', verifier['sandbox_id'], ['test', '!', '-e', 'target'])
verifier['sourceCommit'] = commit
settings = '<settings><mirrors><mirror><id>aliyun</id><mirrorOf>*</mirrorOf><url>https://maven.aliyun.com/repository/public</url></mirror></mirrors></settings>\n'
subprocess.run(['docker', 'exec', '-i', '--user', '1001:1000', '-w', verifier['workspace_path'],
                verifier['container_name'], 'sh', '-c', 'cat > .cache/settings.xml'], input=settings.encode(), check=True)
(root / 'state/verifier.json').write_text(json.dumps(verifier, indent=2))
print(json.dumps({'verifier': verifier['sandbox_id'], 'sourceCommit': commit, 'freshTargetAbsent': True}))
