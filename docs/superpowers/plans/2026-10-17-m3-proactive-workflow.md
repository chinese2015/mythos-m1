# M3 主动漏洞工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 新 High/Critical 已映射漏洞自动研判、通知 Owner，Owner 在任务中心批准接管后才进入既有修复流水线。

**Architecture:** 新增 M2 `source_intakes` 持久化登记簿（唯一新表）+ 新 Cordis 插件 `argon-subscribe`（轮询 Mock→研判→先落 intake→再写 Mock triageResult/发邮件）+ Mock overlay `notify-owner` 端点 + 任务启用门从"硬编码 FND-00009"改为"intake APPROVED"。批准后复用既有全链路。

**Tech Stack:** Python (M2/SQLite)、Node ESM (DSH 插件)、Java/Spring (Mock overlay)、node:test / unittest。

**Spec:** `docs/superpowers/specs/2026-10-17-m3-proactive-workflow-design.md`

## Global Constraints

- 任何 Mock 外部写之前 intake 已落库；外部写失败记 `lastError` 不阻塞状态机。
- 批准前 Mock `status` 保持 `Not Started`（零状态翻转）；批准前仅允许写 `triageResult` 与通知邮件。
- `enabled` 不得再依赖硬编码 finding id；映射表（source.mjs `mappings`）仍是资产边界。
- Owner 决定幂等防丢：M2 侧 `expectedRevision` + Idempotency-Key（scope `intake-decide`）。
- 测试命令：`cd m1 && node --test tests/*.test.mjs`、`python3 -m unittest discover -s tests -p 'test_*.py'`、Mock overlay `mvn test`（在 backend 目录）。全部不得变红。
- UI 文案中文；console POST 走既有 bodyOf 门禁（X-Argon-Action/Idempotency-Key）。

## Review Focus

1. 轮询重复发现同一 Finding（多轮/重启后）——intake upsert 幂等性。
2. Finding `revision` 在通知后变化（人工 PATCH）——决定不被 Revision 变化冲掉。
3. Mock 写 `triageResult` 成功但邮件失败（或反之）——半提交状态的可见性与重试。
4. operator 点"批准接管"两次/刷新重放——decide 幂等。
5. FND-00009（已有 work item 无 intake）——任务卡不得退化（grandfathered 可启动）。

---

### Task 1: M2 source_intakes 表 + API

**Files:**
- Modify: `brain/store.py`（建表 + 三个方法）、`brain/api.py`（三条路由）
- Test: `tests/test_brain_intakes.py`（新，Python）

**Interfaces:**
- Consumes: 既有 `connection()`/`_retry()`/`_remember()`/`identifier()`/`now()`；api.py 既有 auth/body/路由分发。
- Produces:
  - `Store.record_intake(owner, finding_id, revision, triage: dict) -> dict`——upsert（`INSERT ... ON CONFLICT(finding_id) DO UPDATE` 或等价）；**已 APPROVED/REJECTED 的 intake 在 revision 变化时保留 `state`/`decision`**，仅更新 `revision`/`triage`/`updatedAt`；新 intake 按 `triage['result']` 置 `AWAITING_OWNER` 或 `NEEDS_REVIEW`。
  - `Store.intakes(owner) -> list[dict]`（按 finding_id 排序）。
  - `Store.decide_intake(owner, finding_id, decision: str, expected_revision, key) -> dict`——幂等（idempotency scope `intake-decide`）；仅 `AWAITING_OWNER` 可决定（否则 409）；写 `state=APPROVED|REJECTED`、`decision={by: owner, at: now(), key}`。
  - 路由：`GET /api/brain/source-intakes` → `{intakes}`；`PUT /api/brain/source-intakes/{findingId}`（body `{revision, triage}`，findingId 需 `^FND-[0-9]{5}$`）；`POST /api/brain/source-intakes/{findingId}/decide`（body `{expectedRevision, decision}`，需 Idempotency-Key）。

