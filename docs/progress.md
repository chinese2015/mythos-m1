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

## 遗留（带入 M2/后续）

- `guardToolCapture` 已导出并有测试，但上游 `@deepseek-ai/dsh-workspace-changes` 的 pre-execution capture 路径没有对外钩子，尚未接线；M2 自研 capture 插件时再接入。
- 沙箱容器无 restart policy，operator host 重启后需按 ledger 命令重建；registry DB（`~/argon-sandboxes/sandboxes.sqlite3`）是唯一事实来源。
- `state/` 证据只在远程 operator host；git 仓库不承诺可复现证据，只保证代码与测试可复现。
- DSH 升版前必须重跑本 PoC 全部证据链（developer preview，breaking changes 预期）。
