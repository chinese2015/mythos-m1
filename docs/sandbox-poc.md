# M1 Docker Sandbox PoC — 2026-10-16

目标：复用同一 DSH Web Host 的模型、Session、原生文件/Bash 工具、工具卡与 Diff，完成 Docker 内读改文件、真实测试和独立容器验证。支持多个 Sandbox 同时运行，并为用户身份授权预留明确边界。

原 M1 计划中的宿主机工作区改为 Docker 开发容器 A；验证从固定 Commit 在独立容器 B 重建。每个 Sandbox 绑定 ownerId/workspaceId/sandboxId/sessionId，使用独立目录、进程和资源上限。

先验证固定版本官方 SSH fs/subprocess 后端能否通过容器 SSH 复用。文档明确原生 Web 有宿主路径假设，因此仅共享该任务目录并保持两侧绝对路径一致，由 Host 变更展示读取同一份源码。纯远程路径不能视为即插即用。

验收：

- 两个不同 owner 的容器同时运行，文件目录和进程不共享；错误 owner 的 broker 请求被拒绝。
- 原生 DSH 文件工具和 Bash 确实访问对应容器，读不到宿主机 home、密钥或其他任务目录。
- 通过 Web Host 的真实 Session，由模型修改示例文件、执行 Maven/JUnit，并保留实际工具事件及 Diff。
- 独立 B 从候选 Commit 检出，无 A 的 target 或进程状态，实际重跑测试。
- 停止一个 Sandbox 不影响另一个 Sandbox 的持续任务。
- 当前共享 Web token 只是操作员入口；身份认证和 Session 资源授权接入前，不宣称已具备真实多租户登录隔离。

步骤：

1. 建立独立控制仓库、测试和 ledger，构建开发镜像。
2. TDD 实现 owner/任务/容器绑定、目录与配额校验、broker 操作；验证两容器隔离和停止。
3. 加载匹配 `0.2.0-rc.2` 的官方 SSH 能力和私有 Agent preset，保留现有默认配置与用户会话。
4. 在同一 Web Host 验证原生读写、执行、日志、Diff。
5. 新容器 B 固定 Commit 验证，保存证据和复现说明，独立代码审查。
