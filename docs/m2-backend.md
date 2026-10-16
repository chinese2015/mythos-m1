# M2 后端操作与接口

## 交付范围

`brain/` 提供独立的 HTTP API、worker 和 SQLite 事务存储。Work Item、Operation、日志、JUnit/提交证据和事件游标均持久化。HTTP 返回 operationId 后即可断开；API/worker 停止不会向已托管的容器命令发送取消信号。

运行目标为现有 Linux Docker operator host。Python 3.9+，只使用标准库。macOS 可运行离线测试，但 Linux subreaper 的脱离进程组子进程清理测试仅在 Linux 上运行。

当前仍为单操作员 PoC：服务端令牌映射 owner，未接 SSO；DSH、broker 与 worker 共用 operator 的 OS 信任域。现有 M1 Agent 工具保持同步行为，尚未迁移到本后端；新 API 仅记录通过它提交的执行。

## 启动

在远程 `/home/hx/argon-m1` 执行一次：

```bash
python3 -m brain --data-dir /home/hx/.argon-brain init-config --owners alice bob
```

令牌只写入 `/home/hx/.argon-brain/tokens.json`，权限 0600；不会打印。不要重复运行初始化，也不要将该文件纳入 Git。数据目录必须为 0700。

分别在两个终端运行：

```bash
cd /home/hx/argon-m1
python3 -m brain --data-dir /home/hx/.argon-brain api --port 3081
```

```bash
cd /home/hx/argon-m1
python3 -m brain --data-dir /home/hx/.argon-brain worker
```

默认只监听 `127.0.0.1:3081`。可通过 SSH 隧道转发本机 3081 到远程同端口。`GET /health` 不需凭据，其余路由需 `Authorization: Bearer <owner token>`。浏览器页面后续通过同源代理接入；本后端不开放跨源访问。

API 和 worker 都可以用 SIGTERM 停止。worker 退出不取消容器里的任务。每个数据目录只允许一个 `worker.run()` 实例，以文件锁保证；默认最多同时观察/调度 4 项执行。同一个源沙箱只派发一项命令。

## 请求与读取

| 方法与路径 | 请求/结果 |
|---|---|
| POST /api/brain/work-items | `{source:{type,id,revision},sandboxId,sessionId?}` → Work Item |
| GET /api/brain/work-items | 当前 owner 的 Work Item 列表 |
| GET /api/brain/work-items/{id} | `{workItem,operations,evidence,cursor}`，同一事务快照 |
| GET /api/brain/work-items/{id}/events?after=0&limit=100 | `{events,nextCursor}` |
| POST /api/brain/work-items/{id}/operations | `{expectedVersion,command,kind?,timeoutSeconds?,sourceCommit?}` → HTTP 202 + Operation |
| GET /api/brain/work-items/{id}/operations | 持久化 Operation 列表 |
| GET /api/brain/operations/{id} | Operation 与 evidence |
| GET /api/brain/operations/{id}/logs?after=0&limit=100 | `{logs,nextCursor}` |
| POST /api/brain/operations/{id}/cancel | `{expectedVersion}` → 取消请求或尚未派发时直接 CANCELLED |
| POST /api/brain/work-items/{id}/pause 或 /resume | `{expectedVersion}` → Work Item |

每次 POST 都需 `Idempotency-Key`；相同 key 的请求体必须完全一致。操作/工作项的版本分别从相应 GET 读取；版本冲突为 409。不同 owner 无权读取的 ID 与不存在的 ID 均为 404。未知字段、非法类型、超限值为 400。JSON 请求体上限 64 KiB；事件/日志分页 limit 为 1..200。

source.type 为 ARGON/JIRA/DIRECT；这是引用的快照，并不代表已经接通来源系统或审批。source 与 sandbox/session 绑定不可变；同 owner、同 source revision 只能有一个 Work Item。

Operation kind 为 COMMAND、UNIT_TEST、VERIFY。timeoutSeconds 为 1..3600 的整数，默认 300。UNIT_TEST/VERIFY 除了 exitCode=0，还必须有本次产生的有效、非全跳过且无失败/错误的 JUnit 报告。成功不会自动关闭 Finding 或完成 Work Item。

