# Main Task Center Demo Reset Design

Date: 2026-10-21

## Goal

Provide a repeatable operator script that returns the main Task Center to a clean demo state: no Alice-owned Work Items or prior intake decisions, the mapped findings reset and available to push again, and no Alice `task-*` sandbox remains. Here, “empty” means the existing Work Items/history and intake decisions are gone; the three mapped source Findings remain available to push again. The current live instance is already in this state; this design covers future resets.

## Scope

- Main Argon instance only: DSH `13080`, Brain `13081`, Finding source `18081`, Gitea `13000`, Brain database `/home/hx/.argon-brain/brain.sqlite3`, app root `/home/hx/argon-m1`, and sandbox root `/home/hx/argon-sandboxes`.
- Owner is fixed to `alice` so the script cannot accidentally reset Bob's or another instance's data.
- Remove every current Alice-owned Work Item, regardless of kind, and its Brain history: operations, logs, evidence, events, session bindings, claims, and related idempotency entries. Remove all Alice-owned Brain source intake rows so no prior triage or approval decisions remain.
- Reset `FND-00003`, `FND-00009`, and `FND-00015` to `Not Started` / `Open`, with empty-string `workItemId`, `remediationJobId`, `codeFixCommit`, and `prUrl`, plus `UNTRIAGED` and `NOT_RUN`. The source API ignores null-valued patch fields, so empty strings clear these links.
- Close linked open, unmerged Gitea PRs. Already closed or merged PRs are left as-is. When a Work Item has a pending delivery identity but no saved PR number/URL, reconcile Gitea by its exact branch and Argon delivery marker before deleting the Work Item.
- Stop and remove every Alice sandbox whose workspace label begins with `task-`, including stopped and orphaned task workspaces. Remove the linked container, workspace directory, SSH include line, and exact registry row. Preserve unrelated stopped test sandboxes such as `verify-*`, `review-*`, and probe workspaces.
- Preserve repository registrations, the generic instance, Bob's data, and unrelated stopped test sandboxes such as `verify-*`, `review-*`, and probe workspaces.

## Operator interface

Add `m1/reset-main-demo.py`. Run it locally from the `m1` checkout; it streams the script to the configured Ubuntu host over OpenSSH, so owner and Gitea credentials remain on the host.

- Default mode is a read-only dry run showing the Work Items, PRs, source records, and all Alice `task-*` sandbox rows it would affect.
- `--apply` performs the reset. It is the only mutating mode.
- The script is idempotent: missing records and already-closed PRs are reported as no-ops.

Add `m1/docs/demo-reset.md` with the scope, dry-run/apply commands, backup location, verification results, and a dated note that the demo instance was reset on 2026-10-21.

## Apply sequence

1. Verify that Brain, Finding source, Gitea, SSH, credentials, and the expected main sandbox root are available.
2. Inventory all current Alice-owned Work Items, operations, source intake rows, source records, associated PRs, and sandbox registry rows. Abort before mutation if any operation is active or `UNKNOWN`, any work phase is `PREPARING`, `BASELINE`, `PLANNING`, `CODING`, or `VERIFYING`, or an ownership/path check fails.
3. Create a private timestamped backup under `/home/hx/backups/argon-main-demo-reset/<timestamp>`: consistent SQLite snapshots of `/home/hx/.argon-brain/brain.sqlite3` and `/home/hx/argon-sandboxes/sandboxes.sqlite3`, plus a JSON manifest of Work Item IDs, intake/source states, PR states, workflow phases, and task sandbox IDs. Use directory mode `0700` and file mode `0600`; never include credentials.
4. Pause Alice Work Items in external delivery phases `PUBLISHING`, `CLOSING`, or `PR_OPEN` through the authenticated Brain API and verify the pause before continuing. This prevents the DSH publisher from writing after the inventory.
5. Reconcile linked Gitea PRs, including pending deliveries by exact branch and `<!-- argon-delivery:<id> -->` marker with complete pagination. Close only linked open, unmerged PRs; already closed or merged PRs are left as-is.
6. Reset the three mapped Finding records through the source API.
7. Stop and remove every inventoried Alice `task-*` sandbox through the existing sandbox CLI and Docker. If the workspace contains files owned by the sandbox UID, use the existing `argon-dsh-sandbox:0.2.0-rc.2` image as a root helper with `--network none` and only that exact workspace mounted. Remove its workspace directory, SSH include line, and exact registry row; refuse paths outside the main root.
8. Delete the inventoried Work Item graph and all Alice-owned source intake rows in one Brain SQLite transaction. Remove Task Center idempotency scopes while preserving repository registrations and their idempotency. Verify foreign-key integrity.
9. Re-read the APIs and registry. Require no Alice-owned Work Items or source intake rows, clean Finding states, no linked open-unmerged PR, and no Alice `task-*` sandbox rows or containers before reporting success.

External services cannot be changed in one atomic transaction. If a stage fails, retain the backup, report the completed stages and remaining items, and stop without attempting unrelated cleanup.

## Backup limits

The SQLite snapshots and manifest preserve Task Center database state and source/PR/sandbox metadata. They do not archive sandbox workspace bytes or DSH conversation journals, so they are not a complete restore of code changes or DSH chat history. The two cleanup passes removed 12 task workspace directories, whose bytes are not in the backups; the available older snapshot also does not contain the exact prior task state.

## Success criteria

- Authenticated main Brain API returns no Alice-owned Work Items of any kind.
- Authenticated main Brain API returns no Alice-owned source intake rows.
- The three mapped findings show `Not Started`, `Open`, no work-item or remediation-job link, `UNTRIAGED`, `NOT_RUN`, and no stale code-fix commit or PR link.
- No linked PR remains open and unmerged.
- No Alice `task-*` sandbox row or container remains.
- Generic, Bob, repository registrations, and unrelated stopped test sandboxes are unchanged.
