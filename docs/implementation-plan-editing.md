# Implementation plan 编辑与讨论

计划区默认渲染 Markdown（标题、列表、链接、引用、表格与代码块）。原始 HTML 作为文本显示。

在 `AWAITING_PLAN_APPROVAL` 阶段：

- **Modify**：编辑 Markdown，实时查看预览；**Save changes** 保存新版计划，不启动编码。
- **Ask model**：向模型提交当前保存的计划（含人工修改）和补充要求；模型返回完整新版计划后继续等待审批。
- **Approve plan & start execution**：只审批当前最新版本，随后按这版计划进入编码。
- 自动刷新保留正在编辑的草稿与焦点。并发修改使草稿过期时，保留草稿并禁止覆盖；可取消后重新打开最新版。

暂停、模型生成中或已批准执行的计划不会显示编辑入口。已经发布 PR 的任务继续使用现有交付流程，不会因编辑计划而修改已发布候选。

计划内容最多 64000 字符；单次模型修改要求最多 16000 字符。无需数据库迁移，旧计划缺少修订号时按第 1 版显示。

## 验证

```sh
node --test tests/plan-markdown.test.mjs
node --test --test-name-pattern='plan edit|model revision|plan discussion|legacy plan|long Chinese' tests/task-controller.test.mjs
npm test
```

本地浏览器验收（需要已安装 Playwright；可通过 `NODE_PATH` 指定包目录，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定现有 Chromium）：

```sh
node tests/live_plan_editor.mjs
```

该验收使用本地测试 HTTP 服务，不访问线上任务、不调用模型、不修改真实 PR。覆盖 Markdown、草稿/焦点在刷新后保留、保存失败时保留草稿、保存、模型修订、并发更新、取消编辑与审批最新版本。

## 原有测试失败

2026-10-20 修改前，`npm test` 已有 30 项失败。主要来自中英文提示不一致、旧端口/仓库配置和来源接管流程变更。此次变更没有修改这些功能。原有失败用例完整名单：

- displayState keeps cancel-requested distinct from cancelled and unknown explained
- displayState maps known terminal and active states
- formatJUnit renders counts or null
- formatEvent folds execution.output away and details failures
- staleNote reports seconds-old snapshots or nothing
- publication commits an intent before Git/PR writes and duplicate requests reuse it
- paused, dirty, failed verify or newer CODE input cannot be published
- merged source completion survives lost acknowledgement and restart without an extra source write
- external reopen is reconciled by refresh and can then complete after a real merge fact
- closed current deliveries stay observable in the background, superseded candidates cannot resume them
- a colliding branch with another head/marker never authorizes creating a PR
- Gitea redirects and unsafe origins are rejected without leaking private response details
- publication binds deterministic unique branch and exact independent clean evidence
- closed, changed head, bot merge or changed merge tree cannot close a source Finding
- configured CI/review gates require exact successful checks and fresh non-author approval
- subscription persists before external writes, recovers notification errors, and restart does not notify twice
- decisions require the displayed revision, are idempotent and never start repairs
- mapped drift is persisted for review without notifying or starting work
- existing work is grandfathered without new claims, patches or notifications
- pending owner change generates a new bound notification instead of reusing the old receipt
- triage confirms exact eligible assets and explains drift or ineligible findings
- approval holds a native admission fence through async Git and CAS, then seals the approved PLAN
- a delayed old read cannot reopen native PLAN input after approval
- new tasks fail closed before approval; existing work stays accessible
- approved exact assets start once while changed owner bindings stay gated
- a pushed finding starts the workflow without polling or manual approval
- a repeated push returns the running work item without a second claim
- the intake falls back to the mock source when the push carries no finding payload
- source adapter enables only exact Nova mapping and disables altered baselines
- provider quota failures give an actionable explanation without exposing the raw response

## 本次交付记录

- 已更新主实例 `http://ubuntu.huaxia2002.cn:13080/mythos/`，仅同步本次涉及的 8 个运行文件。
- 远端备份：`/home/hx/mythos-m1/backups/plan-editing-20261020-183106`。
- 新增 9 项控制器/HTTP 用例和 2 项 Markdown 用例通过；本地 Chromium 交互验收通过。
- 最终 `npm test`：136 项，106 通过，30 项原有失败；与修改前失败用例逐项比较，无新增失败。
- 已验证线上新资源需要登录、可正常加载，已审批计划拒绝写入，原任务计划与 PR 状态保持不变。
- 已在实际域名下完成浏览器登录验收：标题/代码块正确渲染，无 JavaScript 错误；390px 手机视口无页面横向溢出，长代码在代码框内滚动。
