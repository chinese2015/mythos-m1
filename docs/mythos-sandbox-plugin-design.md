# mythos-sandbox 控制面插件设计 — M2 开发输入

**日期**：2026-10-16
**状态**：评审稿（待用户与接手团队评审）
**前置**：M1 Docker Sandbox PoC 已闭环（见 `progress.md` 2026-10-16 两节）
**依赖裁定**：plugin 两层结构（progress.md「隔离结论评审与 plugin 抽象裁定」）；DSH 官方 sandbox 家族能力边界核定（progress.md 末条）
**业务归属**：方案 v2.0 §9 中 `mythos-execution` 模块（P0）的核心组件

---

## 1. 目标与范围

把 PoC 中"operator 手工 CLI + 文件桥"的临时形态，升级为**可复用的 Sandbox 控制面**：

- DSH Session（Agent）能通过标准工具面申请、使用、释放隔离执行环境
- 容器生命周期权限（docker.sock）始终留在 DSH 进程之外的独立 broker 进程
- owner 绑定、配额、审计、事件流为 M2 Run Monitor / Task Hub 提供数据源
- 现有 M1 资产（registry DB、broker 代码、镜像、preset）全部复用，不停机迁移

**非目标**：

- 不实现能力层（fs/subprocess/bash 执行仍由官方 `dsh-*-ssh` 插件负责）
- 不实现身份认证本身（定义 IdentityAdapter 接缝，具体 SSO/账号方案评审时定）
- 不做多机 broker 调度（单 operator host；多 host 是后续演进）
- 不覆盖方案 §7 Remote Dev VM（broker 的 profile 机制为其预留扩展点）

## 2. 总体架构

```text
┌─ DSH Web Host 进程（node，hx 用户）─────────────┐
│                                                  │
│  mythos-sandbox 控制面插件 (Cordis)                │
│  ├─ IdentityAdapter   session → owner            │
│  ├─ PolicyGate        quota / 白名单 / 审批      │
│  ├─ Tool Surface      model-facing 工具          │
│  ├─ EventBridge       broker 事件 → DSH 事件     │
│  └─ BrokerClient      unix socket JSON-lines     │
└──────────────┬───────────────────────────────────┘
               │ unix domain socket
               │ /home/hx/.mythos/sandbox.sock
               │ SO_PEERCRED 鉴权 + 0700 目录
┌──────────────┴───────────────────────────────────┐
│  mythos-sandbox-broker（独立进程，hx 用户）        │
│  ├─ socket server   请求/响应 + 事件订阅          │
│  ├─ Registry        sandboxes.sqlite3（沿用）     │
│  ├─ ContainerOps    create/stop/exec/verify      │
│  ├─ AuditLog        append-only JSONL             │
│  └─ ImageGuard      镜像白名单 + helper hash 校验 │
└──────────────────────┬───────────────────────────┘
                       │ docker.sock（仅此进程可触达）
              ┌────────┴─────────┐
              │ mythos-sb-* 容器   │ × N（network-none、只读根、cap-drop）
              └──────────────────┘
```

信任域：DSH 进程被 prompt injection 打穿时，最坏获得的是"以某 owner 名义申请沙箱"的工具面；docker.sock、宿主凭据、registry 写权限不进入其攻击面。

## 3. 工具契约（model/session 面）

插件向 Agent 暴露以下工具（命名对齐 DSH 工具风格，最终名以 DSH 0.2.x 工具注册 API 为准）：

### 3.1 `sandbox_create`

```
{
  "workspaceId":  "nova-fix-1",        // 必填，[a-z0-9-]，与 Work Item 对应
  "repoUrl":      "http://127.0.0.1:3000/demo/demo-nova-catalog-api.git",  // 可选
  "profile":      "java17-maven"       // 可选，默认；白名单见 §6
}
→ { "sandboxId": "sb-...", "workspacePath": "...", "state": "running" }
```

- 幂等：携带 `Idempotency-Key` 时，相同 key 返回首次创建结果（registry 增列 `client_request_id UNIQUE`）
- 门禁：owner 配额（默认 2）/全局配额（默认 4）/profile 白名单/repo 白名单（默认仅限 `demo/` org）
- 拒绝即失败，不创建半成品；失败路径沿用 PoC 的 cleanup 语义（registry 记 `failed`）

### 3.2 `sandbox_exec`

```
{ "sandboxId": "sb-...", "command": "mvn test", "timeoutMs": 60000 }
→ { "operationId": "exec-..." }     // 异步，结果走事件与 follow
```

