# Run Monitor 最小完整链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任务工作台工作详情页交付「运行监控」区块：Work Item 阶段、Agent 活动、操作状态/退出码/JUnit、M2 事件流、活动操作的实时日志尾随；关网页重开可无损恢复观察。

**Architecture:** 纯轮询，不引入推送。console 新增一条只读代理路由 `GET /argon/api/work-items/{id}/events?after=N` 转发到 M2 既有游标接口；前端仿 `delivery-view.js` 新增 `monitor-view.js`（渲染）+ `monitor-state.js`（纯函数，可单测），游标状态存模块级 Map（按 workItemId），重开网页 = after=0 全量拉取，天然恢复。

**Tech Stack:** 原生 ES modules（无构建、无新依赖）、node:test、M2 后端既有 API（无改动）。

**Spec:** `docs/superpowers/specs/2026-10-17-run-monitor-design.md`

## Global Constraints

- 状态文案只来自 M2 `operation.state` / `workflow.phase` 原文映射；CANCEL_REQUESTED 显示"取消已请求，等待进程终止"，绝不提前显示 CANCELLED；FAILED 必带 exitCode/reason；UNKNOWN 注明"执行器失联，未自动重放"。
- M2 代理失败时显示可见错误条并标注快照时间，不填充假状态。
- 浏览器 CSP：`script-src 'self'`——新 JS 必须经 assets Map 注册的同源文件，无内联脚本。
- 不改动 M2 后端（brain/）、不动 DSH 核心、不新增 npm 依赖。
- 测试命令：`cd m1 && node --test tests/*.test.mjs`；全量回归外加 `python3 -m unittest discover -s tests -p 'test_*.py'`（不得变红）。
- UI 文案中文，风格仿现有 panel（`panelHead`/`operation`/`log-box`）。

## Review Focus

1. `CANCEL_REQUESTED` 输入被提前显示成"已取消"（验收红线）→ Task 2 displayState 测试。
2. `events?after=` 返回与本地已有事件 sequence 重叠/乱序（游标重放）→ Task 2 mergeEvents 测试。
3. 代理 5xx/断连期间轮询继续（用户看到旧数据但不知道多旧）→ Task 2 staleNote 测试 + Task 3 错误条渲染。
4. `after` 为负数/非整数/超大值（注入与分页越界）→ Task 1 HTTP 400 测试。
5. 事件流里 `execution.output` 高频事件刷屏掩盖状态事件 → Task 2 formatEvent 对 output 折叠为计数。

---

### Task 1: events 只读代理路由（workflow.events + console GET 路由）

**Files:**
- Modify: `plugins/argon-workflow/controller.mjs`（`logs()` 之后，约 :138）
- Modify: `plugins/argon-console/index.mjs`（GET 分支 :34-42、assets Map :4）
- Test: `tests/task-controller.test.mjs`

