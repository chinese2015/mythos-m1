# 通用任务与仓库接入 Implementation Plan

**Goal:** 在现有 Gitea 中从页面登记仓库、新建手工任务，使用冻结策略完成多文件/获批测试变更、独立验证和真实 PR。
**Architecture:** M2 持有仓库配置及不可变 TaskSpec；Git/执行端重验同一策略，Cordis 复用现有任务状态机。旧 ARGON/DIRECT 任务保留原语义。
**Spec:** `docs/superpowers/specs/2026-10-17-generic-task-intake-design.md`
**Execution:** 用户已确认按设计实施，细化计划后直接执行，例行步骤无需再次确认。使用 subagent-driven-development，实施任务串行，逐任务评审；独立目录 `/Users/lanw/IdeaProjects/hackathon/worktrees/generic-task-intake`，分支 `codex/generic-task-intake`，基线 `2c45762`。另一 agent 在原 m1 的 vibe-coding-integration 分支工作，不操作其文件/index/HEAD。

## Global Constraints

- 不改变已有 Nova/Pixel PR、Orion 审批、legacy DIRECT 会话。DSH 固定 0.2.0-rc.2；复用 M2、broker、snapshot/cursor、取消/UNKNOWN 语义。
- 仅预配置连接 local-gitea / http://127.0.0.1:3000；浏览器和模型不提供凭据路径、任意 origin、镜像名、SSH 目标或宿主路径。凭据留宿主，容器 network=none。
- TaskSpec 不可变，审批关联 specDigest；仓库更新只影响新任务。禁止放宽 legacy Finding 的固定验证契约。
- 新通用任务 source.type=MANUAL，id=TASK-加12位小写十六进制，revision=1。Work Item 仍为 work-32hex，先落库、后 prepare/Session/模型。
- 仅实际执行结果能通过；JUnit 需有效报告和配置最低数量，不固定 2；command 模式不展示伪造 JUnit 数量。
- 代码修改范围和测试变更许可来自冻结策略；候选和发布均检查；B 从精确 Git bundle 重建，不复制 A 构建产物。
- 仅已授权 Gitea 仓库；不新增企业 Git/Jira/SSO，不自动合并 PR。新增验收仓库必须是虚构样本。
- 所有实现先写失败测试、观察 RED、最小实现、GREEN、全量适当回归。独立提交，禁止 git add -A 混入别人的工作。

## Canonical Contract（所有任务引用，保持字段不漂移）

Repository input:
`{displayName,connectionId:'local-gitea',fullName:'demo/demo-customer-api',defaultBranch:'main',runtimeProfile:'java17-maven-offline-v1'|'standard-tools-v1',execution:{baselineCommand,verificationCommand,baselineMode:'record'|'must-pass'|'must-fail',timeoutSeconds:300,evidence:{format:'junit'|'command',reportDirs:['target/surefire-reports'],minTests:1,allowSkipped:false}},changePolicy:{allowedPaths:['src/'],allowTestChanges:false,maxFiles:100},reviewPolicy:{minApprovals:0,requiredStatusContexts:[]}}`。

Repository output:
`{repositoryId:'repo-'+32hex,ownerId,revision:1,enabled:true,config:<normalized input>,createdAt,updatedAt}`。
POST revisions body `{expectedRevision,config?,enabled?}`；返回完整最新记录。停用只阻止新任务。

Manual input:
`{repositoryId,repositoryRevision,title,description,acceptanceCriteria,baseBranch?,baseCommit?,allowedPaths?,allowTestChanges?}`。
baseCommit 可省略；若给出，首版必须等于所选分支当前 HEAD，陈旧/不匹配返回409。基线 SHA 总由 Gitea refs 读取验证；不接受未验证任意 SHA。

TaskSpec:
`{specVersion:1,ownerId,repository:{repositoryId,revision,connectionId,provider:'gitea',origin:'http://127.0.0.1:3000',fullName,cloneUrl,baseBranch},baseCommit:<40hex>,task:{title,description,acceptanceCriteria},runtimeProfile,execution:<frozen>,changePolicy:<frozen>,reviewPolicy:<frozen>,specDigest:<sha256>}`。
specDigest=SHA256(UTF8 JSON、递归键排序、无空格、ensure_ascii=False、不含 specDigest 本身)。只允许安全字段和有限相对路径/目录前缀，任务范围只能收窄仓库范围；测试许可不能从 false 扩成 true；任务省略 allowTestChanges 时默认 false，即使仓库允许。command 模式 reportDirs=[]、minTests=0；JUnit minTests>=1。reviewPolicy 默认 minApprovals=0/requiredStatusContexts=[]，minApprovals 0..20、contexts最多20条非空<=200字；TaskSpec冻结该值，人工合并/合并树一致始终强制，不能用配置关闭。禁止 `.git`/内部 `.cache`/路径逃逸；构建配置仅在批准范围明确覆盖时允许。

