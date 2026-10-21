"""Trusted operator CLI for isolated task containers. Not exposed as an Agent tool."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

from registry import Registry
from ssh_config import register_include

IMAGE = 'mythos-dsh-sandbox:0.2.0-rc.2'

CLONE_URL = re.compile(r'http://127\.0\.0\.1:13000/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.git')


def validate_clone_target(url, branch, git_context):
    """Reject unsafe branches, URLs, or credential contexts before Git/Docker I/O."""
    from brain.task_spec import branch_name
    from brain.errors import InvalidInput
    branch_name(branch)
    if git_context is None:
        if not isinstance(url, str) or not CLONE_URL.fullmatch(url):
            raise InvalidInput('Unsafe Git clone URL')
        return url, branch, None
    if (not isinstance(git_context, dict) or set(git_context) != {'url', 'credentialFile'}
            or not isinstance(git_context['url'], str) or not isinstance(git_context['credentialFile'], str)):
        raise InvalidInput('Git context must provide exactly url and credentialFile')
    if url != git_context['url'] or not CLONE_URL.fullmatch(url):
        raise InvalidInput('Git clone URL does not match the approved context')
    return url, branch, git_context


def run(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{argv[0]} failed: {result.stderr[-1500:]}')
    return result.stdout.strip()


class SandboxBroker:
    def __init__(self, root, per_owner_limit=2, global_limit=4):
        self.registry = Registry(root, per_owner_limit=per_owner_limit, global_limit=global_limit)

    def create(self, owner, workspace, source=None, *, branch='main', git_context=None):
        if source:
            source, branch, git_context = validate_clone_target(source, branch, git_context)
        record = self.registry.allocate(owner, workspace)
        folder = Path(record['workspace_path']).parent
        secret = folder / 'private'
        secret.mkdir(mode=0o700)
        key = secret / 'client_ed25519'
        try:
            run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
            if source:
                if git_context is None:
                    run(['git', 'clone', '--single-branch', '--branch', branch, source, record['workspace_path']])
                else:
                    from brain.git_credentials import helper_command
                    environment = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                                       GIT_TERMINAL_PROMPT='0', GIT_ASKPASS='/bin/false')
                    run(['git', '-c', 'credential.helper=' + helper_command(git_context['credentialFile'], source),
                         '-c', 'credential.useHttpPath=true',
                         'clone', '--single-branch', '--branch', branch, source, record['workspace_path']],
                        env=environment)
                run(['git', '-C', record['workspace_path'], 'config', 'core.sharedRepository', 'group'])
            for directory, _, files in os.walk(record['workspace_path']):
                os.chmod(directory, 0o2770)
                for name in files:
                    path = Path(directory) / name
                    if not path.is_symlink():
                        path.chmod(path.stat().st_mode | 0o060)
            run(['docker', 'run', '-d', '--name', record['container_name'],
                 '--label', 'mythos.owner=' + owner, '--label', 'mythos.sandbox=' + record['sandbox_id'],
                 '--network', 'none', '--memory', '2g', '--cpus', '1', '--pids-limit', '256',
                 '--read-only', '--security-opt', 'no-new-privileges:true',
                 '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
                 '--cap-add', 'SYS_CHROOT', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN',
                 '--tmpfs', '/run:rw,nosuid,nodev,size=16m',
                 '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=256m',
                 '--mount', f'type=bind,src={record["workspace_path"]},dst={record["workspace_path"]}',
                 '--mount', f'type=bind,src={key}.pub,dst=/etc/mythos/authorized_keys,readonly', IMAGE])
            host_key = ''
            for _ in range(50):
                result = subprocess.run(['docker', 'exec', record['container_name'], 'cat', '/run/ssh_host_ed25519_key.pub'], capture_output=True, text=True)
                if result.returncode == 0:
                    host_key = result.stdout.strip()
                    break
                time.sleep(0.1)
            if not host_key:
                raise RuntimeError('Sandbox SSH daemon did not start')
            known = secret / 'known_hosts'
            alias = 'mythos-' + record['sandbox_id']
            known.write_text(f'{alias} {host_key}\n')
            known.chmod(0o600)
            config = folder / 'ssh_config'
            config.write_text(f'Host {alias}\n  HostName 127.0.0.1\n  HostKeyAlias {alias}\n  User runner\n'
                              f'  IdentityFile {key}\n  UserKnownHostsFile {known}\n'
                              '  StrictHostKeyChecking yes\n  IdentitiesOnly yes\n  ForwardAgent no\n'
                              # OpenSSH's admin forwarding gate also covers Unix sockets.
                              # This is a stdio transport into a network-none container.
                              f'  ProxyCommand /usr/bin/docker exec -i --user 0 {record["container_name"]} /usr/sbin/sshd -i -o AllowTcpForwarding=yes '
                              '-o SetEnv=GIT_CONFIG_GLOBAL=/tmp/mythos-gitconfig -f /etc/ssh/sshd_config\n'
                              f'  SetEnv MAVEN_OPTS=-Dmaven.repo.local={record["workspace_path"]}/.cache/m2/repository\n')
            config.chmod(0o600)
            ssh = Path.home() / '.ssh/config'
            register_include(ssh, config)
            run(['ssh', '-o', 'BatchMode=yes', alias, 'true'])
            self.registry.transition(owner, record['sandbox_id'], 'running')
            self.execute(owner, record['sandbox_id'], ['true'])
            # The image's HOME is inherited from Gitea and its root is read-only.
            # Native SSH tools get this per-container config through sshd SetEnv.
            self.execute(owner, record['sandbox_id'], ['git', 'config', '--file', '/tmp/mythos-gitconfig',
                                                       '--add', 'safe.directory', record['workspace_path']])
            self.execute(owner, record['sandbox_id'], ['sh', '-c', 'mkdir -p .cache/m2 && cp -a /opt/m2-seed/repository .cache/m2/'])
            excludes = Path(record['workspace_path']) / '.git/info/exclude'
            if excludes.exists():
                with excludes.open('a') as f:
                    f.write('\n.cache/\ntarget/\n')
            return self.registry.get(owner, record['sandbox_id'])
        except Exception:
            removed = subprocess.run(['docker', 'rm', '-f', record['container_name']], capture_output=True)
            absent = removed.returncode == 0
            if not absent:
                listing = subprocess.run(['docker', 'ps', '-aq', '--filter', 'name=^/' + record['container_name'] + '$'], capture_output=True, text=True)
                absent = listing.returncode == 0 and not listing.stdout.strip()
            self.registry.transition(owner, record['sandbox_id'], 'failed' if absent else 'cleanup-pending')
            raise

    def execute(self, owner, sandbox_id, argv):
        record = self.registry.get(owner, sandbox_id)
        if record['state'] != 'running':
            raise RuntimeError('Sandbox is not running')
        return run(['docker', 'exec', '--user', '1001:1000', '-w', record['workspace_path'],
                    record['container_name'], *argv])

    def execute_capture(self, owner, sandbox_id, argv, timeout=None):
        """Run a command and report its real exit code instead of raising."""
        record = self.registry.get(owner, sandbox_id)
        if record['state'] != 'running':
            raise RuntimeError('Sandbox is not running')
        result = subprocess.run(['docker', 'exec',
                                 '-e', 'GIT_CONFIG_COUNT=1',
                                 '-e', 'GIT_CONFIG_KEY_0=safe.directory',
                                 '-e', 'GIT_CONFIG_VALUE_0=*',
                                 '--user', '1001:1000', '-w', record['workspace_path'],
                                 record['container_name'], *argv],
                                capture_output=True, text=True, timeout=timeout)
        return {'stdout': result.stdout, 'stderr': result.stderr, 'exitCode': result.returncode}

    def stop(self, owner, sandbox_id):
        record = self.registry.get(owner, sandbox_id)
        run(['docker', 'stop', '--time', '10', record['container_name']])
        return self.registry.transition(owner, sandbox_id, 'stopped')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path.home() / 'mythos-sandboxes')
    sub = parser.add_subparsers(dest='action', required=True)
    create = sub.add_parser('create')
    create.add_argument('--owner', required=True)
    create.add_argument('--workspace', required=True)
    create.add_argument('--source')
    stop = sub.add_parser('stop')
    stop.add_argument('--owner', required=True)
    stop.add_argument('sandbox_id')
    execute = sub.add_parser('exec')
    execute.add_argument('--owner', required=True)
    execute.add_argument('sandbox_id')
    execute.add_argument('--timeout', type=float, default=None)
    execute.add_argument('cmd', nargs=argparse.REMAINDER)
    status = sub.add_parser('status')
    status.add_argument('--owner', required=True)
    status.add_argument('sandbox_id', nargs='?')
    args = parser.parse_args()
    broker = SandboxBroker(args.root)
    if args.action == 'create':
        record = broker.create(args.owner, args.workspace, args.source)
    elif args.action == 'stop':
        record = broker.stop(args.owner, args.sandbox_id)
    elif args.action == 'exec':
        cmd = list(args.cmd)
        if cmd and cmd[0] == '--':
            cmd = cmd[1:]
        if not cmd:
            raise SystemExit('exec requires a command after --')
        record = broker.execute_capture(args.owner, args.sandbox_id, cmd, timeout=args.timeout)
    else:
        if args.sandbox_id:
            record = broker.registry.get(args.owner, args.sandbox_id)
        else:
            record = broker.registry.list_owned(args.owner)
    print(json.dumps(record))


if __name__ == '__main__':
    main()
