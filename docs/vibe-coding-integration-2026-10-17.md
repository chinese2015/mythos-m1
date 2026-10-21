# Vibe Coding 生产接入：只读切片实现（mythos-vibe）

日期：2026-10-17
分支：`vibe-coding-integration`（自 `codex/m3-pr-delivery` HEAD `2c45762` 切出）
范围：把方案 B PoC（`poc/vibe-coding-plugin/`，只读探针）推进为生产插件 `plugins/mythos-vibe/`。未修改 DSH 核心、node_modules、brain Python；未 commit。

## 交付内容

### 服务端（`plugins/mythos-vibe/service.mjs`，inject `webServer/connection/mythosWorkflow/mythosSdlc/mythosBrain`）

全部路由走 `connection.requestRejection` 登录/来源门禁，仅开放 GET（写方法 405）：

| 路由 | 语义 |
|---|---|
| `GET /mythos/vibe/tasks/:id/context` | 任务上下文快照：phase/blocked/paused/reason、plan/code Session 绑定、approval、candidateCommit、交付（PR）状态、sandboxId、operations。只读 `TaskWorkflow.snapshot`，绝不 Start/建 Session/触发模型 |
| `GET /mythos/vibe/tasks/:id/files?path=&offset=&limit=` | 任务沙箱只读文件：safePath → brain evidence 核验 `sandboxId` 绑定一致（502 `SANDBOX_BINDING_MISMATCH`）→ `dsh-fs-ssh` + `dsh-sandbox-policy` **read-only** 装配（LRU 8 会话/60s 闲置回收），容器内 realpath 逃逸校验（400），超 512KiB 拒绝 413，行窗口分页 + version + eof，对齐 DSH workspaceFiles 语义。SSH 不可用一律 502，**不降级读 Host** |
| `GET /mythos/vibe/tasks/:id/diff` | 任务 Diff：代理 brain evidence 的结构化 git 快照（base/head/branch/status/diff/changedFiles/testsChanged），`diffTruncated` 原样透传；ETag + If-None-Match → 304。不重开 Host change capture |
| `GET /mythos/vibe/bridge-browser.mjs` | 桥模块浏览器资产 |

### 客户端（`plugins/mythos-vibe/client.js`，dsh.client factory）

- 激活条件：URL 带 `mythosVibeTask=work-...`；否则静默不激活。
- 外壳：左侧文件列表（sourcePath + changedFiles，见"遗留"）/ 中间源码 + Diff + 运行区 / 右侧原生客户端不动。全部数据走本插件路由；context 2s 轮询，BLOCKED 显示 reason 横幅。
- 选区引用：`conversation.input.dock` + `inputActions`，poc `referenceText` 格式；binding generation 模式，迟到响应丢弃。
- 反向导航：`sidebarRightTabs.register` 资源处理器（`dsh-resource://file/**`）。
- **Run Monitor 挂载（切片3）**：中间区底部挂主线 `renderMonitor`，并修复全局选择器缺陷——签名改为 `renderMonitor(ctx, mount = {})`，`mount.container` 传入后所有迟到写入限定容器内、`isConnected === false` 跳过；不传时行为与原来完全一致（console 现有调用方未改，测试锁定）。
- **任务输入（切片5）**：派发走 `POST /mythos/api/work-items/:id/message`（主线持久化意图 + 阶段守卫，Idempotency-Key 与 console 一致），绝不用 PoC 的拦截 prompt 手法；服务端 409 的守卫原因直接展示。

### 部署接线

`configure_presets.py`：`make_task_services` 追加 `mythos-vibe`（SSH helper 参数与 `verify-candidate.mjs` 对齐：`node /usr/bin/node` + `helperHash`），清理 id 集合同步加入。

## 验证

- Node `node --test tests/*.test.mjs`：**119/119 通过**（原 106 未破坏；新增 safePath、三路由 handler、桥移植 6 组、monitor 挂载、client 冒烟）。
- 关键安全断言入测试：路径逃逸 400（含 resolve 后落出容器 root）、沙箱绑定不一致 502、未绑定 409、写方法 405、ETag 304；context 路由在 spy 会话门面上 create/prompt 零调用；插件 inject 不含 session 门面。
- `python3 -m py_compile configure_presets.py` 通过。
- **远程真实验收**（2026-10-17，hx-server，`tests/live_vibe_acceptance.py`，证据 `~/mythos-m1/state/vibe-acceptance.json` 0600）：已同步插件 + `configure_presets.py` 注册 + DSH 重启。Nova 工作项 `work-e0c22f1188d6495781d2c33659937fa5`（phase=PR_OPEN，sandbox `sb-f7ffb81208d043d6`）：未认证 401；context 200；diff 200（base `7fd32b05…` / head `4656408a…`，changedFiles 恰为 CatalogSearchService.java，ETag 重放 304）；**files 经 SSH 真实读取容器文件**（38 行 + 版本号）；逃逸/目录 400、缺失 404、POST 405、未知任务 404，全部符合预期。
- **浏览器 e2e**（2026-10-17，SSH 隧道 + 内置浏览器实测 Nova 工作项，截图 `artifacts/vibe-e2e-{shell,source,monitor}.png` 本地留存）：外壳激活（phase/version/已阻塞横幅）；源码区经 SSH 加载容器 CatalogSearchService.java（38 行 + version）；Diff 区显示分支/base/head/变更文件/测试未变更；运行区任务作用域挂载 Run Monitor（真实操作历史：基线失败、独立验证完成等）；输入"发送"被阶段守卫 409 拒绝（pendingMessage 与服务端状态核对无变化，符合 PR_OPEN 已发布预期）。
- **e2e 发现并修复 1 个真实缺陷**：`bridge-browser.mjs` 静态 import `./bridge.mjs`，浏览器解析为 `/mythos/vibe/bridge.mjs` 而服务端未提供该资产，导致 client 插件 apply 挂起、整个 DSH web boot 被阻塞（"did not activate … loading"）。修复：资产路由同时服务 `/bridge.mjs`，测试锁定。

## 边界与遗留（诚实清单）

1. ~~真实 SSH 沙箱验证~~ **已在远程验收**（见上）；Host/容器同名文件区分由 sandboxId 绑定核验 + 容器内 realpath 约束双保险，证据为经 SSH 读到的容器内容。
2. ~~浏览器 e2e~~ **已实测**（见上）；唯一未走的 live 路径是"引用选区插入原生草稿"——需要右侧选中本会话，由桥单测 6 组覆盖。
3. **文件树非目录树**：files 路由只接受普通文件；左侧为已知文件列表。后续可加目录列举路由。
4. **单窗口无 iframe**：同窗口运行，`acceptMessage` 保留在桥模块供嵌入场景，未在热路径使用。
5. **后续切片**（本文档范围外）：人工单写者接管、CAS 保存、旧验证失效与交还 Agent；M3 剩余流程沿用主线。

PoC 探针保持独立可丢弃，不被本插件替换或发布。
