# Execution ledger — M1 Docker Sandbox PoC

当前任务工作台入口与最新验收见 [task-workbench.md](task-workbench.md)。2026-10-16 的 Nova 任务已由真实模型完成只读计划、批准后编码提交和新容器独立验证，停在 AWAITING_REVIEW；浏览器视觉/点击验收因自动浏览器 URL 策略拒绝而未完成。

Plan: docs/sandbox-poc.md

Spec: ../Argon_AI_Brain_总体方案_v2.0.md §8.1 and user-approved Sandbox/native-capability/multi-user amendments.

- Ruling: use a new isolated m1 Git repository because the parent workspace is not a Git repository; no parent documents or credentials enter Git.
- Ruling: supersede host-only M1 execution with Docker A/B and concurrent owner-scoped Sandbox validation. Cost if wrong: revise adapters before full M1 coding.
- Ruling: two owner-labelled Sandbox tests do not prove multi-user sign-in; report authentication separately.
- Pre-flight: file and process providers must address the same task files. Web changes uses host paths, so test an explicitly shared per-task bind mount.
- Pre-flight: official SSH providers match 0.2.0-rc.2; validate them before developing new provider code.

## 2026-10-16 — PoC 验收闭环（远程 operator host 实测）

证据文件均在远程 `~/argon-m1/state/`，本目录 `state/` 不入 git。

- Step 1 完成：控制仓库 + 测试 + ledger；沙箱镜像 `argon-dsh-sandbox:0.2.0-rc.2`（rootless 运行时、sshd stdio transport、m2 种子缓存）。
- Step 2 完成（integration-probe.json，4/4 通过）：network=none、只读根、cap-drop ALL、2G/1cpu/pids 256；跨 owner stop 被拒（AccessDenied）；停一个 Sandbox 不中断另一个 30-tick 任务；同 owner 可多 Sandbox；宿主凭据、docker.sock、对方 workspace 在容器内均不可见；两容器私有 volume 无交集。
- Step 3 完成（native-smoke.json）：官方 `@deepseek-ai/dsh-{ssh,fs-ssh,subprocess-ssh,sandbox-ssh,sandbox-policy,bash-sandbox}` 经容器 SSH 并发加载，fs 读写互相隔离，`CONCURRENT_NATIVE_PROVIDERS_OK`。
- Step 4 完成：operator-bridge 在 Web Host 内创建真实 Session（preset argon-alice / argon-bob）。alice session 107 events / 19 tool calls（bash/read/edit/write），模型提交 `ce4181d`「FND-00009: fix SQL injection via PreparedStatement parameter binding」，diff 仅 `CatalogSearchService.java`（+14/-7）；bob 同流程 preflight 通过。host-changes 守卫使 Sandbox session 走容器内 inline diff，不污染宿主 change capture。
- Step 5 完成（verification.json）：候选 commit 经 git bundle 传入独立验证容器 B（alice/nova-independent-verification，sb-7190dbef0f534201），无 A 的 target/进程状态，`mvn -o clean verify` exitCode=0，收到 1 份真实 JUnit XML（TEST-com.example.catalog.CatalogSearchServiceTest.xml）。
- 缺陷修复：`change-boundary.mjs` 补 `guardToolCapture`（TDD：测试先行引用后实现），`shouldCapture` 增加 sandbox preset 短路（preset 命中即排除，不看 cwd）。测试套件在 operator host 全绿（node 0 fail；python unittest OK）。注意套件默认 root 依赖 operator host 的 `$HOME`，在 macOS 上跑路径类用例会失败，属预期。
- 验收结论：sandbox-poc.md 六项验收全部达成；身份认证仍按 Ruling 单独报告（共享 Web token 仅是 operator 入口，未宣称多租户登录隔离）。

