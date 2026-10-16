"""Install operator-only PoC Agent presets into the existing Web profile."""
import json
from pathlib import Path
import shutil
import time

ROOT = Path(__file__).resolve().parent


def make_preset(owner, record):
    provider = lambda name: str(Path.home() / 'dsh-run/node_modules/@deepseek-ai' / name / 'lib/index.js')
    plugins = [
        {'id': 'ssh', 'name': provider('dsh-ssh'), 'config': {
            'host': 'argon-' + record['sandbox_id'], 'node': '/usr/bin/node',
            'helper': '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
            'helperHash': record['helper_hash'], 'workspace': record['workspace_path']}},
        {'id': 'fs', 'name': provider('dsh-fs-ssh')},
        {'id': 'subprocess', 'name': provider('dsh-subprocess-ssh')},
        {'id': 'sandbox', 'name': provider('dsh-sandbox-ssh')},
        {'id': 'bash', 'name': '@deepseek-ai/dsh-bash-sandbox',
         'config': {'cwd': record['workspace_path'], 'timeoutMs': 60000}},
        {'id': 'files', 'name': '@deepseek-ai/dsh-tool-fs'},
        {'id': 'search', 'name': '@deepseek-ai/dsh-tool-fs-search',
         'config': {'sampleOverCapGlobResults': False}},
        {'id': 'commands', 'name': '@deepseek-ai/dsh-tool-bash'},
        {'id': 'jobs', 'name': '@deepseek-ai/dsh-tool-jobs'},
        {'id': 'sandboxctl', 'name': str(ROOT / 'plugins/argon-sandbox/index.mjs'),
         'config': {'owner': owner}},
        {'id': 'brain', 'name': str(ROOT / 'plugins/argon-brain/index.mjs'),
         'config': {'owner': owner}},
    ]
    return {'id': 'preset-argon-' + owner, 'name': '@deepseek-ai/dsh-agent-preset', 'config': {
        'id': 'argon-' + owner, 'name': 'Argon Sandbox ' + owner,
        'description': 'Operator PoC: native tools in an owner-bound Docker sandbox',
        'plugins': [
            {'id': 'persona', 'name': '@deepseek-ai/dsh-persona', 'config': {
                'prefix': 'You are a coding agent. Use the provided native file and Bash tools to do real work.',
                'suffix': 'Your Docker sandbox working directory is {{cwd}}. Do not change tests, read reference fixes, or access credentials. Use execution_run for monitored build/test commands; it returns an operationId, not a completed result. Use execution_status and execution_follow for facts. Stop Agent does not cancel an accepted execution; execution_cancel does. Native file tools remain available.'}},
            {'id': 'execution', 'name': 'cordis:group', 'group': True,
             'isolate': {key: True for key in ['fs', 'subprocess', 'ssh', 'sandbox', 'shell']},
             'config': plugins},
        ]}}


def make_brain_service(records):
    return {'id': 'argon-brain-service', 'name': str(ROOT / 'plugins/argon-brain/service.mjs'),
            'config': {'baseUrl': 'http://127.0.0.1:3081',
                       'tokenFile': str(Path.home() / '.argon-brain/tokens.json'),
                       'pollIntervalMs': 1000,
                       'owners': {owner: {'sandboxId': record['sandbox_id'],
                                          'workspacePath': record['workspace_path'],
                                          'preset': 'argon-' + owner} for owner, record in records.items()}}}


def main():
    import yaml
    records = json.loads((ROOT / 'state/sandboxes.json').read_text())
    sandbox_root = Path.home() / 'argon-sandboxes'
    if any(not Path(item['workspace_path']).is_relative_to(sandbox_root) for item in records.values()):
        raise ValueError('Web presets require the protected Sandbox root')
    profile = Path.home() / '.dsh/profiles/web/cordis.patch.yml'
    backup = ROOT / 'state' / ('profile-before-presets-' + str(int(time.time())) + '.yml')
    shutil.copy2(profile, backup)
    backup.chmod(0o600)
    entries = yaml.safe_load(profile.read_text()) or []
    # These IDs belong only to this PoC; preserve all user settings and defaults.
    ids = {'preset-argon-' + owner for owner in records} | {'argon-safe-host-changes', 'argon-brain-service'}
    cleaned = []
    for entry in entries:
        if entry.get('id') in ids:
            continue
        if 'insert' in entry:
            entry = {**entry, 'insert': [x for x in entry['insert'] if x.get('id') not in ids]}
            if not entry['insert']:
                continue
        cleaned.append(entry)
    cleaned.append({'insert': [make_brain_service(records)] + [make_preset(owner, record) for owner, record in records.items()] + [
        {'id': 'argon-safe-host-changes', 'name': str(ROOT / 'host-changes.mjs')}]})
    cleaned = [entry for entry in cleaned if entry.get('id') != 'workspace-changes']
    cleaned.append({'id': 'workspace-changes', 'disabled': True})
    profile.write_text(yaml.safe_dump(cleaned, sort_keys=False, allow_unicode=True))
    print('Added operator PoC presets: ' + ', '.join('argon-' + owner for owner in records))
    print('Previous profile backup: ' + str(backup))


if __name__ == '__main__':
    main()
