"""Fixed read-only operation. Anchor traversal to FDs; never follow repository symlinks."""
import errno
import json
import os
import stat
import sys

MAX_BYTES = 512 * 1024


class Refusal(Exception):
    def __init__(self, message, status):
        self.message, self.status = message, status


def version(info):
    return ':'.join(str(x) for x in (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))


def run(root, kind, path):
    if kind not in ('read', 'list') or (not path and kind == 'read'):
        raise Refusal('无效的只读操作', 400)
    parts = path.split('/') if path else []
    if any(p in ('', '.', '..', '.git') or '\\' in p or any(ord(c) < 32 or ord(c) == 127 for c in p) for p in parts) or path.startswith('/'):
        raise Refusal('只允许任务内相对路径', 400)
    if not hasattr(os, 'O_NOFOLLOW'):
        raise Refusal('当前系统不支持安全目录读取', 503)
    directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, directory)
    try:
        parents = parts if kind == 'list' else parts[:-1]
        for component in parents:
            child = os.open(component, directory, dir_fd=fd)
            os.close(fd)
            fd = child
        if kind == 'list':
            names = sorted(name for name in os.listdir(fd) if name != '.git')
            entries = []
            for name in names[:2000]:
                try:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                entry_type = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
                entries.append({'name': name, 'type': entry_type, 'size': info.st_size})
            return {'path': path, 'entries': entries, 'truncated': len(names) > 2000}
        target = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(target)
            if not stat.S_ISREG(before.st_mode):
                raise Refusal('此路径不是普通文件', 415)
            if before.st_size > MAX_BYTES:
                raise Refusal('文件超过 512 KiB', 413)
            data = bytearray()
            while True:
                chunk = os.read(target, min(65536, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise Refusal('文件超过 512 KiB', 413)
            if version(os.fstat(target)) != version(before):
                raise Refusal('文件在读取时变化，请重新加载', 409)
            if b'\x00' in data:
                raise Refusal('二进制文件不支持文本预览', 415)
            try:
                text = data.decode('utf-8-sig')
            except UnicodeDecodeError:
                raise Refusal('文件不是 UTF-8 文本', 415)
            lines = len(text.split('\n')) - int(text.endswith('\n')) if text else 0
            if lines > 16000:
                raise Refusal('文件超过 16000 行', 413)
            return {'path': path, 'text': text, 'lines': lines, 'version': version(before), 'eof': True}
        finally:
            os.close(target)
    finally:
        os.close(fd)


try:
    result = run(*sys.argv[1:])
    print(json.dumps({'value': result}, ensure_ascii=True))
except Refusal as error:
    print(json.dumps({'error': error.message, 'status': error.status}))
except OSError as error:
    code = 403 if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM) else 404 if error.errno == errno.ENOENT else 503
    print(json.dumps({'error': '任务路径不可读取', 'status': code}))
