"""Atomically merge operator-owned SSH includes across concurrent creators."""
import fcntl
import os
from pathlib import Path
import tempfile


def register_include(config_path, include_path):
    config = Path(config_path).resolve()
    config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = config.parent / '.argon-ssh-config.lock'
    with lock.open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        text = config.read_text() if config.exists() else ''
        line = 'Include ' + str(include_path)
        if line in text.splitlines():
            return
        fd, temporary = tempfile.mkstemp(prefix='.argon-ssh-config-', dir=config.parent)
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(line + '\n' + text)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, config)
        finally:
            Path(temporary).unlink(missing_ok=True)