Manual Work Item:
顶层 taskSpec=上述冻结值，source={type:'MANUAL',id:'TASK-<12hex>',revision:1}，sourceRecord 提供 id/title/description/ownerId/repositoryUrl/baseCommit/revision，sourcePaths=允许范围，sourcePath=''（不假冒单文件），其余结构与 ARGON 受管任务相同。

## Review Focus

1. branch HEAD 在创建重试间变化：同 key 返回原任务/原 SHA，改业务参数409；网络失效也不能丢掉已受理任务。
2. 仓库配置更新/停用与任务创建竞争：CAS 拒绝陈旧 revision；已创建任务的命令/权限不漂移。
3. 跨 owner、未知仓库、URL/相对路径逃逸、配置文件路径注入在 Git/Docker/凭据读取之前拒绝。
4. 无 JUnit/损坏报告/旧报告/skip/命令失败不假成功；多个文件、删除/重命名及测试修改边界在 Python 和 JS 一致。
5. 注册/任务/发布的断线与重试不重复资源，源为 MANUAL 时不误写 Mock；legacy Finding 证据仍严格。

### Task 1: TaskSpec、仓库登记与手工任务 M2 API

**Files:** Create `brain/task_spec.py`, `brain/repository_store.py`, `brain/repositories.py`, `brain/git_host.py`, `tests/test_task_spec.py`, `tests/test_repositories.py`, `tests/fixtures/generic-task-spec.json`; modify `brain/store.py`, `brain/api.py`。

**Interfaces:**
- task_spec.py: `repository_config_from_spec(spec)->dict`（只从已校验冻结快照还原完整 transport config，不读最新Store配置）, `normalize_repository(config)->dict`, `make_task_spec(owner,repository,input,base_commit)->dict`, `validate_task_spec(spec,owner=None)->dict`, `is_manual(work)->bool`, `change_allowed(spec,paths)->bool`, `verification_passes(spec,operation,evidence=None)->bool`（精确候选、命令、报告/退出码、fresh B 关系在调用者提供时核验）。导出 legacy 对照所需纯逻辑，不导入 Store。
- RepositoryStore mixin 提供 `register_repository(owner,config,key)`, `repositories(owner)`, `repository(owner,id)`, `revise_repository(owner,id,body,key)`, `manual_retry(owner,input,key)`, `create_manual_task(owner,input,spec,key)`。使用 Store.connection/_retry/_remember/_event；Store 初始化增量建表，原数据不变。
- GitHostClient: `__init__(credential_file=None)`, `check(config)->{fullName,defaultBranch,pushPermission}`, `resolve(config,branch)->40hex`, `git_context(config)->{url:<canonical clone URL>,credentialFile:<private configured path>}`。默认私有文件 `~/gitea/secrets/argon-agent.json`；GET 使用 Basic、禁止重定向、超时/响应上限；仅既定 origin。懒读凭据，不打印 secret。
- RepositoryService(store,host=None): `register(owner,body,key)`, `revise(owner,id,body,key)`, `check(owner,id)`, `create_task(owner,input,key)`。create_task 先查 manual_retry，再读当前注册版本/真实 ref，构造冻结 spec；最后事务再验 repo revision/enabled。
- make_server 添加尾部可选 `repository_service=None`，不改变现有 positional publisher 参数。新路由 GET/POST `/api/brain/repositories`，POST `/{id}/revisions`、`/{id}/check`，POST `/api/brain/tasks/manual`。GET返回 `{repositories:[...]}`；任务 POST202。M2 owner与幂等契约沿用。

