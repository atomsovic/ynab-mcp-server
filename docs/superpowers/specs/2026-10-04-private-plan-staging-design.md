# Private plan staging design

Approved by the user on 2026-10-04: build a private on-demand SQLite Durable
Object copy of the selected joint plan, delta sync, shared snapshot analysis,
durable category review queue, and unchanged fresh-check/audit write boundary.
No deployment or live API calls are authorized in this implementation phase.

One PLAN_STAGING SQLite Durable Object per authenticated numeric GitHub user ID
and selected plan UUID. A private binding-only client supplies this immutable
scope; no unauthenticated HTTP route exposes storage. Persist scope and reject
mismatches. No token/key is serialized into requests, tables or diagnostic errors.

Sync four collections (transactions/accounts/payees/categories) with independent
YNAB server_knowledge markers. Stage responses off to the side; merge/deletions,
retention, revision and markers commit atomically only when every endpoint
succeeds. Snapshot consistency means one committed local revision, not an
upstream multi-endpoint transaction. Partial failures retain the prior revision
and expose sanitized freshness/error metadata. Singleflight coordinates overlap;
durable cooldown/rate reservations prevent restart/retry stampedes. Fetches have
timeouts and no automatic retry loop. Use YNAB rate headers and Retry-After;
conservative per-object 180-per-rolling-hour sync request ceiling leaves headroom.
Other consumers of the same token are not globally coordinated.

Store allowlisted transaction fields required by existing categorization/reports,
12 months of history plus old still-unapproved uncategorized ordinary outflows.
Accounts/payees/categories retain fields needed by current read tools. Purge
staging and review financial data after 30 days without access, with cleanup-only
alarms (never background fetch). Prune review rows after 30 days and when source
transactions disappear; invalidate proposals on changed fingerprints. Persist no
raw TypeSafe request/response, secret, header or full error payload. A clear tool
can purge the stage/queue; rate/backoff metadata must survive purge to avoid
turning deletion into a rate-limit bypass.

Expose tools to sync/status/query snapshot and list/update/clear the advisory
review queue. YNAB_READ_ONLY continues to disable all YNAB writes; local queue
edits change only staging and must be described as such. No queue action grants
approval to apply. Suggestion results persist bounded proposal/evidence/confidence
and unresolved questions tagged with snapshot revision/fingerprint. Failed queue
persistence is explicitly reported, never silently claimed successful.

Read analysis uses a single immutable snapshot per tool invocation and returns
revision/synced_at/history_since/staleness metadata. Never wrap the apply tool's
YNAB client: it must refetch affected live transactions and verify fingerprints
before writes and R2 audit. Existing selected-plan/OAuth checks remain intact.
When staging is unavailable, staging-enabled reads fail closed rather than
stampeding the upstream API. Local stdio remains supported without durable
staging through request-local bulk loading.

Bulk explicit candidate loading replaces N individual requests with one full
plan transaction collection and indexed selection, preserves request order,
deduplication, old-row and deleted semantics, and handles IDs absent from the
collection (including pending differences) with bounded explicit fallback/reporting.
Never silently discard requested missing IDs. Request budgets must remain below
Worker Free's external subrequest limit, including prerequisites and TypeSafe.

Migration: new v3 PLAN_STAGING SQLite class; existing OAuth classes and R2 audit
untouched. Default on-demand freshness window 5 minutes. No cron added, no paid
service activation. Document storage/request/alarm costs, retained data, purge,
rollback, initial load bounds and the YNAB shared-token rate-budget limitation
before requesting deployment approval.

Explicit suggestion IDs outside retention use a wholly live bounded bulk read,
clearly labeled live_explicit_fallback and not persisted to the review queue.
This avoids mixing live candidates with staged history. Cash flow/month/plan
metadata tools remain live; only the collections enumerated in integration.ts
use staging.
