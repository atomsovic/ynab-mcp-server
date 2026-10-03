# Deferred OAuth Replacement Implementation Plan

> Execute inline with superpowers:executing-plans; independent security review at completion.

**Goal:** Keep the old connection until durable replacement issuance and activation.
**Architecture:** Separate SQLite Durable Object active-grant authority; request-local validated exchange context and post-provider-response activation. Version-2 grants require authority checks; v1 reconnects once.
**Tech Stack:** TypeScript, Workers OAuth provider 0.10.3, SQLite DO, KV, Vitest/workerd.
**Spec:** docs/oauth-replacement-design.md

## Global constraints
- One active grant per user/client. 3600-second access and 604800-second absolute refresh TTL.
- Preserve selected-plan/read-only, PKCE, CSRF and replay guards; no real upstream calls.
- Local implementation/tests only. No push, deployment or credential access.

## Review focus
- Code replay must not revoke the winner before application hooks run.
- Validated refresh revocation must fence concurrent late refresh writes.
- Ambiguous activation failure must not restore a previous generation.
- Missing/expired authority state must never accept legacy or orphan tokens.
- Dependency extension must fail closed on unsupported provider versions.

## Tasks
1. Write authority tests, observe red, implement `OAuthGrantStore` and binding helpers: begin, activate, check, revoke; durable generation/tombstone, bounded expiring pending candidates. Test concurrent CAS and restart.
2. Write actual OAuth replacement/replay/revocation tests, observe red. Add pinned provider extension (replay rejection without revocation; validated grant-revocation callback). Integrate versioned props and request-local post-persistence activation, MCP/refresh checks, temporary errors and migration binding.
3. Add injected persistence failure, abandoned code, races, DO response loss/restart, wrong-owner revocation, TTL/renewal and legacy-migration regressions. Update fixtures without bypassing authority.
4. Add authenticated, financial-data-free discovery diagnostics if it fits existing provider routing; document migration, patch maintenance, response-loss boundary and operational risks. Full tests, browser, type/build, isolated bundle; independent review and fix findings.

## Ledger
- Initial baseline: main af5e6b7; only prior approved design untracked. Working on local fix/deferred-oauth-replacement branch in task checkout; dependencies already installed.
- Ruling: provider lacks validated revocation callback and revokes on replay before application callback. A minimal pinned local extension is necessary; no private-KV interception or ownership inferred from HTTP200. Cost: maintaining/checking patch on provider upgrades. Explicitly report before production approval.
- Ruling: preserve checkout review as an uncommitted diff; no task commits or external changes required by user.
- Task 1 complete: authority tests red (missing implementation) -> 5 green initially; expanded bounds/alarm/restart tests included in full suite.
- Task 2 complete: replacement tests observed 4 failing / 3 passing before integration -> all green; local provider extension reviewed explicitly.
- Task 3 complete: deterministic late token/grant writes, ambiguous activation, orphan credentials, expiry, migration and actual workerd restart/concurrency covered.
- Task 4 complete: authenticated diagnostics and migration/maintenance docs added. Security review packaging/build-check blockers reproduced red -> 5 green; code review late-grant-recreation test added. No deferred findings.
- Final verification: 495/495 full tests with Chromium; typecheck/build/audit restart and isolated Worker dry-run passed. Detailed commands and limits: docs/oauth-replacement-verification.md.
- Ruling: patch application uses pure Node contextual replacements with before/after hashes, not an external patch utility; installer is packaged and Wrangler checks it. Cost: provider upgrades require deliberate rebasing.
- Ruling: diagnostics reports authorization version, gates and count; no build ID/descriptor hash in this scoped implementation. Cost: it cannot distinguish every schema-only build change, and does not reveal the client's internal import failure.
