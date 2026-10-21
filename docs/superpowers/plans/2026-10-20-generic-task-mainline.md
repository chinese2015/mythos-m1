# 通用任务能力并入主 DSH 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主 DSH 增加仓库登记、手工任务、通用验证和更完整的只读代码工作台，完成安全的远端主实例部署，同时保留既有 Finding 推送与计划编辑行为。

**Architecture:** 选择性把 generic 任务能力接入主 Brain、Work Item、工作流和 Console，不整体合并分叉。以 owner-scoped Repository revision 冻结 TaskSpec，保留 MYTHOS 与 MANUAL 两种任务语义；通过主 Gitea origin 派发精确仓库凭据。远端只迁移代码和 profile，不迁移 generic 任务数据库、审批、Session 或沙箱。

**Tech Stack:** Python 3 / SQLite / Docker runner、Node ESM / DSH `0.2.0-rc.2` 插件 API、现有 Gitea HTTP API 与私有 credential helper、Bash/SSH 部署。

**Spec:** `docs/superpowers/specs/2026-10-20-generic-task-mainline-design.md`

## Global Constraints

- 主 DSH/Brain 使用 loopback `13080/13081`，Gitea 使用 loopback HTTP `http://127.0.0.1:13000`，Mock 为 `18081`；generic `13093/13083` 不改。
- 现有 Finding source push、免 DSH 登录例外、自动接管和来源 UI 行为保持不变。
- 保留现有 `MYTHOS` 类型、source intake、来源幂等、planHash、方案编辑和模型修订路径；新增 `MANUAL` 类型不能伪装成 Finding。
- 新 TaskSpec 的审批绑定 `planHash` 与 `specDigest`。旧 generic Work Item、审批、TaskSpec、Session、沙箱、PR 和数据库不迁移。
- 仓库/TaskSpec API 只使用现有 owner bearer、Brain API、owner-scoped 幂等及 revision CAS；Git 凭据不进入 URL、TaskSpec、浏览器或日志。
- 保留 Java/JUnit 与 command 证据语义、baseline 模式、双层改动范围、独立 B、create-only push、人工合并与合并树门禁。
- 复用已安装 DSH 的 `dsh-client-ui-primitives`；不升级 DSH、不联网安装 npm/pip/Maven 依赖。
- 修改只触及整合所需的文件；保留 `m1/` 当前工作区中其他用户未提交改动和 generic 原分支工作区内容。
- 不改 generic 服务/数据、Mock、Gitea 容器、外部端口转发或 PR；不在远端创建测试 Work Item、模型任务、沙箱或 PR。

## Review Focus

- 已有 MYTHOS Work Item 与 MANUAL Work Item 同时列出时，detail、session、phase、delivery 是否始终按 source type 分流。
- 同一 repo revision 正在创建 TaskSpec 时并发停用或改 revision，服务端是否 fail closed。
- 用户仓库名/分支/路径/报告目录带有 URL userinfo、路径逃逸、`.git` 或构建配置混淆时是否在网络/凭据访问前拒绝。
- Worker/DSH 重启或 Gitea push/PR 响应丢失后，是否只按相同冻结 TaskSpec 和幂等键对账，不创建新分支或重放非幂等写入。
- 原有 plan 修改或模型修订与 MANUAL TaskSpec digest 同时存在时，审批和 CODE Session 是否仍对应最新 plan 与同一个 TaskSpec。

---

### Task 1: TaskSpec 与仓库策略合约

**Files:**
- Create: `brain/task_spec.py`
- Create: `plugins/mythos-workflow/task-spec.mjs`

**Interfaces:**
- Produces Python `normalize_repository(config) -> dict`, `validate_manual_input(value) -> dict`, `make_task_spec(owner, repository, input, base_commit) -> dict`, `validate_task_spec(spec, owner=None) -> dict`, `change_allowed(spec, paths) -> bool`, `verification_passes(spec, operation, evidence=None) -> bool`.
- Produces JS `isManagedWork(work) -> boolean`, `candidateAllowed(work, git) -> boolean`, `baselineReady(work, operation) -> boolean`, `verifiedTaskCandidate(work, operation, git) -> boolean` with the same TaskSpec field names and digest canonicalization.
- Consumes: existing Python owner/errors conventions and current JS `plugins/mythos-workflow/rules.mjs`.

