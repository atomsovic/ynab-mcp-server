# Private plan staging implementation plan

User authorized implementation of the recorded design and delegated independent
reviews; deployment remains a separate approval. Base: 14bce83.

1. Durable core: src/worker/plan-staging.ts using src/staging/types.ts; SQLite
   atomic snapshots, independent delta markers/deletions, request coordination,
   retention/purge and advisory review queue. Mock YNAB tests plus real workerd
   restart/failure/concurrency tests. Never store secrets or raw provider payloads.
2. Bulk candidate reads: src/tools/SuggestCategoriesTool.ts and regression tests.
   Preserve explicit selection/order/duplicates and meaningful absent-ID results;
   avoid 98 external calls. Cover old/pending/deleted and request quota behavior.
3. Authenticated integration: binding-only staging client, Worker principal
   scoping, registry context and selected read adapters/tools. Persist proposals
   using a single snapshot revision. Apply remains on live API. Add v3 migration,
   docs, privacy/retention and deployment cost review.
4. Verify: snapshot/delta/restart/concurrent/error/429/isolation/review tests,
   stale apply regression, all existing OAuth and TypeSafe cases, full browser
   suite, Node/Worker typechecks, builds, audit restart, synthetic Worker bundle.
   Independent code and security review; address findings; no push or deployment.

Interfaces: src/staging/types.ts is the common contract. Store operations are
POST /snapshot, /sync, /status, /reviews/save, /reviews/list, /reviews/update,
/clear with body {scope:{userId,planId},...}; save takes revision/rows, update takes
transactionId/decision/note/questions. Success JSON is the corresponding interface
(or {}); sanitized {error, retry_after?} errors use HTTP 400/409/429/503.

Progress ledger: implementation complete. Independent review findings addressed
with regression tests (rate observations, queue capacity, concurrent review
saves, diagnostics parity and malformed internal responses). Full verification
passed: 602 tests, Node/Worker typechecks, Node build, synthetic Worker bundle
and audit restart. See docs/private-plan-staging-verification.md. Deployment
remains unapproved.
