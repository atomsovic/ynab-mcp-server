# Private plan staging: operation and deployment review

This change is prepared locally, not deployed. It adds a SQLite Durable Object
behind the existing authenticated Worker, scoped to the GitHub numeric user ID
and explicitly selected plan. Local stdio keeps live reads and the bulk candidate
loader; it does not acquire a new filesystem staging database.

## Behavior

The first staged read fetches transactions, accounts, payees and category groups.
Later reads reuse a snapshot for five minutes; on-demand sync uses each
collection's own YNAB `server_knowledge` marker. Four successful responses,
including deletion tombstones, merge atomically with the next revision. Failed
syncs retain the prior database revision but fail the requesting read; inspect
`ynab_staging_status` for freshness, sanitized error and retry time. Concurrent
requests share one sync. There is no recurring upstream sync or automatic retry.

Transaction listing, unapproved transactions, accounts, payees, categories,
spending by payee/category, and category suggestions use one committed snapshot
per tool invocation. Results identify revision, retention start and sync time.
This is local consistency: YNAB's four endpoints are not an atomic upstream
snapshot. Cash flow, month and plan metadata tools remain live. Explicit date
requests older than retained history fail rather than return an incomplete total.

Explicit suggestion IDs missing from retention use one wholly live operation,
labeled `live_explicit_fallback`; its proposals are not saved to the queue.
Multiple IDs use one unfiltered collection read, request-order deduplication, and
at most ten sequential missing-ID lookups. Further missing IDs get explicit
per-row failures. A collection failure does not fan out to individual reads.
One requested ID still uses one direct lookup. This preserves inspection of old
or pending rows without mixing staged history with live candidates.

`ynab_category_review_queue` lists proposals and lets the user record an advisory
review decision, notes and questions. Suggestions save only bounded proposal,
confidence, brief evidence and fingerprint fields; persistence failure is visible
in `review_persistence`. Queue rows are invalidated when transaction eligibility,
fingerprint or selected category eligibility changes. A review decision never
authorizes application. `ynab_clear_staging` requires `confirm: true` and purges
snapshot and queue data; the next staged read can fetch a new snapshot.

`YNAB_READ_ONLY` still hides all YNAB write tools. Sync, queue edits, and clear are
local mutations and carry non-read-only MCP annotations. Application bypasses
staging: the existing tool refetches live transactions, checks fingerprints and
eligibility, and retains dry run, idempotent no-op and R2 audit safeguards. The
queue is not an audit log or rollback facility. See [category audit design](./category-audit-design.md).

## Privacy, retention and recovery

Stored financial fields include transaction dates, amounts, payees, memos,
categories, splits, approval/cleared/import fields, account balances and category
metadata needed by the existing tools. Credentials, authorization headers and raw
TypeSafe request/response bodies are not persisted. The private Worker binding
has no standalone public endpoint; normal OAuth and current-grant checks run
before constructing a scoped client.

Transactions retain twelve months plus older still-unapproved, uncategorized,
ordinary outflows. Review rows expire thirty days after their last update; all
financial staging data expires after thirty days without staging access.
Cleanup-only alarms enforce expiry without YNAB requests. Cloudflare alarm
availability affects physical deletion timing; access also enforces expiry.
Clear and expiry retain minimal scope, revision/generation and rate/cooldown
metadata to prevent quota bypass or an in-flight sync restoring purged data.
The separate R2 category audit is not deleted by clearing staging.

A failed/partial sync advances no collection marker. Retry after the reported
cooldown; do not repeatedly force sync. Clearing loses advisory notes/proposals
permanently and requires a full refetch. It does not undo YNAB changes. Recover
actual category writes using the audit/undo manifest and fresh live verification,
subject to the existing audit recovery limitations.

## Limits and rate coordination

Each sync reserves four requests durably, capped at 180 per rolling hour per
object. YNAB rate headers and HTTP 429 `Retry-After` can impose a persisted
cooldown; a restart lease blocks immediate overlapping retries. Each upstream
request times out after fifteen seconds; each response is bounded at 16 MiB and
50,000 records. Review saves allow 100 rows and the queue holds at most 1,000.
At capacity, oldest dismissed reviews (including their notes) are evicted only
as needed; pending, reviewed and stale rows are never evicted for capacity.
Oversize or malformed responses fail without partial publication. The first
transaction request is full-history to retain old pending candidates; plans over
these bounds need a separately designed import strategy.

This is not a global token rate limiter. Other tools, explicit live fallback,
other principals/objects and outside clients can share the token. YNAB's token
limit is 200 requests per rolling hour; remaining capacity is not guaranteed by
the local reserve. See the [official YNAB rate and delta documentation](https://api.ynab.com/).

## Migration and cost decision before deployment

Both checked-in Wrangler configurations add `PLAN_STAGING` / `PlanStagingStore`
and the additive `v3-plan-staging` SQLite migration. Preserve the existing OAuth
classes, bindings, migration history, grant enforcement and R2 bucket. No cron,
new secrets, paid-plan activation or credential grants are introduced. Migration
and publication still require explicit operator approval; no command here has
been run against a Cloudflare account.

SQLite Durable Objects are available on Workers Free. Current free allowances
include 100,000 requests/day, 5 million rows read/day, 100,000 rows written/day and
5 GB total SQL storage. Exceeding free limits causes failures. Requests, active
duration, SQL operations, alarm scheduling and retained storage consume quota;
paid accounts can incur overage charges. These are shared account allowances,
not a cost guarantee. Check [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
before approval (reviewed 2026-10-04).

On-demand reads still consume Durable Object requests and metadata/alarm writes;
sync reads the retained collections for merging and writes changed entities.
Retention deletes consume SQL writes. A large first import can materially use a
free daily write allowance. Review queue updates and cleanup also consume quota.
Existing Worker, R2, OAuth and opt-in TypeSafe costs remain separate. No account
usage or production plan size was inspected; actual cost/performance needs an
approved deployment and measurement with the operator's account.

Prefer a forward fix. To disable staging after deployment, remove only its
binding from the Worker configuration while keeping the class export/migration
history; reads return to their prior live behavior and quota profile. Review
notes remain stored until cleanup; clear while the binding is available if purge
is intended. Do not roll back across the existing OAuth grant-security migration
or delete OAuth/R2 resources. Removing a class/namespace is a separate destructive
migration and is not part of this change.
