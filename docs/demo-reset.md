# 主 Task Center 演示数据重置

`reset-main-demo.py` 用于重置主 Argon 实例中 Alice 的 Task Center 演示数据。默认只盘点；确认输出范围后，显式传 `--apply` 才会写入。脚本把自身通过 SSH stdin 发送到 Ubuntu 主机，Brain token 和 Gitea 凭据只在主机上读取。

## 使用方法

```bash
cd /path/to/hackathon/m1
python3 reset-main-demo.py
python3 reset-main-demo.py --apply
```

先检查 dry-run JSON 中的 `workItemIds`、`intakeFindingIds`、`pullRequests`、`sandboxIds` 和 `plannedActions`。apply 成功时会返回备份路径、完成阶段和最终 Finding 状态；失败时会报告停止阶段与剩余 ID，备份会保留。

## 重置范围

- 主实例端口：DSH `13080`、Brain `13081`、Finding source `18081`、Gitea `13000`。
- apply 会先暂停 `PUBLISHING`、`CLOSING`、`PR_OPEN` 中的 workflow，并重新对账 PR；active operation 或活跃编码阶段会让脚本先停下。
- Brain 数据库：`/home/hx/.argon-brain/brain.sqlite3`；sandbox registry：`/home/hx/argon-sandboxes/sandboxes.sqlite3`。
- 清除 Alice 所有类型的 Work Item 及 operations、events、logs、evidence、session bindings、claims、source intakes 和任务幂等记录。
- 重置 `FND-00003`、`FND-00009`、`FND-00015` 到 `Not Started` / `Open`、`UNTRIAGED`、`NOT_RUN`，并清空 work item、remediation job、提交和 PR 字段。Mock 的 PATCH 会忽略 null 值，因此这些链接以空字符串写入。
- 关闭明确关联、仍 open 且未合并的 Gitea PR。已合并 PR 不会关闭；链接、仓库或 head 身份不匹配时脚本会停止。
- 删除 Alice 所有 `task-*` sandbox，包括已停止和 orphan task workspaces，也删除与 Work Item 关联的 sandbox。保留 `verify-*`、`review-*`、probe 等无关测试 sandbox。
- 保留 Alice 的仓库登记、Bob 的数据和通用实例。

这里的“清空”指 Alice 的 Work Items、详情历史和旧 intake 决策被删除；三个 Finding 源记录保留为 `Not Started`，可以重新推送。

## 备份与恢复限制

每次 apply 在写入前创建：

`/home/hx/backups/argon-main-demo-reset/<UTC 时间戳>-<随机后缀>/`

目录权限为 `0700`，SQLite 快照和 `manifest.json` 权限为 `0600`。快照包含 Brain 与 sandbox registry；manifest 只记录目标 ID、状态和 PR/sandbox 元数据，不含凭据。

备份不包含 sandbox workspace 文件或 DSH conversation journals，不能还原源码工作区或聊天历史。删除的 workspace 内容无法从这份备份恢复。

## 本次重置记录（2026-10-21）

- 清除两轮演示数据：FND-00003 和后续出现的 FND-00009，共 2 个 Alice Work Item、5 条 operation、104 条 event、36 条 log、5 条 evidence、3 个 session binding、2 条 claim 和 2 条 source intake；清除相应 Task Center 幂等记录。
- 删除 12 个 `task-*` sandbox registry 行及 workspace 目录；共清除 9 个容器，其中 2 个运行中、7 个已停止。其余无关测试 sandbox 保留。
- FND-00009 曾关联 Gitea PR #4；第二轮清理时该 PR 已合并并关闭，因此保留仓库状态。Finding 上的 PR 链接已清空；没有 open、unmerged 的关联 PR。
- FND-00003/00009/00015 均已核验为 `Not Started` / `Open`，无 work item/remediation 链接，`UNTRIAGED`、`NOT_RUN`，无提交或 PR 链接。
- 两次备份分别位于 `/home/hx/backups/argon-main-demo-reset/20261021T132813Z` 和 `/home/hx/backups/argon-main-demo-reset/20261021T135039Z-6f46e6`。快照保留数据库状态，但不含上述 workspace 内容。
