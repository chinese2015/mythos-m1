# Main Task Center Demo Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repeatable, backed-up reset command and runbook for the main Alice Task Center demo state.

**Architecture:** A single Python 3 operator script runs locally, streams its own source over the configured OpenSSH connection, then performs a remote read-only inventory by default or a staged reset with `--apply`. The remote script uses the existing Brain, Finding source, Gitea, SQLite and sandbox setup; it does not deploy application code or require new dependencies.

**Tech Stack:** Python 3 standard library, OpenSSH, HTTP/JSON APIs, SQLite, Docker CLI, existing `sandbox.py` and SSH include configuration.

**Spec:** `docs/superpowers/specs/2026-10-21-main-demo-reset-design.md`

## Global Constraints

- Main Argon instance only: DSH `13080`, Brain `13081`, Finding source `18081`, Gitea `13000`, Brain DB `/home/hx/.argon-brain/brain.sqlite3`, app root `/home/hx/argon-m1`, and sandbox root `/home/hx/argon-sandboxes`.
- Owner is fixed to `alice` so the script cannot accidentally reset Bob's or another instance's data.
- Remove every current Alice-owned Work Item, regardless of kind, and its Brain history: operations, logs, evidence, events, session bindings, claims, and related idempotency entries. Remove all Alice-owned Brain source intake rows so no prior triage or approval decisions remain.
- Reset `FND-00003`, `FND-00009`, and `FND-00015` to `Not Started` / `Open`, with empty-string `workItemId`, `remediationJobId`, `codeFixCommit`, and `prUrl`, plus `UNTRIAGED` and `NOT_RUN`; the source PATCH ignores null-valued fields.
- Close linked open, unmerged Gitea PRs. Already closed or merged PRs are left as-is.
- Stop and remove every Alice sandbox whose workspace label begins with `task-`, including stopped and orphaned task workspaces. Preserve unrelated stopped test sandboxes such as probe, verify, and review workspaces.
- Preserve repository registrations, the generic instance, Bob's data, and unrelated stopped test sandboxes such as `verify-*`, `review-*`, and probe workspaces.
- The default mode is a read-only dry run. `--apply` is the only mutating mode.
- Create a private timestamped backup under `/home/hx/backups/argon-main-demo-reset/<timestamp>` with directory mode `0700`, file mode `0600`, and no credentials.
- The current live instance is already in the reset state; the script is for future resets. The three mapped source Findings remain available to push again.

## Review Focus

- Wrong host, unavailable services, or missing/unsafe credentials: abort before mutation and never print credential contents.
- Any `QUEUED`, `STARTING`, `RUNNING`, `CANCEL_REQUESTED`, or `UNKNOWN` operation, or an inventory that changes during reset: stop and report the completed stages.
- Active code phases (`PREPARING`, `BASELINE`, `PLANNING`, `CODING`, `VERIFYING`): abort before writes; pending external delivery phases (`PUBLISHING`, `CLOSING`, `PR_OPEN`): pause and verify before continuing.
- A linked PR whose repository, number, head identity, or stored URL does not match, or which is merged: do not close it. Discover pending deliveries with no stored PR number by exact branch and `argon-delivery` marker.
- A source Finding with an unexpected revision/state, or a reset response that does not contain the requested values: stop after recording the completed stage.
- A sandbox path outside the main root, symlinked path, container label mismatch, or registry row changed since inventory: refuse its removal.

---

### Task 1: Add local transport and safe remote dry-run inventory

**Files:**
- Create: `reset-main-demo.py`

**Interfaces:**
- `main(argv: Sequence[str] | None = None) -> int` parses local `--apply`; absence of the flag means dry-run.
- `run_remote(apply: bool) -> int` streams this script to `hx@ubuntu.huaxia2002.cn` over OpenSSH stdin and runs `python3 - --remote-mode [--apply]` remotely.
- `build_inventory() -> dict[str, Any]` returns owner-scoped APIs, source records, linked PR identities, and sandbox registry rows consumed by dry-run and apply.
- `remote_main(apply: bool) -> dict[str, Any]` returns a redacted JSON summary with `status`, `mode`, `owner`, `workItemIds`, `intakeFindingIds`, `findingStates`, `pullRequests`, `sandboxIds`, `plannedActions`, `backup`, `completedStages`, and `remaining` fields as applicable.
- Dry-run inventory reads the Alice owner token from `/home/hx/.argon-brain/tokens.json`, Gitea credentials from `/home/hx/gitea/secrets/argon-agent.json`, Brain at `127.0.0.1:13081`, Finding source at `127.0.0.1:18081`, Gitea listener/API origin `127.0.0.1:13000`, Brain DB `/home/hx/.argon-brain/brain.sqlite3`, and sandbox root `/home/hx/argon-sandboxes`.

- [ ] Add fixed main-instance constants, a hidden remote-mode argument, and the local CLI where no flag is read-only and `--apply` is forwarded explicitly.
- [ ] Implement bounded OpenSSH transport with `BatchMode=yes`, a connection timeout, script bytes sent only on stdin, and JSON-only result parsing; do not use SCP or include secrets in command arguments.
- [ ] Implement remote preflight for loopback health/ports `13000`, `13080`, `13081`, and `18081`, expected roots, private credential files, Alice token availability, Brain schema version 1, the expected sandbox registry schema, and the existing `argon-dsh-sandbox:0.2.0-rc.2` cleanup image. Redact errors to service/stage/type rather than file contents or credentials.
- [ ] Inventory Alice Work Items and snapshots through the authenticated Brain API, all Alice source intakes, the three mapped Finding records, linked Gitea PR details, and every Alice `task-*` sandbox registry row.
- [ ] Refuse to proceed when any operation state is `QUEUED`, `STARTING`, `RUNNING`, `CANCEL_REQUESTED`, or `UNKNOWN`, or a Work Item workflow phase is `PREPARING`, `BASELINE`, `PLANNING`, `CODING`, or `VERIFYING`; refuse owner mismatch, incomplete pagination, unexpected API/schema data, or unsafe sandbox paths.
- [ ] Print a concise JSON dry-run report of affected IDs and planned actions without creating a backup, changing a source record, closing a PR, or editing either database.

