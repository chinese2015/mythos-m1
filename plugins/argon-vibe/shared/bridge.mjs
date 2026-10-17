// Server-side port of poc/vibe-coding-plugin/shared/bridge.js safePath.
// Pure function: only workspace-internal relative paths are accepted.
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1500 || /[\\\x00-\x1f]/.test(path) || path.startsWith('/') || path.split('/').some(x => !x || x === '..' || x === '.')) throw new Error('只允许工作区内的相对路径');
  return path;
}
