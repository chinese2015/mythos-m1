# 通用仓库与手工任务接入

这条链路把已登记仓库、真实基线和任务策略冻结为 TaskSpec，再复用 PLAN → 人工审批 → CODE → 独立 B 验证 → PR 流程。首版是单 operator、本地固定 Gitea 和隔离容器；不是 Jira/Teams/SSO 接入、DevVM 或可手工编辑文件的 IDE。

## 从页面开始

1. 在已登录的任务工作台进入「仓库与新建任务」。登记 `owner/repository`、默认分支、运行时模板、基线/验收命令、报告策略和有限改动范围。连接固定为 `local-gitea`，页面不接收口令、凭据文件路径、镜像名或任意 Git origin。
2. 使用「连接检查」确认预配置自动化账号对仓库具有读取和推送权限。登记不会授予 Git 权限；账号必须已被 Gitea 仓库授权。检查结果只对当时的配置和 revision 有效，配置变化后须重新检查。
3. 新建任务，填写标题、描述、验收标准，审阅基线分支、改动范围及测试许可。创建时服务端读取真实分支 HEAD；手填的完整 SHA 必须等于该 HEAD，陈旧值返回冲突。
4. 查看真实基线、只读 PLAN 和冻结策略；显式批准当前方案后才允许 CODE。批准绑定当前 `specDigest`，刷新或恢复不能替换这份策略。
5. 查看已提交候选、真实 Diff、独立 B 的操作/日志/证据。验收通过后发布 PR，由人审核并合并。服务不自动合并；合并树必须与已验证候选一致。

任务详情保留原生 DSH Session 链接和 iframe。Session 标题旁另有「只读编码工作台」入口，同源绑定当前 Work Item 和所展示 Session；打开入口不会创建或提示新会话。它展示受限文件/变更、源码、Diff、运行区，选区可引用到原生草稿；它没有手工文件写入/CAS，也不提供完整目录树。PLAN/CODE、Session、Run Monitor 与 PR 仍走原有受管链路。

## 两种运行与证据方式

| 配置 | 使用方式 | 验收依据 |
| --- | --- | --- |
| `java17-maven-offline-v1` | Java 17/Maven 离线缓存模板 | 可配置 JUnit 报告目录、有效测试最少数量、skip 规则；不固定为两项测试 |
| `standard-tools-v1` | 镜像中已有的 Node/Python 等标准工具；适合无第三方依赖的小项目 | 可选择 `command` 模式，实际命令 exit 0；`reportDirs=[]`、`minTests=0`、`junit=null` |

模板只保证既定镜像和可信缓存中已有的工具/依赖；不开放容器外网或自动安装任意 npm/pip/Maven 依赖。命令在隔离容器中执行。缺失/损坏的 JUnit 报告会明确显示缺失/无效，不把空报告说成「0 项通过」。命令模式显示真实退出码，不编造 JUnit 数量。

基线模式可选 `record`、`must-pass`、`must-fail`。`record` 记录真实成功或失败，不要求每个新需求预先有固定名字的失败测试。环境错误、UNKNOWN、缺少强制报告或没有有效测试不能作为正常证据推进。最终 B 必须从精确候选重建，不复用 A 的构建产物。

## 权限、范围和配置版本

- 允许范围是有限仓库相对文件名或以 `/` 结尾的目录前缀，不接受任意 glob、绝对路径、逃逸、`.git` 或内部 `.cache`。
- 仓库测试许可只是上限。**每个任务必须显式勾选允许测试修改**；任务省略该选项时始终为 false，即使仓库允许。获批方案还应说明实际测试 Diff，最终仍需人工评审，自动检查不证明测试未被语义弱化。
- 构建/CI 配置必须被仓库和任务两层范围分别明确批准。宽泛 `src/` 不能通过任务收窄为 `src/pom.xml` 而获得原本没有的构建许可。
- 更新配置生成新 revision；停用阻止新任务。已经创建的任务继续使用原冻结仓库 URL、分支、SHA、命令、改动/报告/评审策略，不能被最新配置覆盖。急停仍使用 pause/cancel。
- 凭据留在宿主私有文件；clone、查询和 create-only push 使用精确仓库限定的 helper，不把密码放入 URL、SQLite、容器 Git 配置或浏览器。

评审策略可要求独立批准数量及成功 CI contexts。没有配置的 CI/评审门禁如实显示未配置/NOT_RUN；不宣称 CI 已通过。人工合并、精确候选和合并树一致始终强制。手工任务完成后只完成 Work Item，不伪造 Finding 或回写 Mock 来源。

## 重试、恢复和失败状态

同一业务意向在确认响应前复用一个持久化 key，页面重载也保留。确认丢失时先查询原任务，再用相同内容重试；换内容会要求显式「放弃当前意向」。存储不可用、不可读、不可写或内容损坏时页面停止 mutation，不换随机 key。不要因超时就盲目放弃未确认意向。

已记录的 FAILED/CANCELLED 可能把 Work Item 的执行派发置为 blocked，而模型工作流仍显示 CODING/PLANNING；QUEUED 表示尚未运行。页面会解释这一差异。仅在存在已确认终态失败、没有 UNKNOWN 或进行中执行、工作流不是 BLOCKED 时，提供「检查后恢复执行」。操作员应先核对日志、当前已提交候选以及排队操作的命令/sourceCommit，再确认调用现有 `/resume`。这不会重放失败操作、把失败验证改为成功或解封 UNKNOWN；后续仍要满足原有独立验证和发布门禁。UNKNOWN、工作流 BLOCKED 或准备结果不确定，应先处理实际原因，不能自动恢复。