- [ ] Map every TaskSpec field against the generic implementation and existing main-line `MYTHOS` contracts; retain one canonical schema.
- [ ] Implement strict normalization for owner/repo, branch, paths, evidence format, baseline mode, runtime profile, review policy, and nested change ceiling.
- [ ] Bind the actual resolved base SHA and calculate SHA256 over canonical UTF-8 JSON excluding only `specDigest`.
- [ ] Make Python and JavaScript validations agree on accepted values and fail-closed policy expansion.
- [ ] Review the resulting interface against `docs/superpowers/specs/2026-10-20-generic-task-mainline-design.md` before consuming it from storage or workflow.

### Task 2: Owner-scoped repository registry and manual admission API

**Files:**
- Create: `brain/repository_store.py`
- Create: `brain/repositories.py`
- Create: `brain/git_host.py`
- Create: `brain/git_credentials.py`
- Modify: `brain/store.py`
- Modify: `brain/api.py`
- Modify: `brain/__main__.py`
- Modify: `brain/executor.py` for exact TaskSpec repository authorization only.

**Interfaces:**
- `RepositoryStore.register_repository(owner, config, key)`, `repositories(owner)`, `repository(owner, id)`, `revise_repository(owner, id, body, key)`, `create_manual_task(owner, input, spec, key)`.
- `RepositoryService.register(owner, body, key)`, `revise(owner, id, body, key)`, `check(owner, id)`, `create_task(owner, input, key)`.
- Authenticated routes: `GET/POST /api/brain/repositories`, `POST /api/brain/repositories/{id}/revisions`, `POST /api/brain/repositories/{id}/check`, `POST /api/brain/tasks/manual`.
- Task creation returns an owner-bound Work Item with `source.type=MANUAL`, `TASK-<12 hex>` source id, and immutable `taskSpec`; it allocates no sandbox or session during admission.

- [ ] Add the repositories SQLite table with an additive `CREATE TABLE IF NOT EXISTS` migration; do not rewrite current Work Item rows or schema data.
- [ ] Add owner-scoped register/revise/check/admission transactions with idempotency replay and expectedRevision CAS.
- [ ] Resolve repository permissions and branch HEAD through the loopback Gitea API at port 13000 before freezing TaskSpec; reject stale user-supplied SHA.
- [ ] Implement a private exact-repository credential helper. No password in origin, command arguments, browser response, SQLite, or Git remote config.
- [ ] Wire API routes behind the existing bearer authentication and verify request body field allowlists and bounds.
- [ ] Thread the Store into DockerExecutor so existing frozen MANUAL TaskSpecs can authorize their exact repository after registry revision/disable, while legacy MYTHOS remains on its existing fixed allowlist.
- [ ] Inspect route/auth flow to confirm the `/source-findings` route and Mock push caller are untouched.

### Task 3: Generic execution, workspace scope, and verification evidence

**Files:**
- Modify: `brain/container_runner.py`
- Modify: `brain/executor.py`
- Modify: `brain/workspace.py`
- Modify: `sandbox.py`
- Modify: `brain/worker.py`
- Modify: `brain/store.py` only for operation validation against frozen MANUAL TaskSpec.

**Interfaces:**
- Runner consumes `operation.spec` fields `reportDirs`, `workspace`, `sourceCommit`, `command`, and `timeoutSeconds`; emits real exit code, JUnit summaries, source cleanliness, runtime identity, and cleanup evidence.
- Workspace reads the MANUAL TaskSpec via `frozen_task_spec(store, op)`; returns `git.diffHash`, branch, HEAD, exact changed file names, testsChanged, and bounded Diff.
- Task-aware validation accepts either a verified MANUAL snapshot repository or the existing MYTHOS allowlist; it never queries the latest repository config to reinterpret a frozen task.

- [ ] Add safe configured JUnit report directory collection and cleanup, keeping the current Surefire default for MYTHOS operations.
- [ ] Resolve a MANUAL TaskSpec before container creation, clone its frozen repository/branch with exact helper context, and checkout the specified full base SHA.
- [ ] Pass the frozen profile, command, timeout, report directories and source commit to the isolated runner; preserve no-network and independent B guarantees.
- [ ] Apply two-layer allowed path/maxFiles/test/build configuration checks before approval, after CODE, and before publishing.
- [ ] Implement `record`, `must-pass`, and `must-fail` baseline gating and both JUnit and command evidence; never synthesize test counts or advance on UNKNOWN/environment errors.
- [ ] Make VERIFY satisfy the frozen command, timeout ceiling, report mode/minimums, exact candidate SHA, fresh sandbox, clean state, and cleanup checks.
- [ ] Produce SHA256 of complete raw git Diff for ETag input while keeping rendered Diff bounded.
- [ ] Keep current MYTHOS command/evidence gates unchanged.