- sandboxctl 插件落地（2026-10-16 下午）：broker 新增 `exec`（真实 exitCode JSON）/`status` 子命令；`plugins/argon-sandbox/index.mjs` 注册 4 个 Agent 工具（sandbox_create/exec/stop/status），owner 取自 `SessionHeader.agentPreset`（持久化字段，模型不可伪造），broker 二次校验；工具随 argon-alice/argon-bob preset 加载（runtime-diagnostic 全 ok）。无头探针实测：模型在真实 session 中实际调用了 sandbox_status/sandbox_exec（session-alice seq 116/122）。缺陷一处：`exec.agent.ctx.preset` 读取报 "cannot get property ... without inject"（Cordis ctx 代理限制），已改走 `exec.agent.session.header.agentPreset`；修复已提交，**待网络恢复后同步→重启→复测**。

- 全链路复测通过（v2–v8 无头探针）：status/exec/create/stop 四工具在真实 session 中全部实际调用成功——含真实 git log 输出、exitCode、**QuotaExceeded 策略门禁正确拒绝超额创建**、完整生命周期 create→exec→stop 闭环。过程中修复：argparse REMAINDER 吞尾参（optionals 必须先于位置参数）、broker exec 注入 git safe.directory、owner 解析改走 SessionHeader.agentPreset。遗留一个 DSH 行为待查：**工具返回的结构化对象在 result 投影中会被丢字段（含数组时整体变 {}），三个列表类工具已改返回 JSON 字符串规避**——M2 实现 Run Monitor 数据源时需查清该投影语义。

- **工具面交付并全链路验收（2026-10-16，v2–v10 探针）**：`sandbox_create`（含 repoUrl 克隆路径：工作区检出基线 commit、mvn 可用）→ `sandbox_exec`（真实 stdout/exitCode）→ `sandbox_stop` 全生命周期经 agent 工具闭环；QuotaExceeded 门禁实测拒绝超额。**当前运行时**：alice 活跃 sb-f4a61d0b6a3648c1（nova-poc，模型修复 commit ce4181d 所在）；bob 活跃 sb-af29940571fd4169；其余已 stop。owner 解析最终形态：preset config（operator 控制）为主、header.agentPreset 兜底。
- DSH 0.2.0-rc.2 已确认怪癖两条（M2 需处理）：① Web UI 建会话不在 header 持久化 agentPreset（工具组合正确但 header 记 standard）→ IdentityAdapter 不能依赖 header；② 工具 execute 返回的结构化对象经 result 投影会丢字段（数组整体变 {}）→ 工具一律返回 JSON 字符串，Run Monitor 消费事件流而非工具返回值。

## 遗留（带入 M2/后续）

- `guardToolCapture` 已导出并有测试，但上游 `@deepseek-ai/dsh-workspace-changes` 的 pre-execution capture 路径没有对外钩子，尚未接线；M2 自研 capture 插件时再接入。
- 沙箱容器无 restart policy，operator host 重启后需按 ledger 命令重建；registry DB（`~/argon-sandboxes/sandboxes.sqlite3`）是唯一事实来源。
- `state/` 证据只在远程 operator host；git 仓库不承诺可复现证据，只保证代码与测试可复现。
- DSH 升版前必须重跑本 PoC 全部证据链（developer preview，breaking changes 预期）。

## 2026-10-16 — 隔离结论评审与 plugin 抽象裁定

