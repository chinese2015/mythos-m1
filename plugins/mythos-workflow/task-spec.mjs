// Frozen TaskSpec policy for MANUAL (generic) works. Legacy MYTHOS works keep their
// original contracts in rules.mjs / mythos-sdlc policy.mjs; this module only adds the
// generic gates and must stay conclusion-compatible with brain/task_spec.py.
import { baselineReproduced } from './rules.mjs';

const SHA = /^[a-f0-9]{40}$/;
const TEST_PARTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_NAME = /(^test[_.]|^Test|^Spec|(_test|_tests|_spec|\.test|\.spec)\.|(Test|Tests|Spec)\.)/;
const BUILD_FILES = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'requirements.txt', 'Makefile', 'Dockerfile', 'Jenkinsfile', '.gitlab-ci.yml']);
const BUILD_PARTS = new Set(['.github', '.gitlab', '.circleci', '.mvn']);

export function isManagedWork(work) {
  return !!work && work.source?.type === 'MANUAL' && !!work.taskSpec && typeof work.taskSpec.specDigest === 'string' &&
    !!work.taskSpec.changePolicy && !!work.taskSpec.execution;
}

export function effectivePolicy(work) {
  if (isManagedWork(work)) return work.taskSpec.changePolicy;
  return { allowedPaths: [work?.sourceRecord?.sourcePath].filter(p => typeof p === 'string' && p), allowTestChanges: false, maxFiles: 1 };
}

const within = (path, scope) => path === scope || (scope.endsWith('/') && path.startsWith(scope));
const trimSlash = path => path.endsWith('/') ? path.slice(0, -1) : path;

function isTestPath(path) {
  return path.split('/').some(p => TEST_PARTS.has(p.toLowerCase())) || TEST_NAME.test(path.split('/').at(-1));
}
function isBuildPath(path) {
  const parts = path.split('/');
  return BUILD_FILES.has(parts.at(-1)) || parts.some(p => BUILD_PARTS.has(p));
}
function explicitBuildScope(path, scopes) {
  return scopes.some(scope => within(path, scope) && isBuildPath(trimSlash(scope)));
}
function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 500 || path.startsWith('/') || path.endsWith('/') ||
      path.includes('\\') || /[\s*?\[\]{}:]/.test(path)) return false;
  const parts = path.split('/');
  return !parts.some(p => !p || p === '.' || p === '..' || p === '.git' || p === '.cache');
}
// Scopes may be directory prefixes with a trailing slash (Python relative_path directory=True).
function safeScope(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.startsWith('/') ||
      value.includes('\\') || /[\s*?\[\]{}:]/.test(value)) return false;
  const parts = value.replace(/\/+$/, '').split('/');
  return !parts.some(p => !p || p === '.' || p === '..' || p === '.git' || p === '.cache');
}

function changeAllowed(policy, paths) {
  if (!policy || !Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !safePath(p))) return false;
  if (new Set(paths).size > policy.maxFiles) return false;
  return paths.every(path =>
    policy.allowedPaths.some(scope => within(path, scope)) &&
    (policy.allowTestChanges || !isTestPath(path)) &&
    (!isBuildPath(path) || explicitBuildScope(path, policy.allowedPaths)));
}

// Task admission narrowing, mirroring make_task_spec in brain/task_spec.py:
// the task scope can only narrow the repository scope, test permission is a ceiling,
// and build/config paths must be explicitly covered by both layers.
export function admittedChangePolicy(repositoryConfig, manualInput = {}) {
  const repoPolicy = repositoryConfig?.changePolicy;
  if (!repoPolicy || !Array.isArray(repoPolicy.allowedPaths) || !repoPolicy.allowedPaths.length) throw new Error('Repository change policy is unavailable');
  const paths = manualInput.allowedPaths ?? repoPolicy.allowedPaths;
  if (!Array.isArray(paths) || !paths.length || !paths.every(safeScope)) throw new Error('Task paths must be safe relative paths');
  if (repoPolicy.allowedPaths.some(p => !safeScope(p))) throw new Error('Repository change policy is unavailable');
  if (paths.some(p => !repoPolicy.allowedPaths.some(scope => within(p, scope)))) throw new Error('Task paths must narrow repository scope');
  if (paths.some(p => isBuildPath(trimSlash(p)) && !explicitBuildScope(p, repoPolicy.allowedPaths)))
    throw new Error('Task cannot expand repository build configuration permission');
  const allowTestChanges = manualInput.allowTestChanges ?? false;
  if (allowTestChanges && repoPolicy.allowTestChanges !== true) throw new Error('Task cannot expand test permission');
  return { ...repoPolicy, allowedPaths: [...paths], allowTestChanges };
}

export function candidateAllowed(work, git) {
  const files = git?.changedFiles ?? [], tests = git?.testsChanged ?? [];
  if (tests.length && !effectivePolicy(work).allowTestChanges) return false;
  if (isManagedWork(work)) return changeAllowed(effectivePolicy(work), [...files, ...tests]);
  return files.length === 1 && files[0] === work.sourceRecord?.sourcePath && tests.length === 0;
}

const normalFailure = op => op?.state === 'FAILED' && Number.isInteger(op.exitCode);

