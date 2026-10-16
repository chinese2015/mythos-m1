# Task-driven Web coding: Nova vertical slice

The user approved: a real task list -> click Start -> prepare a fresh repository/sandbox -> DSH read-only plan -> human plan approval -> DSH coding -> real tests and independent verification -> visible diff/results. Tasks own Sessions/workspaces, not the reverse. Keep existing M2/DSH tools compatible. No IM/Jira connector, PR publication, SSO or production deployment is included in this iteration; end at AWAITING_REVIEW, never auto-close Finding.

## Product surface

A Cordis `argonWorkflow` service owns source intake and business orchestration. A Cordis `argon-console` package serves authenticated `/argon/` on the existing DSH webServer. It reuses DSH connection authorizeIndex/requestRejection, same-origin browser cookie and Origin fence; browser never receives M2 credentials. All browser mutations require JSON and `X-Argon-Action: 1`, plus an Idempotency-Key; versioned decisions carry expectedVersion. The single operator is explicitly configured as alice, with demo actor labeling, not enterprise identity claims.

Two views: hash `#/tasks` and `#/work/<workItemId>`. Read real Mock findings through a server-side source adapter; show the three mapped demo findings, with Nova FND-00009 enabled for this first workflow and the other two clearly preview-only. Refresh/poll returns durable state; reload never starts another task.

## Domain/M2 internal API contract

Extend existing Store without deleting legacy Work Items. Schema remains versioned and additive; tables claim/session mappings are created idempotently.

- `Store.claim_task(owner, source_record, expected_revision, key)` -> Work Item. source_record is normalized `{id,title,risk,ownerId,repositoryUrl,baseCommit,sourcePath,revision,description?}` (all trusted source adapter fields). Global claim uniqueness for ARGON source id, across owners/revisions while active; repeat by same owner returns existing Work Item. Another owner conflicts. No sandbox or Session is required yet. Work Item contains source `{type:'ARGON',id,revision}`, `sourceRecord`, sandboxId=null, sessionId=null, sessionIds=[], workflow `{phase:'CLAIMED'}`, stage/status CLAIMED, version/sequence. New claim checks expectedRevision against sourceRecord.revision; existing active claim is returned before revision checks.
- `POST /api/brain/tasks/claim` body `{sourceRecord,expectedRevision}` invokes the above; authenticated owner and Idempotency-Key. Only exact Nova demo URL/base commit can be enabled by workflow; backend also validates demo URL allowlist before any clone.
- `POST /api/brain/work-items/{id}/prepare` body `{expectedVersion}` -> current Work Item, including workspace metadata. Durable `workspaceProvision` intent is written before broker.create, unique label `task-<workId suffix>`. Replay does not allocate twice; interrupted preparation reconciles the registry by label, never silently starts another container. Attach workspace only after exact baseline checkout, a task branch, safe demo git identity and settings are ready. Source snapshot is immutable. Expose provision error/UNKNOWN in Work Item. Preparation can outlive HTTP disconnection.
- `POST /api/brain/work-items/{id}/sessions` body `{sessionId,role,expectedVersion}`, role PLAN or CODE. Unique (owner,sessionId) can belong to only one Work Item. Store.bind_session(owner,id,session_id,role,version,key); update sessionIds and primary sessionId (CODE preferred). Snapshot adds `sessions:[{sessionId,role}]`. Legacy Work Items with original sessionId remain compatible.
- `POST /api/brain/work-items/{id}/workflow` body `{expectedVersion,workflow,stage?,blocked?}` -> Work Item. Store.update_workflow(...). CAS and append event atomically. Business phase policy lives in Cordis, not worker. Workflow dict includes durable action/prompt ids and explicit approval. stage controlled server-side enum, never marks COMPLETED in this slice.
- `GET /api/brain/work-items/{id}/workspace` -> `{sandboxId,workspacePath,git:{baseCommit,headCommit,branch,status,diff,changedFiles,testsChanged,diffTruncated}}`. All commands are fixed git argv inside registered owner sandbox, never caller shell on host. Bound diff max 128 KiB. Compare against immutable source baseline.
- Existing enqueue requires sandbox attached. Snapshot includes Work Item, sessions, operations, evidence and cursor. Existing operation APIs retain their contracts.
- SandboxBroker gets optional per_owner_limit/global_limit; default stays 2/4. M2 API/worker CLI may use explicit task-demo limit 3/4 to accommodate the old alice PoC sandbox plus fresh task A and temporary verifier B without stopping existing containers. Global cap stays 4.

## Cordis workflow state machine