- [ ] 写真实临时 SQLite/HTTP 测试：登记/更新/停用、owner隔离、错误JSON/类型/路径、同key创建重试固定原SHA（host第二次改HEAD/失效仍复用）、改参409、配置CAS竞争、手工任务无资源分配、冻结快照更新不变；验证 digest/路径收窄/测试许可；shared fixture供JS消费。
- [ ] 跑 `python3 -m unittest discover -s tests -p 'test_repositories.py'` 与 `test_task_spec.py`，确认缺少模块/契约 RED。
- [ ] 实现上述模块。避免继续把全部业务写入 store.py；受管任务创建与现有事务、事件、幂等共存。
- [ ] 全部 `python3 -m unittest discover -s tests` GREEN；记录命令与数量，提交 `feat: register repositories and freeze generic manual tasks`。

### Task 2: 通用 Git、执行、报告与发布后端

**Files:** Create `brain/git_credentials.py`, `tests/test_generic_runtime.py`; modify `sandbox.py`, `brain/executor.py`, `brain/workspace.py`, `brain/container_runner.py`, `brain/worker.py`, `brain/publication.py`, `brain/__main__.py`, `brain/store.py`（仅submit额外门禁）；extend `tests/test_brain_executor.py`, `tests/test_brain_evidence.py`, `tests/test_publication.py`。

**Interfaces:** Consume Task1 TaskSpec、repository_config_from_spec、Store.repository、GitHostClient.git_context；legacy validate_repository(url)仍三仓库默认允许。新增 task-aware 验证入口，不能简单删除全局白名单。
- SandboxBroker.create 可增加 keyword-only branch='main',git_context=None；原三参数调用不变。手工任务 clone 使用批准分支和限定目的地的宿主凭据 helper，Git配置隔离，helper拒绝非精确目标，容器不含凭据。
- DockerExecutor 支持可选 store/GitHostClient，CLI/API/worker正确接线；取 spec 必须从持久化 Work Item，不信任模型传入 op 的 taskSpec。A/B 均使用冻结 repo/ref；fresh B 仍真实重建。legacy 无需新配置。
- TaskWorkspace prepare/evidence 支持 MANUAL 分支/范围；Git改动名用NUL结果，显示列表与策略可正确处理删除/重命名/奇异文件名。
- supervisor `capture_reports(workspace, report_dirs=None)` / `clear_reports` 支持冻结目录并保留原默认；不放松8份/256KiB、常规文件、symlink/FIFO/DTD约束。避免旧报告污染与路径逃逸。
- Worker 按 Work Item 策略判断 UNIT_TEST/VERIFY；command模式 evidence.junit=null，并保存 `validation:{format:'command',...}`，不伪造用例；legacy JUnit规则不变。未知/取消/清理语义不变。
- Manual VERIFY 提交/发布要求实际命令等于冻结 verificationCommand，精确 SHA、fresh B、合格报告/退出码及允许改动范围；私有 bare staging/create-only push与原幂等保持。

- [ ] 写失败测试：第四仓库通过登记可clone/verify/push、未登记/错误owner/恶意URL在I/O前拒绝；配置变更不改旧执行；3+ JUnit及command无报告成功/非零失败；超额/损坏/旧报告/skip拒绝；多文件/测试许可/越界/rename/delete路径一致；伪造VERIFY命令和A冒B拒绝；凭据helper用私有fixture按目标输出、未知目标无secret。
- [ ] 观察 RED，再做最小实现；不扩大容器网络或挂载。
- [ ] 跑 Python 全套 GREEN，Node套件确认未回归；提交 `feat: execute and publish task-specific verification policies`。

### Task 3: Cordis 通用任务工作流与 SDLC

**Files:** Create `plugins/argon-workflow/task-spec.mjs`, `plugins/argon-workflow/intake.mjs`, `tests/generic-workflow.test.mjs`; modify `plugins/argon-workflow/controller.mjs`, `session-policy.mjs`, `plugins/argon-brain/bridge.mjs`, `plugins/argon-sdlc/controller.mjs`, `gitea.mjs`, `policy.mjs`；extend相应Node测试。

**Interfaces:** Consume canonical fixture及 M2 API。`task-spec.mjs` 导出 `isManagedWork(work)`, `effectivePolicy(work)`, `candidateAllowed(work,git)`, `baselineReady(work,operation)`, `verifiedTaskCandidate(work,operation,git)`；legacy调用原规则，不重写三条Finding契约。`intake.mjs` 的 `TaskIntake(client)` 封装 repositories/register/revise/check/create；TaskWorkflow 暴露 intake。