**Interfaces:**
- Consumes: `TaskWorkflow.snapshot(id)` 返回 `{workItem}`（既有）；`this.client.request('GET', path)`（既有 M2Client）；console 既有 GET 分支模式（index.mjs:37-41）。
- Produces:
  - `TaskWorkflow.prototype.events(id: string, after: number) -> Promise<{events: Array, nextCursor: number}>` —— 先 `await this.snapshot(id)`（确存在性 + 记忆状态），再 `this.client.request('GET', route(workItem.workItemId) + '/events?after=' + after + '&limit=200')`，原样返回 M2 响应。
  - `GET /argon/api/work-items/{id}/events?after=N` → 200 透传 `workflow.events(id, after)`；`after` 缺省 0，非安全整数或 <0 → 400 `无效事件游标`（与日志路由同句式）。只读：不要求 `X-Argon-Action`/`Idempotency-Key`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/task-controller.test.mjs`）

```js
test('console proxies work-item events with cursor validation and auth fencing', async () => {
  let seen = null;
  const server = createServer(consoleHandler({ connection: { requestRejection: ({ headers }) => headers.cookie === 'session=valid' ? undefined : 401 },
    workflow: { events: async (id, after) => { seen = { id, after }; return { events: [{ sequence: 7, type: 'execution.started' }], nextCursor: 7 }; } } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(url + '/argon/api/work-items/work-x/events')).status, 401);
    assert.equal((await fetch(url + '/argon/api/work-items/work-x/events?after=-1', { headers: { cookie: 'session=valid' } })).status, 400);
    assert.equal((await fetch(url + '/argon/api/work-items/work-x/events?after=1.5', { headers: { cookie: 'session=valid' } })).status, 400);
    const ok = await fetch(url + '/argon/api/work-items/work-x/events?after=5', { headers: { cookie: 'session=valid' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { events: [{ sequence: 7, type: 'execution.started' }], nextCursor: 7 });
    assert.deepEqual(seen, { id: 'work-x', after: 5 });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd m1 && node --test tests/task-controller.test.mjs`
Expected: FAIL（`workflow.events is not a function` 或路由 404）

- [ ] **Step 3: 实现 `events()`（controller.mjs）+ GET 路由（index.mjs）**

controller.mjs 在 `logs()` 后加 3 行方法（签名见 Interfaces）。index.mjs GET 分支在 logs 路由后加 events 分支（模式逐行仿 index.mjs:38-41）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd m1 && node --test tests/task-controller.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tests/task-controller.test.mjs plugins/argon-workflow/controller.mjs plugins/argon-console/index.mjs
git commit -m "feat: proxy cursor-paginated work-item events to the console"
```

---

### Task 2: `monitor-state.js` 纯函数模块（TDD）

**Files:**
- Create: `plugins/argon-console/public/monitor-state.js`
- Test: `tests/monitor-state.test.mjs`（新）

**Interfaces:**
- Consumes: M2 事件对象 `{sequence, type, occurredAt, correlation?: {operationId?}, payload?}`；operation 状态枚举（`QUEUED/STARTING/RUNNING/CANCEL_REQUESTED/SUCCEEDED/FAILED/CANCELLED/UNKNOWN`）。
- Produces（全部 `export`，无 DOM 依赖，node 直接 import）：
  - `mergeEvents(existing: Array, page: {events?: Array, nextCursor?: number}) -> {events: Array, cursor: number}` —— 按 `sequence` 去重（Map by sequence）、升序排序；`cursor` 取 `page.nextCursor`（安全整数时），否则取合并后最后一个 sequence，再否则 0。
  - `displayState(state: string) -> {label: string, cls: string}` —— 精确映射：`SUCCEEDED`→已完成/succeeded；`COMPLETED`→已完成/succeeded；`FAILED`→失败/failed；`RUNNING`→运行中/running；`QUEUED`→排队中；`STARTING`→启动中；`CANCEL_REQUESTED`→**取消已请求，等待进程终止**/cancel-pending；`CANCELLED`→已取消/cancelled；`UNKNOWN`→**状态未知 · 执行器失联，未自动重放**/unknown；其他→原文/unknown。空值按 UNKNOWN。
  - `formatJUnit(j: object|null|undefined) -> string|null` —— 有 `tests` 字段时 `JUnit：T 项 · F 失败 · E 错误`，否则 null。
  - `formatEvent(event: object, operationLabel: (opId: string) => string) -> string|null` —— 时间（occurredAt 转 zh-CN locale）+ 摘要；`execution.output` 返回 null（由调用方折叠计数）；`execution.succeeded/failed/cancelled` 带 payload.exitCode/reason；`execution.cancel_requested`→"已请求取消"；`workspace.preparation_started/ready/failed`、work_item 系列映射中文摘要；未知 type 返回原文 type。
  - `staleNote(lastErrorAt: number|null, now?: number) -> string|null` —— null→null；否则 `连接中断，显示的是 N 秒前的快照`。

- [ ] **Step 1: 写失败测试**（`tests/monitor-state.test.mjs`，直接 `import { ... } from '../plugins/argon-console/public/monitor-state.js'`）

覆盖断言（每个 Review Focus 至少一条）：
- `mergeEvents`：重叠 sequence 去重、乱序归并、空页（`{events: []}`）cursor 保持上一页 nextCursor、nextCursor 缺失时取末位 sequence。
- `displayState('CANCEL_REQUESTED')` label 含"等待进程终止"且 cls 为 `cancel-pending`；`displayState('CANCELLED')` 是"已取消"；两者不相等。`UNKNOWN` label 含"未自动重放"。未识别状态原样返回。
- `formatJUnit({tests: 2, failures: 1, errors: 0})` === `'JUnit：2 项 · 1 失败 · 0 错误'`；`formatJUnit(null)` === null。
- `formatEvent({type: 'execution.output', sequence: 3})` === null；`formatEvent({type: 'execution.failed', occurredAt: '2026-10-17T08:00:00Z', payload: {exitCode: 23, reason: 'boom'}, correlation: {operationId: 'exec-a'}})` 含 `exitCode 23` 与 `boom` 且含操作标签。
- `staleNote(null)` === null；`staleNote(Date.now() - 9000)` 含"9 秒前"。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd m1 && node --test tests/monitor-state.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `plugins/argon-console/public/monitor-state.js`**

签名与映射表见 Interfaces；纯函数、无 DOM/Node API（`Date` 可用），中文文案按 Global Constraints。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd m1 && node --test tests/monitor-state.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tests/monitor-state.test.mjs plugins/argon-console/public/monitor-state.js
git commit -m "feat: pure run-monitor state helpers with cancel-requested semantics"
```

---

### Task 3: `monitor-view.js` 视图 + 集成（app.js / index.mjs / styles.css）

**Files:**
- Create: `plugins/argon-console/public/monitor-view.js`
- Modify: `plugins/argon-console/public/app.js:1`（import）、`buildDetail`（col1 操作记录面板后插入一行调用，约 :183）
- Modify: `plugins/argon-console/index.mjs:4`（assets Map 加 `/monitor-view.js`、`/monitor-state.js`）
- Modify: `plugins/argon-console/public/styles.css`（追加 `.event-stream` 等少量样式）

**Interfaces:**
- Consumes: Task 1 的 `GET /work-items/{id}/events?after=` 路由；Task 2 全部纯函数；app.js 的 `el`/`panelHead`/`request`/`showNotice`（经 ctx 注入，同 `renderDelivery` 模式，app.js:167）；app.js 的 `normalizeOperation`（在 buildDetail 内先归一化再传入）。
- Produces:
  - `export function renderMonitor(ctx)`，`ctx = { workItemId, workflow, operations /* 已归一化 */, session, el, panelHead, request, phaseText }`，返回 `section.panel` 元素（`data-panel="monitor"`），由 `buildDetail` append 到 col1。
  - 模块级 `const state = new Map()`：按 workItemId 存 `{eventCursor, events: [], logCursors: Map<opId, number>, logText: Map<opId, string>, expanded: Set<opId>, outputCount: Map<opId, number>, lastErrorAt, fetching}`——跨 1800ms 重渲染存活；整页重开则重新 `after=0` 全量拉取（恢复观察的根基）。

行为规格（实现要点）：
- 面板头「运行监控」/ 副标「Work Item 阶段 · Agent 活动 · 执行事实」。
- 第一行：阶段（`phaseText(workflow.phase)`）+ Agent 活动（`session.activity || '—'`）+ 暂停标记（workItem.paused）。
- 操作时间线：每个 operation 一行——`opLabel`（app.js:105 传入或等价映射）、`displayState(op.status)` pill、退出码、JUnit（`formatJUnit`）、开始/结束时间；ACTIVE 状态（QUEUED/STARTING/RUNNING/CANCEL_REQUESTED）右侧给"取消此操作"按钮（复用 `POST /operations/{id}/cancel`，body `{expectedVersion: op.version}`，mutation:true，confirm 提示，成功后不乐观翻转、等下一轮快照）。
- 实时日志尾随：ACTIVE 操作默认展开日志盒（`log-box`），`expanded` 记录用户手动开关；每次 `renderMonitor` 被调且不在 fetch 中时，对展开操作并发 `GET /operations/{id}/logs?after=logCursor`，结果按 `text` 追加进 `logText`（截断保留末尾 200 行）、`logCursors` 推进 `nextCursor`，然后直接写当前 DOM 盒（patch 前的下次渲染也从 state 重建，两者一致）。操作转终态后再拉一次收尾。
- M2 事件流：面板底部 `.event-stream`（max-height 16em、overflow auto）盒；`renderMonitor` 时若不在 fetch 中则 `GET /work-items/{id}/events?after=eventCursor`，`mergeEvents` 归并，`eventCursor` 推进；`formatEvent` 为 null 的 `execution.output` 折叠为"…本操作已输出 N 行日志"；其余追加渲染（最多保留 200 条）。请求失败：`lastErrorAt = Date.now()`，盒顶渲染 `staleNote` 错误条，保留旧事件。
- 任何情况下不从 exitCode/日志/事件缺席推断成功；所有状态经 `displayState`。

- [ ] **Step 1: 集成接线（无独立前端测试约定，验证靠 Task 4 实机验收 + Task 2 纯函数测试）**

按 Interfaces 实现三个新/改文件；app.js 的 buildDetail 在 `activity` 面板 append 后加：

```js
col1.append(renderMonitor({ workItemId: currentWorkId, workflow, operations, session, el, panelHead, request, phaseText: p => phaseLabels[phaseIndex(p)] ?? p }));
```

（import 加在 app.js:1 同行模式；`operations` 变量 buildDetail :169 已有。）

- [ ] **Step 2: 语法与加载自检**

Run: `cd m1 && node --check plugins/argon-console/public/monitor-view.js && node --check plugins/argon-console/public/monitor-state.js && node --check plugins/argon-console/public/app.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: 全量回归**

Run: `cd m1 && node --test tests/*.test.mjs && python3 -m unittest discover -s tests -p 'test_*.py' 2>&1 | tail -3`
Expected: Node 全 pass（62 个，含 Task 1/2 新增）；Python `OK`

- [ ] **Step 4: 提交**

```bash
git add plugins/argon-console/public/monitor-view.js plugins/argon-console/public/monitor-state.js plugins/argon-console/public/app.js plugins/argon-console/public/styles.css plugins/argon-console/index.mjs
git commit -m "feat: run monitor panel with cursor-recovered event stream and live log tail"
```

---

### Task 4: 远程部署与真实验收

**Files:**
- 远程：`~/argon-m1/`（tar 同步）、DSH 重启
- 证据：`~/argon-m1/state/run-monitor-acceptance.json`

**Interfaces:**
- Consumes: Task 1-3 部署产物；既有 `/tmp/argon-sshpw.sh` 风格的 ssh 通道（由执行者自行建立）；M2 API `POST /api/brain/work-items/{id}/operations`（既有，owner token 在远程 `~/.argon-brain/tokens.json`）。
- Produces: `state/run-monitor-acceptance.json`（0600），ledger 条目。

- [ ] **Step 1: 同步 + 重启 DSH + 烟测**

tar 同步跟踪文件到远程（先备份既有同名文件），仅重启 DSH（`python3 restart-dsh.py`，M2 后端无改动）；`curl` 确认 `GET /argon/api/work-items/work-e0c22f1188d6495781d2c33659937fa5/events?after=0`（带 DSH cookie）返回 200 且含 `nextCursor`。

- [ ] **Step 2: 起一条长命令操作并观察（关网页重开恢复）**

经 M2 API 在 Nova 工作项绑定沙箱创建 `sleep 90` 命令 operation（body `{command, timeoutSeconds: 180}`，注意 owner 限额）；浏览器打开工作详情「运行监控」→ 确认操作显示"运行中"、日志/事件在增长 → **关闭标签页** → 重开同一 URL → 确认阶段/操作/日志/事件从游标完整恢复、无重复无假状态。

- [ ] **Step 3: 取消语义**

对该 operation 点"取消此操作"→ 立即显示"取消已请求，等待进程终止"（不是"已取消"）→ 进程终止后显示"已取消"且带真实退出码。

- [ ] **Step 4: worker 重启对账**

operation 运行中（再起一条 `sleep 60`）SIGTERM M2 worker 并重新拉起 → 监控对账：操作不重复执行，状态从事件流恢复，不跳变不假成功。

- [ ] **Step 5: 失败不假成功**

运行 `exit 23` 命令 operation → 面板显示"失败 · 退出码 23"，任何位置不得显示成功；JUnit 无时不显示 JUnit 行。

- [ ] **Step 6: 写证据与 ledger**

`state/run-monitor-acceptance.json`（0600）记录各步结果与时间戳；`docs/progress.md` 追加 2026-10-17 Run Monitor 条目（含限制：多任务大盘/通知/推送不做）；同步回本地。

- [ ] **Step 7: 提交**

```bash
git add docs/progress.md docs/superpowers/specs/2026-10-17-run-monitor-design.md docs/superpowers/plans/2026-10-17-run-monitor.md
git commit -m "docs: record run monitor acceptance evidence and ledger"
```

## Self-Review 结论

- Spec 覆盖：代理路由（§组件 1）→ Task 1；纯函数与真实性红线（§组件 4、§红线）→ Task 2；视图与恢复（§组件 3）→ Task 3；真实验收（§验收）→ Task 4。安全边界（§安全）由 Task 1 的 401/400 用例 + 既有 requestRejection 覆盖。无缺口。
- Review Focus 5 项已分别落到 Task 1（#4）与 Task 2（#1/#2/#3/#5）的测试断言。
- 接口一致：`workflow.events`、代理路径、`mergeEvents/displayState/formatJUnit/formatEvent/staleNote`、`renderMonitor(ctx)` 在各 Task 间签名一致。