- 隔离结论：**基础设施层的拉取/修改隔离已闭环**——clone 独立副本（`--single-branch`，凭据留在宿主信任域，容器内无 git 凭据/docker.sock）、写入三重夹逼（独立 bind-mount、只读根、`workspace-write` policy）、宿主 change capture 被守卫、候选 commit 经 git bundle 在全新容器 B 独立复现（无 A 的 target/进程，`mvn clean verify` exitCode=0）。
- 边界裁定：隔离的是**执行环境**，不是**身份**；`owner` 目前是 operator 赋予的标签，`AccessDenied` 是 registry 层校验而非认证。信任域在 `hx` 这个 OS 用户（broker/registry/docker.sock 同域）；多真人 operator 互不信任时需拆 OS 账户，超出 PoC 范围。
- plugin 抽象裁定：采用**两层结构**。能力层继续复用官方 SSH provider 插件（不重写）；控制面层新写 `argon-sandbox` Cordis 插件（生命周期工具 create/execute/stop/verify + owner 绑定 + 策略门禁 + M2 接 Run Monitor 事件），经 **unix socket（peer creds 鉴权）** 调用外部 broker。**broker 不进 DSH 进程**——docker.sock 等于 root，不能与 Agent 执行面同进程（方案 §10 安全边界）。operator-bridge 文件桥即为该 socket 协议的 MVP。
- 下一步输入：控制面插件的工具契约 + socket 协议设计文档（M2 开发输入），待排期。
- 能力边界核定（实证，2026-10-16）：DSH 官方 `dsh-sandbox-*` 家族的 "sandbox" 是**调用级文件效果约束**（Linux bwrap/landlock、Windows ACL、SSH 远端复用宿主机本地后端），`dsh-bash-sandbox` 明示 *network access and process visibility remain outside its guarantees*；dsh core 无任何容器生命周期动词。端点**创建/停止/销毁/配额/owner 绑定/干净环境重建**在 DSH 能力之外，全部由外部 broker 补齐（互补关系，非重叠）。附注：`dsh-sandbox-local`（bwrap/landlock）将来可用于 DSH 宿主机非容器类工具（如浏览器工具）的同机约束，与容器方案构成两级。
- 设计文档产出：`docs/argon-sandbox-plugin-design.md`（M2 开发输入）——工具契约（create/exec/verify/stop/status/follow + cancel）、unix socket 协议（NDJSON + SO_PEERCRED + 事件订阅）、IdentityAdapter 接缝、PolicyGate 矩阵、迁移与双写比对计划、测试计划、4 个待拍板开放问题（首要是身份认证选型）。

## 2026-10-16 — M2 后端实现与远程验收

- 用户选择先实现 M2 后端；代码位于独立分支 `codex/m2-backend` 的 `brain/`，不更改已有 DSH 同步工具接口。设计与执行计划见 `docs/superpowers/`，操作与接口见 `docs/m2-backend.md`。
- SQLite WAL 事务存储：Work Item/source revision 去重、owner 绑定、乐观版本、请求幂等、ExecutionOperation、追加事件、日志与证据。快照和事件 cursor 在同一读事务取得；事件与事实更新在同一写事务提交。
- 独立 API/worker：HTTP 立即返回 operationId；容器内 detached root supervisor 管理 runner 命令，worker/API 重启后继续读取原任务，不重放命令。服务端私有 bearer 配置解析 owner；明确仍是单 operator OS 信任域，SSO/OS 权限隔离不在本交付内。
- 状态语义：取消先 CANCEL_REQUESTED，实际进程终止后才 CANCELLED；失败阻止后续自动调度，显式 resume 可继续已确认结束的失败；UNKNOWN 不自动重放，并隔离整个源沙箱，即使其他 Work Item 绑定同一沙箱也不派发。
- VERIFY：从 A 的精确 HEAD commit 导出 Git bundle，在新 B 检出并确认无 target；不复制 A 的未提交文件或缓存。Evidence 记录实际退出码、提交、JUnit 报告/计数与 SHA256、持久化日志 SHA256。成功后 AWAITING_REVIEW，不自动完成 Finding/创建 PR。
- 独立审查指出并修复 5 项问题，均补回归：失败/UNKNOWN 之后排队任务错误续跑；沿用旧 JUnit 造成假成功；FIFO 报告阻塞采集；setsid 子进程逃过取消；B 创建后准备失败丢失清理元数据。另由真实 Docker 实测定位 root 无 CAP_KILL，改用 runner 身份信号辅助进程，不扩大容器 capabilities；Linux subreaper 确认后代终止。
- 测试：macOS Python 50 项（49 通过、1 项 Linux 专属跳过）；远程 Linux Python **50/50**，Node **7/7**。M1 两项路径测试改为显式 fixture root，现已可在 macOS 验证。
- 真实远程验收证据：`/home/hx/argon-m1/state/m2-smoke-38c7ab654237/acceptance.json` 及同目录 SQLite。API 重开 + worker SIGKILL 恢复后执行计数仍 1；跨 owner 拒绝；取消实际 exitCode=-9；刻意失败 exitCode=23；新 B `sb-1c8be569640b48f9` 的候选 ce4181d 经 mvn test 得到 2 tests / 0 failures/errors；B 证据落库后清理；失去容器记 UNKNOWN。
- Maven 缓存缺口未掩盖：新 B 的 clean verify 真实记录 **FAILED / exitCode=1**，仍需后续修复镜像种子缓存。该失败不推翻单元测试通过，也不允许报告完整构建通过。
- 后端开发服务：远程 `127.0.0.1:3081`，运行目录 `/home/hx/argon-m1`，数据/令牌/进程记录在 `/home/hx/.argon-brain/`；凭据未输出或入 Git。临时探针 API/worker 已关闭、其容器已清理，保留原 alice/bob 两个沙箱。
- 后续接入：DSH 工具改走异步 API、Run Monitor 页面、主动来源订阅、Owner 审批、PR/SDLC；本后端不会自动捕获旧 M1 同步工具的执行。UNKNOWN 的手工解除隔离接口、真实多用户认证与主机开机自启尚未实现。