- 每次执行产生一条 ExecutionOperation（方案 §4 `ExecutionOperation`），持久化 `QUEUED→RUNNING→SUCCEEDED/FAILED/CANCELLED/UNKNOWN`
- `UNKNOWN` 是合法终态：broker 与容器失联时不得猜（方案 §6.2 状态陷阱）
- 取消：`sandbox_cancel {operationId}`，返回 Cancel Requested，不承诺已停止（方案 §4.4）

### 3.3 `sandbox_verify`

```
{ "sandboxId": "sb-...", "fromCommit": "<sha>", "testCommand": "mvn clean verify" }
→ { "operationId": "exec-...", "verifierSandboxId": "sb-..." }
```

- 即 PoC `prepare-verifier.py` + `verify-candidate.mjs` 的产品化：从 `fromCommit` 重建**干净容器 B**（无 A 的 target/进程状态），检出候选 commit，执行测试
- 产出 Evidence（方案 §4）：`exitCode`、JUnit XML、日志、工件 SHA，按 `operationId` 索引

### 3.4 `sandbox_stop` / `sandbox_status` / `sandbox_follow`

```
sandbox_stop   { "sandboxId": "sb-..." } → { "state": "stopped" }
sandbox_status { "sandboxId": "sb-..." } → 完整记录 + 活跃 operations
sandbox_follow { "operationId": "...", "cursor": "<opaque>" } → { "lines": [...], "nextCursor": "..." }
```

- owner 校验：全部操作先过 `ownerId = IdentityAdapter(session)` 再查 registry（沿用 PoC `AccessDenied` 语义）
- `sandbox_follow` 的大日志只回传尾部与索引（方案 §4.2）

### 3.5 工具不可见面

broker 维护类操作（list_all、force_cleanup、镜像加载）**不注册为 Agent 工具**，仅经 socket 由 operator CLI 使用。Agent 面只有 §3.1–3.4。

## 4. socket 协议（插件 ↔ broker）

- 路径：`/home/hx/.mythos/sandbox.sock`；目录 `0700`、socket `0660`，属主 `hx`
- 帧格式：newline-delimited JSON；单条消息 ≤ 1MB，超限用 `follow` 游标
- 鉴权：`SO_PEERCRED` 校验 uid 属白名单（默认仅 `hx`）；未来多 operator 拆 OS 账户时此校验即为边界

### 4.1 请求/响应

```json
// request
{"id": "req-01", "version": 1, "op": "sandbox.create",
 "ownerId": "alice", "params": { "workspaceId": "nova-fix-1", "repoUrl": "..." },
 "idempotencyKey": "wi-142-create-1"}
// response
{"id": "req-01", "ok": true, "result": { "sandboxId": "sb-...", "state": "running" }}
// error
{"id": "req-01", "ok": false, "error": { "code": "QUOTA_EXCEEDED", "message": "...", "retryable": false }}
```

### 4.2 事件订阅

连接可声明 `"subscribe": ["sandbox", "execution", "audit"]`。事件 envelope 对齐方案 §4.2 统一事件契约：

```json
{
  "eventId": "evt-...", "schemaVersion": 1,
  "workItemId": "WORK-142", "sequence": 42,
  "type": "execution.started", "occurredAt": "2026-10-16T09:20:00Z",
  "source": "mythos-execution", "correlation": { "operationId": "exec-...", "sandboxId": "sb-..." },
  "payload": { "environment": "DOCKER_SANDBOX", "status": "RUNNING", "sourceCommit": "..." }
}
```

`workItemId` 由调用方（Workflow 层）注入；broker 不感知 Work Item 语义，只透传 correlation。

### 4.3 错误码

`ACCESS_DENIED`（peer/owner）、`QUOTA_EXCEEDED`、`NOT_FOUND`、`INVALID_STATE`（状态机拒绝）、`PROFILE_FORBIDDEN`、`SANDBOX_UNAVAILABLE`（镜像/守护进程异常）、`TIMEOUT`、`INTERNAL`。UNKNOWN 场景以 `status=UNKNOWN` 出现在记录与事件中，而非错误码。

## 5. IdentityAdapter 接缝

```ts
interface IdentityAdapter {
  // 从 DSH session 上下文解析业务 owner；无法解析时的行为由配置决定
  resolveOwner(session: SessionContext): string | null;
}
```

- 默认实现（M2 前半）：沿用 PoC 语义——preset 名 `mythos-<owner>` 映射为 owner；未命中时拒绝
- 认证落地后：session 的已认证 principal → owner 映射表（SSO claim 或账号），同一个 adapter 接口不变
- **明确不做**：owner 由 Agent 自报（prompt 可伪造自报值）；模型可见的 owner 永远来自 session 上下文