- [x] **Step 1: 写失败测试**（`tests/test_brain_intakes.py`，参照 `tests/test_brain_api.py` 的临时目录 Store/服务器 fixture）——覆盖 Review Focus #1/#2/#4：登记幂等（同 finding 两次 → 一条）、修订变化保留 APPROVED、decide 幂等重放同结果、非 AWAITING_OWNER decide 409、路由 401（无 bearer）/400（非法 findingId/decision）。
- [x] **Step 2: 跑测试确认失败**（ImportError/AttributeError）。Expected: FAIL。
- [x] **Step 3: 实现** store.py + api.py（schema 加 `CREATE TABLE IF NOT EXISTS source_intakes (finding_id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, triage TEXT NOT NULL, notified_at TEXT, last_error TEXT, decision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`；schema_version 保持 1，增量表）。
- [x] **Step 4: 跑测试确认通过**；`python3 -m unittest discover -s tests -p 'test_*.py'` 全绿。
- [x] **Step 5: Commit** `feat: durable source intake registry with owner decision gate`。

---

### Task 2: argon-subscribe 插件（轮询 + 研判 + 编排）

**Files:**
- Create: `plugins/argon-subscribe/triage.mjs`（纯函数）、`plugins/argon-subscribe/service.mjs`、`plugins/argon-subscribe/index.mjs`（Cordis 入口）
- Modify: `configure_presets.py`（注册插件 + config：owner/pollIntervalMs=30000/sourceUrl='http://127.0.0.1:8080'）
- Test: `tests/subscribe-triage.test.mjs`、`tests/subscribe-service.test.mjs`（新）

**Interfaces:**
- Consumes: Task 1 的 M2 API（经 `plugins/argon-brain/client.mjs` 的 M2Client，构造仿 TaskWorkflow）；`plugins/argon-workflow/source.mjs` 的 `mappings`（import 复用资产边界）与 `FindingSource.request` 模式（订阅器自建 mockClient，同 8s 超时/2MB 上限/redirect:error）。
- Produces:
  - `export function triageFinding(row, mapping) -> {result: 'CONFIRMED'|'NEEDS_REVIEW', reasons: string[]}`——CONFIRMED 需：`repositoryUrl/baseCommit/sourcePath` 与 mapping 逐字一致、`risk ∈ {HIGH, CRITICAL}`、`status === 'Not Started'`、`closed !== 'Closed'`、无 `workItemId`；否则 NEEDS_REVIEW + 人类可读理由（中文）。
  - `export class SubscribeController`：`constructor(config, {client /* M2 */, mock /* finding source */, report})`；`async syncOnce()`——mock 全量列表 → 过滤映射内候选 → 对每个候选：已有 work item（`GET /api/brain/work-items/{...}` 不行——work item 按 finding 关联走 `GET /api/brain/work-items` 列表按 `source.id` 匹配，已有则 PUT intake `{revision, triage:{result:'CONFIRMED', reasons:['existing-work-item']}}` 且 state 直接 APPROVED grandfathered）→ 否则 triageFinding → `PUT intake` → 成功后外部写：`PATCH /api/findings/{id} {triageResult}` → result==='CONFIRMED' 时 `POST /api/findings/{id}/notify-owner` → 成功后回写 intake `notifiedAt`（PUT 带 `{notified: true}` 或专用字段，implementer 定，保持幂等）。任一步失败：`report` + intake `lastError`（PUT 带 triage 理由外字段），下轮重试。全部 Finding 处理完返回摘要 `{seen, registered, notified, errors}`。
  - Cordis Service：`inject ['argonBrain']` 不需要——直接 `new M2Client`；`ctx.effect` setInterval(`syncOnce`, pollIntervalMs)，dispose clearInterval；`apply(ctx, config)`。
