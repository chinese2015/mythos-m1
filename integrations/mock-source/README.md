# Mock source atomic completion overlay

This installable overlay adds a small synthetic integration to the existing Spring Boot Mock. It uses the existing `findings.revision` column as a JPA `@Version`; it does not add a database column. Both the legacy Finding PATCH and the completion write run transactionally, and JPA optimistic-lock failures return HTTP 409.

`POST /api/findings/{id}/ai-completion` accepts:

```json
{
  "expectedRevision": 4,
  "workItemId": "work-123",
  "ownerId": "owner-orion-01",
  "repositoryUrl": "http://127.0.0.1:3000/demo/demo-orion-notes-api.git",
  "baseCommit": "2ce309f4dd7a39a22fcce59ad4309a50e1df237e",
  "sourcePath": "src/main/java/com/example/notes/AppConfig.java",
  "codeFixCommit": "0123456789abcdef0123456789abcdef01234567",
  "prUrl": "http://127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17"
}
```

It checks the current owner, work item, nonempty remediation job binding, repository URL, base commit, source path, and `In Progress` status. On success, one database transaction sets verification to `PASSED`, records the fix commit and PR, and changes status/closed to `Resolved`/`Closed`. A repeat with an exact matching completed target succeeds without another revision increment, even when its expected revision is old. A stale revision or a changed binding/decision returns 409. Malformed or oversized fields return 400.

The repository and PR URLs must use the exact local Gitea origin `http://127.0.0.1:3000`. The repository path must be one of `demo/demo-nova-catalog-api.git`, `demo/demo-orion-notes-api.git`, or `demo/demo-pixel-reports-batch.git`; the PR path must identify that same repository as `/demo/{repo}/pulls/{number}`. User info, alternate ports/schemes, queries, fragments, and other paths are rejected. This is demo-local shape validation. This endpoint trusts its caller's upstream gates; it does not authenticate a human or independently attest a merge. The SDLC integration must establish the external facts before calling it.

The BOLA fixture adds loopback-only `POST /api/findings/{id}/bind-demo-repository` for FND-00016. It uses the existing revision as an optimistic-lock version and binds only the exact unclaimed Aster placeholder to `demo/demo-tenant-invoice-api`, its local Gitea URL, the frozen base SHA, `InvoiceController.java`, and the invoice-specific Finding title. A stale revision or changed Finding state returns 409; malformed or alternate targets return 400. An exact replay returns the existing Finding without another revision increment. Owner, CWE category, risk, score, status, and closure state stay unchanged; the endpoint does not create findings or reset the database.

## Apply

Run from the repository root against the Mock backend checkout:

```sh
bash m1/integrations/mock-source/apply.sh /path/to/argon-security-platform/backend
```

The script is idempotent, refuses to overwrite different overlay-owned controller/test files, and adds the integration test to the app. Then build and test with Maven from that backend directory. The included integration tests force a separate in-memory H2 database (`jdbc:h2:mem:argon-mock-cas`) and `create-drop`; they do not use the Mock's file-backed production H2 database.
