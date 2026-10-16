# M2 收口：Run Monitor 最小完整链路

用户已批准继续（"run monitor 可以继续做了"），验收标准沿用 `docs/status-review-2026-10-16.md` 第 3 条：以 FND-00009 为唯一首条演示，显示 Work Item 阶段、Agent 活动、执行状态、实际日志/退出码/JUnit；Maven（或等价长命令）运行中关闭网页，重开能恢复观察；worker 重启能对账；失败不能显示成功；取消请求不能提前显示 CANCELLED。本设计只做这一个垂直切片，不扩展多任务列表页、通知或审批。

## 方案：轮询，不引入推送

M2 后端（`brain/store.py`）已提供三条带游标的只读接口，全部事实在 SQLite，天然支持"关网页重开后无损续看"：

- `GET /api/brain/work-items/{id}` —— 全量快照（workItem、sessions、operations、evidence、cursor）
- `GET /api/brain/work-items/{id}/events?after=N&limit=M` —— `{events:[{sequence,type,occurredAt,correlation:{operationId?},payload}], nextCursor}`（store.py:380-384）
- `GET /api/brain/operations/{id}/logs?after=N` —— `{logs:[{sequence,stream,offset,data(base64),text}], nextCursor}`（store.py:386-393）

DSH 侧 `argon-brain/snapshot|event|error` Cordis 事件（bridge.mjs:71/186/45）已在广播，但 console 未订阅这些事件，且推送与"重开可恢复"的硬要求正交。**决定：console 前端沿用现有 1800ms 整页轮询 + DOM patch 模式（app.js:207），数据源走 console 新增的只读代理路由 → M2 游标接口。** 不新增 Cordis 订阅、不改 M2 后端、不动 DSH 核心。

## 组件与改动面

1. **console API 代理**（`plugins/argon-console/index.mjs`）：GET 分支新增 `GET /argon/api/work-items/{id}/events?after=N`，仿现有 logs 代理（index.mjs:38-41）：先做 `connection.requestRejection` 认证（401/403 不变），校验 `after` 为非负安全整数（缺失=0，越界 400），转发 `ctx.argonWorkflow.controller.client`（M2Client，路径前缀已硬校验 `/api/brain/`，client.mjs:52）。快照与日志复用现有 `workflow.detail(id)` / `workflow.logs(id, after)` 路由。只读，不要求 X-Argon-Action / Idempotency-Key。
2. **workflow 适配**（`plugins/argon-workflow/controller.mjs`）：`TaskWorkflow` 新增 `events(id, after)` 方法，仿 `logs()`（controller.mjs:137）：读当前版本、转发 client、原样返回 M2 响应。owner 隔离继承 M2 bearer（单操作员 alice 现状不变）。
3. **前端视图**（新文件 `plugins/argon-console/public/monitor-view.js`，仿 `delivery-view.js` 的 ES 模块模式，注册进 index.mjs:4 assets Map）：
   - 嵌入工作详情页（`#/work/{id}`）作为独立区块「运行监控」，放在「操作记录」之后，不打断现有布局与 iframe。
   - 内容：Work Item 阶段（workflow.phase 原文）、Agent 活动（复用 detail 快照的 sessionProgress）、操作时间线（每个 operation：state pill、kind、退出码、JUnit 摘要、起止时间、可展开日志框）、M2 事件流（execution.*/workspace.* 按 sequence 追加）。
   - 游标持久化只在 DOM 状态与闭包内：打开时 `events?after=0` 全量拉取，之后每次轮询带 `lastCursor`；展开的日志框各自维护 `logCursor`。重开网页 = 重新全量拉取，天然恢复。
   - 轮询节拍与现有 work 视图一致（约 2s，document.hidden 时暂停），渲染仍走 `patchChildren/patchTree`（app.js:131-143）保留展开/滚动状态。
4. **纯函数状态模块**（新文件 `plugins/argon-console/public/monitor-state.js`）：把可测逻辑从 DOM 中剥离——事件归并（按 sequence 去重排序、维护 nextCursor）、展示状态映射（state → 文案/颜色，CANCEL_REQUESTED 与 CANCELLED 严格区分）、JUnit 摘要格式化。用 `node:test` 直接测试该模块（不依赖浏览器，仿 console-client.test.mjs 的 runInNewContext 或直接 import——该文件保持无 DOM 依赖即可直接 import）。

## 真实性红线（验收标准的显示层落点）

- 所有状态文案只来自 M2 operation.state / workItem.workflow.phase 原文映射，**不从 exitCode、日志内容或轮询缺席推断成功**。
- `CANCEL_REQUESTED` 显示"取消已请求，等待进程终止"（ACTIVE 色），只有终态 `CANCELLED` 才显示已取消；`FAILED` 必须带出 exitCode/reason；`UNKNOWN` 单独显示且注明"执行器失联，未自动重放"。
- M2 代理失败（网络/5xx）时面板显示可见错误条，保留旧数据并标注"连接中断，显示的是 N 秒前的快照"，不填充假状态。
- 取消按钮复用现有 `POST /argon/api/operations/{id}/cancel`（index.mjs:52），点击后立即显示 CANCEL_REQUESTED 事实（来自下一次快照），不本地乐观翻转。

## 安全边界

无新增认证面：代理走同一 `connection.requestRejection`；M2Client 的 owner token 不出 console 进程；浏览器只拿到 M2 的事件/日志投影（无凭据、无宿主路径）。`after` 参数校验防注入；响应不做缓存（`Cache-Control: no-store`，与现有 json() 一致）。

## 测试

- `tests/task-controller.test.mjs`：HTTP 级用例——events 代理 200 透传、after 非法 400、认证 401/403、未知 work item 透传 M2 404；workflow.events() 单元用例（游标参数透传、响应原样返回）。
- `tests/monitor-state.test.mjs`（新）：事件归并/去重/游标推进、CANCEL_REQUESTED≠CANCELLED 映射、FAILED 带 exitCode、UNKNOWN 文案、JUnit 摘要格式化。
- 全量回归：Node + Python 套件不红。

## 真实验收（远程 operator host）

1. 同步代码 + 仅重启 DSH（console 是 DSH 侧；M2 后端无改动）。
2. 以 FND-00009（work-e0c22f…，PR_OPEN 中、交付不受影响）为演示：经 M2 API 在其绑定沙箱创建一条长命令 operation（如 `sleep 90`），浏览器打开运行监控 → 运行中**关闭标签页** → 重开，观察状态/日志从游标恢复续看。
3. 取消该 operation：界面先显示"取消已请求"，进程终止后才显示 CANCELLED。
4. worker 重启（SIGTERM 后拉起） mid-run：监控对账，不重复执行、状态不跳变。
5. 运行一条 `exit 23` 的命令：界面显示 FAILED/exitCode 23，不得显示成功。
6. 证据写 `~/argon-m1/state/run-monitor-acceptance.json`（0600），ledger 记录；探针 operation 留在审计轨迹（不改候选、不动 PR #2）。

## 明确不做

多任务监控大盘、主动通知/审批页（M3 剩余）、Cordis 推送订阅、SSE/WebSocket、Run Monitor 独立导航项（首切片嵌入工作详情页）。UNKNOWN 手工解除隔离 API、SSO 仍不在本切片。
