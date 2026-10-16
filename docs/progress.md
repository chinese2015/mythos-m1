# Execution ledger — M1 Docker Sandbox PoC

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
