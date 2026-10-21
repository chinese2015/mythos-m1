"""Credential-private, bounded read-only access to the fixed Gitea connection."""
import base64
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import stat
from urllib.parse import quote

from .errors import Conflict, InvalidInput
from .task_spec import ORIGIN, SHA, branch_name, normalize_repository

MAX_RESPONSE = 1024 * 1024


class GitHostClient:
    def __init__(self, credential_file=None):
        self.credential_file = Path(credential_file).expanduser() if credential_file is not None else Path.home() / 'gitea/secrets/mythos-agent.json'

    def _credentials(self):
        fd = None
        try:
            # O_NOFOLLOW and fstat close the symlink/replacement window.
            fd = os.open(str(self.credential_file), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            metadata = os.fstat(fd)
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                    or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_size > 65536):
                raise ValueError()
            with os.fdopen(fd, 'r', encoding='utf-8') as stream:
                fd = None
                value = json.load(stream)
            if (not isinstance(value, dict) or not isinstance(value.get('username'), str) or not value['username']
                    or ':' in value['username'] or any(c in value['username'] for c in '\r\n\x00')
                    or not isinstance(value.get('password'), str) or len(value['password']) < 16
                    or any(c in value['password'] for c in '\r\n\x00')):
                raise ValueError()
            return value
        except (OSError, ValueError, UnicodeError):
            raise InvalidInput('Private Git host credentials are unavailable') from None
        finally:
            if fd is not None: os.close(fd)

    def git_context(self, config):
        config = normalize_repository(config)
        self._credentials()
        return {'url': ORIGIN + '/' + config['fullName'] + '.git', 'credentialFile': str(self.credential_file.absolute())}

    def _get(self, config, suffix=''):
        config = normalize_repository(config)
        credentials = self._credentials()
        authorization = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode('ascii')
        connection = HTTPConnection('127.0.0.1', 3000, timeout=5)
        try:
            connection.request('GET', '/api/v1/repos/' + config['fullName'] + suffix,
                               headers={'Authorization': 'Basic ' + authorization, 'Accept': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                raise Conflict('Git host refused repository access')
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > MAX_RESPONSE):
                raise Conflict('Git host response exceeds limit')
            payload = response.read(MAX_RESPONSE + 1)
            if len(payload) > MAX_RESPONSE: raise Conflict('Git host response exceeds limit')
            value = json.loads(payload)
            if not isinstance(value, dict): raise ValueError()
            return value
        except Conflict:
            raise
        except Exception:
            raise Conflict('Git host response unavailable or invalid') from None
        finally:
            connection.close()

    def check(self, config):
        config = normalize_repository(config)
        value = self._get(config)
        if value.get('full_name') != config['fullName'] or not isinstance(value.get('permissions'), dict) or value['permissions'].get('push') is not True:
            raise Conflict('Repository identity or push permission unavailable')
        try: default = branch_name(value.get('default_branch'))
        except InvalidInput: raise Conflict('Git host returned an invalid default branch') from None
        return {'fullName': config['fullName'], 'defaultBranch': default, 'pushPermission': True}

    def resolve(self, config, branch):
        config = normalize_repository(config)
        branch_name(branch)
        self.check(config)
        value = self._get(config, '/branches/' + quote(branch, safe=''))
        commit = value.get('commit')
        sha = commit.get('id') if isinstance(commit, dict) else None
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise Conflict('Git host did not return a full commit SHA')
        return sha
