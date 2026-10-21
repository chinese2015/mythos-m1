# 多租户发票 API 的 BOLA 演练样例

日期：2026-10-18。状态：用户已同意 BOLA/IDOR 样例方向，待审阅本设计后进入实施计划。

## 目标

扩展现有本地漏洞演练集，增加一个可由 Mythos 发现、Owner 审批、执行基线、只读分析、编码、独立验证并发布 PR 的多租户对象级授权缺陷。项目和数据均为合成演示数据，使用本地 Gitea、Mock Findings 和 Java 17/Maven 离线执行模板。

成功标准：

- 浏览器任务中心能把新 Finding 显示为待 Owner 审批；审批后可启动已有 SDLC 全链路。
- 基线真实复现跨租户读取，最终独立 VERIFY 全部通过，PR head 与已验证候选完全一致并保持 open/unmerged。
- 项目能从受版本控制的脆弱基线重建；Fixture、Finding 映射、基线证据和 PR 仓库约束绑定同一精确 commit。
- 不改变 FND-00003/00009/00015、已有 PR/Work Item 或 Task 5 回执语义；仅在 CAS 保护下绑定未领取的 FND-00016，新样例有自己的现场验收回执。

## 当前代码相对已有设计的差距

现有 M2/M3 工作流、Owner 审批、隔离执行、Run Monitor、独立 B 验证、PR 发布和完成回写已具备。通用 MANUAL TaskSpec 也已支持多文件、测试改动及冻结的测试数量策略。这些设计本身无需再造新的工作流引擎。

新场景缺少的是样例接入层：

| 现有边界 | 当前限制 | 本样例需要的增量 |
|---|---|---|
| `plugins/mythos-workflow/source.mjs` | 只映射 FND-00003、00009、00015 | 为 FND-00016 添加仓库、真实 base SHA、源码路径映射 |
| `plugins/mythos-workflow/rules.mjs` | 仅有三个 Finding 的固定失败测试名 | 为 FND-00016 登记跨租户失败测试名，并继续要求精确基线证据 |
| `brain/executor.py`、`plugins/mythos-sdlc/policy.mjs` | MYTHOS 仓库白名单固定为三个旧 repo | 将新 repo 加入执行和交付白名单；保留原 owner/URL/commit 绑定 |
| 远端 Git 凭据助手 `/home/hx/gitea/repositories.json` | helper 只为三个旧 repo 提供 Git 凭据 | 为新私有 repo 添加唯一精确 allowlist 项；保留其他项/文件权限，先存私有备份再原子写入 |
| `plugins/mythos-sdlc/policy.mjs`、`plugins/mythos-workflow/task-spec.mjs` | legacy MYTHOS 验证要求恰好 2 项 JUnit，候选只准改一个映射源码文件且不准改测试 | Fixture 保留 2 个 JUnit 测试方法；基线已有失败回归，候选只修源码，不放宽既有门禁 |
| `integrations/mock-source/AiCompletionController.java` | 完成回写只接受三个 repo | 将新 repo 加入精确本地 Gitea 白名单并补拒绝/接受测试 |
| 远端 Mock `SeedData.java` | FND-00016 已存在但仍指向 placeholder repo、假 SHA、`sourcePath=null`；`run()` 在数据库非空时直接返回 | 在不重置数据库、不覆盖已领取 Finding 的前提下，安全绑定新 repo 和路径 |
| 现场验收脚本 | `tests/live_generic_intake.py` 固定检查 Task 5 的两条 MANUAL 任务及三条 legacy Finding | 新增专用 BOLA 回执，避免改写已完成 Task 5 的固定库存契约 |

在远端 Mock 的只读观察中，FND-00016 当前为 `CRITICAL`、CWE-284、Owner `owner-aster-01`、`Not Started`、`Open`、revision 1、无 Work Item；它的标题是“Example multi-user notes view lacks mock tenant scope”。当前仓库 URL 是 `https://git.example.test/demo/demo-aster-ui-service.git`，base SHA 为 `6a11c9d2e8f34b0a9d5e7c61f2b8a0d4e6c3f1a2`，`sourcePath=null`。因此复用这个未绑定 Finding，比另造编号和 Owner 更稳妥；绑定时将标题改为“Invoice endpoint exposes another tenant's invoice by ID”，让任务中心、Owner 通知和代码项目一致。Owner、CWE 类别、风险等级、状态及 Finding ID 不变。

## 方案选择

1. **推荐：复用 FND-00016，将独立 BOLA 项目接入 MYTHOS/M3。** 覆盖新漏洞代码、自动映射、Owner 门禁和完整交付，最大化复用现有工作流。需要同步维护少数 legacy 白名单和 Finding 绑定。
2. 仅通过通用 MANUAL TaskSpec 注册新 repo。实现改动较少，但跳过自动 Finding 研判、Owner 审批和来源绑定，不能验证 M3 的新漏洞接入路径。
3. 新建 Finding 和新 owner。需要额外处理 Mock seed、编号和通知身份，当前已存在语义匹配且未领取的 FND-00016，收益有限。

采用方案 1。新项目位于 `demo/demo-tenant-invoice-api`，本地可复建源放在 `samples/security/demo-tenant-invoice-api/`。仓库首个脆弱 commit 建成后，真实 SHA 和唯一源码路径才写入 Finding mapping；不得提前填假 SHA。主机 Git 凭据助手的 `repositories.json` 只新增这个 repo 的名字，供现有 helper 对该仓库使用已有账号凭据；写入前将原文件以 0600 保存到私有 artifacts 目录，并原子替换且保留原 owner/mode。

