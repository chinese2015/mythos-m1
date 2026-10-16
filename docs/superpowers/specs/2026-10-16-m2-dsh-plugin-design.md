# M2 DSH adapter and lifecycle

The user approved implementing the proposed boundary: DSH/Cordis owns registration, clients and event subscriptions; M2 API/worker, container supervisors, commands, data and evidence remain independent. DSH core continues to own Sessions and workspaces. Unloading the adapter never means cancelling an execution, deleting a Session, stopping a sandbox or terminating a backend process.

## Integration

- A global `argonBrain` Cordis service wraps a bounded, loopback-only M2 client per configured owner. Credentials are read from a private operator file and never placed in prompts, parameters, results, URLs or diagnostics.
- Per-preset `argon-brain-tools` registers `execution_run`, `execution_status`, `execution_follow`, `execution_cancel`, `work_item_status`, `work_item_pause`, `work_item_resume`. All outputs are JSON strings to accommodate DSH 0.2.0-rc.2 result projection behavior.
- Tool context supplies the immutable Session header id. The preset config supplies owner; the global service supplies sandbox and workspace. Model arguments cannot select owner, sandbox, another Work Item or a Session. An operation must belong to that Session's bound Work Item before it can be read/cancelled through a tool, including when both Sessions have the same owner.
- A Session first submitting execution obtains one durable Work Item: DIRECT source `DSH:<sessionId>`, revision 1, immutable sessionId/sandboxId. Read-only status on an unbound Session returns unbound without creating work. Re-instantiation discovers the same binding from M2, and mismatched persisted bindings fail closed.
- Each model tool call uses a deterministic idempotency key derived from owner, Session id, operation and DSH callId. M2 idempotency fingerprints business input separately from expectedVersion, allowing safe retry after a lost acknowledgement and plugin reload. Stale optimistic versions can be reread/retried once; changed business input with the same key conflicts. HTTP/Agent abort never triggers implicit execution cancellation.

## Session adapter and events

The server-only service can prepare a Session through `workspaceRegistry` and `sessionController.create`, using a stable Session id derived from an operator request id; it passes workspaceId OR cwd, never both. It binds the result to M2. A separate explicit prompt method uses `sessionController.prompt` with a stable requestId. No model call, automatic prompt, auto-resume, or Session creation occurs during plugin startup/restoration.

The service restores existing DSH Work Items, reads atomic snapshots, then polls events after each snapshot cursor. It emits `argon-brain/snapshot`, `argon-brain/event`, `argon-brain/error` on the Cordis bus for future Run Monitor consumers. Execution details remain authoritative in M2; no arbitrary execution event is inserted into DSH's native journal. Cursors advance only after delivery and are reset from snapshots on gaps; reconnection does not enqueue work. Logs are read explicitly with cursors and remain bounded. Agent polling is not required for backend progress.

## Ownership of teardown

The plugin owns its named service, tool registrations, timer/subscription loops, listeners, pending HTTP requests and in-memory bindings. Cordis effects unregister tools/service; dispose aborts and awaits pending client work, prevents late emissions and new calls. No backend mutating cleanup runs on dispose. Repeated disposal is harmless. Tokens and all persisted records remain intact.

Native DSH Agent stop cancels an in-flight HTTP observation/admission only; an already accepted M2 job remains. Cancelling execution requires execution_cancel. Pausing workflow requires work_item_pause. Session creation/prompt methods are server-only and check configured owner/binding. Existing M1 tools remain available but are not automatically captured by M2.

## Deployment and validation

Extend the two operator presets and global profile, preserve existing configuration and sessions, and keep DSH 0.2.0-rc.2. The configured backend must already run; plugin startup does not start/stop API or worker. Add concise persona guidance to use asynchronous execution tools for monitored build/test runs.

Tests: real M2 HTTP/SQLite fixture, actual Cordis plugin registration/disposal, session-control boundary fixtures, same-owner cross-session denial, immutable bindings, idempotency across reload, abort-after-admission, credential/redirect handling, event replay and no late events after dispose. Preserve full Python/Node suites. Remote acceptance must include a real model tool call in the existing DSH Web Host and a real Cordis unload/reload while M2 continues a command exactly once. No Run Monitor UI, automatic workflow notifications, SSO or OS privilege changes are included.