VERIFY 必须提供完整 40 位 sourceCommit，且源 A 的 HEAD 与其相同。worker 只导出该提交的 Git bundle，从 Gitea 白名单中的对应仓库新建 B、检出并核验提交、确认没有 target 后执行；A 的未提交内容不会进入 B。验证 B 的源码必须干净。只允许现有 Orion/Nova/Pixel 三个确切 HTTP 仓库 URL。

## 状态与恢复规则

- QUEUED → STARTING → RUNNING → SUCCEEDED/FAILED；取消先进入 CANCEL_REQUESTED，确认命令和 Linux 子进程树结束才进入 CANCELLED。正常完成抢先发生时保留实际成功/失败结果。
- 超时有实际退出码时记 FAILED；执行器、容器或启动确认丢失记 UNKNOWN，不把它推断为成功、失败或取消。
- FAILED/CANCELLED/UNKNOWN 会阻止工作项继续自动派发。对已确认结束的失败/取消，显式 resume 后可以派发排队任务。
- UNKNOWN 会额外隔离整个源沙箱，即使另一个 Work Item 绑定相同沙箱或用户 resume，也不会派发。先人工确认旧执行/环境状态，后续使用新沙箱；本版本没有解除 UNKNOWN 沙箱隔离的 API，也不会自动重放。
- pause 只阻止下一项调度，不取消当前命令；stop API、stop worker、cancel execution 是不同动作。
- RUNNING 是最近持久化观察到的状态；worker 停止期间 API 不能提供新的执行器观察，worker 恢复后继续对账。
- 已有 runtime 的 STARTING/RUNNING/CANCEL_REQUESTED 从原监督进程读取结果和日志；准备阶段中断且无可信监督进程时记 UNKNOWN。
- VERIFY 的临时 B 在终态证据落库后停止并删除。准备失败也记录 B 与清理结果。cleanup.status=failed 需要 operator 处理，不自动无限重试。UNKNOWN 环境不自动销毁，避免用清理隐式取消仍可能运行的命令。

## 日志和证据

容器内根目录 `/run/argon-operations/<operationId>` 为 root 所有、0700；模型可写 workspace 不包含该目录。监督进程以 runner 身份运行命令，使用 subreaper 管理脱离原进程组的后代；信号权限不足时以 runner 身份发送信号，不增加容器 capabilities。

stdout/stderr 每路最多保存 2 MiB，超出仍消费管道并标记 truncated。每次最多拉取 64 KiB；分页日志的 data 为 base64 原始字节，text 是便于阅读的尽力解码。前端流式显示 UTF-8 时应按 stream 用增量解码器解码 data，避免在字节块边界损坏字符。

每次执行前清除旧的 TEST-*.xml，结束并清理子进程后采集本次报告。只接受 workspace 内的常规文件，拒绝符号链接、FIFO、DTD、超大或损坏 XML；最多 8 份报告、每份 256 KiB。JUnit 内容来源仍是任务 workspace，其正确性需要后续 SDLC 测试策略约束。

事件只存状态与日志索引；日志字节与证据存 SQLite。Evidence 包含实际提交、源码脏状态、命令、退出码、报告 SHA256 与各路持久化日志 SHA256。默认数据文件是 `<data-dir>/brain.sqlite3`，不要在运行中仅复制主库文件；备份应使用 SQLite backup API，或停止 API/worker 后完整备份数据目录。

## 验证

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm test
```

明确需要 Docker 的远程实测单独运行：

```bash
cd /home/hx/argon-m1
PYTHONPATH=. python3 tests/live_brain_smoke.py --source-sandbox sb-f4a61d0b6a3648c1
```

探针使用临时端口 13081 和 `state/m2-smoke-<id>/` 数据目录，保存 acceptance.json、服务日志和 SQLite 证据。覆盖 API 重开、worker SIGKILL 后恢复且不重复执行、owner 拒绝、确认取消、真实非零退出码、独立 B 的 Maven/JUnit 与容器丢失 UNKNOWN；最后停止探针服务并清理自己创建的容器。

当前镜像缺 maven-clean-plugin:3.2.0，离线 `mvn clean verify` 仍可能失败；后端必须保留该真实失败。M1 缓存收口、DSH 工具迁移、Run Monitor 页面、来源订阅和 PR/审批仍是后续工作。