## 项目和漏洞行为

### API

项目使用 Java 17、Maven 和已有 JUnit 离线缓存，不引入在线依赖。服务提供合成的 `GET /api/invoices/{invoiceId}`。身份解析层产生可信 principal `{subject, tenantId, role}`；租户 ID 不从 URL、查询参数或请求头直接采信。数据集含两个租户的发票和一个演示管理员身份。

授权规则：发票属于当前 principal 的 tenant 时返回 200；演示管理员可跨租户读取；普通租户读取其他租户发票时返回 404，避免暴露对象存在性；未认证请求返回 401。未知发票也返回 404。

脆弱基线只包含一个缺陷：通过 `invoiceId` 查询对象后，没有将查询结果绑定到 principal 的 tenant。候选修复将对象查询限制在当前 principal 的 tenant，保留管理员通道和现有响应语义。不得加入真实个人、支付数据、生产凭据、外网调用或第二个无关漏洞。

### 基线与候选范围

Fixture 有两个 JUnit 测试方法，以兼容现有 legacy MYTHOS `tests === 2` 固定合同：

1. `crossTenantInvoiceReadIsHidden`：跨租户读取应为 404。脆弱基线中该方法确定失败，且只能有这一项失败。
2. `sameTenantAdminAndAnonymousAccessRemainCorrect`：同租户读取、管理员跨租户读取、未认证请求和不存在对象的结果均正确。

测试和构建文件在基线中已经存在。工作流候选只修改映射的一个源码文件；不放宽 legacy 的单文件/无测试改动策略。基线命令和最终独立验证沿用 `mvn -B -o -s .cache/settings.xml test` 与 `mvn -B -o -s .cache/settings.xml clean verify`。基线必须是 exit 1、JUnit 2 tests/1 expected failure/0 errors/0 skipped；独立候选必须是 exit 0、JUnit 2/0/0/0。

## Finding 与交付流程

1. 在本地 Gitea 的 `demo` 组织创建私有仓库，先备份并将精确仓库名加入主机 `repositories.json` helper allowlist，再由现有 credential helper 推送脆弱基线 commit；记录真实 commit SHA、默认分支、源码路径和两项测试。重复运行不新增仓库、commit、allowlist 重复项或冗余备份；已有非预期仓库内容时停止。
2. `integrations/mock-source/` 增加 loopback-only、CAS 保护的 `POST /api/findings/{id}/bind-demo-repository`。请求 `{expectedRevision, repositoryId, repositoryUrl, baseCommit, sourcePath, lineRange, findingName}` 只接受 FND-00016、`owner-aster-01`、预期 revision、原始 placeholder 身份，以及项目实际生成的 `REPO-demo-tenant-invoice-api`、本地 Gitea URL、40 位 base SHA、固定源码路径和目标标题。原记录已领取、状态变化或字段漂移时返回 409；非 loopback 调用拒绝。精确相同的已完成绑定幂等成功且不增加 revision。绑定器不接受任意仓库 URL，也不改 Owner、category、risk、score 或工作流状态。
3. `plugins/mythos-workflow/source.mjs` 映射 FND-00016 到新 repo、base SHA 和唯一源码路径；`rules.mjs` 为其声明唯一预期失败名。订阅器依现有映射规则完成 triage，任务中心按既有流程等待 Owner 审批。
4. MYTHOS 执行/交付白名单及 Mock 完成回写白名单加入新 repo。增加对应 mapping、baseline、repo allowlist、CAS 绑定端点与完成回写测试；不改 `tests/live_generic_intake.py` 的旧固定库存。
5. Owner 批准后复用现有 PLAN、CODE、VERIFY、PR 链路。候选仅修映射源码文件；PR 保持 open/unmerged，代码服务不自动合并或关闭 Finding。
6. 新增 `tests/live_bola_acceptance.py`，只读核对 FND-00016 身份和映射、baseline 失败证据、候选单文件干净状态、fresh B 通过证据、PR 精确 head、重启前后 Work Item/Session/operation 身份，以及浏览器任务详情和 read-only Diff。人工观察写入私有 `state/bola-browser.json`（mode 0600）；完整通过后输出私有验收回执，不包含 token 或原始日志。

## 运行时安全和恢复

- 所有服务、仓库和浏览器地址维持现有 loopback Gitea/Mock 配置；不接受 Finding 提供的任意 clone URL。
- 绑定过程经由新的 Mock CAS API，不读写 H2 文件、不重置数据库；endpoint 校验 owner、revision、未领取状态和原始 placeholder，避免覆盖其他任务或 Finding 更新。
- Git helper allowlist 仅增加 `demo-tenant-invoice-api`；备份不包含 credential 内容，原文件 owner/mode 保持不变，写入失败时不推送仓库。
- 只使用合成账号/发票；测试服务器只绑定 loopback。仓库、PR 和浏览器工作台都显示样例身份与合成数据。
- FND-00016 已由现有 `SeedData.java` 在干净数据库中创建为未映射样例。新的绑定 API 和启动文档必须说明如何在空库或已存在数据库中建立精确映射；重复调用不得重建 Finding 或推进 revision。
- PR 与源 Finding 维持待人工审核/合并状态；没有配置的 CI 或 review gate 如实显示“未配置/未运行”。

## 非目标

不构建生产级 OAuth/JWT 身份系统或数据库集群，不连接真实账单、钉钉/邮件收件人或公网，不自动合并 PR，不将通用 MANUAL 流程改造成新 DSL，也不改变已有三个 Finding 的规则和既有 PR。
