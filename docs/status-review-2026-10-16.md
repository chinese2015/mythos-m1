# 2026-10-16 进度复核与后续建议

复核范围：本地控制仓库、远程实际部署、DSH Session 原始事件、Gitea API、Mock API，以及从候选提交重建的新容器。未调用模型、修改演示源码、推送分支或创建 PR；未重启现有服务。本次新建的三个验证容器均已停止并删除，原有 alice/bob 沙箱保留。

## 结论

M0 的真实演示仓库映射和统计接口已具备；M1 已有真实模型修复与独立验证证据，本次复测确认候选提交的单元测试通过，但发现全新环境的离线 `clean verify` 无法复现。M2 的 Work Item、持久化 Operation Store、Run Monitor 尚未实现。

因此下一步应先收口 M1 的验证环境，再交付 M2 的最小完整链路。

## 本次验证结果

| 项目 | 本次结果 |
|---|---|
| 远程连接 | SSH 正常，主机 hx-server |
| DSH | 0.2.0-rc.2；未授权访问 HTTP 401；mythos-alice/bob preset 无 broken 标记 |
| Gitea | healthz HTTP 200；三个私有演示仓库可认证读取 |
| Mock | HTTP 200；234 条 Finding：199 Not Started、26 In Progress、9 Resolved |
| Mock 统计 | stats 与列表一致；225 Open，64 Critical、133 High、37 Medium |
| Finding 映射 | FND-00003/00009/00015 的真实仓库、基线提交和 owner 均存在 |
| 当前沙箱 | alice/bob 各一个 running，与 Docker 实例一致 |
| 部署目录原有测试 | Node 3/3，Python 7/7 |
| 完整本地测试在远程部署代码上运行 | 临时测试目录加载本地测试、引用远程部署模块：Node 7/7，Python 8/8 |
| macOS 原地测试 | Node 5/7，Python 8/8；两个失败由测试硬编码 `/home/hx/mythos-sandboxes`、实现默认使用当前 HOME 导致 |
| 模型修复提交 | ce4181db901633376275bbd51e719cb7ff46c060；相对基线仅修改 CatalogSearchService.java，测试文件未改 |
| 新容器单元测试 | 仅传递候选 Git bundle，确认无 target，离线 mvn test：exit 0，JUnit 2 tests / 0 failures / 0 errors / 0 skipped |
| 新容器完整验证 | 离线 mvn clean verify：exit 1，尚未运行 JUnit，缺 maven-clean-plugin:3.2.0 |
| Gitea 交付 | 三个仓库目前仅 main 和 reference/verified-fix 分支，均无 PR；模型候选尚未发布 |

三个 Finding 的 workItemId、remediationJobId、prUrl 仍为空，verificationResult 为 NOT_RUN。因此不能把历史 26 条 In Progress 当作 AI Brain 已接管的任务数。

## 需要处理的实际缺口

1. **新环境验证不完整。** 当前镜像 `/opt/m2-seed/repository` 缺少 clean 插件；旧独立验证目录 sb-7190dbef0f534201 的私有缓存有该依赖，历史 exit 0/JUnit 证据有效，但不证明今天从镜像新建容器仍可完整重现。第一次探针遗漏 Maven mirror settings；补齐原验收 settings 后再次失败，确认镜像缓存本身仍缺依赖。单元测试成功与完整构建失败须分别报告。
2. **部署测试未完整同步。** 运行模块 SHA256 与本地一致；远程缺 tests/sandboxctl.test.mjs，tests/test_registry.py 少一项列表隔离测试。完整测试已在临时目录验证通过，未修改运行目录。应将同步清单和部署后测试固定下来。
3. **策略与权限设计尚未落地。** sandbox_create 的 repoUrl 描述承诺白名单，但 sandbox.py:create 直接调用宿主 git clone，尚无 URL 白名单检查。插件当前通过子进程执行 CLI，unix socket/异步 Operation/verify/follow/cancel 仍是设计内容。
4. **分进程不能直接形成权限边界。** 现场 DSH 进程 uid=1000，补充组含 docker gid=983，docker.sock 为 root:docker 0660。即使按设计改为同一 hx 用户的独立 broker + SO_PEERCRED，也不能据此声称 DSH 无法访问 Docker；若要达到设计文档所述边界，还须隔离 OS 身份、socket/registry/凭据权限，并处理目前 SSH ProxyCommand 直接使用 docker exec 的路径。当前仍按单操作员 PoC 描述。
5. **停止与删除语义不一致。** sandbox_stop 的工具描述说删除容器，实现仅 docker stop；现场保留六个历史退出容器。本次只删除新建的验证容器，不清理既有历史证据。

## 推荐推进顺序与验收点

1. **M1 收口：固定可复现的验证 profile。** 补齐可信 Maven 依赖种子、mirror/cache/JVM 参数和默认执行环境；修正测试的 HOME 假设及部署同步。验收：从镜像新建 B，仅导入候选 bundle，离线 clean verify exit 0，并记录提交、真实 JUnit 和日志。不得复制 A 的 target 或依赖旧 B 的可变缓存来宣称完成。
2. **M2 后端：先记录权威执行事实。** 建立持久化 Work Item、ExecutionOperation、Evidence 与有序事件；把 create/exec/verify 接入 operationId 和后台 worker。支持幂等、快照、游标补发、取消请求及重启对账，失联允许 UNKNOWN。先解决同 UID 权限边界的设计表述；真实多用户认证另行接入 IdentityAdapter。
3. **M2 页面：交付 Run Monitor 的最小完整链路。** 以 FND-00009 为唯一首条演示，显示 Work Item 阶段、Agent 活动、执行状态、实际日志/退出码/JUnit。验收：Maven 运行中关闭网页，重开能恢复观察；worker 重启能对账；失败不能显示成功；取消请求不能提前显示 CANCELLED。
4. **代码交付与后续业务。** 将经过完整验证的候选提交关联到 Gitea 修复分支/PR和 Evidence；保持 Finding 的办结门禁。随后接 M3 主动订阅、Owner 审批与通知，再扩展 Jira/Remote Dev。

## 证据位置

远程 `/home/hx/mythos-m1/state/`：

- verification.json：历史独立验证，2 tests、0 failures/errors。
- session-alice.json：真实模型修复及 sandbox_create/exec/stop/status 工具事件。
- integration-probe.json、native-smoke.json：历史隔离与官方 SSH provider 证据，本次只读取，未重跑整套探针。
- review-20261016-verification.json：首次完整验证探针失败，含日志。
- review-20261016-verification-retry.json：使用原验收 mirror settings 的完整验证失败，缺 clean 插件。
- review-20261016-unit.json：全新容器单元测试通过，绑定候选提交与 JUnit 计数。

此次未重新进行浏览器交互验收，也未声称 M2 的断线、重启、取消能力已通过。
