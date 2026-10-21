// Repository registry and manual task intake page.
// Pure builders below mirror the M2 admission contract; the DOM wiring stays in renderIntake.
export const CONNECTION_ID = 'local-gitea';
export const RUNTIME_PROFILES = ['java17-maven-offline-v1', 'standard-tools-v1'];
export const BASELINE_MODES = ['record', 'must-pass', 'must-fail'];
export const EVIDENCE_FORMATS = ['junit', 'command'];

const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SHA = /^[a-f0-9]{40}$/;
const KEY_FORMAT = /^[A-Za-z0-9_-]{1,150}$/;

function fail(message) { throw new Error(message); }
function requireText(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(`${label} is required and must not exceed ${limit} characters`);
  return value;
}
function requireInt(value, lower, upper, label) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(number) || number < lower || number > upper) fail(`${label} must be an integer in ${lower}..${upper}`);
  return number;
}
function requireBranch(value, label) {
  const branch = requireText(String(value ?? ''), 200, label);
  if (['-', '/', '.'].some(prefix => branch.startsWith(prefix)) || ['/', '.', '.lock'].some(suffix => branch.endsWith(suffix)) || branch.includes('..') || branch.includes('@{')
      || /[\s~^:?*[\\]/.test(branch) || branch === '@' || branch.includes('//')
      || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) fail(`${label} is not a safe Git branch name`);
  return branch;
}
function requireRelativePath(value) {
  const path = requireText(value, 500, 'Path');
  if (path.startsWith('/') || path.includes('\\') || /[\s*?[\]{}:]/.test(path) || path.replace(/\/+$/, '').split('/').some(part => ['', '.', '..', '.git', '.cache'].includes(part))) fail(`Path is unsafe or protected: ${path}`);
  return path;
}
function splitList(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
}
function splitPaths(value) {
  const paths = splitList(value).map(requireRelativePath);
  if (paths.length < 1 || paths.length > 100) fail('Allowed scope requires 1..100 paths');
  return paths;
}
function requireFullName(value) {
  const name = requireText(String(value ?? ''), 219, 'Repository');
  if (!FULL_NAME.test(name) || name.endsWith('.git') || name.split('/').some(part => ['.', '..'].includes(part))) fail('fullName must be in owner/repository form');
  return name;
}

export function buildRepositoryConfig(values = {}) {
  const displayName = requireText(String(values.displayName ?? ''), 200, 'Display name');
  const fullName = requireFullName(values.fullName);
  const defaultBranch = requireBranch(values.defaultBranch || 'main', 'Baseline branch');
  if (!RUNTIME_PROFILES.includes(values.runtimeProfile)) fail(`Unknown runtime profile (runtimeProfile): ${String(values.runtimeProfile)}`);
  if (!BASELINE_MODES.includes(values.baselineMode)) fail(`Unsupported baseline mode (baselineMode): ${String(values.baselineMode)}`);
  const baselineCommand = requireText(String(values.baselineCommand ?? ''), 8192, 'Baseline command');
  const verificationCommand = requireText(String(values.verificationCommand ?? ''), 8192, 'Validation command');
  const timeoutSeconds = requireInt(values.timeoutSeconds, 1, 3600, 'Timeout seconds');
  const allowSkipped = values.allowSkipped === true;
  let evidence;
  if (values.evidenceFormat === 'command') {
    evidence = { format: 'command', reportDirs: [], minTests: 0, allowSkipped };
  } else if (values.evidenceFormat === 'junit') {
    evidence = { format: 'junit', reportDirs: splitPaths(values.reportDirs), minTests: requireInt(values.minTests, 1, 1000000, 'Minimum tests'), allowSkipped };
  } else {
    fail(`Unknown evidence format (format): ${String(values.evidenceFormat)}`);
  }
  const contexts = splitList(values.requiredStatusContexts);
  if (contexts.length > 20) fail('At most 20 required status contexts');
  for (const context of contexts) requireText(context, 200, 'Status context');
  return {
    displayName, connectionId: CONNECTION_ID, fullName, defaultBranch, runtimeProfile: values.runtimeProfile,
    execution: { baselineCommand, verificationCommand, baselineMode: values.baselineMode, timeoutSeconds, evidence },
    changePolicy: { allowedPaths: splitPaths(values.allowedPaths), allowTestChanges: values.allowTestChanges === true, maxFiles: requireInt(values.maxFiles ?? 100, 1, 10000, 'Max files') },
    reviewPolicy: { minApprovals: requireInt(values.minApprovals ?? 0, 0, 20, 'Minimum approvals'), requiredStatusContexts: contexts },
  };
}

export function buildManualInput(values = {}, repository) {
  if (!repository || typeof repository !== 'object' || typeof repository.repositoryId !== 'string') fail('Select a registered repository first');
  const input = {
    repositoryId: repository.repositoryId,
    repositoryRevision: requireInt(repository.revision, 1, Number.MAX_SAFE_INTEGER, 'Repository revision'),
    title: requireText(String(values.title ?? ''), 300, 'Title'),
    description: requireText(String(values.description ?? ''), 16000, 'Description'),
    acceptanceCriteria: requireText(String(values.acceptanceCriteria ?? ''), 16000, 'Acceptance criteria'),
  };
  if (String(values.baseBranch ?? '').trim()) input.baseBranch = requireBranch(String(values.baseBranch).trim(), 'Baseline branch');
  if (String(values.baseCommit ?? '').trim()) {
    const sha = String(values.baseCommit).trim();
    if (!SHA.test(sha)) fail('baseCommit must be a 40-character lowercase SHA; leave empty to resolve the current HEAD of the selected branch');
    input.baseCommit = sha;
  }
  if (String(values.allowedPaths ?? '').trim()) input.allowedPaths = splitPaths(values.allowedPaths);
  if (values.allowTestChanges === true) {
    if (repository.config?.changePolicy?.allowTestChanges !== true) fail('This repository does not allow test changes; task scope cannot widen permissions');
    input.allowTestChanges = true;
  }
  return input;
}

// ---- Intent idempotency: one key per business intent until the server acknowledgement is seen ----
export function createIntentKey() {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function fingerprintOf(value) { return canonical(value); }

function intentStorageError(corrupt = false) {
  const error = new Error(corrupt
    ? 'The submission intent store is corrupted and the original submission id cannot be confirmed. Verify the original result first; you can resubmit only after explicitly abandoning the current intent.'
    : 'The submission intent store is unavailable and the original submission id cannot be saved or read reliably. Restore the store and retry to avoid duplicate creation.');
  error.code = corrupt ? 'INTENT_CORRUPT' : 'INTENT_STORAGE';
  return error;
}

export class IntentLedger {
  constructor(scope, storage) {
    if (typeof scope !== 'string' || !scope) fail('Intent scope is required');
    if (!storage || ['getItem', 'setItem', 'removeItem'].some(method => typeof storage[method] !== 'function')) throw intentStorageError();
    this.itemKey = 'mythos-intent:' + scope;
    this.storage = storage;
  }
  peek() {
    let raw;
    try { raw = this.storage.getItem(this.itemKey); }
    catch { throw intentStorageError(); }
    if (raw === null) return null;
    let current;
    try { current = JSON.parse(raw); }
    catch { throw intentStorageError(true); }
    if (typeof raw !== 'string' || !current || typeof current !== 'object' || Array.isArray(current)
        || Object.keys(current).length !== 2 || typeof current.key !== 'string' || !KEY_FORMAT.test(current.key)
        || typeof current.fingerprint !== 'string' || !current.fingerprint) throw intentStorageError(true);
    return current;
  }
  // Reuses the unacknowledged key for the same business input; refuses silent reuse after a change.
  intent(fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprint) fail('Intent fingerprint is required');
    const current = this.peek();
    if (current) {
      if (current.fingerprint === fingerprint) return { key: current.key, reused: true };
      const error = new Error('The form content changed while the previous submission is still unacknowledged. Verify the original task result first, or explicitly "Abandon current intent" before editing and retrying.');
      error.code = 'INTENT_CHANGED';
      error.current = current;
      throw error;
    }
    const key = createIntentKey();
    try { this.storage.setItem(this.itemKey, JSON.stringify({ key, fingerprint })); }
    catch { throw intentStorageError(); }
    const saved = this.peek();
    if (!saved || saved.key !== key || saved.fingerprint !== fingerprint) throw intentStorageError();
    return { key, reused: false };
  }
  // Acknowledged: the original task/result is confirmed, so the intent is spent.
  succeed() { this.reset(); }
  // Explicit operator decision to abandon an unacknowledged intent and start a new one.
  reset() {
    try { this.storage.removeItem(this.itemKey); }
    catch { throw intentStorageError(); }
  }
}

// ---- Truthful rendering helpers shared with the work detail ----
export function evidenceLine(format, junit) {
  if (format === 'command') return null;
  if (!junit || typeof junit !== 'object') return format === 'junit' ? 'No JUnit report produced' : null;
  if (Array.isArray(junit.invalidReports) && junit.invalidReports.length) return `JUnit reports invalid (${junit.invalidReports.length})`;
  if (!Array.isArray(junit.reports) || !junit.reports.length) return 'No JUnit report produced';
  if (!Array.isArray(junit.invalidReports) || ['tests', 'failures', 'errors'].some(key => !Number.isInteger(junit[key]) || junit[key] < 0)) return 'JUnit reports invalid';
  return `JUnit: ${junit.tests} tests · ${junit.failures} failures · ${junit.errors} errors`;
}
const RISK_LABELS = { HIGH: 'High risk', MEDIUM: 'Medium risk', LOW: 'Low risk', high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
export function sourceFacts(sourceRecord = {}, taskSpec = null) {
  if (!taskSpec || typeof taskSpec !== 'object') {
    const risk = sourceRecord?.risk;
    return { managed: false, riskLabel: risk ? (RISK_LABELS[risk] || String(risk)) : null, singleFile: !!sourceRecord?.sourcePath,
      scopeLabel: sourceRecord?.sourcePath || null, evidenceLabel: null };
  }
  const evidence = taskSpec.execution?.evidence || {};
  return { managed: true, riskLabel: null, singleFile: false,
    scopeLabel: (sourceRecord?.sourcePaths || []).join(', ') || null,
    evidenceLabel: evidence.format === 'command' ? 'Command exit code' : `JUnit · at least ${evidence.minTests ?? 1} tests` };
}

// ---- DOM page ----
const MODE_LABELS = { record: 'Record baseline result', 'must-pass': 'Baseline must pass', 'must-fail': 'Baseline must fail' };
const EVIDENCE_LABELS = { junit: 'JUnit report', command: 'Command exit code' };

function defaultStorage() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

export function renderIntake({ el, panelHead, request, notice, goWork }) {
  let repositories = [], selectedId = null, busy = false, loadSeq = 0;
  let checkResults = new Map(), created = null;
  const storage = defaultStorage();
  const ledgers = storage ? {
    register: new IntentLedger('register', storage),
    task: new IntentLedger('manual-task', storage),
    revise: id => new IntentLedger('revise:' + id, storage),
  } : null;
  const ledgerFor = kind => {
    if (!ledgers) throw intentStorageError();
    return typeof kind === 'function' ? kind() : ledgers[kind];
  };

  const view = el('div');
  const listBox = el('div', { class: 'task-list' });
  const taskBox = el('div'), regBox = el('div');

  const field = (label, input, extraClass = '') => {
    const wrap = el('div', { class: `form-field ${extraClass}`.trim() });
    wrap.append(el('label', { text: label }), input);
    return wrap;
  };
  const textInput = attrs => el('input', { type: 'text', autocomplete: 'off', ...attrs });
  const numberInput = attrs => el('input', { type: 'number', min: '1', ...attrs });
  const checkbox = (labelText, attrs = {}) => {
    const box = el('label', { class: 'check-field' });
    const input = el('input', { type: 'checkbox', ...attrs });
    box.append(input, el('span', { text: labelText }));
    return { box, input };
  };
  const read = node => ('value' in node ? node.value : '');
  const readInt = node => String(node.value ?? '').trim();
  const intentGuard = (ledger, hint, run) => {
    try { return run(); }
    catch (error) {
      if (['INTENT_CHANGED', 'INTENT_CORRUPT'].includes(error?.code)) {
        hint.replaceChildren();
        const abandon = el('button', { class: 'text-button', type: 'button', text: 'Abandon current intent' });
        abandon.addEventListener('click', () => {
          try { ledger.reset(); hint.replaceChildren(); notice('Abandoned the unacknowledged submission intent; you can edit and resubmit.', 'info'); }
          catch (error) { notice(error.message, 'error'); }
        });
        hint.append(abandon);
      }
      throw error;
    }
  };

  // ---- repository list cards ----
  function repoCard(repo) {
    const card = el('article', { class: 'task-card' });
    const content = el('div');
    const row = el('div', { class: 'task-title-row' });
    row.append(el('span', { class: 'finding-id', text: repo.repositoryId.slice(0, 12) }),
      el('span', { class: 'task-title', text: repo.config?.displayName || repo.config?.fullName || 'Unnamed repository' }),
      el('span', { class: `status-pill ${repo.enabled ? 'enabled' : ''}`, text: repo.enabled ? `Enabled · revision ${repo.revision}` : `Disabled · revision ${repo.revision}` }));
    const meta = el('div', { class: 'task-meta' });
    meta.append(el('span', {}, 'Repository: '), el('b', { class: 'mono', text: repo.config?.fullName || '—' }),
      el('span', { class: 'dotsep', text: '•' }), el('span', {}, 'Baseline branch: '), el('b', { text: repo.config?.defaultBranch || '—' }),
      el('span', { class: 'dotsep', text: '•' }), el('span', {}, 'Runtime: '), el('b', { text: repo.config?.runtimeProfile || '—' }));
    content.append(row, meta);
    const policy = repo.config ? policySummary(repo.config) : null;
    if (policy) content.append(el('p', { class: 'task-description', text: policy }));
    const check = checkResults.get(repo.repositoryId);
    if (check && check.revision === repo.revision && check.configFingerprint === fingerprintOf(repo.config)) content.append(el('p', { class: check.ok ? 'subtle' : 'task-description', text: check.message }));
    const side = el('div', { class: 'task-side' });
    const actions = el('div', { class: 'intake-actions' });
    const checkButton = el('button', { class: 'secondary-button', type: 'button', text: 'Connection check' });
    checkButton.addEventListener('click', async () => {
      checkButton.disabled = true; checkButton.textContent = 'Checking…';
      try {
        const result = await request(`/repositories/${encodeURIComponent(repo.repositoryId)}/check`, { method: 'POST', body: {}, mutation: true });
        checkResults.set(repo.repositoryId, { revision: repo.revision, configFingerprint: fingerprintOf(repo.config), ok: true, message: `Connection OK: ${result.fullName} · default branch ${result.defaultBranch} · push permission ${result.pushPermission ? 'confirmed' : 'missing'}` });
      } catch (error) {
        checkResults.set(repo.repositoryId, { revision: repo.revision, configFingerprint: fingerprintOf(repo.config), ok: false, message: `Connection check failed: ${error.message}` });
      }
      renderList();
    });
    const toggle = el('button', { class: repo.enabled ? 'danger-button' : 'secondary-button', type: 'button', text: repo.enabled ? 'Disable' : 'Enable' });
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      const body = { expectedRevision: repo.revision, enabled: !repo.enabled };
      try {
        const ledger = ledgerFor(() => ledgers.revise(repo.repositoryId));
        const { key } = intentGuard(ledger, regIntentHint, () => ledger.intent(fingerprintOf(body)));
        await request(`/repositories/${encodeURIComponent(repo.repositoryId)}/revisions`, { method: 'POST', body, mutation: true, idempotencyKey: key });
        ledger.succeed();
        notice(body.enabled ? 'Repository enabled; new tasks can be registered.' : 'Repository disabled; only new task registration is blocked, in-progress work is unaffected.', 'info');
        await load(true);
      } catch (error) { notice(error.message, 'error'); toggle.disabled = false; }
    });
    const edit = el('button', { class: 'secondary-button', type: 'button', text: 'Update config' });
    edit.addEventListener('click', () => fillRegisterForm(repo));
    actions.append(checkButton, toggle, edit);
    if (repo.enabled) {
      const use = el('button', { class: 'primary-button', type: 'button', text: 'New task' });
      use.addEventListener('click', () => { selectedId = repo.repositoryId; syncRepoSelect(); renderPolicy(); view.querySelector('#task-title')?.focus(); });
      actions.append(use);
    }
    side.append(actions);
    card.append(content, side);
    return card;
  }
  function policySummary(config) {
    const parts = [
      `Allowed scope ${config.changePolicy.allowedPaths.join(', ')} (at most ${config.changePolicy.maxFiles} files${config.changePolicy.allowTestChanges ? ', test changes allowed' : ', test changes not allowed'})`,
      `Baseline ${config.execution.baselineCommand} (${MODE_LABELS[config.execution.baselineMode] || config.execution.baselineMode})`,
      `Validation ${config.execution.verificationCommand} (${config.execution.timeoutSeconds}s · ${EVIDENCE_LABELS[config.execution.evidence.format] || config.execution.evidence.format}${config.execution.evidence.format === 'junit' ? ` · ${config.execution.evidence.reportDirs.join(', ')} · at least ${config.execution.evidence.minTests} tests` : ''})`,
      `Review: at least ${config.reviewPolicy.minApprovals} approvals${config.reviewPolicy.requiredStatusContexts.length ? ' · required contexts ' + config.reviewPolicy.requiredStatusContexts.join(', ') : ''}`,
    ];
    return parts.join('; ');
  }
  function renderList() {
    listBox.replaceChildren();
    if (!repositories.length) {
      listBox.append(el('div', { class: 'empty-state', text: 'No repositories registered yet. Register a repository in the form below and confirm the connection first.' }));
      return;
    }
    for (const repo of repositories) listBox.append(repoCard(repo));
  }

  // ---- register / revise form ----
  const reg = {
    displayName: textInput({ 'aria-label': 'Display name' }), fullName: textInput({ 'aria-label': 'Repository', placeholder: 'owner/repository' }),
    defaultBranch: textInput({ 'aria-label': 'Baseline branch', value: 'main' }),
    runtimeProfile: el('select', { 'aria-label': 'Runtime profile' }),
    baselineMode: el('select', { 'aria-label': 'Baseline mode' }), timeoutSeconds: numberInput({ 'aria-label': 'Timeout seconds', value: '300' }),
    baselineCommand: textInput({ 'aria-label': 'Baseline command' }), verificationCommand: textInput({ 'aria-label': 'Validation command' }),
    evidenceFormat: el('select', { 'aria-label': 'Evidence format' }), reportDirs: textInput({ 'aria-label': 'Report directories', placeholder: 'target/surefire-reports' }),
    minTests: numberInput({ 'aria-label': 'Minimum tests', value: '1', min: '1' }),
    allowSkipped: checkbox('Allow skipped test cases'), allowedPaths: el('textarea', { rows: '2', 'aria-label': 'Allowed scope', placeholder: 'src/' }),
    allowTestChanges: checkbox('Allow test changes within scope'), maxFiles: numberInput({ 'aria-label': 'Max files', value: '100' }),
    minApprovals: numberInput({ 'aria-label': 'Minimum approvals', value: '0', min: '0', max: '20' }),
    requiredStatusContexts: textInput({ 'aria-label': 'Required status contexts', placeholder: 'Leave empty for no required contexts' }),
  };
  for (const profile of RUNTIME_PROFILES) reg.runtimeProfile.append(el('option', { value: profile, text: profile }));
  for (const mode of BASELINE_MODES) reg.baselineMode.append(el('option', { value: mode, text: `${mode} (${MODE_LABELS[mode]})` }));
  for (const format of EVIDENCE_FORMATS) reg.evidenceFormat.append(el('option', { value: format, text: EVIDENCE_LABELS[format] }));
  reg.runtimeProfile.value = RUNTIME_PROFILES[0];
  reg.baselineMode.value = BASELINE_MODES[0];
  reg.evidenceFormat.value = EVIDENCE_FORMATS[0];
  const regMode = { repository: null };
  const regTitle = el('h2', { text: 'Register repository' });
  const regNote = el('small', { text: 'The connection is fixed to local-gitea; commands and policies are frozen into the task at registration.' });
  const regSubmit = el('button', { class: 'primary-button', type: 'submit', text: 'Register repository' });
  const regCancel = el('button', { class: 'text-button', type: 'button', text: 'Cancel update' });
  regCancel.hidden = true;
  regCancel.addEventListener('click', () => { fillRegisterForm(null); notice('Exited update mode.', 'info'); });
  const regIntentHint = el('div', { class: 'subtle', id: 'reg-intent-hint' });

  function fillRegisterForm(repo) {
    regMode.repository = repo;
    if (!repo) {
      regTitle.textContent = 'Register repository';
      regNote.textContent = 'The connection is fixed to local-gitea; commands and policies are frozen into the task at registration.';
      regSubmit.textContent = 'Register repository';
      regCancel.hidden = true;
      for (const [key, node] of Object.entries(reg)) {
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) node.value = key === 'defaultBranch' ? 'main' : '';
        if (node instanceof HTMLSelectElement) node.selectedIndex = 0;
      }
      reg.timeoutSeconds.value = '300'; reg.minTests.value = '1'; reg.maxFiles.value = '100'; reg.minApprovals.value = '0';
      reg.allowSkipped.input.checked = false; reg.allowTestChanges.input.checked = false;
      syncEvidenceInputs();
      return;
    }
    const config = repo.config;
    regTitle.textContent = `Update config · ${config.fullName} · revision ${repo.revision}`;
    regNote.textContent = 'Submitting creates a new repository revision; in-progress tasks keep using their frozen revision.';
    regSubmit.textContent = `Submit as new revision (based on revision ${repo.revision})`;
    regCancel.hidden = false;
    reg.displayName.value = config.displayName; reg.fullName.value = config.fullName; reg.defaultBranch.value = config.defaultBranch;
    reg.runtimeProfile.value = config.runtimeProfile;
    reg.baselineCommand.value = config.execution.baselineCommand; reg.verificationCommand.value = config.execution.verificationCommand;
    reg.baselineMode.value = config.execution.baselineMode; reg.timeoutSeconds.value = String(config.execution.timeoutSeconds);
    reg.evidenceFormat.value = config.execution.evidence.format;
    reg.reportDirs.value = config.execution.evidence.reportDirs.join(', ');
    reg.minTests.value = String(config.execution.evidence.minTests);
    reg.allowSkipped.input.checked = config.execution.evidence.allowSkipped;
    reg.allowedPaths.value = config.changePolicy.allowedPaths.join(', ');
    reg.allowTestChanges.input.checked = config.changePolicy.allowTestChanges;
    reg.maxFiles.value = String(config.changePolicy.maxFiles);
    reg.minApprovals.value = String(config.reviewPolicy.minApprovals);
    reg.requiredStatusContexts.value = config.reviewPolicy.requiredStatusContexts.join(', ');
    syncEvidenceInputs();
  }
  function syncEvidenceInputs() {
    const command = reg.evidenceFormat.value === 'command';
    reg.reportDirs.disabled = command; reg.minTests.disabled = command;
    reg.reportDirs.placeholder = command ? 'Report directories are not read in command mode' : 'target/surefire-reports';
    reg.minTests.placeholder = command ? '0' : '1';
  }
  reg.evidenceFormat.addEventListener('change', syncEvidenceInputs);

  const regForm = el('form', { class: 'form-grid' });
  regForm.append(
    field('Display name', reg.displayName), field('Repository (owner/repository)', reg.fullName),
    field('Baseline branch', reg.defaultBranch), field('Runtime profile', reg.runtimeProfile),
    field('Baseline mode', reg.baselineMode), field('Timeout seconds', reg.timeoutSeconds),
    field('Baseline command', reg.baselineCommand, 'full'), field('Validation command', reg.verificationCommand, 'full'),
    field('Evidence format', reg.evidenceFormat), field('Report directories', reg.reportDirs),
    field('Minimum tests', reg.minTests), field('Max files', reg.maxFiles),
    field('Allowed scope (comma- or newline-separated)', reg.allowedPaths, 'full'),
    (() => { const wrap = el('div', { class: 'check-row' }); wrap.append(reg.allowTestChanges.box, reg.allowSkipped.box); return wrap; })(),
    field('Minimum approvals (0–20)', reg.minApprovals), field('Required status contexts', reg.requiredStatusContexts));
  const regActions = el('div', { class: 'intake-actions' });
  regActions.append(regSubmit, regCancel, regIntentHint);
  regForm.append(regActions);
  regForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    let config;
    try { config = buildRepositoryConfig({
      displayName: read(reg.displayName), fullName: read(reg.fullName), defaultBranch: read(reg.defaultBranch),
      runtimeProfile: reg.runtimeProfile.value, baselineCommand: read(reg.baselineCommand), verificationCommand: read(reg.verificationCommand),
      baselineMode: reg.baselineMode.value, timeoutSeconds: readInt(reg.timeoutSeconds), evidenceFormat: reg.evidenceFormat.value,
      reportDirs: read(reg.reportDirs), minTests: readInt(reg.minTests), allowSkipped: reg.allowSkipped.input.checked,
      allowedPaths: read(reg.allowedPaths), allowTestChanges: reg.allowTestChanges.input.checked, maxFiles: readInt(reg.maxFiles),
      minApprovals: readInt(reg.minApprovals), requiredStatusContexts: read(reg.requiredStatusContexts),
    }); }
    catch (error) { notice(error.message, 'error'); return; }
    const revising = regMode.repository;
    const body = revising ? { expectedRevision: revising.revision, config } : config;
    busy = true; regSubmit.disabled = true;
    try {
      const ledger = ledgerFor(revising ? (() => ledgers.revise(revising.repositoryId)) : 'register');
      const { key } = intentGuard(ledger, regIntentHint, () => ledger.intent(fingerprintOf(body)));
      if (revising) await request(`/repositories/${encodeURIComponent(revising.repositoryId)}/revisions`, { method: 'POST', body, mutation: true, idempotencyKey: key });
      else await request('/repositories', { method: 'POST', body, mutation: true, idempotencyKey: key });
      ledger.succeed();
      notice(revising ? `Repository configuration updated to a new revision (previous revision ${revising.revision}).` : `Repository ${config.fullName} registered successfully.`, 'info');
      fillRegisterForm(null);
      await load(true);
    } catch (error) { notice(error.message, 'error'); }
    finally { busy = false; if (regSubmit.isConnected) regSubmit.disabled = false; }
  });

  // ---- manual task form ----
  const task = {
    repo: el('select', { 'aria-label': 'Repository', id: 'task-repo' }),
    title: textInput({ id: 'task-title', 'aria-label': 'Title' }),
    description: el('textarea', { rows: '3', 'aria-label': 'Description' }),
    acceptance: el('textarea', { rows: '3', 'aria-label': 'Acceptance criteria' }),
    baseBranch: textInput({ 'aria-label': 'Baseline branch', placeholder: 'Leave empty to use the repository default branch' }),
    baseCommit: textInput({ class: 'mono', 'aria-label': 'Baseline commit', placeholder: 'Leave empty to resolve the current HEAD of the selected branch' }),
    allowedPaths: el('textarea', { rows: '2', 'aria-label': 'Allowed scope', placeholder: 'Leave empty to inherit the repository allowed scope' }),
    allowTestChanges: checkbox('Allow test changes within scope (repository must permit test changes)'),
  };
  const policyBox = el('div', { class: 'policy-box' });
  const taskSubmit = el('button', { class: 'primary-button', type: 'submit', text: 'Create task' });
  const taskIntentHint = el('div', { class: 'subtle' });
  const createdBox = el('div', { class: 'created-box' });

  function selectedRepo() { return repositories.find(repo => repo.repositoryId === selectedId) || null; }
  function syncRepoSelect() {
    task.repo.replaceChildren();
    const enabled = repositories.filter(repo => repo.enabled);
    if (!enabled.length) {
      task.repo.append(el('option', { value: '', text: repositories.length ? 'No available repositories (all disabled)' : 'Register a repository first' }));
      task.repo.disabled = true;
    } else {
      task.repo.disabled = false;
      if (!enabled.some(repo => repo.repositoryId === selectedId)) selectedId = enabled[0].repositoryId;
      for (const repo of enabled) task.repo.append(el('option', { value: repo.repositoryId, text: `${repo.config.displayName} · ${repo.config.fullName} · revision ${repo.revision}` }));
      task.repo.value = selectedId;
    }
    const repo = selectedRepo();
    task.allowTestChanges.input.disabled = !repo || repo.config.changePolicy.allowTestChanges !== true;
    if (task.allowTestChanges.input.disabled) task.allowTestChanges.input.checked = false;
  }
  function renderPolicy() {
    const repo = selectedRepo();
    policyBox.replaceChildren();
    if (!repo) { policyBox.append(el('div', { class: 'subtle', text: 'Select a repository to see the policy summary that will be frozen into the task.' })); return; }
    const config = repo.config;
    const taskPaths = splitList(read(task.allowedPaths));
    const paths = taskPaths.length ? taskPaths : config.changePolicy.allowedPaths;
    const allowTests = task.allowTestChanges.input.checked && config.changePolicy.allowTestChanges === true;
    const lines = [
      `Task scope: ${paths.join(', ')} (at most ${config.changePolicy.maxFiles} files)${taskPaths.length ? ' · narrowed from the repository scope' : ' · inherited from the repository scope'}`,
      `Test permission: ${allowTests ? 'test changes allowed within the approved scope' : 'test changes not allowed'}${config.changePolicy.allowTestChanges ? ' (repository permits it; can be narrowed to forbidden here)' : ' (repository does not permit it)'}`,
      `Baseline command: ${config.execution.baselineCommand} (${MODE_LABELS[config.execution.baselineMode] || config.execution.baselineMode})`,
      `Validation command: ${config.execution.verificationCommand} · timeout ${config.execution.timeoutSeconds}s`,
      `Evidence: ${EVIDENCE_LABELS[config.execution.evidence.format] || config.execution.evidence.format}${config.execution.evidence.format === 'junit' ? ` · ${config.execution.evidence.reportDirs.join(', ')} · at least ${config.execution.evidence.minTests} tests${config.execution.evidence.allowSkipped ? ' · skipped allowed' : ''}` : ''}`,
      `Review policy: at least ${config.reviewPolicy.minApprovals} approvals${config.reviewPolicy.requiredStatusContexts.length ? ' · required contexts ' + config.reviewPolicy.requiredStatusContexts.join(', ') : ''} (frozen after task creation; human merge always enforced)`,
    ];
    for (const line of lines) policyBox.append(el('div', { text: line }));
  }
  task.repo.addEventListener('change', () => { selectedId = task.repo.value || null; syncRepoSelect(); renderPolicy(); });
  for (const node of [task.allowedPaths, task.allowTestChanges.input]) node.addEventListener('input', renderPolicy);

  const taskForm = el('form', { class: 'form-grid' });
  taskForm.append(
    field('Repository', task.repo, 'full'), field('Title', task.title, 'full'),
    field('Description', task.description, 'full'), field('Acceptance criteria', task.acceptance, 'full'),
    field('Baseline branch (optional)', task.baseBranch), field('Baseline commit (optional)', task.baseCommit),
    field('Allowed scope (optional, comma- or newline-separated)', task.allowedPaths, 'full'),
    (() => { const wrap = el('div', { class: 'check-row full' }); wrap.append(task.allowTestChanges.box); return wrap; })(),
    (() => { const wrap = el('div', { class: 'form-field full' }); wrap.append(el('label', { text: 'Policy to be frozen into the task (review before creating)' }), policyBox); return wrap; })());
  const taskActions = el('div', { class: 'intake-actions full' });
  taskActions.append(taskSubmit, taskIntentHint, createdBox);
  taskForm.append(taskActions);
  taskForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const repo = selectedRepo();
    let input;
    try { input = buildManualInput({
      title: read(task.title), description: read(task.description), acceptanceCriteria: read(task.acceptance),
      baseBranch: read(task.baseBranch), baseCommit: read(task.baseCommit), allowedPaths: read(task.allowedPaths),
      allowTestChanges: task.allowTestChanges.input.checked,
    }, repo); }
    catch (error) { notice(error.message, 'error'); return; }
    busy = true; taskSubmit.disabled = true;
    try {
      const ledger = ledgerFor('task');
      const { key, reused } = intentGuard(ledger, taskIntentHint, () => ledger.intent(fingerprintOf(input)));
      const work = await request('/tasks/manual', { method: 'POST', body: input, mutation: true, idempotencyKey: key });
      ledger.succeed();
      created = { workItemId: work.workItemId, taskId: work.source?.id, reused };
      renderCreated();
      notice(`Task ${work.source?.id || ''} registered; the workflow will start automatically.`, 'info');
      task.title.value = ''; task.description.value = ''; task.acceptance.value = '';
      renderPolicy();
    } catch (error) { notice(error.message, 'error'); }
    finally { busy = false; if (taskSubmit.isConnected) taskSubmit.disabled = false; }
  });
  function renderCreated() {
    createdBox.replaceChildren();
    if (!created) return;
    createdBox.append(el('div', { class: 'subtle', text: `Created ${created.taskId || ''} (${created.reused ? 'duplicate submission returned the original result' : 'new task'})` }));
    if (created.workItemId) {
      const open = el('button', { class: 'secondary-button', type: 'button', text: 'Open work detail' });
      open.addEventListener('click', () => goWork(created.workItemId));
      createdBox.append(open);
    }
  }

  // ---- page assembly ----
  function mount(container) {
    view.replaceChildren();
    const heading = el('div', { class: 'page-heading' });
    heading.append(
      (() => { const left = el('div'); left.append(el('div', { class: 'eyebrow', text: 'REPOSITORY REGISTRY' }), el('h1', { text: 'Repositories & New Task' }),
        el('p', { text: 'Policies are frozen with the task after registration; duplicate submissions reuse the same intent id until the result is acknowledged, so no duplicate tasks are created.' })); return left; })(),
      (() => { const metaWrap = el('div', { class: 'heading-meta' }); metaWrap.append((() => { const strong = el('strong', { text: '0' }); strong.id = 'repo-count'; return strong; })(), document.createTextNode(' registered repositories')); return metaWrap; })());
    const listSection = el('section', { class: 'panel' });
    listSection.append((() => { const head = el('div', { class: 'panel-head' }); head.append(el('h2', { text: 'Repository list' }), el('small', { text: 'Policy & connection status' })); return head; })(), (() => { const body = el('div', { class: 'panel-body' }); body.append(listBox); return body; })());
    const grid = el('div', { class: 'intake-grid' });
    const taskPanel = el('section', { class: 'panel' });
    taskPanel.id = 'manual-task-panel';
    taskPanel.append((() => { const head = el('div', { class: 'panel-head' }); head.append(el('h2', { text: 'New task' }), el('small', { text: 'Registered as a MANUAL work item' })); return head; })(), (() => { const body = el('div', { class: 'panel-body' }); body.append(taskForm); return body; })());
    const regPanel = el('section', { class: 'panel' });
    regPanel.id = 'repository-panel';
    regPanel.append((() => { const head = el('div', { class: 'panel-head' }); head.append(regTitle, regNote); return head; })(), (() => { const body = el('div', { class: 'panel-body' }); body.append(regForm); return body; })());
    taskBox.append(taskPanel); regBox.append(regPanel);
    grid.append(taskBox, regBox);
    view.append(heading, listSection, el('div', { class: 'section-spacer' }), grid);
    container.replaceChildren(view);
    syncRepoSelect(); renderPolicy(); syncEvidenceInputs(); renderCreated();
  }

  function focus(kind) {
    const needsRepository = kind === 'manual' && !repositories.some(repo => repo.enabled);
    const target = needsRepository ? view.querySelector('#repository-panel')
      : kind === 'manual' ? view.querySelector('#manual-task-panel')
      : kind === 'repository' ? view.querySelector('#repository-panel') : null;
    if (!target) return;
    if (needsRepository) notice('Register and enable a repository before creating a MANUAL task.', 'info');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')?.focus({ preventScroll: true });
  }

  async function load(force = false) {
    if (busy && !force) return;
    const seq = ++loadSeq;
    let data;
    try { data = await request('/repositories'); }
    catch (error) { if (seq === loadSeq) notice(error.message, 'error'); return; }
    if (seq !== loadSeq) return;
    repositories = Array.isArray(data?.repositories) ? data.repositories : [];
    const count = view.querySelector('#repo-count');
    if (count) count.textContent = String(repositories.length);
    renderList();
    syncRepoSelect();
    renderPolicy();
  }

  return { mount, load, focus };
}
