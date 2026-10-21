# M3 剩余：主动漏洞工作流（来源订阅 · 自动 Triage · Owner 通知/审批）

目标（总体方案 M3 验收）：新 High/Critical 漏洞**自动研判并通知，Owner 批准后才修复**。AI Fix 与 PR 交付已完成，本切片只新增"发现 → 研判 → 通知 → Owner 批准"前半段，批准后复用既有任务工作台全链路。演示载体：FND-00003（orion，硬编码密钥，HIGH）与 FND-00015（pixel，路径遍历，HIGH）——两者已仓库映射、Open、Not Started，当前被 `row.id === 'FND-00009'` 硬编码门挡在"此演示暂不可启动"。

## 架构与组件

1. **M2 来源登记簿（唯一新增持久化）**：`brain/store.py` 新表 `source_intakes`（`finding_id` 主键，`revision`、`state`：`AWAITING_OWNER|NEEDS_REVIEW|APPROVED|REJECTED`、`triage`（JSON：结果+理由）、`notifiedAt`、`lastError`、`decision`（JSON：by/at）、`createdAt/updatedAt`）。新 API（`brain/api.py`，owner bearer + GET 只读 / POST decide 需 Idempotency-Key）：
   - `GET /api/brain/source-intakes` → `{intakes: [...]}`（operator 全量，量小）
   - `PUT /api/brain/source-intakes/{findingId}` → 登记/更新（订阅器用；body `{revision, triage}`；按 finding_id 幂等 upsert，revision 变化时保留既有 APPROVED/REJECTED 决定并在 `triage` 里记新研判）
   - `POST /api/brain/source-intakes/{findingId}/decide` → body `{expectedRevision, decision: 'APPROVE'|'REJECT'}`；仅 AWAITING_OWNER 可决定；幂等（同 key 重放返回同一结果）；决定后写 `work_item.workflow_updated` 风格的 intake 事件不必，保持最小。
2. **`plugins/mythos-subscribe/`（新 Cordis 插件）**：Service+`ctx.effect` 定时器（`pollIntervalMs` 默认 30000，可配置）。每轮：`GET {mock}/api/findings` 全量 → 客户端过滤候选（映射表精确匹配 repositoryUrl/baseCommit/sourcePath 且 `closed != 'Closed'`、`status == 'Not Started'`、`risk ∈ {HIGH, CRITICAL}`、Mock 侧 `workItemId` 为空、无现存 work item）→ 对未登记候选做**自动研判**（纯函数 `triageFinding(finding, mapping)`：`CONFIRMED`（全部精确）或 `NEEDS_REVIEW`（映射漂移/字段缺失，附理由））→ 先 PUT intake（持久化意图）→ 外部写：Mock `PATCH /api/findings/{id}` `{triageResult}`（CONFIRMED/NEEDS_REVIEW）→ CONFIRMED 时调 Mock 通知端点发 Owner 邮件并在 intake 记 `notifiedAt`。**任何外部写之前 intake 已落库**；外部写失败记入 intake `lastError` 并保持状态可重试。已批准/已拒绝/已有 work item 的 Finding 跳过；FND-00009（已有 work item）首次同步为 APPROVED（ grandfathered ）。
3. **Mock overlay 新增 `POST /api/findings/{id}/notify-owner`**（`m1/integrations/mock-source/`，apply.sh 打进 jar；仅 loopback）：从 Finding 取 `ownerId`/`ownerTeamsId`，合成收件人 `{ownerId}@mythos.demo`，`mail.deliver(...)` 发"批准请求"邮件（finding 摘要、研判结论、控制台链接 `http://127.0.0.1:3080/mythos/`、`X-Mythos-Intake` 头语义写进正文）；preview 模式落 `data/outbox/*.eml`（验收直接读文件）。Java 侧补集成测试（loopback 拒绝、未知 finding 404、outbox 文件生成）。**Mock 重建走既有 `~/mythos-mock-cas-build-release` 流水线**。
4. **任务启用门改造**：`plugins/mythos-workflow/source.mjs` 删除 `row.id === 'FND-00009'` 硬编码；`enabled = exact 映射匹配 && eligible`。`controller.tasks()` 合并 M2 intakes：每个 task 附带 `intake: {state, triage}`；**启用规则改为**：已有 work item → 直接可打开（原有）；无 work item → 仅当 intake.state === 'APPROVED' 才显示"开始处理"，否则显示"待 Owner 批准"（AWAITING_OWNER）或"需人工复核"（NEEDS_REVIEW）。`controller.start()` 对无 work item 且 intake 非 APPROVED 的 finding 返回 409（message：请等待 Owner 在任务中心批准接管）。
5. **console**：任务卡新状态 pill（待 Owner 批准/需人工复核）+ Owner 建议行（`ownerId · ownerTeamsId`）；AWAITING_OWNER 卡上给"批准接管"（primary）与"拒绝"（text-button）按钮 → `POST /mythos/api/tasks/{id}/decide`（新路由，仿 approve-plan 的 X-Mythos-Action/Idempotency-Key 门禁）→ 经 subscribe 服务转 M2 decide；批准后卡变"开始处理"。`nav-count` 改为显示"待批准"数（`intakes.filter(AWAITING_OWNER).length`），有等待时侧边栏任务中心红点提示文案保留。任务列表轮询自动刷新决定后状态。

## 数据流（一次完整 M3 旅程）

```
Mock findings ←30s─ subscribe 轮询
  → 候选(FND-00015) → triage CONFIRMED → PUT intake(AWAITING_OWNER) → PATCH Mock triageResult
  → POST /notify-owner → outbox 邮件
  → console 任务卡:"待 Owner 批准"+Owner 建议 → operator 点"批准接管" → M2 decide(APPROVED)
  → 卡变"开始处理" → operator 点开始 → 既有链路(claim→sandbox→baseline→plan→approve→code→verify→PR)
  → PR 人工合并 → SDLC 回写 ai-completion（既有）
```

拒绝路径：decide(REJECTED) → 卡显示"已拒绝接管"，Mock 保持 Not Started，不再通知。

## 真实性红线

- 批准前零 Mock 状态翻转（status 仍 Not Started）；只有 `triageResult` 与通知邮件是批准前写入，且两者都先落 intake。
- 邮件/通知失败不阻塞 intake 状态机，错误可见可重试。
- `enabled` 不再依赖任何硬编码 finding id；映射表仍是资产边界（未映射 finding 永不进入审批）。
- Owner 决定幂等、防丢（M2 侧 expectedRevision + Idempotency-Key，console 侧走既有 mutation 门禁）。

## 明确不做

真实 Teams/Jira 集成、Webhook 反向推送（demo 用轮询）、多 operator 真实认证、 Finding 时间戳（Mock 无此字段，用 revision + 状态过滤）、订阅非漏洞类来源。M4 Jira Task Hub 不在本切片。