### Task 4: Manual workflow, native Session bridge, and PR delivery

**Files:**
- Modify: `plugins/mythos-workflow/controller.mjs`
- Modify: `plugins/mythos-workflow/session-policy.mjs`
- Modify: `plugins/mythos-brain/bridge.mjs`
- Modify: `plugins/mythos-sdlc/policy.mjs`
- Modify: `plugins/mythos-sdlc/controller.mjs`
- Modify: `plugins/mythos-sdlc/gitea.mjs`
- Modify: `brain/publication.py`

**Interfaces:**
- Workflow uses Task 1’s `isManagedWork`, `baselineReady`, `candidateAllowed`, `verifiedTaskCandidate` and Task 2’s `TaskIntake` wrapper/API.
- PLAN approval contains both `planHash` and `specDigest`; CODE tool execution is allowed only in the owner-bound approved CODE Session.
- `deliveryIdentity(work)` derives repository, branches, candidate and verification id from the validated frozen TaskSpec for MANUAL; existing MYTHOS identity remains unchanged.
- `pullBody(work, delivery, operation)` reports actual frozen command, evidence format/count and change scope.

- [ ] Extend snapshot/list/tasks/detail/workspace so MANUAL and MYTHOS Work Items coexist without entering the other type’s source triage/completion logic.
- [ ] Start MANUAL workflow through the same PLAN → approval → CODE → fresh B pipeline, submitting only TaskSpec commands/timeout and binding approvals to unchanged `specDigest` across plan edits/revisions.
- [ ] Authorize Session bridge file/execution calls for MANUAL only against owner, sandbox, approved spec digest, and CODE role; preserve MYTHOS and legacy Session behavior.
- [ ] Implement TaskSpec-based candidate verification, arbitrary registered repo routing only after authorization, scoped create-only Git push, and durable PR reconciliation.
- [ ] Generate MANUAL PR details from actual operation evidence and frozen TaskSpec, never send source completion to Mock, and enforce review/CI/human-merge/tree gates.
- [ ] Reconcile remote facts using canonical stable JSON; keep the existing MYTHOS source response and source completion flow untouched.

### Task 5: Console route, repository intake UI, and task list integration

**Files:**
- Create: `plugins/mythos-workflow/intake.mjs`
- Create: `plugins/mythos-console/public/intake-view.js`
- Modify: `plugins/mythos-console/index.mjs`
- Modify: `plugins/mythos-console/public/app.js`
- Modify: `plugins/mythos-console/public/index.html`
- Modify: `plugins/mythos-console/public/styles.css`
- Modify: `plugins/mythos-console/client.js` only if existing client-session bridge needs MANUAL support.

**Interfaces:**
- `TaskIntake` owner-scoped wrapper calls the four authenticated Brain API route groups from Task 2.
- `renderIntake({ el, panelHead, request, notice, goWork })` mounts in a separate `#/intake` route; source task list remains the default `#/tasks` route.
- Console work-item detail uses Task 4’s TaskSpec/source data and existing plan/delivery renderers.

- [ ] Mount a dedicated repositories/new task navigation route alongside Task Center without replacing pushed Finding cards or the plan editor.
- [ ] Add fields for repository connection/full name/default branch/runtime profile, commands/evidence mode/report dirs, repo scope/test/build policy, review policy, and task title/description/acceptance criteria.
- [ ] Display revision and connection-check state; invalidate a previous check when revision changes.
- [ ] Persist one idempotency intent per business input and scope; same-input lost ACK reuses its key, changed input requires explicit abandon, and unreadable/corrupt storage fails closed.
- [ ] Include MANUAL records in tasks and details without fabricating risk, source path, Finding, triage status, or Owner notification.
- [ ] Render real baseline/verification command or JUnit facts, changed scope, and delivery gates through existing panels.
- [ ] Preserve existing plan text editing, Markdown rendering, saved plan revisions, model discussion and approval handlers exactly.

### Task 6: Read-only coding workbench and generic operational improvements

