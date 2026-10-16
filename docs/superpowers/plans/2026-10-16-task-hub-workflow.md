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
- [ ] RED tests for global claims, unprepared work, multi-Session binding, workflow CAS, preparation recovery and owner access.
- [ ] Implement additive Store/API/workspace provisioning and git evidence; run Python suite.
### Task 2: Source/workflow and dynamic presets
- [ ] RED tests for Mock normalization, read-only guard, journal parsing, approval/phase/reload and task-bound tool resolution.
- [ ] Implement Cordis source/workflow service and per-task PLAN/CODE presets; run Node suite.
### Task 3: Console and native navigation
- [ ] Implement task list/detail static assets against exact same-origin contract; register authenticated routes and native client bridge.
- [ ] Verify version/conflict/errors and actual browser interactions.
### Task 4: Trusted cache and remote acceptance
- [ ] Integrate independently warmed reproducible offline Maven image without stopping legacy containers.
- [ ] Deploy with backup; click Nova, approve actual model plan, verify actual code/tests/diff in fresh B; refresh/restart and duplicate-action checks.
- [ ] Independent review, regression fixes, complete suites, document user URL and remaining limitations.