- [x] **Step 1: 失败测试**——triageFinding 各分支（Review Focus #5 映射漂移→NEEDS_REVIEW）；syncOnce fixture：假 mock（列表含 FND-00015 可候选 + FND-00009 已有 work item）+ 假 client 记录请求序列——断言 **PUT intake 先于 PATCH triageResult 先于 notify-owner**（红线）、grandfathered 路径、外部写失败时 lastError 落库且状态保持。
- [x] **Step 2: 确认失败。** Step 3: 实现三文件 + configure_presets.py 注册（仿 argon-workflow 条目格式）。
- [x] **Step 4: 测试通过 + `node --test tests/*.test.mjs` 全绿。**
- [x] **Step 5: Commit** `feat: argon-subscribe plugin with triage-first intake orchestration`。

---

### Task 3: Mock notify-owner overlay 端点

**Files:**
- Modify: `integrations/mock-source/AiCompletionController.java`（同文件加端点，保持 overlay 单文件可 apply）或新 `NotifyOwnerController.java` + `apply.sh` 白名单更新
- Test: `integrations/mock-source/tests/` 补 notify-owner 集成测试
- 远程构建：`~/argon-mock-cas-build-release` 流水线（Task 5 部署时做）

**Interfaces:**
- Consumes: Mock 既有 `MailDelivery`（`deliver(to, subject, body)`，preview 落 `data/outbox/*.eml`）、`OWNERS`/`FindingRepository`。
- Produces: `POST /api/findings/{id}/notify-owner`——仅 loopback（非 127.0.0.1/::1 → 403）；finding 不存在 404；收件人 `{ownerId}@argon.demo`；主题 `[Argon] 批准请求：{id} {name}`；正文含 risk/category/ownerTeamsId/研判结论（从 `triageResult` 读）/控制台链接；返回 `{delivered: true, to}`。
- [x] **Step 1: 失败测试**（Java：loopback 403、404、outbox .eml 生成且含 finding id）。Step 2: 确认失败。Step 3: 实现。
- [x] **Step 4: `cd argon-security-platform/backend && mvn -q test`（对本机；若无 mvn 则远程构建机跑，记录事实）通过。**
- [x] **Step 5: Commit** `feat: notify-owner endpoint in mock overlay`。

---

### Task 4: 任务启用门 + console 审批 UI

**Files:**
- Modify: `plugins/argon-workflow/source.mjs`（删 FND-00009 硬编码门）、`plugins/argon-workflow/controller.mjs`（tasks() 合并 intakes、start() 加 intake 门）
- Modify: `plugins/argon-console/index.mjs`（POST `/api/tasks/{id}/decide` → `subscribe.decide`）、`plugins/argon-console/public/app.js`（卡状态/Owner 建议/批准拒绝按钮/nav-count）
- Modify: `plugins/argon-console/index.mjs` inject 加 `argonSubscribe`
- Test: `tests/task-controller.test.mjs`、`tests/subscribe-service.test.mjs` 补用例

**Interfaces:**
- Consumes: Task 1 M2 API（decide）、Task 2 controller（SubscribeController.decide(id, decision, key) 薄封装：PUT 无需，POST decide + 记 intake）。
- Produces:
  - `source.mjs:14`：`enabled: exact`（删 `&& row.id === 'FND-00009'`）。
  - `controller.tasks()`：每个 task 附加 `intake`（从 `client.request('GET','/api/brain/source-intakes')` 按 id 匹配；无则 null）；task 增加 `startable` 字段：有 workItemId 或 intake?.state==='APPROVED' 或无 intake 时 enabled（兼容性，见 Review Focus #5：无 intake 且 enabled 的老任务仍可启动，FND-00009 走 grandfathered intake 也可）。
  - `controller.start()`：无 work item 且 intake 存在且非 APPROVED → 409 '请等待 Owner 在任务中心批准接管'。
  - console 卡：`startable` false 时——AWAITING_OWNER → pill '待 Owner 批准' + Owner 建议行（task.ownerId/ownerTeamsId，ownerTeamsId 需 tasks() 透传 finding 字段）+ 按钮 '批准接管'/'拒绝'；NEEDS_REVIEW → pill '需人工复核' + triage 理由；REJECTED → '已拒绝接管'。decide 按钮 → POST `/argon/api/tasks/{id}/decide {decision:'APPROVE'|'REJECT'}`（mutation:true）。
  - `nav-count` 显示 `tasks.filter(t=>t.intake?.state==='AWAITING_OWNER').length`，0 时回退 enabled 计数。