function validBaselineEvidence(work, operation) {
  const spec = work.taskSpec, execution = spec.execution, policy = execution.evidence;
  const base = work.sourceRecord?.baseCommit, evidence = operation?.evidence;
  if (!operation || !['SUCCEEDED', 'FAILED'].includes(operation.state) || operation.reason != null ||
      operation.kind !== 'UNIT_TEST' || operation.command !== execution.baselineCommand ||
      !Number.isInteger(operation.timeoutSeconds) || operation.timeoutSeconds < 1 ||
      operation.timeoutSeconds > execution.timeoutSeconds || operation.sourceCommit !== base ||
      !operation.sandboxId || operation.sandboxId !== work.sandboxId || !evidence ||
      evidence.sourceCommit !== base || evidence.expectedSourceCommit !== base || evidence.sourceDirty !== false ||
      evidence.command !== execution.baselineCommand || evidence.kind !== 'UNIT_TEST' ||
      evidence.sandboxId !== work.sandboxId || evidence.exitCode !== operation.exitCode ||
      !Number.isInteger(operation.exitCode)) return false;

  if (policy.format === 'command') {
    return evidence.validation?.format === 'command' && evidence.validation.exitCode === operation.exitCode &&
      ((operation.state === 'SUCCEEDED' && operation.exitCode === 0) ||
        (operation.state === 'FAILED' && operation.exitCode !== 0));
  }

  const junit = evidence.junit;
  // The baseline proves that genuine tests ran. `minTests` is the final
  // VERIFY threshold, which can be higher after an approved regression is added.
  if (!junit || !Array.isArray(junit.reports) || !junit.reports.length ||
      !Array.isArray(junit.invalidReports) || junit.invalidReports.length !== 0 ||
      !['tests', 'failures', 'errors', 'skipped'].every(key => Number.isInteger(junit[key]) && junit[key] >= 0) ||
      junit.failures + junit.errors + junit.skipped > junit.tests ||
      junit.tests - junit.skipped < 1 ||
      (junit.skipped > 0 && !policy.allowSkipped) ||
      !junit.reports.every(report => report && typeof report.path === 'string' && safePath(report.path) &&
        policy.reportDirs.some(dir => within(report.path, trimSlash(dir) + '/')))) return false;

  if (operation.state === 'SUCCEEDED') return operation.exitCode === 0 && junit.failures === 0 && junit.errors === 0;
  return operation.exitCode !== 0 && junit.failures + junit.errors > 0;
}

export function baselineReady(work, operation) {
  if (!isManagedWork(work)) return baselineReproduced(operation, work?.source?.id);
  if (!validBaselineEvidence(work, operation)) return false;
  const mode = work.taskSpec.execution.baselineMode;
  if (operation?.state === 'UNKNOWN') return false;
  if (mode === 'must-pass') return operation?.state === 'SUCCEEDED' && operation.exitCode === 0;
  if (mode === 'must-fail') return normalFailure(operation) && operation.exitCode !== 0;
  return operation?.state === 'SUCCEEDED' || normalFailure(operation);
}

function evidencePassing(spec, evidence) {
  const policy = spec.execution.evidence;
  if (!evidence || evidence.exitCode !== 0 || evidence.sourceDirty !== false) return false;
  if (policy.format === 'command') return true;
  const j = evidence.junit;
  if (!j || !Array.isArray(j.reports) || !j.reports.length || j.invalidReports?.length !== 0) return false;
  for (const key of ['tests', 'failures', 'errors', 'skipped'])
    if (!Number.isInteger(j[key]) || j[key] < 0) return false;
  if (j.failures || j.errors || j.tests - j.skipped < policy.minTests || (j.skipped && !policy.allowSkipped)) return false;
  return j.reports.every(r => r && typeof r.path === 'string' && safePath(r.path) &&
    policy.reportDirs.some(dir => within(r.path, trimSlash(dir) + '/')));
}

export function verifiedTaskCandidate(work, operation, git) {
  const wf = work.workflow, spec = work.taskSpec, op = operation ?? {}, evidence = op.evidence ?? {}, runtime = op.runtime ?? {};
  if (!wf.approval || wf.approval.specDigest !== spec.specDigest) return false;
  if (!SHA.test(wf.candidateCommit ?? '') || op.operationId !== wf.verificationOperationId || op.kind !== 'VERIFY' ||
      op.state !== 'SUCCEEDED' || op.exitCode !== 0 || op.command !== spec.execution.verificationCommand ||
      !Number.isInteger(op.timeoutSeconds) || op.timeoutSeconds < 1 || op.timeoutSeconds > spec.execution.timeoutSeconds ||
      op.sourceCommit !== wf.candidateCommit ||
      typeof op.sandboxId !== 'string' || !op.sandboxId ||
      runtime.freshTargetAbsent !== true || typeof runtime.sandboxId !== 'string' || !runtime.sandboxId ||
      runtime.sandboxId === op.sandboxId || runtime.sandboxId === work.sandboxId ||
      evidence.sandboxId !== runtime.sandboxId || evidence.sourceCommit !== wf.candidateCommit) return false;
  if (!evidencePassing(spec, evidence)) return false;
  return !!git && git.headCommit === wf.candidateCommit && !git.status && candidateAllowed(work, git);
}
