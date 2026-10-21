# Mythos read-only coding workbench

The task detail page links to `/mythos/coding/#/work/{workItemId}`. The workbench keeps task files, Git Diff, the task's existing DSH session, and the Run Monitor together. The task ID and session ID are checked against the owner-bound Work Item before the page opens the session.

## Behavior

- The file pane is read-only. It reads only the workspace returned for the current Work Item, uses relative paths, and shows a SHA-256 content identity with each stable source snapshot. Files over 512 KiB or 16,000 lines, binary files, non-UTF-8 files, symlinks, and files changing during a read are rejected with an explicit status.
- The tree is limited to 2,000 entries per directory and hides `.git`. The task Diff shows the frozen base commit, current head, branch, changed paths, status, and patch. It refreshes while the workbench is open so a live coding session does not leave a stale file list or patch on screen.
- “引用选区” inserts a bounded path/line/version/text snapshot into the current native draft. It does not send the draft. The native session retains its existing phase policy; any message or execution still requires an explicit user action and the server-side task gate.
- Run Monitor uses the existing task-scoped operation and log APIs. Switching task IDs invalidates late responses and removes the old task's frame and activity view before loading the new task.

## Read boundary

The server derives the owner, sandbox, workspace root, and allowed session from `TaskWorkflow`; callers cannot supply or override them. The API is authenticated and same-origin, exposes only `GET`, and rejects paths outside the task root. File access uses the official DSH SSH providers for the bound sandbox, never host filesystem fallback, and registers no file tools with the model.

Each remote read uses an isolated Python process with no site packages. It opens the task root and each parent directory with descriptor-relative, no-follow operations, then reads from the opened file descriptor. It checks the file identity before and after the read, caps each response, limits remote reads to four concurrent subprocesses, and releases pooled SSH readers when the plugin unloads. Disconnecting or timing out a request aborts that read.

The browser does not create a Work Item or Session, start a model turn, run a command, save a file, or submit a PR. The right-side native session is the already-bound session and remains governed by the existing PLAN/CODE/VERIFYING/PR_OPEN policy.

## Verification

`tests/live_coding_readonly.mjs` is a read-only operator probe. It checks task-file contents and hash, directory listing, traversal refusal, and unchanged head/status/diff; it does not edit the task or invoke a model. The latest recorded remote observation for the existing Customer task found `src/main/java/com/example/catalog/CatalogSearchService.java` at 1,171 bytes / 38 lines with SHA-256 `59b462b2487a7c02facf23293acacfde9a5ab97caae730ae977990ce5b2ec96e`. The observed candidate SHA was `4656408a3d0a19641516a6ea719f44276619534c`, `git status` was empty, changed paths stayed unchanged, and `modelInvoked` was false.

For browser-only integration, `tests/start_coding_preview.mjs` starts an isolated local DSH profile with two throwaway Git fixtures. It can use a port other than the default with `MYTHOS_CODING_PREVIEW_PORT`; its private login URL is stored in the ignored `artifacts/coding-preview/login-url.txt` file and must not be copied into logs or documentation. This preview is a UI fixture, not task or verification evidence.
