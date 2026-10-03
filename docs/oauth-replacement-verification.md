# Deferred OAuth replacement verification

Verification recorded on `fix/deferred-oauth-replacement`, based on
`af5e6b7ede8ab88f4cca6547eceaa82c04b477ef`, before commit, push or deployment.
Merge and deployment were subsequently approved on 2026-10-03; deployment
confirmation is reported separately.
All identities, tokens, transactions and service responses used in tests are
synthetic. No live GitHub sign-in, YNAB or TypeSafe request was made.

## Result

The previous connection stays active through abandoned replacement consent,
invalid PKCE and failed code-redemption persistence. It is replaced only after
provider token issuance succeeds and the durable generation comparison activates
the candidate. Only one concurrent candidate based on the same generation wins.
Active-grant checks fence both MCP requests and refreshes. Version-1 grants are
not migrated implicitly: one planned reconnect is required after future deployment.

Read-only and selected-plan controls, browser binding, CSRF, code single-use and
existing 3600-second access / absolute 604800-second refresh lifetimes remain.
Authenticated `GET /mcp/diagnostics` reports only effective gates and tool count.
It does not diagnose the ChatGPT importer or claim to fix metadata refresh.

## Tests actually run

- `YNAB_BROWSER_TESTS=true npm run test:run`: **495 passed in 40 files**, including
  all five native Chromium consent cases and actual workerd OAuth tests.
- `npm run typecheck`: passed for Node and Worker TypeScript targets.
- `npm run build`: passed.
- `node scripts/verify-category-audit-restart.mjs`: passed; audit prepared state
  survives independent Node processes.
- `git diff --check`: passed.
- `node scripts/patch-oauth-provider.mjs --check`: passed (also required by test,
  typecheck, build and both Wrangler custom build commands).
- Provider installer tests reconstruct an unpatched 0.10.3 fixture, reject missing
  patch in check-only mode, apply/reapply without external tools, reject tampering
  and upgrades, and verify `npm pack --dry-run --ignore-scripts --json` contains
  the required installer and patch artifacts.
- Offline `npm install --package-lock-only --ignore-scripts --offline --no-audit
  --no-fund` with distinct empty user/global config files and a temporary cache
  completed successfully. Unrelated npm normalization of libc metadata was not
  retained. No dependency version changed except pinning the existing provider.

Worker bundling used only a synthetic config outside the checkout and a cleared
environment, from `/tmp`:

```bash
env -i PATH="$PATH" XDG_CONFIG_HOME=/tmp/ynab-discovery-bundle/config WRANGLER_SEND_METRICS=false node /workspace/ynab-mcp-server/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config /tmp/ynab-discovery-bundle/wrangler.json --outdir /tmp/ynab-discovery-bundle/dist
```

Result: `--dry-run: exiting now`, **1814.22 KiB / gzip 295.19 KiB**. The config
contains the two DO classes/migrations, zero/synthetic KV and R2 identifiers,
`https://worker.example` and the provider checksum custom build command. No live
configuration or credential files were used. A dry-run is not deployment.

There is no configured lint command in this repository.

## Regression evidence

Before integration, the new replacement suite failed four cases: abandoned / bad
PKCE replacement lost old access; grant/token persistence failure lost old access;
code replay revoked the winner. Those cases passed after integration. The existing
provider revocation default is replaced only with the documented active authority.

Coverage includes:

- Persisted-but-unactivated tokens cannot call MCP or refresh.
- Lost activation response before and after durable commit; never roll back an
  ambiguous commit or return unactivated credentials.
- Simultaneous same-code redemption and competing replacement candidates.
- Refresh completion after replacement/revocation, including a refresh recreating
  the provider grant after deletion: the durable tombstone still denies it.
- Correct-client versus wrong-client refresh revocation; access-token-only
  revocation retains renewal semantics; distinct clients remain independent.
- Expired candidates, active expiry, cleanup alarms retaining tombstones, bounded
  pending candidates, invalid internal payloads and storage outages.
- Three sequential renewals preserving the original refresh deadline, plus
  selected-plan/mode checks and read-only tool exposure.
- Real workerd process restart with local KV/SQLite, preserving pending candidates,
  active winner and revoked state. Actual-runtime concurrent replacement has one
  winner. Cryptographically valid v1 test credentials are rejected after switching
  to the v2 implementation; a fresh connection succeeds.
- Authenticated diagnostics deny unauthenticated requests, return no-store data
  without secrets/identities/financial fields, reflect missing AI key configuration,
  and reject unsupported methods.

## Independent review

Security review independently passed 23 focused cases and found two integration
blockers: missing patch artifacts in the npm package and no checksum check in
Wrangler's direct build path. Both were reproduced by new failing tests, fixed,
and verified by five passing installer/configuration tests plus the full suite.

A separate whole-diff code review independently passed 33 focused tests, including
actual workerd persistence/migration and installer checks, and found no production
logic blocker. Its requested late-grant-recreation test was added and passed.

A subsequent storage-error check exposed generic permanent-style errors for DO
outages in code redemption / callback. Three failing regressions were added, then
fixed to return sanitized temporary 503 errors; the 41 focused cases passed and
are included in the final full suite. No review findings remain deferred.

## Deployment and recovery limits

See `DEPLOY.md` and `patches/README.md` before a separately approved deployment.
The new authority binding/migration and one planned reconnect are required.
Authority checks add runtime latency/storage cost and fail closed on outages.
Permanent authority generations must not be reset as an outage workaround.

The pinned provider extension is security-sensitive and must be reviewed on any
upgrade. Replaced KV grants remain stored until existing expiry but are inactive.
Blind rollback to pre-authority code could accept old provider records; prefer a
forward fix or a separately reviewed revocation/migration procedure.

Once activation commits, response loss can still leave the client without its new
credentials. Requests that passed authorization before replacement cannot be
retroactively cancelled. A consumed code with failed issuance requires fresh
consent; it does not take down the old active connection. Seven-day refresh expiry
is unchanged. Live deployment, production OAuth round trips, real network outages,
iOS/WebKit and ChatGPT metadata import remain untested.
