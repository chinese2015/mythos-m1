# 真实任务只读编码工作区 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline, task by task.

**Goal:** 在现有任务入口内交付插件式文件/Diff/Agent/运行观察工作区。

**Architecture:** 新双端 argon-coding 插件隔离 SSH 只读 provider，使用 TaskWorkflow 的权限与绑定。外壳复用已验证客户端桥与主线 Run Monitor，保持审批和执行控制语义。

**Tech Stack:** DSH 0.2.0-rc.2、Cordis、Node ESM、原生 fs-ssh、浏览器原生 JS、现有 Python M2（不修改）。

**Spec:** `docs/superpowers/specs/2026-10-17-coding-readonly-design.md`

## Global Constraints

- 固定 DSH 0.2.0-rc.2；无新依赖；隔离 worktree，不动主线未提交改动或现有服务。
- 所有文件 API 只读；512 KiB / 16000 行；目录最多 2000 项。
- 不自动创建任务/会话、调用模型、执行命令或扩大写权限。
- 身份来自 DSH cookie 与 TaskWorkflow owner；沙箱/路径来自服务端绑定；禁止 Host fs 回退。

## Review Focus

- 源码被后台改动：返回冲突，不展示错误的稳定哈希。
- Host 和容器同名：只使用明确的官方 SSH provider。
- 链接与父目录 symlink：逐段拒绝，并再次检查 canonical containment。
- 快速切任务：迟到文件、桥消息和运行日志不污染当前任务。
- 大日志/二进制/截断：明示不完整或不支持，不显示假空文件/通过。

### Task 1: 任务文件服务与 SSH 工厂

**Files:** Create `plugins/argon-coding/{files,ssh}.mjs`, `tests/coding-files.test.mjs`.

**Interfaces:** `TaskFiles({workflow,openFs}).list(id,path,signal)` / `.read(id,path,signal)`；`createSshReaders(config).open(work,location)` 返回 `{fs,dispose}`，`.dispose()` 清理。

- [x] 写文件目录/读取、owner 拒绝、Host 同名、路径、symlink、二进制、超限、版本变化测试，观察 RED。
- [x] 实现原生远端 fs 限定读取与 8 连接上限、Context 清理；无模型/工具。
- [x] 运行 `node --test tests/coding-files.test.mjs` 与完整 `npm test`，记录结果。

### Task 2: 认证路由与插件注册

**Files:** Create `plugins/argon-coding/{index.mjs,package.json}`, `tests/coding-api.test.mjs`; Modify `configure_presets.py`.

**Interfaces:** `codingHandler({connection,workflow,files,assetReader})`；GET context/files/file；其余方法 405；静态资产精确 allowlist。

- [x] 写真实 HTTP 401/403/404/405、owner 与查询校验测试，观察 RED。
- [x] 实现路由/请求取消、复用 detail，注册生命周期及 task service 项。
- [x] 运行目标用例、完整 Node/Python 套件；不执行配置部署。

### Task 3: 四区任务外壳与原生桥

**Files:** Create `plugins/argon-coding/{client.js,public/*}`、`tests/coding-bridge.test.mjs`; Modify `plugins/argon-console/public/app.js`、`plugins/argon-console/public/monitor-view.js`、`monitor-state.js`。

**Interfaces:** `/argon/coding/#/work/{id}`；原生 iframe `argonCodingWork/argonCodingBinding`；复用 `/argon/api` monitor request 和 `renderMonitor(ctx)`。

- [x] 先写消息边界、目录时序、引用与任务限定 monitor 目标测试并观察 RED。
- [x] 迁移已验收 PoC 桥为任务上下文绑定；文件树、只读源码、Diff、原生会话、轮询日志、可调面板及任务入口链接。
- [x] 浏览器验证来源/Session、原生引用、Diff 与监控、切任务/刷新；区分 fixture 与真实远程证据。

### Task 4: 交付验证

**Files:** Create `docs/coding-workbench.md`、只读远程验收脚本；Update 本计划勾选项及独立 ledger。

- [x] 跑完整 Node/Python 套件；对新增代码做独立审查，修复重要发现并跑回归。
- [x] 只读 operator 验证 task fs 路径、内容 hash、候选 SHA/测试事实不变；无法访问时报告缺项。
- [ ] 提交隔离分支的具体代码、测试、文档，不合并/部署；报告成果与后续编辑接管边界。
