"""Scoped Git credential helper: answers only for one exact approved URL.

Used as a host-side `credential.helper` for manual task clones. The secret
never enters the container; an unexpected target receives no output at all.
Direct use: git_credentials.py <credential-file> <url> get  (git appends the
operation after the configured helper arguments).
"""
import json
import os
from pathlib import Path
import stat
import sys

try:
    from .git_host import GitHostClient
except ImportError:  # Standalone execution: python3 brain/git_credentials.py ...
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from brain.git_host import GitHostClient


def helper_command(credential_file, url):
    """Build the git config value for this scoped helper."""
    import shlex
    script = Path(__file__).resolve()
    return '!' + ' '.join(shlex.quote(part) for part in
                          (sys.executable, str(script), str(credential_file), url))


def credential_answer(credential_file, expected_url, request_text):
    """Return the git credential response, or '' for any non-exact target."""
    try:
        request = {}
        for line in request_text.splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                request[key] = value
        target = request.get('protocol', '') + '://' + request.get('host', '') + '/' + request.get('path', '')
        if target != expected_url or request.get('protocol') != 'http':
            return ''
        credentials = GitHostClient(credential_file)._credentials()
        return 'username=%s\npassword=%s\n' % (credentials['username'], credentials['password'])
    except Exception:
        return ''


def main(argv):
    # git invokes a shell helper as: <command> "$@" with the action appended,
    # so the operation is the final argument after our file and URL.
    if len(argv) != 4 or argv[3] != 'get':
        return 0
    answer = credential_answer(argv[1], argv[2], sys.stdin.read())
    if answer:
        sys.stdout.write(answer)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
