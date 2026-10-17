# M3 主动漏洞接管：当前实现与验收

2026-10-17。代码、部署和审批前半程已完成；Pixel 后续模型分析、修复与新 PR 尚未完成，原因是 Kimi 返回 403：本周 7 天额度已耗尽。流程保持 BLOCKED，没有代写修复、重放模型调用或将失败标为成功。

## 使用与当前状态

入口 `http://127.0.0.1:3080/argon/#/tasks`，复用 DSH 登录。本机已恢复 3080、3081、3000 的 SSH 转发。

| 来源 | 当前状态 | 已验证事实 |
| --- | --- | --- |
| FND-00003 / Orion | 待 Owner 批准 | CONFIRMED；本地通知预览已生成；未领取、未创建工作区；直接启动返回 409 |
| FND-00009 / Nova | PR_OPEN | 原任务、原会话、原 PR #2 保留；没有重复创建 |
| FND-00015 / Pixel | BLOCKED | 页面批准接管并启动；真实基线 2 tests / 1 traversal failure / exit 1；Kimi 分析首轮额度失败，Git 保持基线且无修改 |

Pixel 工作项 `work-466690061b6c4ed492e2f41ab94f8dda`；PLAN Session `session-aaa641ca-5de9-fccb-30ab-7e2001a6f50c`；基线操作 `exec-f2eeac4a94cb406e94635f9411f107d3`。恢复模型额度后，从工作详情发送说明继续只读分析；方案生成后仍需另行批准，才允许写代码。

## 行为与边界

`argon-subscribe` 每 30 秒读取 Mock Findings。仅对已映射资产内、尚未处理的 High/Critical 来源做规则研判，精确核对仓库、基线、路径与 Owner。先持久化 M2 intake，再写 triageResult、生成通知预览。失败保存 lastError，后续轮询重试。审批前不更改 Finding 的处理状态。

任务中心显示研判、Owner 建议、通知预览与批准/拒绝按钮。缺少 intake 或尚未批准时，新启动均拒绝；已有任务可继续打开。批准不会自动启动任务，也不会代替后续代码方案审批。

审批保存不可变 `decision.binding`，包含 finding/Owner/仓库/基线/路径。并发轮询可以更新研判，不能把旧批准改绑给新 Owner。待批准来源的绑定变化会清除旧通知标记，并生成新绑定的预览；同一通知身份的重试复用首次成功回执，即使标题或团队文案后来变化。

通知只写远程 `~/argon-backend/data/outbox/FND-*-intake-*.eml`，拒绝 SMTP 模式。本轮没有向真人发邮件、Teams 或钉钉消息。控制台依旧是单 operator alice；不是企业多用户身份认证，M2 bearer 是受信管理面。

原生会话嵌入已实测：修复同步 catalog 回调造成的递归后，Pixel 详情显示 Pixel PLAN，未再显示旧 Nova 会话。模型额度错误有明确解释，保留阻塞状态。

## 验证与证据

- 本地 Node 81/81；Python 86 项（85 pass、Linux 专属 1 skip）。
- 远程 Linux Node 81/81、Python 86/86；Java overlay 16/16。部署 JAR 与通过测试的 JAR SHA256 一致。
- 独立代码审查发现的 3 项 Important 均有先失败后通过的回归：审批改绑竞态、Owner 变化后漏通知、通知落盘后正文变化导致重试 409。
- 真实证据：远程 `~/argon-m1/state/m3-acceptance.json`，包含 409 门禁、来源未领取、重复启动返回同任务、仅两份预览、Nova PR 保留、Pixel JUnit 与 Git 状态。
- 本地浏览器截图：`artifacts/m3-task-center.png`、`artifacts/m3-pixel-blocked.png`（忽略入 Git）。

## 实现裁定与后续代价

- 沿用现有功能分支和工作区，显式路径提交，保留其它 agent 的成果；后续整合由当前分支继续。
- 补齐已有 intake API 的 state/notified/lastError，并禁止旧轮询倒退 revision；后续扩展通知状态应延续同一持久化接口。
- M2 保持 APPROVED/REJECTED 枚举，控制台翻译 APPROVE/REJECT；改命名只需在边界协调。
- 未登记任务默认禁止启动；代价是新任务可能等待一个轮询周期。已有工作项不受影响。
- 通知限定本地预览；真正投递需要另行授权和真实身份/通知适配器。
- 基线期待按三份仓库的真实测试确定；测试契约变化时需同步更新映射中的失败名与计数。
- 保留旧 PoC 与 Nova 沙箱，演示运行时配额调整为每 owner 4、全局 5（主机 16 GiB），容纳 Pixel 的 A/B；若资源不足，验证应停在配额门而非清理其它任务。
- 已批准后来源绑定发生变化时禁止新启动，当前需要 operator 人工复核；没有自动沿用旧批准。原有不带绑定的未领取批准也不会自动获得执行权限。
- 真实 SMTP/Teams/Jira、多真人认证、受信 M2 管理员直接调用底层接口，以及 Nova 合并后的真实来源回写，均未在本轮宣称验收。
- 保留原 intake 审查的轻微事项：非法 expectedRevision 的部分类型返回 409 而非 400；Finding ID 格式校验在 HTTP 路由层。不会放行审批或执行。
