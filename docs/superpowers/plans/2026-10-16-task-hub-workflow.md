# Task Hub Workflow Implementation Plan

> Execute inline with TDD and an independent final review. User approved this vertical slice. Parallel agents own only independent cache and static UI work under the shared spec contract.

**Goal:** Launch real Nova coding by clicking a task and approving its plan, with actual diff and durable verification results.
**Architecture:** Task-first M2 facts/resources, Cordis source/workflow/preset services, authenticated same-origin console and native DSH navigation bridge.
**Tech Stack:** Existing Python SQLite/M2, Node Cordis/DSH rc.2, plain browser HTML/CSS/JS.
**Spec:** docs/superpowers/specs/2026-10-16-task-hub-design.md.

## Constraints and review focus
- Model writes require persisted human approval; PLAN guard must deny all non-read tools.
- Claim is global per source task; Session belongs to task, not vice versa.
- Stable IDs/intent/CAS before side effects; ambiguous write execution is not replayed.
- Browser authenticates through DSH, never receives backend secrets. No fake progress, test success, PR or closure.
- Keep legacy data/services/presets; new task sandboxes start from vulnerable baseline and fixed branch.

### Task 1: Task-first domain and resources
- [x] RED tests for global claims, unprepared work, multi-Session binding, workflow CAS, preparation recovery and owner access.
- [x] Implement additive Store/API/workspace provisioning and git evidence; run Python suite.
### Task 2: Source/workflow and dynamic presets
- [x] RED tests for Mock normalization, read-only guard, journal parsing, approval/phase/reload and task-bound tool resolution.
- [x] Implement Cordis source/workflow service and per-task PLAN/CODE presets; run Node suite.
### Task 3: Console and native navigation
- [x] Implement task list/detail static assets against exact same-origin contract; register authenticated routes and native client bridge.
- [x] Verify version/conflict/errors and real authenticated HTTP paths.
- [ ] Browser click/layout/iframe acceptance: CUA rejected URL access; no alternate browser or bypass attempted.
### Task 4: Trusted cache and remote acceptance
- [x] Integrate independently warmed reproducible offline Maven image without stopping legacy containers.
- [x] Deploy with backup; launch Nova through the console HTTP API, approve actual model plan, verify actual code/tests/diff in fresh B; duplicate-action checks.
- [x] Complete final restart recovery check and documentation after regression deployment: same 2 Sessions / 3 operations, both native presets restored; Node41 / Linux Python63 pass.
- [x] Independent review and regression fixes for inbox cancellation, approval admission fence, verification freshness and supplemental-message loss.
