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
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(`${label}不能为空且不能超过 ${limit} 字`);
  return value;
}
function requireInt(value, lower, upper, label) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(number) || number < lower || number > upper) fail(`${label}必须是 ${lower}..${upper} 的整数`);
  return number;
}
function requireBranch(value, label) {
  const branch = requireText(String(value ?? ''), 200, label);
  if (['-', '/', '.'].some(prefix => branch.startsWith(prefix)) || ['/', '.', '.lock'].some(suffix => branch.endsWith(suffix)) || branch.includes('..') || branch.includes('@{')
      || /[\s~^:?*[\\]/.test(branch) || branch === '@' || branch.includes('//')
      || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) fail(`${label}不是安全的 Git 分支名`);
  return branch;
}
function requireRelativePath(value) {
  const path = requireText(value, 500, '路径');
  if (path.startsWith('/') || path.includes('\\') || /[\s*?[\]{}:]/.test(path) || path.replace(/\/+$/, '').split('/').some(part => ['', '.', '..', '.git', '.cache'].includes(part))) fail(`路径不安全或受保护：${path}`);
  return path;
}
function splitList(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
}
function splitPaths(value) {
  const paths = splitList(value).map(requireRelativePath);
  if (paths.length < 1 || paths.length > 100) fail('允许范围需要 1..100 个路径');
  return paths;
}
function requireFullName(value) {
  const name = requireText(String(value ?? ''), 219, '仓库地址');
  if (!FULL_NAME.test(name) || name.endsWith('.git') || name.split('/').some(part => ['.', '..'].includes(part))) fail('fullName 必须是 owner/repository 形式');
  return name;
}

export function buildRepositoryConfig(values = {}) {
  const displayName = requireText(String(values.displayName ?? ''), 200, '显示名称');
  const fullName = requireFullName(values.fullName);
  const defaultBranch = requireBranch(values.defaultBranch || 'main', '基线分支');
  if (!RUNTIME_PROFILES.includes(values.runtimeProfile)) fail(`未知的运行时模板 (runtimeProfile)：${String(values.runtimeProfile)}`);
  if (!BASELINE_MODES.includes(values.baselineMode)) fail(`不支持的基线模式 (baselineMode)：${String(values.baselineMode)}`);
  const baselineCommand = requireText(String(values.baselineCommand ?? ''), 8192, '基线命令');
  const verificationCommand = requireText(String(values.verificationCommand ?? ''), 8192, '验收命令');
  const timeoutSeconds = requireInt(values.timeoutSeconds, 1, 3600, '超时秒数');
  const allowSkipped = values.allowSkipped === true;
  let evidence;
  if (values.evidenceFormat === 'command') {
    evidence = { format: 'command', reportDirs: [], minTests: 0, allowSkipped };
  } else if (values.evidenceFormat === 'junit') {
    evidence = { format: 'junit', reportDirs: splitPaths(values.reportDirs), minTests: requireInt(values.minTests, 1, 1000000, '最少测试数'), allowSkipped };
  } else {
    fail(`未知的证据格式 (format)：${String(values.evidenceFormat)}`);
  }
  const contexts = splitList(values.requiredStatusContexts);
  if (contexts.length > 20) fail('必需状态上下文最多 20 条');
  for (const context of contexts) requireText(context, 200, '状态上下文');
  return {
    displayName, connectionId: CONNECTION_ID, fullName, defaultBranch, runtimeProfile: values.runtimeProfile,
    execution: { baselineCommand, verificationCommand, baselineMode: values.baselineMode, timeoutSeconds, evidence },
    changePolicy: { allowedPaths: splitPaths(values.allowedPaths), allowTestChanges: values.allowTestChanges === true, maxFiles: requireInt(values.maxFiles ?? 100, 1, 10000, '最大文件数') },
    reviewPolicy: { minApprovals: requireInt(values.minApprovals ?? 0, 0, 20, '最少批准数'), requiredStatusContexts: contexts },
  };
}

export function buildManualInput(values = {}, repository) {
  if (!repository || typeof repository !== 'object' || typeof repository.repositoryId !== 'string') fail('请先选择一个已登记的仓库');
  const input = {
    repositoryId: repository.repositoryId,
    repositoryRevision: requireInt(repository.revision, 1, Number.MAX_SAFE_INTEGER, '仓库版本'),
    title: requireText(String(values.title ?? ''), 300, '标题'),
    description: requireText(String(values.description ?? ''), 16000, '描述'),
    acceptanceCriteria: requireText(String(values.acceptanceCriteria ?? ''), 16000, '验收标准'),
  };
  if (String(values.baseBranch ?? '').trim()) input.baseBranch = requireBranch(String(values.baseBranch).trim(), '基线分支');
  if (String(values.baseCommit ?? '').trim()) {
    const sha = String(values.baseCommit).trim();
    if (!SHA.test(sha)) fail('baseCommit 必须是 40 位小写 SHA；留空则自动解析所选分支当前 HEAD');
    input.baseCommit = sha;
  }
  if (String(values.allowedPaths ?? '').trim()) input.allowedPaths = splitPaths(values.allowedPaths);
  if (values.allowTestChanges === true) {
    if (repository.config?.changePolicy?.allowTestChanges !== true) fail('该仓库未开放测试修改许可，任务范围不能扩大权限');
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
    ? '提交意向存储已损坏，无法确认原提交标识。请先核对原结果；只有显式放弃当前意向后才能重新提交。'
    : '提交意向存储不可用，无法可靠保存或读取原提交标识。为避免重复创建，请恢复存储后重试。');
  error.code = corrupt ? 'INTENT_CORRUPT' : 'INTENT_STORAGE';
  return error;
}

export class IntentLedger {
  constructor(scope, storage) {
    if (typeof scope !== 'string' || !scope) fail('Intent scope is required');
    if (!storage || ['getItem', 'setItem', 'removeItem'].some(method => typeof storage[method] !== 'function')) throw intentStorageError();
    this.itemKey = 'argon-intent:' + scope;
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
      const error = new Error('表单内容已变化，而上一次提交的确认尚未收到。请先核对原任务结果，或显式“放弃当前意向”后再修改重试。');
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
  if (!junit || typeof junit !== 'object') return format === 'junit' ? '未产出 JUnit 报告' : null;
  if (Array.isArray(junit.invalidReports) && junit.invalidReports.length) return `JUnit 报告无效（${junit.invalidReports.length} 份）`;
  if (!Array.isArray(junit.reports) || !junit.reports.length) return '未产出 JUnit 报告';
  if (!Array.isArray(junit.invalidReports) || ['tests', 'failures', 'errors'].some(key => !Number.isInteger(junit[key]) || junit[key] < 0)) return 'JUnit 报告无效';
  return `JUnit：${junit.tests} 项 · ${junit.failures} 失败 · ${junit.errors} 错误`;
}
const RISK_LABELS = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险', high: '高风险', medium: '中风险', low: '低风险' };
export function sourceFacts(sourceRecord = {}, taskSpec = null) {
  if (!taskSpec || typeof taskSpec !== 'object') {
    const risk = sourceRecord?.risk;
    return { managed: false, riskLabel: risk ? (RISK_LABELS[risk] || String(risk)) : null, singleFile: !!sourceRecord?.sourcePath,
      scopeLabel: sourceRecord?.sourcePath || null, evidenceLabel: null };
  }
  const evidence = taskSpec.execution?.evidence || {};
  return { managed: true, riskLabel: null, singleFile: false,
    scopeLabel: (sourceRecord?.sourcePaths || []).join('、') || null,
    evidenceLabel: evidence.format === 'command' ? '命令退出码' : `JUnit · 至少 ${evidence.minTests ?? 1} 项` };
}

// ---- DOM page ----
const MODE_LABELS = { record: '记录基线结果', 'must-pass': '基线必须成功', 'must-fail': '基线必须失败' };
const EVIDENCE_LABELS = { junit: 'JUnit 报告', command: '命令退出码' };

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
        const abandon = el('button', { class: 'text-button', type: 'button', text: '放弃当前意向' });
        abandon.addEventListener('click', () => {
          try { ledger.reset(); hint.replaceChildren(); notice('已放弃未确认的提交意向，可以修改后重新提交。', 'info'); }
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
      el('span', { class: 'task-title', text: repo.config?.displayName || repo.config?.fullName || '未命名仓库' }),
      el('span', { class: `status-pill ${repo.enabled ? 'enabled' : ''}`, text: repo.enabled ? `启用中 · 版本 ${repo.revision}` : `已停用 · 版本 ${repo.revision}` }));
    const meta = el('div', { class: 'task-meta' });
    meta.append(el('span', {}, '仓库：'), el('b', { class: 'mono', text: repo.config?.fullName || '—' }),
      el('span', { class: 'dotsep', text: '•' }), el('span', {}, '基线分支：'), el('b', { text: repo.config?.defaultBranch || '—' }),
      el('span', { class: 'dotsep', text: '•' }), el('span', {}, '运行时：'), el('b', { text: repo.config?.runtimeProfile || '—' }));
    content.append(row, meta);
    const policy = repo.config ? policySummary(repo.config) : null;
    if (policy) content.append(el('p', { class: 'task-description', text: policy }));
    const check = checkResults.get(repo.repositoryId);
    if (check && check.revision === repo.revision && check.configFingerprint === fingerprintOf(repo.config)) content.append(el('p', { class: check.ok ? 'subtle' : 'task-description', text: check.message }));
    const side = el('div', { class: 'task-side' });
    const actions = el('div', { class: 'intake-actions' });
    const checkButton = el('button', { class: 'secondary-button', type: 'button', text: '连接检查' });
    checkButton.addEventListener('click', async () => {
      checkButton.disabled = true; checkButton.textContent = '检查中…';
      try {
        const result = await request(`/repositories/${encodeURIComponent(repo.repositoryId)}/check`, { method: 'POST', body: {}, mutation: true });
        checkResults.set(repo.repositoryId, { revision: repo.revision, configFingerprint: fingerprintOf(repo.config), ok: true, message: `连接正常：${result.fullName} · 默认分支 ${result.defaultBranch} · 推送权限${result.pushPermission ? '已确认' : '缺失'}` });
      } catch (error) {
        checkResults.set(repo.repositoryId, { revision: repo.revision, configFingerprint: fingerprintOf(repo.config), ok: false, message: `连接检查失败：${error.message}` });
      }
      renderList();
    });
    const toggle = el('button', { class: repo.enabled ? 'danger-button' : 'secondary-button', type: 'button', text: repo.enabled ? '停用' : '启用' });
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      const body = { expectedRevision: repo.revision, enabled: !repo.enabled };
      try {
        const ledger = ledgerFor(() => ledgers.revise(repo.repositoryId));
        const { key } = intentGuard(ledger, regIntentHint, () => ledger.intent(fingerprintOf(body)));
        await request(`/repositories/${encodeURIComponent(repo.repositoryId)}/revisions`, { method: 'POST', body, mutation: true, idempotencyKey: key });
        ledger.succeed();
        notice(body.enabled ? '仓库已启用，可以登记新任务。' : '仓库已停用；只阻止登记新任务，进行中的工作不受影响。', 'info');
        await load(true);
      } catch (error) { notice(error.message, 'error'); toggle.disabled = false; }
    });
    const edit = el('button', { class: 'secondary-button', type: 'button', text: '更新配置' });
    edit.addEventListener('click', () => fillRegisterForm(repo));
    actions.append(checkButton, toggle, edit);
    if (repo.enabled) {
      const use = el('button', { class: 'primary-button', type: 'button', text: '新建任务' });
      use.addEventListener('click', () => { selectedId = repo.repositoryId; syncRepoSelect(); renderPolicy(); view.querySelector('#task-title')?.focus(); });
      actions.append(use);
    }
    side.append(actions);
    card.append(content, side);
    return card;
  }
  function policySummary(config) {
    const parts = [
      `允许范围 ${config.changePolicy.allowedPaths.join('、')}（最多 ${config.changePolicy.maxFiles} 个文件${config.changePolicy.allowTestChanges ? '，允许修改测试' : '，不允许修改测试'}）`,
      `基线 ${config.execution.baselineCommand}（${MODE_LABELS[config.execution.baselineMode] || config.execution.baselineMode}）`,
      `验收 ${config.execution.verificationCommand}（${config.execution.timeoutSeconds}s · ${EVIDENCE_LABELS[config.execution.evidence.format] || config.execution.evidence.format}${config.execution.evidence.format === 'junit' ? ` · ${config.execution.evidence.reportDirs.join('、')} · 至少 ${config.execution.evidence.minTests} 项` : ''}）`,
      `评审 至少 ${config.reviewPolicy.minApprovals} 票批准${config.reviewPolicy.requiredStatusContexts.length ? ' · 必需上下文 ' + config.reviewPolicy.requiredStatusContexts.join('、') : ''}`,
    ];
    return parts.join('；');
  }
  function renderList() {
    listBox.replaceChildren();
    if (!repositories.length) {
      listBox.append(el('div', { class: 'empty-state', text: '尚未登记任何仓库。请先在下方表单登记仓库并确认连接。' }));
      return;
    }
    for (const repo of repositories) listBox.append(repoCard(repo));
  }

  // ---- register / revise form ----
  const reg = {
    displayName: textInput({ 'aria-label': '显示名称' }), fullName: textInput({ 'aria-label': '仓库地址', placeholder: 'owner/repository' }),
    defaultBranch: textInput({ 'aria-label': '基线分支', value: 'main' }),
    runtimeProfile: el('select', { 'aria-label': '运行时模板' }),
    baselineMode: el('select', { 'aria-label': '基线模式' }), timeoutSeconds: numberInput({ 'aria-label': '超时秒数', value: '300' }),
    baselineCommand: textInput({ 'aria-label': '基线命令' }), verificationCommand: textInput({ 'aria-label': '验收命令' }),
    evidenceFormat: el('select', { 'aria-label': '证据格式' }), reportDirs: textInput({ 'aria-label': '报告目录', placeholder: 'target/surefire-reports' }),
    minTests: numberInput({ 'aria-label': '最少测试数', value: '1', min: '1' }),
    allowSkipped: checkbox('允许跳过用例'), allowedPaths: el('textarea', { rows: '2', 'aria-label': '允许范围', placeholder: 'src/' }),
    allowTestChanges: checkbox('允许按范围修改测试'), maxFiles: numberInput({ 'aria-label': '最大文件数', value: '100' }),
    minApprovals: numberInput({ 'aria-label': '最少批准数', value: '0', min: '0', max: '20' }),
    requiredStatusContexts: textInput({ 'aria-label': '必需状态上下文', placeholder: '留空表示无必需上下文' }),
  };
  for (const profile of RUNTIME_PROFILES) reg.runtimeProfile.append(el('option', { value: profile, text: profile }));
  for (const mode of BASELINE_MODES) reg.baselineMode.append(el('option', { value: mode, text: `${mode}（${MODE_LABELS[mode]}）` }));
  for (const format of EVIDENCE_FORMATS) reg.evidenceFormat.append(el('option', { value: format, text: EVIDENCE_LABELS[format] }));
  reg.runtimeProfile.value = RUNTIME_PROFILES[0];
  reg.baselineMode.value = BASELINE_MODES[0];
  reg.evidenceFormat.value = EVIDENCE_FORMATS[0];
  const regMode = { repository: null };
  const regTitle = el('h2', { text: '登记仓库' });
  const regNote = el('small', { text: '连接固定为 local-gitea；命令与策略在登记时冻结进任务。' });
  const regSubmit = el('button', { class: 'primary-button', type: 'submit', text: '登记仓库' });
  const regCancel = el('button', { class: 'text-button', type: 'button', text: '取消更新' });
  regCancel.hidden = true;
  regCancel.addEventListener('click', () => { fillRegisterForm(null); notice('已退出更新模式。', 'info'); });
  const regIntentHint = el('div', { class: 'subtle', id: 'reg-intent-hint' });

  function fillRegisterForm(repo) {
    regMode.repository = repo;
    if (!repo) {
      regTitle.textContent = '登记仓库';
      regNote.textContent = '连接固定为 local-gitea；命令与策略在登记时冻结进任务。';
      regSubmit.textContent = '登记仓库';
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
    regTitle.textContent = `更新配置 · ${config.fullName} · 版本 ${repo.revision}`;
    regNote.textContent = '提交后生成新仓库版本；进行中的任务仍使用其冻结的版本。';
    regSubmit.textContent = `提交为新版本（基于版本 ${repo.revision}）`;
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
    reg.reportDirs.placeholder = command ? '命令模式不读取报告目录' : 'target/surefire-reports';
    reg.minTests.placeholder = command ? '0' : '1';
  }
  reg.evidenceFormat.addEventListener('change', syncEvidenceInputs);

  const regForm = el('form', { class: 'form-grid' });
  regForm.append(
    field('显示名称', reg.displayName), field('仓库地址（owner/repository）', reg.fullName),
    field('基线分支', reg.defaultBranch), field('运行时模板', reg.runtimeProfile),
    field('基线模式', reg.baselineMode), field('超时秒数', reg.timeoutSeconds),
    field('基线命令', reg.baselineCommand, 'full'), field('验收命令', reg.verificationCommand, 'full'),
    field('证据格式', reg.evidenceFormat), field('报告目录', reg.reportDirs),
    field('最少测试数', reg.minTests), field('最大文件数', reg.maxFiles),
    field('允许范围（逗号或换行分隔）', reg.allowedPaths, 'full'),
    (() => { const wrap = el('div', { class: 'check-row' }); wrap.append(reg.allowTestChanges.box, reg.allowSkipped.box); return wrap; })(),
    field('最少批准数（0–20）', reg.minApprovals), field('必需状态上下文', reg.requiredStatusContexts));
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
      notice(revising ? `仓库配置已更新为新版本（原版本 ${revising.revision}）。` : `仓库 ${config.fullName} 登记成功。`, 'info');
      fillRegisterForm(null);
      await load(true);
    } catch (error) { notice(error.message, 'error'); }
    finally { busy = false; if (regSubmit.isConnected) regSubmit.disabled = false; }
  });

  // ---- manual task form ----
  const task = {
    repo: el('select', { 'aria-label': '仓库', id: 'task-repo' }),
    title: textInput({ id: 'task-title', 'aria-label': '标题' }),
    description: el('textarea', { rows: '3', 'aria-label': '描述' }),
    acceptance: el('textarea', { rows: '3', 'aria-label': '验收标准' }),
    baseBranch: textInput({ 'aria-label': '基线分支', placeholder: '留空使用仓库默认分支' }),
    baseCommit: textInput({ class: 'mono', 'aria-label': '基线提交', placeholder: '留空自动解析所选分支当前 HEAD' }),
    allowedPaths: el('textarea', { rows: '2', 'aria-label': '允许范围', placeholder: '留空继承仓库允许范围' }),
    allowTestChanges: checkbox('允许按范围修改测试（需仓库开放测试许可）'),
  };
  const policyBox = el('div', { class: 'policy-box' });
  const taskSubmit = el('button', { class: 'primary-button', type: 'submit', text: '创建任务' });
  const taskIntentHint = el('div', { class: 'subtle' });
  const createdBox = el('div', { class: 'created-box' });

  function selectedRepo() { return repositories.find(repo => repo.repositoryId === selectedId) || null; }
  function syncRepoSelect() {
    task.repo.replaceChildren();
    const enabled = repositories.filter(repo => repo.enabled);
    if (!enabled.length) {
      task.repo.append(el('option', { value: '', text: repositories.length ? '没有可用仓库（均已停用）' : '请先登记仓库' }));
      task.repo.disabled = true;
    } else {
      task.repo.disabled = false;
      if (!enabled.some(repo => repo.repositoryId === selectedId)) selectedId = enabled[0].repositoryId;
      for (const repo of enabled) task.repo.append(el('option', { value: repo.repositoryId, text: `${repo.config.displayName} · ${repo.config.fullName} · 版本 ${repo.revision}` }));
      task.repo.value = selectedId;
    }
    const repo = selectedRepo();
    task.allowTestChanges.input.disabled = !repo || repo.config.changePolicy.allowTestChanges !== true;
    if (task.allowTestChanges.input.disabled) task.allowTestChanges.input.checked = false;
  }
  function renderPolicy() {
    const repo = selectedRepo();
    policyBox.replaceChildren();
    if (!repo) { policyBox.append(el('div', { class: 'subtle', text: '选择仓库后，这里会显示将冻结进任务的策略摘要。' })); return; }
    const config = repo.config;
    const taskPaths = splitList(read(task.allowedPaths));
    const paths = taskPaths.length ? taskPaths : config.changePolicy.allowedPaths;
    const allowTests = task.allowTestChanges.input.checked && config.changePolicy.allowTestChanges === true;
    const lines = [
      `任务范围：${paths.join('、')}（最多 ${config.changePolicy.maxFiles} 个文件）${taskPaths.length ? ' · 已收窄自仓库范围' : ' · 继承仓库范围'}`,
      `测试许可：${allowTests ? '允许按获批范围修改测试' : '不允许修改测试'}${config.changePolicy.allowTestChanges ? '（仓库已开放，可在此收窄为禁止）' : '（仓库未开放）'}`,
      `基线命令：${config.execution.baselineCommand}（${MODE_LABELS[config.execution.baselineMode] || config.execution.baselineMode}）`,
      `验收命令：${config.execution.verificationCommand} · 超时 ${config.execution.timeoutSeconds}s`,
      `证据：${EVIDENCE_LABELS[config.execution.evidence.format] || config.execution.evidence.format}${config.execution.evidence.format === 'junit' ? ` · ${config.execution.evidence.reportDirs.join('、')} · 至少 ${config.execution.evidence.minTests} 项${config.execution.evidence.allowSkipped ? ' · 允许跳过' : ''}` : ''}`,
      `评审策略：至少 ${config.reviewPolicy.minApprovals} 票批准${config.reviewPolicy.requiredStatusContexts.length ? ' · 必需上下文 ' + config.reviewPolicy.requiredStatusContexts.join('、') : ''}（任务创建后冻结，人工合并始终强制）`,
    ];
    for (const line of lines) policyBox.append(el('div', { text: line }));
  }
  task.repo.addEventListener('change', () => { selectedId = task.repo.value || null; syncRepoSelect(); renderPolicy(); });
  for (const node of [task.allowedPaths, task.allowTestChanges.input]) node.addEventListener('input', renderPolicy);

  const taskForm = el('form', { class: 'form-grid' });
  taskForm.append(
    field('仓库', task.repo, 'full'), field('标题', task.title, 'full'),
    field('描述', task.description, 'full'), field('验收标准', task.acceptance, 'full'),
    field('基线分支（可选）', task.baseBranch), field('基线提交（可选）', task.baseCommit),
    field('允许范围（可选，逗号或换行分隔）', task.allowedPaths, 'full'),
    (() => { const wrap = el('div', { class: 'check-row full' }); wrap.append(task.allowTestChanges.box); return wrap; })(),
    (() => { const wrap = el('div', { class: 'form-field full' }); wrap.append(el('label', { text: '将冻结进任务的策略（创建前请审阅）' }), policyBox); return wrap; })());
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
      notice(`任务 ${work.source?.id || ''} 已登记，工作流将自动开始。`, 'info');
      task.title.value = ''; task.description.value = ''; task.acceptance.value = '';
      renderPolicy();
    } catch (error) { notice(error.message, 'error'); }
    finally { busy = false; if (taskSubmit.isConnected) taskSubmit.disabled = false; }
  });
  function renderCreated() {
    createdBox.replaceChildren();
    if (!created) return;
    createdBox.append(el('div', { class: 'subtle', text: `已创建 ${created.taskId || ''}（${created.reused ? '重复提交已按原结果返回' : '新任务'}）` }));
    if (created.workItemId) {
      const open = el('button', { class: 'secondary-button', type: 'button', text: '打开工作详情' });
      open.addEventListener('click', () => goWork(created.workItemId));
      createdBox.append(open);
    }
  }

  // ---- page assembly ----
  function mount(container) {
    view.replaceChildren();
    const heading = el('div', { class: 'page-heading' });
    heading.append(
      (() => { const left = el('div'); left.append(el('div', { class: 'eyebrow', text: 'REPOSITORY REGISTRY' }), el('h1', { text: '仓库与新建任务' }),
        el('p', { text: '登记仓库后策略随任务冻结；重复提交在确认结果前复用同一意向标识，不会生成重复任务。' })); return left; })(),
      (() => { const metaWrap = el('div', { class: 'heading-meta' }); metaWrap.append((() => { const strong = el('strong', { text: '0' }); strong.id = 'repo-count'; return strong; })(), document.createTextNode('个已登记仓库')); return metaWrap; })());
    const listSection = el('section', { class: 'panel' });
    listSection.append((() => { const head = el('div', { class: 'panel-head' }); head.append(el('h2', { text: '仓库列表' }), el('small', { text: '策略与连接状态' })); return head; })(), (() => { const body = el('div', { class: 'panel-body' }); body.append(listBox); return body; })());
    const grid = el('div', { class: 'intake-grid' });
    const taskPanel = el('section', { class: 'panel' });
    taskPanel.append((() => { const head = el('div', { class: 'panel-head' }); head.append(el('h2', { text: '新建任务' }), el('small', { text: '登记为 MANUAL 工作项' })); return head; })(), (() => { const body = el('div', { class: 'panel-body' }); body.append(taskForm); return body; })());
    const regPanel = el('section', { class: 'panel' });
    regPanel.append((() => { const head = el('div', { class: 'panel-head' }); head.append(regTitle, regNote); return head; })(), (() => { const body = el('div', { class: 'panel-body' }); body.append(regForm); return body; })());
    taskBox.append(taskPanel); regBox.append(regPanel);
    grid.append(taskBox, regBox);
    view.append(heading, listSection, el('div', { class: 'section-spacer' }), grid);
    container.replaceChildren(view);
    syncRepoSelect(); renderPolicy(); syncEvidenceInputs(); renderCreated();
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

  return { mount, load };
}