- [x] **Step 1: 失败测试**——start() intake 门 409；tasks() startable/intake 合并；console decide 路由 202/401/409。Step 2: 失败。Step 3: 实现。Step 4: 全绿。Step 5: Commit `feat: owner approval gate in task intake with console decision UI`。

---

### Task 5: 集成回归 + 部署 + 真实验收

- [x] **Step 1: 三套件全绿**（node + python + overlay mvn）。
- [x] **Step 2: 部署**——tar 同步 m1；重启 M2 api+worker（brain 代码变更）+ DSH（插件变更）+ Mock（新 jar：overlay apply → mvn package → 备份旧 jar → 换 jar → 重启，流水线仿既有 build-release）。
- [x] **Step 3: 订阅验收**——≤60s 内 FND-00003 与 FND-00015 出现在 intakes（AWAITING_OWNER，triage CONFIRMED）；Mock 侧 `triageResult=CONFIRMED`；`~/argon-backend/data/outbox/` 出现两封 owner 邮件（含 finding id 与链接）；console 任务卡显示 '待 Owner 批准' + Owner 建议；FND-00009 卡不退化。
- [x] **Step 4: 审批验收**——console 批准 FND-00015 → 卡变 '开始处理' → 点击启动 → 既有链路跑通到基线复现与只读方案（模型真实执行）；批准后 FND-00003 保持 '待 Owner 批准'（门生效证明）。
- [x] **Step 5: 全链验收（时间盒）**——FND-00015 走完 plan 审批 → 编码 → 独立验证 → 发布 PR（复用 publish 链路），PR 保持开放；证据写 `~/argon-m1/state/m3-acceptance.json`。若模型会话异常，如实记录停在哪个阶段。
- [x] **Step 6: ledger**——progress.md 记 M3 条目 + 限制；交接文档更新；Commit docs。

## Self-Review 结论

- Spec 覆盖：intakes（§1）→ Task 1；订阅/研判/通知编排（§2）→ Task 2；notify-owner（§3）→ Task 3；门控/合并/UI（§4/§5）→ Task 4；验收（§数据流）→ Task 5。红线逐条有对应测试。无缺口。
- Review Focus #1/#2/#4 → Task 1 测试；#3 → Task 2 测试；#5 → Task 4 测试。

## 执行交接（2026-10-17）

Task 1–4 已实现、审查修复并部署。Task 5 已完成回归、通知与批准门禁、真实基线、浏览器点击和记录；Step 4 的只读方案及 Step 5 的模型修复/独立验证/Pixel PR 因 Kimi 403 周额度耗尽未完成。未重放模型请求，任务保留 BLOCKED，恢复步骤见 `docs/m3-proactive-workflow.md`。

## 额度恢复后最终交接（2026-10-17）

Task 5 的 Step 4/5 已完成：Pixel 由真实模型生成方案、审批后编码并提交 b4b64a6；新 B clean verify 2/2；补充仓库外边界探针 8/8；工作台发布 PR #2 开放待审。独立 Gitea 对账和 DSH 重启均确认单一交付、2 Sessions/3 operations；Orion 保持未批准。新增发现的会话初始化时序缺陷已 TDD 修复并在浏览器复测 CODE 绑定正确。详见 `docs/m3-proactive-workflow.md`，此前额度阻塞记录作为历史保留。
