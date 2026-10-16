import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import threading

from sandbox import SandboxBroker
from .api import make_server
from .executor import DockerExecutor
from .store import Store
from .worker import Worker


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='Argon durable workflow backend')
    parser.add_argument('--data-dir', type=Path, default=Path.home() / '.argon-brain')
    sub = parser.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init-config', help='Create private owner tokens; never prints them')
    init.add_argument('--owners', nargs='+', default=['alice', 'bob'])
    api = sub.add_parser('api')
    api.add_argument('--host', default='127.0.0.1')
    api.add_argument('--port', type=int, default=3081)
    api.add_argument('--token-file', type=Path)
    api.add_argument('--sandbox-root', type=Path, default=Path.home() / 'argon-sandboxes')
    api.add_argument('--per-owner-limit', type=int, default=2)
    api.add_argument('--global-limit', type=int, default=4)
    worker = sub.add_parser('worker')
    worker.add_argument('--sandbox-root', type=Path, default=Path.home() / 'argon-sandboxes')
    worker.add_argument('--concurrency', type=int, choices=range(1, 5), default=4)
    worker.add_argument('--per-owner-limit', type=int, default=2)
    worker.add_argument('--global-limit', type=int, default=4)
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.data_dir.stat().st_mode & 0o077:
        parser.error('data-dir must be private (chmod 700)')
    token_file = getattr(args, 'token_file', None) or args.data_dir / 'tokens.json'
    if args.action == 'init-config':
        if any(not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', name) for name in args.owners):
            parser.error('Invalid owner name')
        with token_file.open('x') as stream:
            json.dump({'owners': {name: secrets.token_urlsafe(32) for name in args.owners}}, stream, indent=2)
        token_file.chmod(0o600)
        print('Owner credentials saved to ' + str(token_file) + ' (0600)')
        return
    store = Store(args.data_dir)
    if getattr(args, 'per_owner_limit', 2) < 1 or getattr(args, 'global_limit', 4) < 1:
        parser.error('sandbox limits must be positive')
    executor = DockerExecutor(SandboxBroker(args.sandbox_root, args.per_owner_limit, args.global_limit))
    if args.action == 'api':
        if not ipaddress.ip_address(args.host).is_loopback:
            parser.error('API must bind a loopback address; use an SSH tunnel or authenticated proxy')
        if token_file.stat().st_mode & 0o077:
            parser.error('token-file must be private (chmod 600)')
        tokens = json.loads(token_file.read_text())['owners']
        if not tokens or any(not isinstance(v, str) or len(v) < 32 for v in tokens.values()):
            parser.error('Each owner token must contain at least 32 characters')
        server = make_server(store, executor, tokens, (args.host, args.port))
        def shutdown(*_):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        print('Argon API listening on ' + args.host + ':' + str(server.server_port), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
    else:
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        print('Argon worker observing ' + str(store.database), flush=True)
        Worker(store, executor, args.concurrency).run(stop)


if __name__ == '__main__':
    main()