## 2026-10-16 — DSH M2 插件接入与生命周期验收

- 用户批准：插件管理 DSH 侧工具/命名服务/客户端/事件订阅；M2 API、worker、数据库、容器与已接收命令独立存续；DSH 核心继续管理 Session/workspace，不因适配插件卸载删除会话。
- 实现 `plugins/argon-brain/`：全局 `argonBrain` Cordis 服务与 per-preset 七工具 execution_run/status/follow/cancel、work_item_status/pause/resume。两个 operator preset 已加载。模型不能指定 owner、沙箱或会话；操作还必须属于当前 Session 的 Work Item，即使相同 owner 的两个会话也不能跨会话读日志/取消。
- SessionAdapter 经 DSH 原生 workspaceRegistry/sessionController 创建并绑定会话；稳定 operator requestId 对应稳定 Session，prepare 不触发模型，prompt 是显式服务端操作。启动/恢复只读快照与事件，不主动推理或重放命令。
- M2 幂等改进：expectedVersion 与逻辑业务请求身份分开；同一 DSH callId 在响应丢失、插件重载、版本变化后仍返回同一个 operationId。改变命令等业务参数仍拒绝。历史完整请求指纹仍支持原体重试。
- 审查问题已补回归修复：初始快照投递失败保持 pending 并重试；以 awaited Cordis parallel 处理异步订阅者，成功确认后推进游标；卸载释放等待中的订阅确认，阻止后续发射；非法快照游标不污染缓存；同 owner 跨会话测试现覆盖双方均已绑定的路径。
- 验证：本地 Node **22/22**，Python **53 项（52 通过 + Linux 专属 1 跳过）**；远程 Linux Node **22/22**、Python **53/53**。
- 真实 DSH Web Host 模型会话：`session-53eb9605-76b3-0196-c375-d3f39d222c1c`，绑定 `work-ea8baeb685e64a09a56fd5ba7d11efed`。journal 37 events；真实 execution_run seq16、execution_status seq29、execution_follow seq31，均无工具错误。执行 `exec-a082e7bfb6c84a7d98db437d58da07c7` 从 QUEUED 到 SUCCEEDED/exitCode=0，日志含 DSH_M2_BEGIN 与 DSH_M2_END。
- 新代码远程 Cordis 生命周期测试：`exec-5c801b7f9dab488abc31a84aa331c20d` 在插件卸载时仍 RUNNING；工具与服务确实移除；重载重试仍为同一 ID，最终 SUCCEEDED/0，起止标记各一次。证据 `state/brain-plugin-lifecycle.json`。真实模型证据 `state/brain-plugin-real-session.json`。
- DSH 重启后两个 Session/Work Item 关联保留，M2 API PID 113022、worker PID 95506 保持存活；验收用临时 operator 文件桥已卸载并移除 profile 条目，默认运行仅全局服务 + 两个 preset 工具插件。profile 备份：`state/profile-before-presets-1792133038.yml`。
- 用户使用入口及生命周期约定见 `docs/m2-dsh-plugin.md`。已有 M1 同步工具继续兼容但不会自动进入 M2；独立 Run Monitor 页面、通知/来源/审批、SSO、OS 权限隔离仍在后续范围。

