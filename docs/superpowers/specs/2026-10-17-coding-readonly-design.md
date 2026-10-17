# 方案 B：真实任务只读编码工作区

依据：用户已确认方案 B 并多次授权继续；独立 PoC 已验证公开客户端 Slot、资源导航、引用与刷新恢复。此切片实现真实任务文件、Git Diff 与运行监控接入，编辑保存另行切片。

## 结果

任务中心仍为入口；现有详情增加“进入编码工作区”，地址 `/argon/coding/#/work/{workItemId}`。左目录、中间只读源码/任务 Diff、右原生会话、底部现有 Run Monitor。来源、phase、branch、HEAD、审批/交付入口始终与 Work Item 绑定。无自动 Start、建 Session、prompt、执行命令或提交。

## 插件与权限

新增 `@local/argon-coding` 双端插件，通过 `configure_presets.py` 的任务服务清单注册；新增 prefix `/argon/coding`，沿用 DSH connection cookie 和来源验证。代码在独立 worktree `codex/vibe-coding-readonly` 开发；不修改共享 checkout 的未提交文件，不重启生产服务。

服务端每次先用 TaskWorkflow.snapshot 验证 owner/来源；workspace 信息由现有绑定推导，Session 只能为当前任务持久化绑定中的 PLAN/CODE。无工作区或会话时 409，不分配新资源。

新只读 SSH 工厂使用任务相同的官方 `dsh-ssh` / `dsh-fs-ssh`，每个 sandbox 持有隔离 Cordis Context，配置来自 operator 的 root/helperHash 与任务绑定。不得回退 Host fs，不向模型注册工具；最多缓存 8 个空闲连接，卸载关闭 Context。请求超时/断开取消读取，失败不返回伪内容。

## API

- `GET /argon/coding/api/work-items/{id}/context`：workItem、当前 Session、source、git、operations/evidence；复用现有 detail。
- `GET …/{id}/files?path=`：相对根目录逐层读取，最多 2000 项；仅返回 name/type/size，明确截断。
- `GET …/{id}/file?path=`：完整 UTF-8 普通文本，最多 512 KiB/16000 行，返回 path/text/contentHash。超限 413；二进制/目录 415；失联 503。
- 原有 `/argon/api/work-items/{id}/events`、`operations/{id}/logs`、cancel 接口继续承担运行事实和控制。

路径拒绝绝对路径、空段、`..`、反斜线、控制字符、`.git`；每层 lstat 拒绝 symlink，并用同一个远端 provider 的 resolve/contains 再确认边界。读取前后 metadata version 不一致返回 409，明确避免将变化中的文件当作稳定快照。只返回必要的相对路径，不公开 operator 根路径或凭据。写方法一律 405。

## 客户端

外壳响应迟到时按请求 generation/Work Item 丢弃。文件、光标/选区与布局按任务保存。工作区为只读；引用用相对路径、1-based 行范围、内容哈希与有界快照，显式操作后进入原生草稿，绝不自动发送。原生 Session 导航等待目录发布，资源类型 extension 把文件导航转到中间区。iframe origin/source/Session/Work Item/binding 校验必需，未知消息拒绝。

右侧复用原生 Chat/Tool/Trajectory/输入与既有任务 policy；阶段不允许输入时保留服务端拒绝，不放宽 PLAN/VERIFYING/PR_OPEN 权限。完整原生界面及概览链接保留。

中间 Diff 展示现有容器 Git 的 baseCommit、headCommit、dirty、changedFiles、raw patch 与截断；不把原生工具单次 Diff 当整仓 Diff。底部复用 renderMonitor；修复其 DOM 定位为任务限定，迟到请求不得写到另一任务。轮询/取消/UNKNOWN 的语义不变。

## 验证

测试覆盖认证与跨 owner、原生 Host/远端同名内容区别、目录/文件/版本变化、路径/符号链接/二进制/大文件、取消与连接清理、客户端消息隔离，以及监控的任务目标检查。跑完整 Node/Python 套件。用独立测试配置演示真实接口和原生客户端；SSH 实际验收可在 operator host 运行只读脚本，不创建/更改任务文件或部署服务。原始主线未提交状态保留。

不包含：保存/人工接管、PTY、LSP、完整编辑器、PR/来源业务重实现。真实环境不可读时明确保留该项未验收，不以本地 fixture 代替远程验收。
