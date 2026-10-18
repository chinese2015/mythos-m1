# 通用任务与仓库接入设计

日期：2026-10-17。状态：用户已审阅并确认按设计实施，细化计划后直接执行，例行步骤无需再次确认。

## 目标与用户意图

用户已明确选择推进“通用任务与仓库接入”。目标是单 operator 从任务中心登记一个新仓库、描述任务和验收条件，批准只读方案后，由真实模型在独立任务沙箱中修改多个文件、补回归测试、独立验证并发布 PR。无需再修改 Finding ID、固定 SHA、源文件名或固定测试数量才能接入项目。

首版建议复用现有本地 Gitea、DSH 0.2.0-rc.2、M2/broker/Run Monitor/SDLC；其他 Git 平台保留适配边界。用户已确认首版先做现有 Gitea 的配置化接入；不新增外部账号或权限。已存在的 Nova/Pixel PR、Orion 待审批、原有 owner PoC 会话全部保留。

## 方案选择

1. **推荐：仓库登记簿 + 不可变 TaskSpec + 复用现有工作流。** 把特定项目参数从代码中移到受认证配置；M2 在创建任务时生成并持久化任务快照。现有编排、Session、执行与 PR 事实继续复用。
2. 扩展 Finding 映射表、允许手填 URL：改动少，但任务仍与漏洞来源耦合，难以形成可审查的权限与验证快照，不采用。
3. 新建通用工作流 DSL/引擎：可表达任意流程，但增加迁移、恢复和插件复杂度，不属于首版。

## 首版范围

- 页面提供“仓库”和“新建任务”入口。手动任务独立于 Finding，不需伪造 FND 编号或 Mock 记录。
- 支持当前连接中任意**已登记且现有凭据有权访问**的 Gitea 仓库；登记不授予 Git 服务器新权限。
- 仓库配置：显示名、连接 ID、仓库路径、默认分支、运行时 profile、基线/最终验证命令、报告策略、允许改动范围与是否允许测试变更。
- 新建任务：仓库及配置版本、标题、需求、验收条件、基线分支、改动范围；使用当前分支 HEAD 解析出的真实 SHA，或与所选分支当前 HEAD 一致的完整 SHA。
- 支持多个源码文件，以及明确批准范围内的回归测试变更；禁止依靠删除所有改动门禁实现“通用”。
- JUnit 策略支持正数测试数量，不再固定为 2；也提供明确标注的命令退出码验证模式，不把无报告显示为“测试全通过”。
- 同一任务的方案审批、执行、独立 B、PR、恢复、取消均走已有链路。通用任务人工合并并通过门禁后仅完成 Work Item；只有 Finding 来源才回写 Mock。

不包括：Jira/Teams/真实多用户认证、完整 IDE/人工编辑接管、任意 Git 服务的账号配置、生产部署、联网沙箱或自动安装未知依赖。首版的页面身份仍是明确标识的单 operator。

## 信任与配置边界

### 连接与运行时

服务端预配置连接 `local-gitea`，其 origin 为 `http://127.0.0.1:3000`，凭据引用现有私有文件。浏览器和模型不能提交凭据文件路径、SSH 主机、Docker socket、镜像名、任意宿主路径或替换连接 origin。URL 不含口令、用户信息、query、fragment；拒绝 file/任意 HTTP 目的地，避免将通用接入变成任意宿主拉取通道。

服务端运行时 profile 指向允许的沙箱镜像和可信依赖缓存。首版使用当前 Java 17/Maven/Node/Python 镜像；预置 Maven 依赖可用于实测。其他命令只有在该 profile 内运行时和依赖可用才可成功，不承诺任意 npm/pip 依赖开箱即用，也不因此开放容器外网。

### 仓库登记

登记动作由当前已认证 operator 发起，经现有同源/JSON/Idempotency-Key 门禁；owner 从服务端配置/私有 token 推导。M2 创建 repo ID、递增配置 revision，验证字段和登记所有权。新增配置版本不改写已有任务；停用只阻止新任务，已有任务继续按冻结快照运行，急停仍用现有 pause/cancel。