任务/Session/执行/交付意向持久化，重启后应对账恢复同一身份，而非重建资源或重推旧 PR。重启稳定性需要单独的前后回执证明，不能由页面仍可访问推断。

## 只读证据 CLI

在隔离 operator checkout 根目录运行：

```sh
python3 tests/live_generic_intake.py \
  --owner alice --work-id "$CUSTOMER_WORK_ID" --work-id "$COMMAND_WORK_ID" \
  --allow-in-progress --output artifacts/generic-progress.json
```

默认只读取 API `127.0.0.1:3083`、console `127.0.0.1:3093`、固定 Gitea `127.0.0.1:3000`，数据根 `~/.argon-brain-generic`、运行根 `~/argon-m1-generic`、沙箱注册表 `~/argon-sandboxes-generic`。可显式传 `--runtime-root`、`--data-root`、`--sandbox-root`、`--api-origin`、`--console-origin`。`--console-log` 默认运行根的 `state/dsh.log`；脚本从私有启动日志取登录信息建立 cookie，不打印或保存登录 URL/token。Git 凭据默认现有私有自动化账号文件，可用 `--credential-file` 指定私有文件。

可以重复 `--state-receipt <private.json>` 从已有回执中的 `workItemId/workId` 提取目标，也可用 `--expected-digest WORK_ID=SHA256` 绑定事先记录的冻结摘要。脚本不创建任务/沙箱/PR、不批准、不提示模型、不重启、不写候选，只 GET 并生成一个新私有 JSON 回执；已存在的输出文件不会覆盖。

回执校验当前 owner/TaskSpec、审批 digest、干净精确候选、允许路径、当前 A 与 fresh B、真实 VERIFY、独立 Gitea PR 的精确 head 和唯一 delivery marker、B 清理状态。Customer 验收额外要求至少四项有效测试、至少两个文件且含测试变更；command 验收要求实际 exit 0、明确 `junit=null`。PR 保持开放。已有 admission/approval/fixture/restart 等私有回执只附安全文件名、大小和 SHA256 引用，不复制原始日志/配置内容。

退出码 0 仅表示本次「已有任务验证与开放 PR」检查全部通过；2 为未就绪，`--allow-in-progress` 的明确未完成抓取返回 3，工具/私有输入错误为 1。缺失门禁显示 FAIL/NOT_RUN，不能作为通过。回执始终注明 `task5Complete=false`；旧 legacy 保留、重启和最终评审仍要独立证明。证据默认落在忽略的 `artifacts/`，输入回执在忽略的 `state/`；文件为 0600，不把秘密提交到 Git。

## 当前实际证据与未完成项（2026-10-17）

隔离实例使用 3083/3093，主 3080/3081 保留。Customer 已通过实际 UI 登记/创建；相同 key 返回同一任务，改参 409、停用后新任务 409、错误 owner 404、过早发布 409，证据在 `state/customer-admission.json`。PLAN 已完成并由受认证控制台审批，绑定冻结 digest；浏览器原生确认自动化超时后，使用的是同一受保护审批 API，未绕过业务门禁。

父任务已记录两条模型产出的真实候选与工作流独立验证：

| 任务 | 候选 | 已观察到的独立 B 结果 |
| --- | --- | --- |
| Customer | `83e5b21ca645f6688560b974c4c0983c73358b67` | VERIFY `exec-c0067dd449f84bc0bc46f1fc06fdccf5`，JUnit 4/0/0/0，cleanup done；源码和新增回归测试两个文件 |
| Command | `f6a2f353f5d09460eef45c00f8b3147c67bb6207` | VERIFY `exec-71795ff6d9a6497c8f4238824b722504`，实际 exit 0、`junit=null`，cleanup done |

Customer 的原始三项测试基线真实 exit 1。第一次错误地验证未提交候选前的旧基线也真实失败并阻塞派发；操作员核对后显式恢复，随后才获得上述成功 B，见 `state/customer-known-failure-resume.json`。运行期间登记簿被改为 R2、不同 fullName/命令且停用；旧任务仍使用冻结 R1 仓库和策略，首个真实 B 已证明旧仓库可构建。Command 原始基线同样真实 exit 1，证据是 command 格式而非假 JUnit。

父任务随后通过独立 Gitea GET 确认两条真实 PR 均保持 open/unmerged、头 SHA 等于上表候选、各恰有一个匹配 delivery marker：

- [Customer PR #1](http://127.0.0.1:3000/demo/demo-customer-api/pulls/1)：delivery `50c3420ec2f0b79104f68e6d9a7969ec9c97653d9e43a2535ad8ea152288bd3c`，4 个操作、2 个 Session；回执 `state/customer-pr-confirmation.json`。
- [Command PR #1](http://127.0.0.1:3000/demo/demo-manual-command/pulls/1)：delivery `818f9c20d9ab5f4070fdf2e14f0f407e06463ddcdd32f637f4e9374a21f101ac`，2 个操作、2 个 Session；回执 `state/command-pr-confirmation.json`。

独立 C 中只替换获批测试、保留原始基线源码的探针，真实运行四项测试、两项失败，包含新增回归；A 未改变，C 已停止，证据 `state/customer-regression-red.json` 及相邻 XML/log。初次探针缺少 Maven 环境选项的错误也保留记录，没有冒充回归 RED。人工合并和合并树一致门禁仍开启，PR 未自动合并。

**尚待父任务收齐：**最终浏览器/只读编码入口检查、重启身份/不重复资源证明、旧 legacy 保留、最终广泛评审。登记簿可在冻结证明后恢复新 revision 的启用配置，旧任务仍保持 R1。这份文档不宣称整个 Task 5 或端到端验收已经完成；新增实际回执后再补结果。