## 2026-10-17 — PR 交付加固与真实验收收尾

- 代码加固（本地工作区，尚未 commit）：①首次 push 改 create-only CAS（`--force-with-lease` 空期望引用）——ref 读取后若被并发创建，push 失败报冲突而不是 fast-forward 覆盖他人提交（竞态回归测试 `test_first_push_cannot_fast_forward_a_ref_created_after_the_missing_ref_read`）；②Gitea 对账分页改"空页终止 + CI 状态按 total_count 对账"，修复服务端每页 cap（如 50）时丢失 closed PR 与最新评审的问题；③CLOSED_UNMERGED 的当前交付保持后台可观察：外部重开经 refresh 对账可回到 PR_OPEN，被新候选替代的旧交付拒绝恢复（409）。
- 测试：本地与远程 Linux 均 Node 59/59、Python 73/73 全绿（含上述新增回归）。
- 部署：tar 同步工作区至 `~/argon-m1`（备份 `~/backups/m1-pre-hardening-20261016T164417Z.tar.gz`、`~/.argon-brain/before-hardening-20261016T164528Z.sqlite3`）；M2 API/worker（`--per-owner-limit 3 --global-limit 4`）与 DSH 已用新代码重启，preset 诊断全 ok。Mock overlay（ai-completion + `@Version` 事务办结）确认已在运行 jar 中（405/404 探测 + zipfile 类清单）。
- 真实验收（plan 第 5 步核心）：经工作台 API 发布 Nova 候选一次 → Gitea **PR #2**（`http://127.0.0.1:3000/demo/demo-nova-catalog-api/pulls/2`，分支 `argon/fnd-00009-e0c22f11-4656408a3d0a`，head=已验证候选 `4656408a…`，body 含 `argon-delivery` marker）；相同幂等键重复发布返回同一 delivery；DSH 重启后对账仍只有一个 PR，交付停在 `PR_OPEN`。证据 `~/argon-m1/artifacts/pr-delivery-acceptance.json`（0600）。PR 保持开放等待人工合并；未自动合并、未写回 Finding（合并关单写回仅经受控 fixture 单测覆盖，待真实合并发生后观察）。
- 浏览器视觉验收（内置浏览器，复用 3080 隧道）：任务中心 FND-00009 显示 PR_OPEN 徽章；工作详情「PR 交付与审核」面板渲染正确（候选/分支/PR 链接/刷新按钮/三项门禁结果/CI 未配置如实显示"暂无检查记录"）；CODE 会话提示只读。限制：PR 链接指向 `127.0.0.1:3000`，本机未建 3000 隧道时点击打不开（环境限制，非产品缺陷）。
- 遗留：本地加固改动待 commit；合并后 ai-completion 写回 Mock 的真实链路待人工合并 PR #2 后验证；浏览器 iframe 内原生会话交互未逐键复核。

## 2026-10-17 — Run Monitor 最小完整链路（M2 收口）