连接检查只做受限的 Gitea 元数据/权限和 Git ref 读取。Git 凭据始终留在宿主信任域，clone/push 使用固定 argv、隔离 Git 配置和限定目的仓库的 helper；不把密码复制到容器或 URL。旧 manifest allowlist 仅保留旧任务兼容，新增仓库走登记簿，不再让每个项目重复维护三处白名单。

## 领域与存储

增量增加 repositories 表，保存 owner、repositoryId、revision、enabled、配置 JSON、createdAt/updatedAt。写入采用 CAS 与业务幂等；不同 owner 无法列出/修改对方记录。连接私钥/密码不存表。

手动任务的 source 为 `{type:'MANUAL', id:'TASK-<server-generated>', revision:1}`，TaskSpec 是 Work Item 顶层不可变字段；不复用“尚未绑定沙箱的 DIRECT 会话”语义，不修改原 legacy DIRECT 行为。手动任务创建可在无 sandbox/session 时落库，后续 prepare 创建 A。

TaskSpec 至少包含：

- specVersion、repositoryId、repositoryRevision、ownerId；
- 已验证的 provider/cloneUrl/仓库路径/defaultBranch/基线 SHA；
- title、description、acceptanceCriteria；
- runtimeProfile、baselineCommand、verificationCommand、baselineMode；
- evidencePolicy（junit 或 command、报告目录、最小有效测试数量、skip 规则）；
- changePolicy（允许的相对路径/前缀、测试变更许可、受保护路径、文件数量上限）；
- canonical specDigest。

TaskSpec 由后端从有效仓库配置和经过验证的任务输入合成。创建后不能通过 workflow 更新接口替换。审批摘要必须关联 specDigest；M2 发布时重新从持久化 TaskSpec 检查，而非信任浏览器/模型提供的策略。不同幂等键的新任务可以来自同一仓库；任务分支使用 Work Item 唯一后缀，不复用一个固定仓库任务分支。

## 验证与改动策略

### 基线

通用任务默认 `record`：执行实际基线，记录通过/失败和证据，然后只读分析；不要求每个新需求必须先有一个已知名字的失败测试。可配置 `must-pass` 或 `must-fail`。JUnit 基线必须有有效报告和至少一项有效未跳过测试；最终 B 仍由冻结的 `minTests` 强制最低测试数，因此允许基线测试数低于新增回归后的最终验收数。超时、UNKNOWN、缺失强制报告或无有效测试均不能作为正常基线推进。

JUnit 项目的失败基线需要真实有效报告，环境错误不能伪装成 Bug 复现。命令模式如实显示“命令 exit N / 未提供 JUnit”，不编造用例数。旧 Finding 仍保持其已验证的固定失败契约，不因泛化放宽旧验收。

### 改动范围

允许路径使用受限的、可规范化的仓库相对路径/目录前缀，不接受绝对路径、`..`、NUL 或含糊的任意 glob。保护 `.git`、内部 `.cache`、路径逃逸；构建/CI 配置只有在仓库配置中显式登记、任务范围中显式批准时才允许修改，宽目录前缀不能被任务转换为额外配置修改权。

测试变更默认关闭，任务可在登记许可范围内显式启用并加入获批方案。保留改动文件清单、测试 Diff 和真实验证报告，交由 PR 审核；不声称自动证明测试未被语义弱化。范围属于候选/发布门禁，配合任务沙箱隔离；不宣称每一次沙箱内临时写入都能按文件策略阻止。

Git 路径检查应使用 NUL 分隔结果，包含删除/重命名，不依赖换行拆分文件名。候选必须提交、工作区干净、改动不越过冻结策略，才能进入 B；B 和发布服务再次验证精确 SHA 与相同策略。

### 独立验证与发布

B 继续从精确提交 bundle 重建，不复制 A 的 target/编译产物。验证命令、报告目录和策略来自冻结快照。JUnit 模式要求有效报告、达到配置的最小用例数且失败/错误为零；command 模式要求实际命令成功，UI/PR 明示报告类型。

