# M2 backend: durable work and execution facts

The user selected implementation of the backend described in the progress review: persist Work Items, operations, logs and evidence; return operation IDs; support reconnect, cancellation and restart reconciliation. The existing DSH version, presets, candidate code and services remain compatible. This is a new subsystem implemented alongside M1.

## Decisions

Use Python standard library and SQLite WAL, following the existing broker. An HTTP API and a separately started worker share a private data directory. This avoids adding a database server or embedding long jobs in DSH. Alternatives were adding the store to the Mock JVM (couples workflow and source facts) and running jobs inside the API (loses supervision when HTTP restarts).

The API listens on loopback by default. Operator-provisioned bearer tokens map to owners in a private configuration file. Body/query owner IDs never establish authority. This is a single-operator PoC, not SSO or a Docker privilege boundary: DSH and the existing broker still share the hx OS trust domain. No Unix socket migration or OS-account changes are required for this delivery.

## Domain and durability

- Work Item: immutable source snapshot, owner, sandbox/session binding, stage, pause flag, optimistic version and event sequence. An existing owner-scoped running sandbox is required. A source revision may have only one Work Item per owner.
- Operation: COMMAND, UNIT_TEST or VERIFY; source sandbox, command, timeout, requested commit, actual execution sandbox, state, optimistic version and result. States: QUEUED, STARTING, RUNNING, CANCEL_REQUESTED, SUCCEEDED, FAILED, CANCELLED, UNKNOWN. UNKNOWN is final and never automatically replayed.
- Append-only events use eventId, schemaVersion=1, workItemId, sequence, type, occurredAt, source, correlation and payload. Snapshot and cursor are read in one SQLite transaction; reconnect replays events after that cursor. Logs have a separate ordered cursor to keep event payloads bounded.
- Mutation and corresponding event commit atomically. Request idempotency is owner- and endpoint-scoped; replay with a different payload conflicts. Version checks happen after idempotent replay checks.
- Pausing blocks subsequent dispatch, not an already running command. A successful command/test never automatically completes a Work Item. Successful VERIFY advances to AWAITING_REVIEW; failed/cancelled/unknown execution blocks further automatic progress until explicit resume. UNKNOWN additionally quarantines the source sandbox across Work Items and resume; this release requires manual recovery using a new environment and provides no quarantine-release API.
- The worker dispatches at most one operation per source sandbox at a time, with bounded global concurrency. A process lock prevents two workers controlling the same store. Queued work survives restarts.

## Executor

The worker uses the existing owner-scoped Registry/SandboxBroker. It never exposes host-shell execution through HTTP. A detached root supervisor inside the container runs the requested command as runner uid 1001/gid 1000, in the registered workspace. Its metadata, logs, cancellation flag and result live under root-owned `/run/argon-operations/<operationId>` outside the model-writable workspace. Result writes are atomic; a supervisor lock makes repeated start requests harmless. The Linux supervisor uses a subreaper and descendant termination as well as process groups; without CAP_KILL it sends signals through a helper running as runner. It confirms termination before reporting CANCELLED.

The worker polls trusted supervisor files through Docker, persists new log bytes and evidence, and reconnects after its own restart. Missing containers/supervisors or ambiguous launch outcomes become UNKNOWN, not PASSED/FAILED and not an automatic rerun. Cancelling a queued operation immediately yields CANCELLED because it never ran; cancelling an active operation first yields CANCEL_REQUESTED. Completion that wins a cancel race keeps its actual outcome.

VERIFY transfers an exact committed Git bundle from source A to a new B created by the existing broker. It does not copy target, process state or A's Maven cache. The source commit and pristine B are checked before execution. Requested repository sources are restricted to the three existing demo HTTP URLs before host cloning. A stable operation-specific workspace label permits finding B after a worker crash; ambiguous preparation becomes UNKNOWN. Verification results include actual exit code and available JUnit reports; missing or failing reports cannot yield successful VERIFY. The known offline clean-plugin cache gap is reported as an actual failed operation, not hidden by reusing old B. B is stopped only after durable terminal evidence; cleanup failure is visible in metadata.

Logs and reports are bounded when transferred. Evidence stores exact source commit, command, exit code, JUnit counts, report hashes and log hashes. JUnit files originate in the workspace and are evidence, not independent authentication of test correctness. Old reports are removed before execution; only new bounded regular files are captured at completion, before the next operation. Large output stays in artifacts, not event payloads. A submitted commit must equal actual HEAD; uncommitted source changes are rejected in the actual execution environment for commit-bound runs, ignoring generated `.cache/` and `target/` paths. VERIFY deliberately exports only A's committed HEAD and ignores A's uncommitted changes; the reconstructed execution environment B must be pristine.

## HTTP contract

All `/api/brain/*` routes require Authorization: Bearer. Unknown resources and wrong-owner resources both return 404. Invalid input is 400, stale versions/idempotency conflicts are 409. Mutations require Idempotency-Key and expectedVersion except initial creation. JSON bodies are at most 64 KiB.

| Route | Result |
|---|---|
| GET /health | Readiness and schema version; no secrets |
| POST /api/brain/work-items | Create/source-deduplicate owner-bound Work Item from source, sandboxId, optional sessionId |
| GET /api/brain/work-items | Owner-scoped snapshots |
| GET /api/brain/work-items/{id} | Atomic Work Item + operations + evidence + event cursor |
| GET /api/brain/work-items/{id}/events?after=N&limit=N | Ordered bounded page and nextCursor |
| POST /api/brain/work-items/{id}/operations | Enqueue command/kind/timeoutSeconds/sourceCommit; immediate operationId |
| GET /api/brain/work-items/{id}/operations | Durable operations |
| GET /api/brain/operations/{id} | Actual operation state and evidence |
| GET /api/brain/operations/{id}/logs?after=N&limit=N | Ordered log chunks and nextCursor; binary data is base64 with a display text field |
| POST /api/brain/operations/{id}/cancel | Request/confirm cancellation according to state |
| POST /api/brain/work-items/{id}/pause or /resume | Versioned dispatch control |

Existing synchronous M1 tools keep their behavior. The backend is independently usable by HTTP; DSH tool migration, Task Hub/Run Monitor pages, source subscriptions, approvals, PR publication, SSO and remote VM execution are subsequent integrations.

## Verification

Tests use real SQLite databases, HTTP sockets and child processes. Docker integration is verified on the existing remote host. Cover concurrent deduplication, source uniqueness, owner isolation on every resource, stale versions, atomic snapshot/replay, pause vs active execution, queue serialization, stdout/stderr and UTF-8 bytes, nonzero exits, confirmed cancellation, timeouts, worker restart while command continues, missing executor UNKNOWN, and commit-bound JUnit evidence. Run the complete existing suite and report its known HOME-path issue separately until made portable.
