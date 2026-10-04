# Private plan staging verification

Verified 2026-10-04 in the task checkout on `feat/private-plan-staging`, based on
`14bce83f8511deafb4e6e45678e63b108e01fecc`. No live YNAB or TypeSafe calls,
account deployment, new credentials, push or PR publication were performed.
All upstream data and credentials in test fixtures are synthetic.

| Command | Result |
| --- | --- |
| `YNAB_BROWSER_TESTS=true npm run test:run` | Exit 0; 45 files, 602 tests passed, including browser OAuth consent and real workerd/SQLite persistence |
| `npm run typecheck` | Exit 0; Node and Worker TypeScript targets, pinned OAuth provider patch integrity |
| `npm run build` | Exit 0; Node distributable compiled |
| `node scripts/verify-category-audit-restart.mjs` | Exit 0; prepared audit survives two independent Node processes |
| `git diff --check` | Exit 0 |

There is no configured lint script in `package.json`; no lint run is claimed.
The first full run had one outdated default Worker tool-count expectation; it was
updated to exclude optional staging tools when the binding is absent. The final
complete rerun above passed without skipped browser cases.

Worker bundling also exited 0 using a temporary synthetic configuration with all
three SQLite classes/migrations, fake KV/R2 resource names and no credentials:

```bash
env -i PATH="$PATH" \
  XDG_CONFIG_HOME=/tmp/ynab-discovery-bundle/config \
  WRANGLER_SEND_METRICS=false \
  node /workspace/ynab-mcp-server/node_modules/wrangler/bin/wrangler.js \
  deploy --dry-run \
  --config /tmp/ynab-discovery-bundle/wrangler.json \
  --outdir /tmp/ynab-discovery-bundle/dist
```

This was run from `/tmp`. Wrangler reported `PLAN_STAGING (PlanStagingStore)`
alongside the existing OAuth bindings, then `--dry-run: exiting now.` It did not
publish or contact a Cloudflare account for deployment.

New coverage includes full/delta sync and independent markers, transaction and
category/account/payee deletion/moves, atomic rollback after storage failure,
malformed responses, retention and cleanup-only alarms, clear during in-flight
sync, overlapping requests, restart persistence, durable 429/timeout cooldown,
rolling-hour quota and decreasing upstream observations, immutable plan/principal
scope, bounded review persistence and stale review protections, dismissed queue
capacity recovery, review saves concurrent with sync hashing, split-filtered
reads, read-only registration, fresh live apply checks and explicit old-ID live
fallback. Bulk read tests cover order, deduplication, older/pending/deleted IDs,
collection failures and capped missing-ID lookups. Existing application audit,
partial/failed writes, eligibility, no-op/dry-run, OAuth and TypeSafe parser tests
remain in the full suite.

Independent code and security reviews found and verified fixes for category group
invalidation, suggestion mutation annotations, rate observation aging, queue
capacity recovery, sync/review races, diagnostic registration parity and malformed
internal response sanitization. Both final reviews reported no outstanding
blocking findings. Reviewers independently reran focused tests.

## Limits of the evidence

Production migration, Cloudflare quota/account usage, actual plan size and latency,
live YNAB delta/header behavior and real TypeSafe responses were not tested. The
private snapshot is advisory; upstream endpoints are not an atomic transaction.
Other consumers of the YNAB token are outside this per-object request limiter.
Full imports exceeding 16 MiB/collection or 50,000 records fail safely and require
a separately designed import strategy. No deployment approval is inferred.

Before any deployment, review [retention, migration, rollback and costs](./private-plan-staging.md).
The existing read-only configuration fix and durable category audit were already
present in the base and are reverified by these tests, not newly reimplemented.
