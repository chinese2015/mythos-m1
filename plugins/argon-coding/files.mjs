export const fault = (message, status) => Object.assign(new Error(message), { status });
function pathOf(path, allowRoot = false) {
  if (allowRoot && path === '') return '';
  if (typeof path !== 'string' || !path || path.length > 1500 || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(x => !x || x === '..' || x === '.' || x === '.git')) throw fault('只允许任务根目录内的相对路径', 400);
  return path;
}
export class TaskFiles {
  constructor({ workflow, openFs }) { this.workflow = workflow; this.openFs = openFs; }
  async using(id, path, signal, read) {
    signal ??= new AbortController().signal; signal.throwIfAborted();
    const { workItem } = await this.workflow.snapshot(id);
    if (!workItem.sandboxId) throw fault('任务工作区尚未准备', 409);
    const location = await this.workflow.workspace(workItem);
    const reader = await this.openFs(workItem, location);
    try {
      signal.throwIfAborted();
      const fs = reader.fs;
      if (!fs || typeof reader.readBound !== 'function') throw fault('安全任务文件服务不可用', 503);
      const cwd = location.workspacePath;
      const rootInfo = await fs.lstat(cwd, {}, signal);
      if (rootInfo?.type !== 'directory') throw fault('任务根目录不可用', 409);
      const root = await fs.resolve(cwd, { signal });
      let prefix = '';
      for (const part of path ? path.split('/') : []) {
        prefix += (prefix ? '/' : '') + part;
        const entry = await fs.lstat(prefix, { cwd }, signal);
        if (!entry) throw fault('任务文件不存在', 404);
        if (entry.type === 'symlink') throw fault('只读工作区不打开符号链接', 403);
      }
      const target = path ? await fs.resolve(path, { cwd, signal }) : root;
      if (!fs.contains(root, target)) throw fault('路径超出任务工作区', 403);
      const info = await fs.stat(target, signal);
      if (!info) throw fault('任务文件不存在', 404);
      return await read(fs, root, target, info, signal, reader);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error.status || error.name === 'AbortError') throw error;
      const statuses = { FS_NOT_FOUND: 404, FS_NOT_TEXT: 415, FS_NOT_REGULAR_FILE: 415, FS_TOO_LARGE: 413, FS_PERMISSION_DENIED: 403, FS_SANDBOX_DENIED: 403 };
      throw fault(statuses[error.code] === 415 ? '该文件不能作为 UTF-8 文本预览' : '任务文件读取失败', statuses[error.code] ?? 503);
    } finally { reader.release?.(); }
  }
  async list(id, path = '', signal) {
    pathOf(path, true);
    return this.using(id, path, signal, async (_fs, _root, _target, info, signal, reader) => {
      if (info.type !== 'directory') throw fault('此路径不是目录', 415);
      return reader.readBound('list',path,signal);
    });
  }
  async read(id, path, signal) {
    pathOf(path);
    return this.using(id, path, signal, async (fs, _root, target, info, signal, reader) => {
      if (info.type !== 'file') throw fault('此路径不是普通文件', 415);
      const result=await reader.readBound('read',path,signal);
      const after = await fs.stat(target, signal);
      if (!after || after.version !== info.version) throw fault('文件在读取时已变化，请重新加载', 409);
      return result;
    });
  }
}
