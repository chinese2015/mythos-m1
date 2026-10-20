# 通用任务能力并入主 DSH 设计

日期：2026-10-20（Asia/Shanghai）

## 目标

在主 DSH（13080）和主 Brain（13081）中加入仓库登记、手工任务、通用验证和改动范围策略，并升级现有只读编码工作台。保留主线 Finding 推送、订阅和方案编辑；主 DSH 继续使用自己的 Brain 数据库、DSH profile 和沙箱登记簿。把实现部署到远端主实例，generic 实例和其历史数据保留原样。

## 已确认的范围

- 整合本地 `m1/` 与 `worktrees/generic-task-intake/` 中已实现且适用于主线的通用任务能力。
- 在主 DSH 提供登记仓库、检查连接、创建并查看手工任务的 UI。
- 对每个手工任务冻结仓库 revision、实际分支 HEAD、执行命令、证据格式、改动范围和评审要求；批准绑定冻结摘要。
- 手工任务复用 PLAN → 人工审批 → CODE → 新容器独立验证 → 人工发布 PR；不伪造 Finding，不回写 Mock Finding。
- 把通用代码阅读体验与其 Diff 缓存修复接到现有任务绑定工作台。
- 统一新增仓库/手工任务路径所需的 Gitea origin 和端口，然后备份和更新远端主 DSH/Brain。
- 现有 Finding 推送接入、免 DSH 登录校验和自动接管行为原样保留；本次不重做该流程。
- 不复制 generic 的 Work Item、TaskSpec、审批、Session、沙箱、PR 记录或 Brain 数据库。generic 实例的数据与服务不变。仓库配置在主实例重新登记。

## 两种任务共用主线，不互相伪装

Brain 中继续保存同一 Work Item 模型，但依据 `source.type` 分流：已有安全 Finding 使用 `ARGON`；人工任务使用 `MANUAL` 并带冻结的 `taskSpec`。任务列表同时呈现已推送 Finding、已有 Work Item 和已创建的手工任务。人工任务有自己的 `TASK-...` 来源标识，不进入 Finding triage、Owner 通知或完成回写。

仓库由 owner 隔离。注册和 revision 使用 Brain API 已有的 bearer owner 身份、幂等键和版本 CAS。SQLite 以 `CREATE TABLE IF NOT EXISTS repositories` 增加登记表，不重建现有表或修改现有 Work Item。每次新任务读取被登记的当前 revision，服务端向 Gitea 确认 push 权限并读取实际分支 HEAD。用户提供的 SHA（若有）必须等于当前 HEAD。

每个 `TaskSpec` 都保存 owner、仓库 id/revision、规范仓库名、分支、真实基线 SHA、需求和验收标准、运行模板、基线/验证命令、timeout、证据格式、改动策略、测试许可、PR 评审策略及 `specDigest`。规范 JSON 的摘要覆盖所有这些字段。PLAN 的批准同时绑定 `planHash` 和 `specDigest`；之后任何执行、验证、发布读取持久化 TaskSpec 并重新校验摘要。不能用改算摘要的方式继承另一份策略的审批。

## 执行、候选范围和证据

先支持当前 generic 已有的 `java17-maven-offline-v1` 与 `standard-tools-v1` 模板。配置可指定 baseline、验证命令、timeout、JUnit 报告目录、最少有效测试和 skipped 规则，或明确的 command 模式（只承认真实 exit code）。baseline 模式为 `record`、`must-pass` 或 `must-fail`；UNKNOWN、容器准备错误、无效证据不得推进工作流。B 必须从精确候选 SHA 在独立容器中重建和执行。

改动范围必须同时落在仓库级允许范围与任务级收窄范围内，并受 maxFiles 限制。任务需要显式许可才允许测试修改；构建配置只有仓库与任务两层都明示许可才可修改。验证完成及发布前再次比对提交状态、文件范围、测试变更、命令、摘要、Owner 和候选 SHA。

手工任务发布使用从冻结 TaskSpec 得来的 Gitea 仓库身份和精确 repository-scoped credential helper。Git push 是 create-only；发生超时或重启时只对账，不覆盖已存在分支。PR 描述从真实冻结命令及运行证据生成。人类合并、合并树等于已验证候选树、配置的独立审批和 CI 门禁继续生效。未配置的门禁显示未配置，不宣称通过。手工任务 PR 通过门禁后完成 Work Item，不调用 Finding source completion。

## 与现有 Finding 推送流程的边界

现有主线 `POST /argon/api/source-findings`、Mock `/api/findings/{id}/push-task`、来源 triage、自动接管与 Work Item 领取按当前行为保留。本次不得要求这个入口增加 DSH 登录态，不得改自动 approve/claim 的时机或来源推送 UI。新增仓库注册与手工任务 API 使用主 Console 现有认证及 Brain owner 身份，并与 Finding 流程并行。

新增任务读取和列表合并时须保留现有 ARGON source intake/idempotency 语义。涉及共享 controller 时，对 Finding 既有行为只做必要的兼容改动，不重构或收紧来源入口。该来源入口的访问控制不在本次范围。

## Console 和只读代码工作台

在当前任务中心并列加入仓库/新建任务页面，不覆盖推送 Finding 视图。注册表支持创建、revision、停用及连接状态失效；创建任务失败或响应丢失时复用持久化业务幂等键，页面不得静默换 key 或重复 mutation。

