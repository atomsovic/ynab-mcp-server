# Verification — login and access hardening

Validated locally with Node `v24.19.0`, npm `11.9.0`, and Wrangler `4.147.0`.
All budget, TypeSafe and GitHub OAuth responses are synthetic. No deployment,
live budget/TypeSafe/OAuth calls, credential creation or account changes ran.

## Commands and results

From `/workspace/ynab-mcp-server`:

| Command | Result |
| --- | --- |
| `npm run test:run` | Passed: 444 tests in 34 files. |
| `npm run typecheck` | Passed: Node and Worker TypeScript targets. |
| `npm run build` | Passed: Node build. |
| `node scripts/verify-category-audit-restart.mjs` | Passed: audit survives separate Node writer/reader processes. |
| `git diff --check` | Passed. |

No lint command/configuration exists in this repository. No production dependency
or lockfile changes were needed.

The Worker bundle passed with this command, from `/tmp`:

```bash
env -i PATH="$PATH" XDG_CONFIG_HOME=/tmp/ynab-worker-build/config WRANGLER_SEND_METRICS=false node /workspace/ynab-mcp-server/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config /tmp/ynab-worker-build/wrangler.json --outdir /tmp/ynab-worker-build/dist
```

The temporary config used the absolute Worker entry path, `nodejs_compat`,
compatibility date `2026-09-01`, synthetic KV/R2 identifiers, `OAUTH_FLOWS` binding
to `OAuthFlowStore`, and its `v1-oauth-flows` SQLite migration. The cleared
environment and isolated config directory avoided project credentials and remote
bindings. Result: `--dry-run: exiting now`, 1802.74 KiB (gzip 292.77 KiB). This
checks bundling, not migration execution or live Cloudflare permissions.

## Security evidence

- Tests exercise actual provider registration, consent, callback, PKCE exchange
  and authenticated MCP requests, with synthetic KV and Durable Object storage.
- A concurrent redemption regression reproduced two successful exchanges before
  the atomic guard; afterward exactly one succeeds. Invalid PKCE does not consume
  the valid code; missing/expired/replayed gates and storage errors fail closed.
- Browser/CSRF/origin mismatch, consent denial/replay, expiry, tampered callbacks,
  XSS metadata, wrong identity, policy changes and failed upstream responses are
  covered. No grant is issued when preparing its code gate fails.
- Entry-point tests cover selected-plan defaults, both aliases, foreign audit
  records, restricted enumeration, read-only and hidden direct tool calls.
  Scheduled reminders also use only the selected plan.
- Independent review found an HTTPS-loopback allowlist gap, including trailing-dot
  hostnames. The new cases failed before the fix and pass afterward. Final review
  identified no remaining blockers and independently passed 64 focused security
  tests. Earlier category-audit review and evidence are recorded separately in
  `category-audit-verification.md`.

## Limits and remaining setup

KV, R2 and Durable Object behavior is mocked; real distributed persistence,
migrations, propagation, account permissions, browser/client interoperability and
GitHub OAuth are untested. Only local file auditing has a separate-process restart
smoke test. Live YNAB/TypeSafe calls and real transaction writes remain untested.

The selected YNAB plan UUID and exact MCP client callback URL still need operator
configuration. Private PAT/OAuth secrets stay outside source and chat. The prepared
account config does not deploy anything. Existing grants require reconnection;
changed policy and interrupted exchanges fail closed. Refresh rotation/revocation
remain provider-owned, and a stolen YNAB PAT retains its direct YNAB permissions.

Audit preparation and YNAB writes cannot form one atomic transaction. API errors
and partial responses can leave unknown outcomes. Preserve the before-state and
reconcile current YNAB state before retrying or manually restoring; there is no
automatic rollback or protection against all concurrent external edits.

## Follow-on: discovery bootstrap and preview URLs

Public RFC 8414 authorization-server metadata and RFC 9728 protected-resource
metadata now need only the canonical public origin. The provider's unauthenticated
MCP challenge includes `WWW-Authenticate` with the resource-metadata URL. Full
security validation remains mandatory before registration, consent/callback,
token issuance and credential-bearing MCP requests. Both deployment configs now
set `preview_urls: false` explicitly.

Seven new regression cases failed before implementation; the updated full suite
passes **450 tests in 34 files** (`npm run test:run`). `npm run typecheck`,
`npm run build`, `node scripts/verify-category-audit-restart.mjs`, and
`git diff --check` also pass. No lint script exists. Independent review found no
blockers and separately passed 49 focused OAuth tests.

Worker bundling passed from `/tmp` with a cleared environment and a synthetic
config containing the same DO/KV/R2 binding types plus `preview_urls: false`:

```bash
env -i PATH="$PATH" XDG_CONFIG_HOME=/tmp/ynab-discovery-bundle/config WRANGLER_SEND_METRICS=false node /workspace/ynab-mcp-server/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config /tmp/ynab-discovery-bundle/wrangler.json --outdir /tmp/ynab-discovery-bundle/dist
```

Result: `--dry-run: exiting now`, 1803.60 KiB (gzip 293.00 KiB). These checks do
not establish client onboarding compatibility or live OAuth/API behavior.