### Task 2: Implement backed-up `--apply` stages and final reconciliation

**Files:**
- Modify: `reset-main-demo.py`

**Interfaces:**
- `create_backup(inventory: dict[str, Any]) -> Path` creates consistent SQLite copies using SQLite's backup API and a JSON manifest without credentials.
- `apply_reset(inventory: dict[str, Any]) -> dict[str, Any]` applies the stages in spec order and returns `completedStages`, `remaining`, and final verification status.
- The Finding reset patch sets `status=Not Started`, `closed=Open`, `workItemId=''`, `remediationJobId=''`, `triageResult=UNTRIAGED`, `verificationResult=NOT_RUN`, `codeFixCommit=''`, and `prUrl=''` because this source API ignores null patch values.

- [ ] Create `/home/hx/backups/argon-main-demo-reset/<timestamp>` with mode `0700`; use `sqlite3.Connection.backup()` for `brain.sqlite3` and `sandboxes.sqlite3`, and write a `0600` manifest containing only Work Item/intake/source/PR/sandbox identities and states.
- [ ] Pause Work Items in `PUBLISHING`, `CLOSING`, or `PR_OPEN` through authenticated `POST /api/brain/work-items/{id}/pause` with expectedVersion and a fresh idempotency key; GET them again and require `paused=true` before any external reset write.
- [ ] Reconcile linked PRs by stored repository/number/URL; for pending deliveries without a saved PR number, list all PR pages and match the exact head branch or `<!-- argon-delivery:<id> -->` marker. Close only exact linked open, unmerged PRs; report missing/already-closed/merged PRs as no-ops and refuse mismatches.
- [ ] Re-read each mapped Finding before mutation, skip exact reset-state records, PATCH only the approved reset fields, then GET again and require an exact state match.
- [ ] For each Alice `task-*` sandbox, use the deployed sandbox CLI to stop a running container; verify Docker owner/sandbox labels before removal; remove the container; clear UID-1001-owned workspace contents using the existing `argon-dsh-sandbox:0.2.0-rc.2` image with `--network none` and only the exact workspace mounted; remove the canonical sandbox directory and SSH `Include` line under `.argon-ssh-config.lock`; delete only the exact registry row, allowing only the CLI's running/allocated/cleanup-pending-to-stopped state transition.
- [ ] Under one `BEGIN IMMEDIATE` Brain transaction, confirm the inventoried Alice Work Item IDs and intake finding IDs are unchanged; delete logs/evidence/operations/events/sessions/claims, every Alice source-intake row, and the inventoried Work Items. Delete only Task Center idempotency scopes `create-work-item`, `create-manual-task`, `claim-task:*`, `bind-session:*`, `workflow:*`, `submit:*`, `cancel:*`, `pause:*`, `resume:*`, and `intake-decide`; preserve repository rows and registration/revision idempotency. Run `PRAGMA foreign_key_check` before commit.
- [ ] Stop on the first unconfirmed stage, keep the backup, and report completed stages plus remaining IDs without continuing unrelated cleanup.
- [ ] Re-read Brain APIs, the Finding source, Gitea PR states, and sandbox registry. Require no Alice Work Items/intakes, reset source fields, no linked open-unmerged PR, no Alice `task-*` sandbox row or container, and unchanged repository registrations before returning success.

### Task 3: Add the operator runbook

**Files:**
- Create: `docs/demo-reset.md`

**Interfaces:**
- Documents `python3 reset-main-demo.py` as the read-only dry run and `python3 reset-main-demo.py --apply` as the mutating command.
- Explains that “empty” means no Alice Work Items/history or prior intake decisions; the three mapped source Findings remain available for a new push.
- Records the 2026-10-21 reset, backup path/modes, output interpretation, preserved Bob/generic/repository/test-sandbox data, and the documented restore limitations.

- [ ] Write the exact scope, prerequisites, commands, backup directory shape, successful-state criteria, and partial-failure behavior from the script.
- [ ] State that the snapshots and manifest do not include workspace bytes or DSH conversation journals, so they are not a full restore of task code or chat history.
- [ ] Link the script and design spec, record the dated reset note, and keep the runbook consistent with the actual script flags and output fields.

---

## Plan self-review

- Spec coverage: work item/intake clearing, source reset, linked PR handling, sandbox quota cleanup, backup, dry-run/apply boundary, final reconciliation, and documented restore limits are assigned to Tasks 1–3.
- Step scan: each checkbox adds one bounded interface, guard, apply stage, or runbook section; no existing user files need modification.
- Type consistency: Task 2 consumes Task 1's `build_inventory()` snapshot and returns the staged report consumed by Task 3's runbook.
- Review focus: all five failure classes have fail-closed guards in Tasks 1–2.
- Proportion: one script and one runbook implement the single cross-service reset operation in the approved spec.
