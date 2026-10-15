# Execution ledger — M1 Docker Sandbox PoC

Plan: docs/sandbox-poc.md

Spec: ../Argon_AI_Brain_总体方案_v2.0.md §8.1 and user-approved Sandbox/native-capability/multi-user amendments.

- Ruling: use a new isolated m1 Git repository because the parent workspace is not a Git repository; no parent documents or credentials enter Git.
- Ruling: supersede host-only M1 execution with Docker A/B and concurrent owner-scoped Sandbox validation. Cost if wrong: revise adapters before full M1 coding.
- Ruling: two owner-labelled Sandbox tests do not prove multi-user sign-in; report authentication separately.
- Pre-flight: file and process providers must address the same task files. Web changes uses host paths, so test an explicitly shared per-task bind mount.
- Pre-flight: official SSH providers match 0.2.0-rc.2; validate them before developing new provider code.