## 6. 策略门禁（PolicyGate）

| 策略 | 默认值 | 违反时 |
|---|---|---|
| per-owner 并发 | 2 | `QUOTA_EXCEEDED` |
| 全局并发 | 4 | `QUOTA_EXCEEDED` |
| profile 白名单 | `java17-maven`（2G/1cpu/network-none） | `PROFILE_FORBIDDEN` |
| repo 白名单 | `http://127.0.0.1:3000/demo/*` | `ACCESS_DENIED` |
| workspace 路径 | 必须落于 `~/mythos-sandboxes/` 内（沿用 PoC `is_relative_to` 校验） | `ACCESS_DENIED` |
| 镜像 | `mythos-dsh-sandbox:0.2.0-rc.2` + helper hash 校验（沿用 PoC） | `SANDBOX_UNAVAILABLE` |

profile 变更（如申请带网络的 profile 做冒烟）走**人工审批事件**：broker 记 `profile.requested`，operator CLI 批准后生效。方案 §7 Remote Dev VM 的 `inspectTarget/requestRun/rollbackRun` 以新 profile 形态接入同一门禁。

## 7. 事件流与 M2 对接

- broker 追加 append-only 审计日志（`~/mythos-sandboxes/audit.jsonl`：who/what/when/params 摘要），与事件流共用 sequence
- EventBridge 把 broker 事件翻译进 DSH session/workspace 事件体系，供 M2 **Mythos Run Monitor** 消费（方案 §6.1 P0 自研件）：列表页状态 `QUEUED/RUNNING/SUCCEEDED/FAILED/UNKNOWN/NOT_RUN` 直接来自 ExecutionOperation，不采信模型自述
- Snapshot+Cursor 语义（方案 §4.2）：`sandbox_status` 返回权威 snapshot；`follow` 以 cursor 补发；断线不取消后台 Job（broker 侧生命周期与 DSH 连接无关，天然满足）

## 8. 持久化与迁移

- **registry DB 沿用**：`sandboxes.sqlite3` 增列 `client_request_id`、`work_item_id`、`profile`、`schema_version`；迁移脚本离线执行，先备份（沿用 Gitea 文档的备份惯例）
- **文件桥退役路径**：operator-bridge 的 pump 保留一个版本，`BrokerClient` 与文件桥双写比对（事件数量、 sandbox 状态一致性），比对通过后再摘文件桥
- 现有 `mythos-alice/mythos-bob` preset 不动；控制面插件仅替换"会话如何拿到沙箱"这一段

## 9. 安全边界清单

1. docker.sock 仅 broker 进程持有；DSH 进程无任何 docker 访问能力（沿用 PoC 容器内无 docker.sock 的验证方式回归）
2. socket 以 `SO_PEERCRED` + 目录 `0700` 双重约束；密钥/凭据永不经 socket 传输（容器内 SSH key 仍由 broker 生成并保管在宿主侧，与 PoC 一致）
3. 所有 Agent 触发的写操作先写 registry 再执行，崩溃恢复以 registry + `docker ps` 对账，绝不把 `UNKNOWN` 直接重放为危险操作（方案 §10）
4. repo 白名单收敛到 Gitea `demo` org；生产凭据/真实仓库永不进入白名单默认值

## 10. 测试计划

| 层 | 内容 | 基线 |
|---|---|---|
| 单元 | PolicyGate 矩阵、协议编解码、状态机、幂等 | 新增，operator host 跑 |
| 协议 | socket 请求/响应/订阅/鉴权拒绝/超限帧 | 新增 |
| 回归 | 复用 M1 全部证据链（native-smoke / integration-probe / verifier 流程改走 socket） | 必须全绿才算迁移完成 |
| 故障注入 | broker 重启中对账、容器 OOM、exec 中途容器被删 → `UNKNOWN` 而非 `FAILED` | 新增 |

## 11. 开放问题（评审需拍板）

1. **身份认证选型**（P1 决策）：简单账号 / 公司 SSO / 阶段性单操作员密码——决定 `resolveOwner` 的实现与审批页设计，接口已隔离，不影响本设计主体
2. profile 是否要在 M2 就做"带网络冒烟"变体，还是留到 M5 Remote Dev 一并设计
3. broker 是否需要 `--once` 干跑模式用于 CI 证据链回归（倾向：要）
4. 事件流的长期存储（Run Monitor 的 Durable Store 选型）随 M2 持久层一起定
