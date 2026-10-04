# Bulk category candidate reads

Implemented locally on 2026-10-04 as task 2 of private plan staging. No live
YNAB or TypeSafe requests, deployment, push, or budget writes were performed.

## Change and request bounds

`loadExplicitCategoryCandidates(api, planId, transactionIds)` in
`src/tools/categoryCandidates.ts` replaces the suggestion tool's one-request-per-ID
candidate load. Multiple distinct IDs fetch the unfiltered plan transaction
collection once, index by ID in request-local memory, and select in first-requested
order. Duplicate IDs are inspected once. No date filter is applied, so explicitly
requested old rows remain available. Deleted rows remain omitted, matching prior
behavior. One distinct ID retains the individual endpoint to avoid a full download.

The SDK's collection endpoint explicitly excludes pending transactions. Absent IDs
therefore receive individual lookups, in requested order, capped at 10 per
invocation. IDs beyond that cap receive a failed result explaining that they may
be pending and can be retried alone or in groups of at most 10. Individual not-found
errors remain per-row failures. A collection error returns failures for all
requested IDs and does not fan out to individual calls. Successful sibling rows
remain available when individual lookups fail. There is no shared or persistent
cache in this helper; each invocation/plan gets its own index.

For a 98- or 100-row fully present batch, the suggestion invocation makes 1 candidate
collection call, 4 prerequisite calls, and up to 10 TypeSafe calls: **15 external
requests**. At most 10 missing-ID fallback requests raises this bound to **25**.
These counts exclude authentication and staging coordination requests. Concurrency
limits alone would not repair the previous cumulative Worker subrequest exhaustion.

The collection fetch downloads all returned plan transactions even when only two
IDs are requested. YNAB collection response size, memory, and latency remain bounded
by the upstream plan rather than the requested selection; this helper does not
introduce pagination or cross-request storage. Durable staging is the separate
approved integration that amortizes those reads. More than 10 pending/absent IDs
requires explicit smaller retries; this is reported, never silently omitted.

## Verification

- Red test: `npm run test:run -- src/tests/categoryCandidates.test.ts` before
  implementation: **2 failed**, reproducing incomplete/failed 98- and 100-row
  previews under a synthetic 50-subrequest cap using the real YNAB SDK.
- After implementation and fixture correction:
  `npm run test:run -- src/tests/categoryCandidates.test.ts src/tests/SuggestCategoriesTool.test.ts`:
  **81 passed** (10 new tests). Full previews are suggested with exactly 15
  requests and 10 synthetic provider calls. Tests also cover old IDs, order,
  deduplication, pending fallback, deleted rows through both endpoints, missing
  rows, fallback exhaustion, collection failures without fanout, single-ID behavior,
  and no stale cross-invocation or cross-plan cache.
- `npm run typecheck`: **passed**, Node and Worker targets.
- `git diff --check`: **passed** at task verification.
- A concurrent full run at 00:48 UTC (`npm run test:run`) reported **547 passed,
  7 failed, 5 skipped**. All seven failures were in `src/tests/planStaging.test.ts`,
  which another agent was actively implementing; existing and bulk-candidate test
  files passed. Parent requested deferring a fresh full run until staging
  integration is stable. This task does not claim the combined checkout is green.

Auth, TypeSafe probability handling, eligibility checks, fingerprints, dry-run
behavior, apply-time fresh reads, and audit persistence are unchanged by this task.
The shared suggestion test fixture now returns candidates plus history for an
unfiltered collection read, and history only when a since-date is provided.
