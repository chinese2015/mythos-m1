"""Restart only the existing operator Web runtime; leave profile/credentials intact."""
from pathlib import Path
import os
import signal
import subprocess
import time

h = Path.home()
for process in Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        args = [x.decode() for x in (process / 'cmdline').read_bytes().split(b'\0') if x]
        if (len(args) > 1 and Path(args[0]).name == 'node' and args[1].endswith('/dsh')
                and Path(os.readlink(process / 'cwd')) == h / 'dsh-run'):
            os.kill(int(process.name), signal.SIGTERM)
            for _ in range(100):
                if not process.exists():
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Existing DSH did not stop; no replacement was started')
    except (OSError, UnicodeDecodeError):
        continue
env = os.environ.copy()
env['PATH'] = ':'.join([str(h / 'tools/node/bin'), str(h / 'tools/maven/bin'), str(h / 'tools/jdk/bin'), env['PATH']])
env['JAVA_HOME'] = str(h / 'tools/jdk')
logfile = h / 'dsh-run/dsh.log'
with logfile.open('wb') as log:
    logfile.chmod(0o600)
    child = subprocess.Popen([str(h / 'dsh-run/node_modules/.bin/dsh'), 'web', '--no-open', '--host', '127.0.0.1', '--port', '3080'],
                             cwd=h / 'dsh-run', env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                             start_new_session=True)
for _ in range(60):
    if child.poll() is not None:
        raise RuntimeError('DSH startup failed; inspect private dsh.log')
    if 'dsh web:' in logfile.read_text(errors='replace'):
        print('DSH Web ready on 127.0.0.1:3080, pid=' + str(child.pid))
        break
    time.sleep(.5)
else:
    raise RuntimeError('DSH did not announce readiness within 30 seconds')