任务详情继续显示原生 DSH Session 和方案面板；部署时保留主线 `plan-view.js`、Markdown renderer、计划编辑、模型修订与审批绑定。只读代码工作台改进为按目录分组的文件导航、语言高亮、Diff 改动标记、窄屏布局和正确行号，并支持按原文 offset 生成文件/版本/行范围/选中内容引用到原生 DSH 草稿。页面只读，不增加写文件能力。通过请求序号和卸载清理隔离轮询、分页和异步 Diff 结果。

Diff ETag 需纳入 branch、工作树状态、changed files 与 diff SHA256；不能只由 Work Item version 和 HEAD 决定，否则未提交修改会得到旧的 304。PR reconciliation 对持久化的外部 facts 使用规范序列化比较。工作台对已有 FAILED/CANCELLED 操作只在无 UNKNOWN 或活动执行、工作流未封锁时提示检查后恢复；不重放失败操作。

代码高亮复用目标 DSH 版本提供的 `dsh-client-ui-primitives`，版本边界与主 DSH `@deepseek-ai/dsh@0.2.0-rc.2` 一致；不在部署时自动升级 DSH 或安装不受信任依赖。

## 服务地址、身份与凭据

新增仓库/手工任务路径使用主机本地 Gitea HTTP origin `http://127.0.0.1:13000`；其 repo clone URL、Git API/branch 查询和精确 credential helper 必须一致。不可把 3000 和 13000 做无差别替换；保留 Finding allowlist、来源映射和现有 Finding 交付路径。Gitea 本身、容器发布端口和外部 IPv6 转发均不在本次改动范围。

主 Brain API 为 loopback `13081`，DSH Web 为 `13080`，Mock 为 `18081`；通用端口 `13083/13093` 不动。DSH owner bearer、Gitea 账号/密码和服务私钥只保存在现有远端私有文件中；不写进 URL、浏览器、TaskSpec、命令日志或 Git。credential helper 只响应 TaskSpec 中精确仓库。

## 远端部署及回滚

部署前重新读取远端运行状态和被部署文件摘要，确认端口、进程工作目录、当前 owner/token 文件位置、数据库文件和 DSH profile。操作前备份主线代码、DSH profile、私有配置，以及使用 SQLite 一致性备份方法保存主 Brain 数据与 logs；备份目录与私有文件限制为 owner-only。现有代码副本不是 Git checkout，不能 `git pull`；过时的 `m1/remote-apply.sh` 和 `restart-dsh.py` 不能直接当成完整发布入口。

只替换主 `~/argon-m1` 中经审核的文件和主 DSH profile 中本项目拥有的服务/插件配置。停止主 Worker 后部署 Python Brain；重启主 API 与 Worker；最后重启主 DSH。保留 DSH Home、已有 Session、主 Brain database、沙箱登记簿及配置的 owner token。generic DSH/Brain、Mock、Gitea、socat 和 PR 不重启或改动。

若 API/Worker/DSH 未在 timeout 内健康，或原有任务读取/批准不满足预期，使用同次备份还原主代码与 profile 并恢复原进程；数据库没有兼容性变更时不替换数据库备份。部署脚本必须逐个明确文件和服务，输出不包含 token、cookie、credential 或 DSH 启动登录链接。

部署后只读检查：主 DSH 登录要求仍在；`/argon/` 静态资源加载；现有任务与工作项读取不受影响；仓库新页面加载，owner 无权时不能读写别人的登记；手工任务表/路由加载且空注册表状态正确；新增 Gitea API/credential helper 使用统一 origin；Finding 推送路由和原自动接管行为保持原样。验收不需要在远端创建模型任务、PR 或新沙箱。

## 可验证验收条件

1. 主任务和通用任务同列表工作，ARGON 与 MANUAL 的详情、消息、Session、沙箱、审批与交付路径正确分流。
2. 仓库注册、更新/停用、连接检查及手工任务创建都经过 owner 认证、幂等和 CAS；不信任用户输入的 URL、HEAD、凭据或越权范围。
3. TaskSpec digest 与规范化内容一致；审批、PLAN 修改/模型修订、CODE、candidate checks、独立 VERIFY、PR identity 全程绑定同一摘要。
4. command 与 JUnit 模式展示真实证据；baseline/skip/invalid/UNKNOWN 与构建错误遵循配置化门禁；测试改动和构建配置两层策略生效。
5. MANUAL PR 仅从已验证 SHA 创建，精确仓库凭据不泄露，重启可恢复 delivery；PR 人工合并且合并树匹配后仅完成 Work Item。
6. 原 Finding 推送入口的登录校验例外、自动批准/领取和来源 UI 行为与改动前一致；方案人工编辑与模型修订仍绑定准确的 plan hash 和 TaskSpec digest。
7. 只读工作台高亮和引用源行准确；未提交 Diff 更改生成新 ETag；页面卸载/切换工作项不收到旧异步响应；仍无文件写能力。
8. 本地新/现有测试覆盖关键差异；部署前记录当前已存在失败的名字和原因，不能把同步后未全绿的 Node/Python 套件说成通过。远端只做低风险只读验收。
9. 主实例部署与回滚均有安全回执；generic 实例与其原有数据库、TaskSpec、PR 和 Session 未修改。

## 尚需在实现前确定的实现细节

实现计划需根据主线当前未提交差异安排合并位置，避免覆盖计划编辑和来源推送代码。还需先对迁移后的固定 origin、Python/Node TaskSpec 字段一致性、自动化帐号仓库权限与 runtime 模板路径做接口映射。不得以 cherry-pick generic 独有的合并链条替代 selective integration；主线和 generic 两边均有用户未提交修改，编辑仅触碰实际要并入的文件，并保留其它变更。
