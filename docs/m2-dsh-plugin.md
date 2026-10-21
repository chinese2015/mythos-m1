# 在 DSH 中使用 M2 执行插件

## 入口

当前 DSH Web Host 已配置全局 `mythos-brain-service`，并在 **Mythos Sandbox alice / bob** 两个 preset 中加载 `mythos-brain-tools`。M2 API/worker 必须独立运行，默认地址为远程 `http://127.0.0.1:3081`。

在 DSH Web 中选择对应的沙箱 workspace 和 preset，新建会话，可以直接说：

> 用 execution_run 执行 echo started; sleep 10; echo finished，返回 operationId。然后用 execution_status 和 execution_follow 查看真实状态、退出码和日志。

测试候选提交时说：

> 用 execution_run，kind=VERIFY，sourceCommit=ce4181db901633376275bbd51e719cb7ff46c060，command=mvn -B -o -s .cache/settings.xml test。检查独立验证容器、退出码和 JUnit 证据。

只验证已提交源码。当前镜像缺 clean 插件缓存，`clean verify` 的失败仍会如实记录。现有原生文件工具可以继续读写源码；旧 bash/sandbox_exec 等同步工具的执行不会自动进入 M2，想要持久化状态和证据的命令应通过 execution_run 提交。

## 七个工具

| 工具 | 行为 |
|---|---|
| execution_run | 异步提交命令，立即返回 operationId、记录状态。kind 为 COMMAND/UNIT_TEST/VERIFY |
| execution_status | 当前会话某次执行的状态、退出码、JUnit 计数、日志哈希及清理结果 |
| execution_follow | 按 after/nextCursor 读取真实日志预览；单块预览最多 4096 字符，完整字节保留在 M2 |
| execution_cancel | 显式取消，先 CANCEL_REQUESTED，确认结束后才 CANCELLED |
| work_item_status | 当前会话的 Work Item、版本、事件 cursor 和执行列表；未绑定时只报告 unbound |
| work_item_pause | 暂停后续派发，当前执行继续 |
| work_item_resume | 显式恢复后续派发；不会解除 UNKNOWN 的沙箱隔离 |

工具没有 owner、sandboxId、workItemId、sessionId 参数。owner 取自 preset 的 operator 配置，沙箱取自全局服务配置，Session id 取自真实工具执行上下文。即使两个会话属于同一个 owner，也不能通过这些工具读取或取消另一个会话的执行。

第一次提交命令自动创建 DIRECT 来源 `DSH:<sessionId>` 的 Work Item，并持久化 Session/owner/sandbox 绑定。插件重载、DSH 重启后恢复同一关联，不自动启动新的命令。

## 生命周期

| DSH 插件拥有 | 独立存续 |
|---|---|
| mythosBrain 服务注册、七个工具注册 | DSH 核心的 Session、对话记录和 workspace |
| HTTP 客户端、未完成的 HTTP 请求 | M2 API、worker、SQLite、证据 |
| 事件轮询、Cordis 订阅和内存缓存 | Docker 沙箱、监督进程和已接收命令 |

插件卸载会注销接入能力、停止轮询并中止未完成 HTTP 请求，不调用 execution_cancel，不停止 API/worker，不删除 Session 或容器。重载先读快照，再从 cursor 接续事件。

Stop Agent 中断工具/HTTP 调用时，POST 可能已经被后端接收。先用 work_item_status 检查；不要把未收到响应解释成没执行并随意发起第二次命令。同一个 DSH callId 的重试使用稳定幂等键，可以在版本变化和插件重载后找回同一个 operationId；新的 callId 代表新的显式操作。

## 服务端扩展接口

Cordis 插件声明 `inject: ['mythosBrain']` 后可调用：

```javascript
// 只准备会话与绑定，不自动调用模型。
const binding = await ctx.mythosBrain.prepareSession('alice', 'operator-request-42');

// 显式将任务交给 DSH Agent；requestId 用于 DSH 自身的消息去重。
await ctx.mythosBrain.promptSession('alice', binding.sessionId,
  '只读分析仓库并提出计划', 'operator-prompt-42', signal);
```

这是 operator/业务插件接口，未作为模型工具或公开 HTTP 路由暴露。会话创建复用 DSH workspaceRegistry/sessionController，使用稳定 Session id，workspaceId 和 cwd 只传其中一个。

供后续 Run Monitor 使用的 Cordis 事件：

- `mythos-brain/snapshot`：ownerId、sessionId、workItemId、权威快照。
- `mythos-brain/event`：上述关联与 M2 原始有序事件。
- `mythos-brain/error`：关联、错误 code/status；不含凭据或后端任意错误正文。

这些事件不会伪装成 DSH 原生 Session journal 事件，也不会自动给模型发消息。执行事实与证据保留在 M2，DSH 对话与工具调用仍由原生 journal 管理。

异步订阅者应返回表示处理完成的 Promise。插件等待确认后推进事件游标，订阅者失败时保留游标并重试；初始快照失败也会重新投递。消费者应按 eventId 去重，重新连接时先读取权威快照。卸载会释放插件正在等待的确认；订阅者自身已启动的异步工作仍应由其所属插件负责清理。

## 配置和验证

`configure_presets.py` 生成全局服务和两个 owner preset，只替换本项目拥有的配置 ID，改写前备份原 Web profile。配置只写 tokenFile 路径，私有令牌仍在远程 `/home/hx/.mythos-brain/tokens.json`，不能复制到 prompt 或 Git。

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

在远程 operator host 验证真实 Docker/Cordis 卸载和恢复：

```bash
cd /home/hx/mythos-m1
export PATH="$HOME/tools/node/bin:$PATH"
node tests/live_brain_plugin.mjs
```

该探针复用已有 alice Session 的绑定，提交一条带唯一标记的短命令。确认运行后卸载实际 Cordis 插件，证明工具/服务被移除而命令仍在运行；重载并重试同一调用，核对 operationId 不变、起止标记各一次、最终成功。证据写 `state/brain-plugin-lifecycle.json`。

`tests/fixtures/dsh_brain_probe.mjs` 是可选的 operator 文件桥，仅用于现有 DSH Web Host 内验收真正的模型工具调用；不属于默认生产配置，也不应作为 Agent 工具。验收后移除 profile 条目并卸载探针。后续 Run Monitor 页面、通知、来源订阅、SSO 和 OS 权限隔离不在本次交付范围。