**Files:**
- Modify: `plugins/mythos-vibe/client.js`
- Modify: `plugins/mythos-vibe/service.mjs`
- Modify: `plugins/mythos-vibe/shared/bridge-browser.mjs`
- Modify: `plugins/mythos-vibe/package.json`
- Modify: `plugins/mythos-console/public/app.js` for explicit known-failure recovery only.
- Modify: `plugins/mythos-console/public/monitor-state.js` only as required by the generic event rendering.

**Interfaces:**
- Client uses DSH-provided `useCodeHighlighter`, `languageForPath`, and `createRoot` APIs from `dsh-client-ui-primitives`.
- `referenceFromOffsets({ path, offset, version, source, start, end })` generates an exact reference for the native DSH draft bridge.
- Diff ETag incorporates work version, HEAD, branch, status, changed paths and `diffHash`.

- [ ] Bring over grouped file navigation, narrow layout, line gutter, syntax highlight, changed markers and accurate source selection offsets.
- [ ] Add guarded sequence ids and disposal cleanup so work-item switches/unmounts reject late file, Diff, Run Monitor and quote events.
- [ ] Add safe MANUAL detail/session binding to the read-only workbench without a new Session or write-file endpoint.
- [ ] Include the DSH primitives injection in the plugin manifest without adding or upgrading packages.
- [ ] Strengthen ETag input using Brain’s full Diff fingerprint, with same-version uncommitted changes producing a new representation.
- [ ] Add the generic known FAILED/CANCELLED recovery affordance only when no UNKNOWN/active op exists and the workflow itself is not BLOCKED; it must require explicit operator confirmation and reuse `/resume` without replay.

### Task 7: Main-instance deployment and rollback tooling

**Files:**
- Create: `deploy-main.py`.
- Modify: `../docs/Mythos_使用说明.md`, `../docs/Mythos_代码梳理与现状.md`, and `docs/progress.md` with the actual deployment result and limits.

**Interfaces:**
- Deployment manifest explicitly lists files for `~/mythos-m1`; it never copies `state/`, `artifacts/`, `.git`, tokens, generic data, node_modules, sandbox roots or DSH Session state.
- Remote preflight reads current process roots, port listeners, profile, data paths and target file hashes; backup result is required before write/restart.
- Deployment result includes backup identifiers, changed file hashes, API/Worker/DSH restart status and rollback command/location; no secret or login URL is printed.

- [ ] Create `deploy-main.py` with a path allowlisted transfer/backup procedure for main Brain code and DSH plugins/assets; do not reuse the legacy partial `remote-apply.sh` or stale `configure_presets.py` output.
- [ ] Read and preserve the existing remote main DSH profile. Change an owned profile entry only if runtime inspection proves a new plugin entry is missing; never regenerate the profile wholesale.
- [ ] Back up main code and profile, and take a consistent owner-only SQLite backup of main Brain data/logs before migration.
- [ ] Preserve the main DSH Home, API tokens, Work Items, Sessions and sandboxes; never access or write generic service/database paths.
- [ ] Restart main Brain API/Worker for Python changes and main DSH for plugin changes, leaving Gitea, Mock, socat and generic services untouched.
- [ ] Roll back code/profile/processes if the expected service startup/readiness conditions fail; leave the additive `repositories` table if code rollback makes it unused.
- [ ] Perform low-risk read-only deployment checks only: main health, authentication behavior, task list/detail availability, new Console assets/routes, and unchanged push route behavior. Do not create remote tasks/PRs/sandboxes.
- [ ] Record exact deployed source commit plus uncommitted-file manifest, backup location, service results and remaining limitations in docs.

## Interface preflight

- Task 1 → Tasks 2/3/4: Python/JS field names and digest canonicalization match; reviewer check the fixture and route shape.
- Task 2 → Tasks 3/4/5: owner-scoped Repository/TaskSpec store and routes return the exact shapes consumed by runner, workflow and Console.
- Task 3 → Task 4/6: execution evidence includes source commit, source cleanliness, runtime sandbox id, real JUnit/command result and Diff SHA256.
- Task 4 → Tasks 5/6: detail response distinguishes MANUAL from MYTHOS and includes frozen taskSpec, operations, session ids and workflow/delivery fields.
- Task 5 → Task 7: Console asset names and routes are explicit in deployment manifest and loaded from the installed main plugin path.

## Execution

The user asked for inline implementation and remote deployment; use `superpowers:executing-plans` in this session after the plan is approved. Execute tasks in numerical order. Keep all pre-existing dirty changes untouched unless a task explicitly lists the file; when a listed file is dirty, merge by editing the working version rather than restoring/copying a clean branch version.
