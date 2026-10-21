# 任务工作台

入口：`http://127.0.0.1:3080/mythos/`，复用现有 DSH Web 的登录和 SSH 转发。
若返回 401，先使用 DSH 当前启动链接登录主页面，再打开工作台；不用把 M2 bearer token 放进浏览器。

## 目前可以怎么用

1. 任务中心显示 Mock Findings 中三个已映射的真实问题。当前只开放 Nova `FND-00009`；另外两个为预览。
2. 点击“开始处理”，创建唯一 Work Item 和新的任务沙箱，从固定漏洞基线检出。重复点击、刷新会返回同一个任务。
3. 查看真实基线测试。只有预期的 SQL 注入回归失败被复现，才创建只读 PLAN 会话。
4. 审查模型方案，点击“批准方案并开始执行”。批准记录绑定当前版本和方案摘要；随后才创建 CODE 会话。PLAN 的工具守卫阻止所有非只读工具。
5. 查看原生 DSH 会话、命令日志、代码差异和 JUnit 结果。候选代码必须已提交、工作区干净，且只修改指定源码，才能进入新的 B 容器执行 `clean verify`。
6. 全部通过后停在“等待审核”。当前不创建 PR、不合并、不自动关闭来源问题。

“暂停工作流”控制后续编排，不终止正在运行的 Agent/命令；取消命令使用对应操作的取消按钮。任务中断后不会自动重放编码，需发送补充说明明确继续。补充说明由持久化意图投递；上一条尚未投递时会拒绝新消息，防止覆盖丢失。审批时会暂时封住原生 PLAN 输入，批准后该计划会话封存。验证期间的进一步修改应从工作台发送补充说明，使旧验证失效。

这是单演示操作员 `alice`，并非企业用户登录或多租户授权。原有 alice/bob PoC 会话和 M2 工具继续可用。

## 已完成的真实验收（2026-10-16）

- Work Item：`work-e0c22f1188d6495781d2c33659937fa5`，现为 `AWAITING_REVIEW`。
- 来源基线：`7fd32b0535fac3f6ce105a8494e2dcbba7ce355b`；基线操作 `exec-9cf48b95371645cc9126217a2301b1b1`，2 tests / 1 failure / 0 errors。失败项为 `maliciousInputReturnsNothing`。
- 只读 PLAN Session：`session-cc1778f1-2599-cbff-e1a8-4aa0b03ca2eb`。批准前 HEAD 保持基线，status/diff 为空。模型实际读取了源码和测试，输出参数绑定方案。
- CODE Session：`session-6a6ac8df-dd57-ca10-d2dc-f92e7aca7703`。由配置中的模型实际修改并提交 `4656408a3d0a19641516a6ea719f44276619534c`，只变更 `CatalogSearchService.java`；测试、POM 未变。
- 独立验证：`exec-43b75d8a969c4d2db9695705b73c7dbe`，新 B `sb-8a5cfd7efd054f13`，起始无 target，实际 `mvn -B -o -s .cache/settings.xml clean verify` exit 0，JUnit 2 tests / 0 failures / 0 errors。
- 重复 Start 和相同批准请求均复用原工作项/决定。原生 SSH 文件读取、glob 搜索、PLAN 写工具拒绝及拒绝文件不存在，另有真实工具验收。
- API/worker/DSH 重启后仍为同一任务、2 个 Session、3 个 operation；PLAN/CODE preset 均恢复，未重发编码或验证。
- 回归：Node 41/41；Python 远程 Linux 63/63（本地 macOS 同一套件 62 pass / 1 Linux-only skip）。
- 认证 HTTP 实测：页面/静态资源返回 200，未登录 API 返回 401，外部 Origin 返回 403；DSH 原生 client manifest 已包含工作台导航插件。
- 自动浏览器工具被 URL 安全策略拒绝访问，本次未进行视觉和点击验收，未尝试绕过。页面布局、iframe 会话选择仍需在浏览器确认。

环境发现并修复：任务镜像继承的 Git HOME 不可写，改为容器内 `/tmp/mythos-gitconfig`，SSH 强制使用该配置，只信任本容器的工作区。原生搜索原先把宿主 npm 的 rg 路径交给 SSH；适配器保留原生搜索参数/解析，仅把执行文件映射为容器 `/usr/bin/rg`。所有修复保留原任务和沙箱，没有重新分配另一任务或人工代写 Java 修复。

## 代码与生命周期

`plugins/mythos-workflow/` 随 Cordis 管理来源适配、任务编排、动态 PLAN/CODE preset、消息投递和观察器。`plugins/mythos-console/` 管理认证页面、同源 API、原生会话导航和前端资源。卸载后停止新编排和输入/工具授权。

SQLite 任务事实、API/worker、Docker 沙箱、已受理执行和日志证据仍由外部 M2/broker 管理；插件卸载不自动取消执行或销毁工作区。重启后从持久化状态恢复 preset 和观察，复用 Session/operation ID，不盲目重发编码。

远程证据（不入 Git）：`~/mythos-m1/artifacts/task-before-approval.json`、`task-acceptance.json`、`task-native-acceptance.json`。验收脚本为 `tests/live_task_workflow.py` 和 `tests/live_task_native.mjs`，在 operator host 运行；从私有配置读取现有凭据，不输出令牌。

后端 task-demo 启动参数：API 和 worker 都使用 `--per-owner-limit 3 --global-limit 4`，容纳原 alice/bob 沙箱、新任务 A 和临时验证 B；默认配额仍为 2/4。首次新建需使用已预热离线缓存的镜像，见 `maven-cache.md`。
