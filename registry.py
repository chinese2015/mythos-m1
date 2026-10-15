"""Operator-side Sandbox ownership and admission registry; not a login service."""
from contextlib import contextmanager
import re
import sqlite3
from pathlib import Path
import uuid


class AccessDenied(PermissionError):
    pass


class QuotaExceeded(RuntimeError):
    pass


class Registry:
    def __init__(self, root, per_owner_limit=2, global_limit=4):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.per_owner_limit = per_owner_limit
        self.global_limit = global_limit
        self.database = self.root / 'sandboxes.sqlite3'
        with self._connection() as connection:
            connection.execute('''CREATE TABLE IF NOT EXISTS sandboxes (
                sandbox_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL UNIQUE,
                container_name TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
                session_id TEXT, ssh_port INTEGER)''')

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(str(self.database), timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
        finally:
            connection.close()

    def allocate(self, owner_id, workspace_id):
        for value in (owner_id, workspace_id):
            if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value):
                raise ValueError('Invalid owner or workspace identifier')
        sandbox_id = 'sb-' + uuid.uuid4().hex[:16]
        path = self.root / sandbox_id / 'workspace'
        with self._connection() as connection:
            connection.execute('BEGIN IMMEDIATE')
            active = "state NOT IN ('stopped', 'failed')"
            own = connection.execute('SELECT count(*) FROM sandboxes WHERE owner_id=? AND ' + active, (owner_id,)).fetchone()[0]
            total = connection.execute('SELECT count(*) FROM sandboxes WHERE ' + active).fetchone()[0]
            if own >= self.per_owner_limit or total >= self.global_limit:
                raise QuotaExceeded('Sandbox concurrency quota exhausted')
            connection.execute('INSERT INTO sandboxes VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
                               (sandbox_id, owner_id, workspace_id, str(path), 'argon-' + sandbox_id, 'allocated'))
            connection.commit()
        try:
            path.mkdir(parents=True, mode=0o700)
        except OSError:
            self.transition(owner_id, sandbox_id, 'failed')
            raise
        return self.get(owner_id, sandbox_id)

    def get(self, owner_id, sandbox_id):
        with self._connection() as connection:
            row = connection.execute('SELECT * FROM sandboxes WHERE sandbox_id=? AND owner_id=?', (sandbox_id, owner_id)).fetchone()
        if row is None:
            raise AccessDenied('Sandbox is unavailable to this owner')
        return dict(row)

    def list_owned(self, owner_id):
        with self._connection() as connection:
            rows = connection.execute('SELECT * FROM sandboxes WHERE owner_id=?', (owner_id,)).fetchall()
        return [dict(row) for row in rows]

    def transition(self, owner_id, sandbox_id, state, *, ssh_port=None, session_id=None):
        allowed = {'allocated': {'running', 'stopped', 'failed', 'cleanup-pending'},
                   'running': {'stopped', 'failed', 'cleanup-pending'},
                   'cleanup-pending': {'stopped', 'failed'}, 'stopped': set(), 'failed': set()}
        with self._connection() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('SELECT * FROM sandboxes WHERE sandbox_id=? AND owner_id=?', (sandbox_id, owner_id)).fetchone()
            if row is None:
                raise AccessDenied('Sandbox is unavailable to this owner')
            if state != row['state'] and state not in allowed[row['state']]:
                raise ValueError('Invalid Sandbox state transition')
            connection.execute('UPDATE sandboxes SET state=?, ssh_port=COALESCE(?, ssh_port), session_id=COALESCE(?, session_id) WHERE sandbox_id=?',
                               (state, ssh_port, session_id, sandbox_id))
            connection.commit()
        return self.get(owner_id, sandbox_id)
