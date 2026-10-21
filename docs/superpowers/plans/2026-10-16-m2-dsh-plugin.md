# M2 DSH Plugin Implementation Plan

> Execute inline with superpowers:executing-plans and TDD; user approved the interface/lifecycle design in chat.

**Goal:** Operate durable M2 execution from DSH without coupling job lifetime to the plugin.
**Architecture:** Global Cordis service, per-preset native tools, private HTTP clients and replayable event bridge; backend worker remains independent.
**Tech Stack:** Node ES modules, DSH/Cordis 0.2.0-rc.2, Python M2 HTTP API.
**Spec:** docs/superpowers/specs/2026-10-16-m2-dsh-plugin-design.md.

## Global constraints
- Never derive owner/sandbox from model parameters; enforce same-Session operation access.
- Dispose only adapter resources. No backend cancellation, process termination or Session deletion on teardown.
- Never expose credentials; preserve the fixed DSH version, existing settings and sessions.
- Explicit request/call identity supplies idempotency; expectedVersion is a concurrency precondition rather than business identity.

## Review focus
- Retry after accepted POST plus lost response/reload must return the same operation despite changed version.
- Same-owner Sessions must not operate each other's jobs through tools.
- Aborted/unloaded requests may have been accepted; never silently resubmit with a new identity or cancel.
- Backend outages and malformed cursors must not leak credentials or fabricate status.
- Tools/service/timers unregister on real Cordis disposal, while backend jobs and DSH Sessions survive.

### Task 1: HTTP and retry contract
Files: plugins/mythos-brain/client.mjs; tests/fixtures/brain_plugin_api.py; tests/brain-plugin.test.mjs; brain/store.py and tests/test_brain_store.py.
- [x] Write RED tests for logical idempotency across changed expectedVersion, credential checks, real HTTP errors and abort.
- [x] Implement bounded loopback client and narrow M2 fingerprint change; verify GREEN.

### Task 2: Session bridge and scoped tools
Files: plugins/mythos-brain/bridge.mjs, service.mjs, index.mjs; tests/brain-plugin.test.mjs.
- [x] Write RED tests for Session binding, same-owner denial, async tools, event snapshots/replay, stable Session preparation, disposal and reload.
- [x] Implement bridge, named service, explicit Session adapter and seven tools; verify full suites.

### Task 3: Deploy and prove lifecycle
Files: configure_presets.py; docs/m2-dsh-plugin.md; tests/live_brain_plugin.mjs; docs/progress.md.
- [x] Test preset generation and update only owned profile entries with backup.
- [x] Deploy to existing Web Host; verify a real model session calls execution tools and receives real M2 results.
- [x] Unload/reload a real Cordis adapter while a real command runs; verify unchanged operationId, one execution and recovered state/logs.
- [x] Obtain independent review, fix substantive findings with regressions, run complete suites, document user entry points and lifecycle boundaries.
