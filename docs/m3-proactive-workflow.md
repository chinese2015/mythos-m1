# M3 主动漏洞接管：当前实现与验收

2026-10-17。额度恢复后已完成 Pixel 的真实 PLAN → 方案审批 → 模型编码 → 新 B 容器独立验证 → PR 交付。Pixel PR #2 保持开放等待人工审核合并，来源仍为 In Progress / Open。此前的 Kimi 额度阻塞已解除。

## 使用与当前状态

入口 `http://127.0.0.1:3080/argon/#/tasks`，复用 DSH 登录。本机已恢复 3080、3081、3000 的 SSH 转发。

| 来源 | 当前状态 | 已验证事实 |
| --- | --- | --- |
| FND-00003 / Orion | 待 Owner 批准 | CONFIRMED；本地通知预览已生成；未领取、未创建工作区；直接启动返回 409 |
| FND-00009 / Nova | PR_OPEN | 原任务、原会话、原 PR #2 保留；没有重复创建 |
| FND-00015 / Pixel | PR_OPEN | 模型提交 b4b64a6，仅修改 ReportImporter.java；新 B clean verify 2/2；补充边界检查 8/8；Gitea PR #2 开放待审 |

Pixel 工作项 `work-466690061b6c4ed492e2f41ab94f8dda`；PLAN Session `session-aaa641ca-5de9-fccb-30ab-7e2001a6f50c`；基线操作 `exec-f2eeac4a94cb406e94635f9411f107d3`。CODE Session 为 `session-1faae69e-95eb-cbb1-5fdd-19afd5b86f37`；候选为 `b4b64a6998caac8d4aacaca38b87b82528251148`；[Pixel PR #2](http://127.0.0.1:3000/demo/demo-pixel-reports-batch/pulls/2)。交付后禁止直接发送编码说明；需要修订时先关闭未合并 PR，再明确继续并重新验证。

## 行为与边界

`argon-subscribe` 每 30 秒读取 Mock Findings。仅对已映射资产内、尚未处理的 High/Critical 来源做规则研判，精确核对仓库、基线、路径与 Owner。先持久化 M2 intake，再写 triageResult、生成通知预览。失败保存 lastError，后续轮询重试。审批前不更改 Finding 的处理状态。

任务中心显示研判、Owner 建议、通知预览与批准/拒绝按钮。缺少 intake 或尚未批准时，新启动均拒绝；已有任务可继续打开。批准不会自动启动任务，也不会代替后续代码方案审批。

审批保存不可变 `decision.binding`，包含 finding/Owner/仓库/基线/路径。并发轮询可以更新研判，不能把旧批准改绑给新 Owner。待批准来源的绑定变化会清除旧通知标记，并生成新绑定的预览；同一通知身份的重试复用首次成功回执，即使标题或团队文案后来变化。

通知只写远程 `~/argon-backend/data/outbox/FND-*-intake-*.eml`，拒绝 SMTP 模式。本轮没有向真人发邮件、Teams 或钉钉消息。控制台依旧是单 operator alice；不是企业多用户身份认证，M2 bearer 是受信管理面。

原生会话嵌入已实测：先修复同步 catalog 回调递归，再修复 native restore 在 retained-catalog 通知后覆盖任务跳转的问题；新页面初始化后，交付页 caption 和 iframe 均显示 Pixel CODE。导航失败局部记录并允许目录变化后重试，不产生未处理的 Promise rejection。

## 验证与证据

- 本地 Node 83/83；Python 86 项（85 pass、Linux 专属 1 skip）。
- 远程 Linux Node 83/83、Python 86/86；Java overlay 16/16（本轮未改 overlay）。部署 JAR 与通过测试的 JAR SHA256 一致。
- 独立代码审查发现的 3 项 Important 均有先失败后通过的回归：审批改绑竞态、Owner 变化后漏通知、通知落盘后正文变化导致重试 409。
- 真实证据：远程 `~/argon-m1/state/m3-acceptance.json`，包含 409 门禁、来源未领取、重复启动返回同任务、仅两份预览、Nova PR 保留、Pixel JUnit 与 Git 状态。
- 当前浏览器截图：`artifacts/m3-pixel-pr-open.png`；`m3-task-center.png`、`m3-pixel-blocked.png` 为额度中断时历史截图。以上均忽略入 Git。

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

## 额度恢复后的完整链路

只读分析先产出 normalize-only 方案，评审后要求补齐相对基目录和外部符号链接边界；修订方案 hash 为 `bdd626feb23a6e4ba58a3da0337916cf91c29534e2215b46160d1b8e8112f688`。批准记录绑定该 hash、version 19 和 operator alice，重复审批返回同一决定。实际源码由 DSH 模型通过原生工具写入并提交；控制台代理没有代写 Java 修复。

- 开发 A：`sb-f363592fdf6c498f`；基线操作 exit 1 / JUnit 2 项 1 失败，编码后 UNIT_TEST `exec-1ef841eb0633497b89a079e87b1b241d` exit 0 / 2 项全过。
- 新验证 B：`sb-7faca107f3604f52`；操作 `exec-49deeccddc4343f784c81f0223131a4f` 从精确候选 Git bundle 重建，freshTargetAbsent=true，`mvn clean verify` exit 0 / JUnit 2 项全过，证据持久化后清理 B。
- 补充检查：`tests/fixtures/PixelPathProbe.java` 在 `/tmp` 独立编译实际源码，不改演示仓库测试、POM 或 Git 状态。同一 probe SHA，基线 4 pass/4 fail → 候选 8 pass/0 fail；覆盖正常文件、相对基目录、父目录穿越、绝对外部路径、外部文件链接、外部目录链接、内部链接及 IOException 包装。operator-host 执行方式为 `python3 -m tests.live_pixel_paths baseline`（修复前）或 `candidate`（候选生成后）。
- 交付：分支 `argon/fnd-00015-46669006-b4b64a6998ca`，PR #2 的 head 精确等于候选，delivery marker 对应 `e0594bb17a4ad4e979b03a8c1224203d3c05d9cf9688ed8da78971be33aaae69`。独立 Gitea API 认证核验仅一条匹配 PR；重复发布、DSH 重启后仍同一交付、2 个 Session、3 个 operation，无新模型/测试重放。
- 门禁：Orion 未批准启动返回 409；已发布 Pixel 的补充输入返回 409；Nova 原 PR 保留；Owner 通知预览仍仅两份；Pixel 来源未提前关闭。CI 未配置，页面如实显示暂无检查记录。

独立候选审查未发现文件名输入、稳定文件系统场景下的阻塞问题。边界：`toRealPath()` 与读取之间并非原子操作，不保证防御并发恶意修改目录结构的攻击者；符号链接与 `..` 混合路径采用词法归一化语义，可能与原始文件系统遍历选择不同的目录内文件。若扩展为不可信并发写入场景，需要描述符相对或原子文件访问方案，不沿用当前安全结论。

浏览器审批点击曾超时，审批与 PR 发布通过同一受认证控制台 API 完成；最终新页面已实际核验 PR 状态、正确 CODE 会话和只读提示。Gitea 人工审核页面需要登录。