- [ ] 失败测试：MANUAL进入列表/detail/PLAN/CODE并绑定正确Session；BASELINE按record/must-pass/must-fail推进；taskSpec摘要绑定审批和重启；多文件及获批测试进入B、越界阻塞；泛化prompt不再声称单文件/禁止全部测试；manual closure不调用Mock complete；Node/Python shared fixture结论一致。
- [ ] 修改状态机使用冻结命令、超时和报告策略；Baseline正常失败可进入只读研判但环境/UNKNOWN拒绝。CODE结束仍需提交和干净树，操作ID稳定。
- [ ] SDLC 对 MANUAL 使用其登记仓库身份和任务范围；GiteaClient仍仅当前连接，仓库许可由可信快照导入（task-scoped client或显式授权集合），不能接受浏览器任意repo。PR正文基于实际命令/报告类型/数量生成，不硬编码Maven或2 tests。MANUAL合并后只完成work，不写Finding；严格合并事实、代码树/人工门禁和PR重开/幂等保留。
- [ ] 全套 `npm test` GREEN，Python兼容回归；提交 `feat: run generic manual tasks through workflow and SDLC`。

### Task 4: 仓库登记与新建任务页面

**Files:** Create `plugins/argon-console/public/intake-view.js`, `tests/intake-console.test.mjs`; modify `plugins/argon-console/index.mjs`, `public/app.js`, `public/styles.css`；必要时小幅修改 `public/index.html`。

**Interfaces:** Consumes `workflow.intake` 与Task3受管任务列表。console代理 GET/POST `/api/repositories`、POST `/{id}/revisions|check`、POST `/api/tasks/manual`，全部先认证/同源/JSON/Idempotency门禁。静态资源登记 intake-view.js。

- [ ] 写 HTTP 失败测试验证代理、401/403/415、key/body/version透传；表单有效输入产生canonical request，无令牌/路径配置；断线/刷新重试同一表单保留业务幂等键，成功确认后才清除，改参需显式新意图，避免随机UUID重试产生重复任务。已有任务列表/详情回归。
- [ ] 页面提供仓库列表/登记/连接检查/版本更新和新建任务表单，显示策略与状态；标题/描述/验收、基线分支、允许范围、测试许可可审阅。列表同时显示Finding与手工Work Item，不重新Start；手工详情不显示虚假风险或单源文件。
- [ ] JUnit和command结果分别如实展示；报告缺失不渲染为0项通过。保留原生Session、Diff、Run Monitor、PR面板。
- [ ] Node全套 GREEN，页面实际检查/截图；提交 `feat: add repository registry and manual task intake UI`。

### Task 5: 非预设仓库真实验收与交接

**Files:** Create `tests/live_generic_intake.py`, `docs/generic-task-intake.md`; update本计划和progress；实际证据只写忽略的state/artifacts。

- [ ] 复核运行服务/并行Vibe工作是否占用同一部署目录，使用独立远程测试目录与端口或完成可审阅集成后部署；不要覆盖其他agent的未提交代码或停止其任务。
- [ ] 将虚构 customer-api（现有3 tests）放入当前Gitea的非Finding仓库；登记配置并由页面创建手工任务，验证真实 refs、key重放、配置冻结与owner门禁。此fixture不宣称Jira接入。
- [ ] 真实只读方案→批准→模型改源码并补获批回归测试（至少两文件）→3+ tests真实通过→精确候选独立B→PR保持开放。若模型异常如实记录阶段，不代写修复伪造模型成功。
- [ ] 小型标准库Node/Python仓库证明command模式：新B实际exit0，无JUnit不伪造用例；非零/UNKNOWN不能发布。至少包含一次失败/门禁路径真实检查。
- [ ] 重启/重复请求保持同任务/Session/operation/PR，旧Nova/Pixel/Orion数据不退化；检查新增任务与并行Vibe工作台适配边界。
- [ ] 最终合适回归、独立全分支审查、记录修复/裁定和限制，提交文档与探针；提供可访问入口及真实PR/证据。

## Self-review

Spec的每个范围均对应Task1–5；跨层关键接口固定在Canonical Contract。Task1→2共享task_spec/store/git_host，Task2→3共享冻结命令和证据，Task3→4共享intake入口，Task4→5依赖真实HTTP。只有顺序依赖，无并行实施共享文件。main工作区Vibe改动隔离；分支整合与发布在实际验收前检查外部状态。首版full SHA仅验证分支HEAD，避免未经授权的历史ref隐式读取；后续历史commit功能需显式扩展。