Persistent workflow.phase: CLAIMED -> PREPARING -> BASELINE -> PLANNING -> AWAITING_PLAN_APPROVAL -> CODING -> VERIFYING -> AWAITING_REVIEW; BLOCKED/PAUSED controls preserve phase or record reason. An in-memory single-flight tick serializes decisions; stable API keys and prompt requestIds plus CAS prevent duplicate side effects after reload.

Start claims a task immediately; a background tick prepares resources and submits fixed baseline `mvn -B -o -s .cache/settings.xml test` as UNIT_TEST. Continue only when actual JUnit shows Nova's expected failing regression (2 tests, 1 failure, 0 errors). Retain FAILED baseline evidence and label it reproduced; environment failures block.

Register dynamic task presets through agentPresets. Each points official SSH/filesystem/subprocess providers at that task's sandbox, not the operator's fixed PoC sandbox. PLAN preset registers native read/search tools but uses a monotonic tools.guard allowing only read, read_image, glob, grep. No Bash/execution/lifecycle tools can run before approval. CODE preset adds native write/Bash and M2 execution tools, bound by persisted Session mapping to this Work Item. Existing manually created legacy preset Sessions remain supported.

Create stable separate PLAN/CODE Session IDs (one Work Item can have both); DSH workspaceRegistry/sessionController own them. Prompt admission has stable requestId and persists intent before dispatch. Inspect the real journal to detect the addressed user message, turn completion/error, final assistant plan text and tool history. Do not infer success from model prose. New sessions are named with Finding id and role. Startup/reload resumes observation and reuses existing IDs, never replays coding blindly.

Approval requires authenticated browser operator, current expectedVersion and exact planHash; persist approval before creating CODE Session. Model cannot invoke approval endpoint or change browser identity. After CODE turn completes, require a new committed HEAD, no uncommitted source, and only the expected source file changed; tests/POM must not change. Submit a fixed VERIFY `mvn -B -o -s .cache/settings.xml clean verify` in fresh B. Real passing JUnit + exact commit + unchanged tests yields AWAITING_REVIEW with diff/evidence; otherwise BLOCKED. No merge/Resolved claim.

Pause prevents subsequent workflow transitions and M2 dispatch, does not secretly stop Agent/execution. Resume is explicit; UNKNOWN sandbox quarantine stays. Execution cancel is separate. Additional user message is explicit, uses a stable requestId and current appropriate Session; while awaiting plan it stays read-only, and post-review changes invalidate old review readiness.

## Browser API (same-origin `/argon/api`)

- GET `/tasks` -> `{tasks:[{id,title,risk,ownerId,repositoryUrl,baseCommit,sourcePath,revision,status,enabled,workItemId?,workStage?}],operator:{id:'alice',label:'演示操作员 alice'}}`.
- POST `/tasks/{findingId}/start` `{expectedRevision}` -> HTTP202 `{workItemId,...}`; repeat click returns same id.
- GET `/work-items` -> `{workItems:[...]}`.
- GET `/work-items/{id}` -> `{workItem,workflow,source,sessions,operations,evidence,cursor,session?,git?}`. session is `{sessionId,role,running,activity,transcript:[{seq,type,text?,toolName?,isError?}]}`; optional git has shape above. `workflow.plan` plain text, `planHash`, `baselineOperationId`, `verificationOperationId`, `reason`, `approval`.
- POST `/work-items/{id}/approve-plan` `{expectedVersion,planHash}`.
- POST `/work-items/{id}/pause` or `/resume` `{expectedVersion}`.
- POST `/work-items/{id}/message` `{text}`.
- GET `/operations/{id}/logs?after=N` -> M2 log page; owner check and Work Item source binding are mandatory.
- POST `/operations/{id}/cancel` `{expectedVersion}`.

Frontend task detail shows real stages, source/commit, baseline reproduction, read-only plan, explicit approval, native DSH Session link/embed, real tool activity, operation logs/exit/JUnit and diff. A native client bridge uses uiWorkspace.openSession(sessionId) for `/?argonSession=<id>`; do not guess unsupported native URL formats. Register plugin client via dsh.client package metadata. Add a Task Hub navigation entry to native DSH. All untrusted text uses textContent/escaping.

## Verification

TDD for task uniqueness, Session bindings, pre-prepare dispatch denial, preparation replay, CAS approval and wrong plan hash, deterministic read-only guards, journal state extraction, duplicate Start/approve, restart reconciliation and source failure. Real HTTP/SQLite and Cordis tests. Remote fresh Nova baseline must fail expected regression; no write before approval; actual model plan and coding; clean independent verification and immutable tests; browser click/refresh/controls and screenshots. Preserve legacy suites. Cache warm/build work is independent and delegated; do not consume its temporary containers.