- 设计与计划：`docs/superpowers/specs/2026-10-17-run-monitor-design.md`、`docs/superpowers/plans/2026-10-17-run-monitor.md`。方案：纯轮询不推送——console 新增只读代理 `GET /argon/api/work-items/{id}/events?after=N`（TaskWorkflow.events 转发 M2 游标接口），前端新增 `monitor-view.js`（视图）+ `monitor-state.js`（纯函数，node 直测），游标状态存模块级 Map；整页重开 = after=0 全量拉取，天然恢复观察。
- 提交：`add6a19`（events 代理 + 401/400 用例）、`7ae3950`（monitor-state 纯函数 + 8 项单测，含 CANCEL_REQUESTED≠CANCELLED、乱序去重、折叠输出）、`276a636`（monitor-view + app.js/index.mjs/styles.css 集成）、`c4eef8e`（评审修复：用户手动收起的日志盒不再被自动展开覆写，shouldAutoExpand）。
- 测试：Node 68/68、Python 73 项（72 通过 + 1 Linux 跳过）本地与远程均绿（`tests/monitor-state.test.mjs`、`tests/task-controller.test.mjs` 新增）。
- 部署：tar 同步 + 仅重启 DSH（M2 无改动）；冒烟：events 代理 200（200 条事件 + nextCursor）、monitor-view.js 200。
- 真实验收（证据 `~/argon-m1/state/run-monitor-acceptance.json`）：① 实时日志尾随（tick 每 3s 增长）+ 输出事件折叠（"已折叠 N 条输出事件"）；② 运行中关标签页 15s → 全新页面恢复观察（运行中 + 取消按钮 + 事件流续载）；③ 浏览器取消 → 已取消 + 退出码 -9，QUEUED 取消 → "Cancelled before dispatch"（CANCEL_REQUESTED 亚秒窗口由单测+事件流锚定）；④ worker SIGTERM+重启 mid-RUNNING → 容器命令存活、新 worker 对账续观察、最终 SUCCEEDED/0、零重复执行；⑤ 失败不假成功：监控内基线 FAILED/退出码 1 红色实况 + M2 `exit 23` → FAILED/23。
- 验收中发现既有行为（非本功能引入）：PR_OPEN 期间 Nova 工作项 `blocked=True`（PLANNING 时代 block() 遗留，`update()` 默认保留旧值），`claim_next` 跳过其新操作；worker 重启对账因此改在 PoC 工作项验证（机制相同）。console 工作详情只服务控制台创建的工作项（既有边界）。
- 明确不做（本切片）：多任务监控大盘、主动通知/审批页（M3 剩余）、Cordis 推送订阅、SSE/WebSocket。

## 2026-10-17 — M3 订阅、规则研判与 Owner 审批接管

- 接续登记簿提交 `487e78f` 完成订阅插件、通知预览 overlay、控制台审批与 fail-closed 启动门（`4ff234b`、`390033e`、`1c028b8`）。API 补持久化通知结果、lastError 和 revision 防倒退。
- 独立审查 3 项 Important 均以 RED→GREEN 修复（`63d8e12`）：审批绑定不可变；通知绑定变化后重新生成；预览已落盘但响应丢失时，文案变化不使重试永久冲突。浏览器实测还定位并修复原生会话 catalog 同步回调递归，Pixel iframe 已正确显示 Pixel 计划。
- 之前 agent 遗留的 PR 加固也已验证并提交 `25d4615`：分页 cap、关闭重开对账、首次分支 push CAS；原 Nova PR #2 仍为 PR_OPEN。
- 最终回归：本地 Node 81/81、Python 86（85 pass + Linux-only 1 skip）；远程 Node 81/81、Python 86/86；Java 16/16，部署 JAR 与受测 JAR 一致。
- 真实 M3 前半程：Orion/Pixel 自动 CONFIRMED，各生成一个本地 outbox 预览；浏览器批准并启动 Pixel；Orion 直接 start 409，仍 Not Started 无工作项；重复启动 Pixel 同一 Work Item；服务重启后无重复预览，Nova 原交付保留。
- Pixel `work-466690061b6c4ed492e2f41ab94f8dda`：真实 Maven 基线 2 tests/1 traversal failure/exit 1 后进入只读 PLAN；Kimi 首轮返回 403 周额度耗尽，0 model tokens，流程保持 BLOCKED，Git 干净且 HEAD 等于基线。未完成模型方案/修复/独立验证/Pixel PR，不作端到端完成宣称。
- 证据：远程 `~/argon-m1/state/m3-acceptance.json`；本地 `artifacts/m3-task-center.png` 与 `artifacts/m3-pixel-blocked.png`。实现与恢复说明见 `docs/m3-proactive-workflow.md`。通知仅本地预览、未向真人投递；真实多用户认证仍未实现。
