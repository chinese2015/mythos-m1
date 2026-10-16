# PR delivery implementation plan

Spec: docs/superpowers/specs/2026-10-16-pr-delivery-design.md. User approved the three-step scope; implementation details refine that scope without another permission gate.

1. **External M2 publisher** (independent agent): tests RED, fixed branch derivation/verified intent guards, safe Git bundle staging and immutable push/reconciliation, API and stage additions. Own brain/publication.py, brain/api.py, brain/store.py stage enum only, tests/test_publication.py and own API tests. No remote publication.
2. **Atomic Mock completion** (independent agent): tracked source overlay/apply script and Java tests, @Version + transactional legacy PATCH + 409 conflicts + atomic idempotent ai-completion endpoint. Own integrations/mock-source/ only; use a separate test build, no running-service changes.
3. **Cordis SDLC** (root): Node tests RED; Gitea bounded credential client/reconcile; delivery policy/controller/service; integrate console publish and workflow input locks; atomic source adapter client.
4. **Console** (root): PR/outbox/gates/reviews/status/source sync panel, publish conflict handling, no merge button; preserve iframe.
5. **Integration** (root): full suites, independent whole-branch review; deploy backups + Mock overlay + owned process restart, publish actual verified Nova once, attach PR if supported; verify duplicate/restart and fixtures for merged closure. Use Browser/Computer to click actual product and record any policy/visual limitations. Check separate UX chat progress without sending unapproved messages.

Outcomes required: real PR URL/head matches candidate; no automatic merge; backend/source writes durable/reconcilable; external failures remain visible and do not close tasks; legacy tests pass. Final report includes current PR/review status, checks and remaining limitations, plus the created parallel chat directive.