PR 标题、正文、分支和校验使用通用任务标识与实际证据，不再硬编码 FND、Maven 或“两项测试”。同一候选/验证 ID 生成稳定 delivery ID；create-only push、分页对账、重开、重试、人工合并和代码树一致性门禁继续保留。

主分支在任务期间变化仍按现有严格合并树门禁处理，不自动冒充重验成功；首版发生冲突时显式阻塞，需重新固定基线/发起新任务，不暗中重放代码。CI/评审门禁可由仓库策略配置；未配置时如实显示 NOT_RUN，不宣称已通过。

## 接口与页面

受认证 M2 API：

- GET/POST `/api/brain/repositories`：列出/登记配置；
- POST `/api/brain/repositories/{id}/revisions`：CAS 新配置版本/停用；
- POST `/api/brain/repositories/{id}/check`：验证连接/读取 refs，限时、无模型与写操作；
- POST `/api/brain/tasks/manual`：创建冻结任务，需 repositoryRevision 与 Idempotency-Key；
- 现有 snapshot、prepare、sessions、workflow、operations、publish-branch 接口复用。

DSH console 同源代理提供对应 `/argon/api/repositories...` 和 `/argon/api/tasks/manual`，不把 M2 token/Git 密码交给浏览器。任务中心同时展示来源 Finding 和手工任务；新任务创建只持久化/排队，不因刷新再次 Start。详情显示来源类型、基线、允许改动范围、冻结验证策略、PLAN/CODE、Diff、真实运行日志与 PR。

新仓库配置表单说明验证命令运行在容器；报告模式、测试变更范围和配置版本可在创建前审阅。只读 PLAN → 显式批准 → CODE 的现有顺序不变。

## 兼容与迁移

1. 旧 ARGON/Finding Work Item 无需改写；由 legacy policy adapter 读出与当前相同的限制。
2. 新 MANUAL Work Item 用冻结 TaskSpec；BrainBridge 的 Session 绑定校验、TaskWorkflow 与 SDLC 明确识别两类受管任务。
3. 旧 DIRECT 会话与已有 sandbox preset 保持兼容。
4. 旧 PR 不重建、不重新推送、不自动合并。旧 owner 审批不被新配置覆盖。
5. 凭据 helper、broker clone、executor verifier、publisher、Node policy 共享同一已登记身份/冻结策略语义；通过跨语言 fixture 与真实链路验收防止只放开一层。

## 验收

- 从页面登记一个不在三条 Finding 映射中的仓库，不改 Python/JS 常量。
- 页面新建手工任务，包含需求、验收条件和改动范围；重复提交相同 key 仅一个 Work Item。
- 创建时固定真实分支 SHA；创建/查看页面不提前触发模型写入。读计划期间 Git 干净；审批持久化绑定 TaskSpec。
- 实际模型完成源码与获批回归测试变更（至少两个文件），不修改未批准文件。
- 验证至少一个非“2 tests”项目：建议复用现有 customer-api（原有 3 tests）作为非 Finding 的验收载体，不把 DEV-142 当作已连接 Jira。
- A 中的真实结果、精确提交、新 B 的成功结果与报告、实际 PR 都可观察。无报告/环境错/越界改动必须阻塞而非假成功。
- 仓库配置变更不影响已创建任务；错误 owner、未登记仓库、URL/路径逃逸、缺少凭据、旧版本、幂等键改参均拒绝。
- command 模式通过独立的小型 Node/Python 标准库项目验收真实退出码，清楚标明无 JUnit；不伪造测试用例统计。
- 重启后仍同一任务/Session/执行/PR；Nova/Pixel 已有 PR 和 Orion 待审批保留。
- 全量已有 Node/Python 套件维持通过；Maven overlay 未改时沿用其已验证结果，新增真实验收证据另存 state/artifacts。

## 自审结果

目的与范围：通用入口和策略配置，不顺带建设 Jira、SSO 或 IDE。主要接口依赖已列出；冻结策略、凭据边界、报告真实性和旧任务兼容作为必测项。首版 Gitea 范围已经用户确认。实现计划应拆分为契约/登记、Git与执行适配、工作流与SDLC、页面、真实验收五组，避免单个文件继续膨胀。
