# Deploying the hardened remote MCP server

The Worker admits one configured GitHub login, one explicitly selected YNAB
plan, and a configured tool mode. The default `category-only` mode exposes reads
plus audited category application. A YNAB PAT is still account-wide at YNAB;
this server's restrictions do not protect a stolen PAT used elsewhere.

**No deployment is implied by these instructions or the prepared configuration.**
Wait for the reviewed commit and passing checks before connecting a deployment
pipeline. Do not enable automatic deployment of unfinished branches.

## Prepared configuration for this account

`wrangler.atomsovic.jsonc` is committed so a dashboard Git import can use it.
It contains only nonsecret values supplied by the operator:

| Setting/binding | Value |
| --- | --- |
| Worker name | `ynab-mcp-server` |
| `PUBLIC_ORIGIN` | `https://ynab-mcp-server.atomsovic2.workers.dev` |
| `OAUTH_KV` | KV namespace `44062199539d467695b9db319996689d` |
| `CATEGORY_AUDIT` | Private R2 bucket `ynab-category-audit` |
| `OAUTH_FLOWS` | SQLite Durable Object class `OAuthFlowStore` |
| Migration | `v1-oauth-flows`, `new_sqlite_classes: ["OAuthFlowStore"]` |
| Tool mode | `category-only` |

KV stores provider grants/tokens. R2 stores durable audit evidence. The Durable
Object stores ten-minute login state and one-use code-redemption gates; its
binding/class migration is installed by a later deployment, not by creating a
KV namespace. No R2 API/S3 key or cookie-signing secret is needed. R2 should remain
Standard storage, private, with no public bucket domain. Bucket/namespace ownership,
permissions and account billing were not checked through live APIs.

The config enables `keep_vars` for additional dashboard runtime values; values
explicitly present in the file, such as `PUBLIC_ORIGIN` and `YNAB_TOOL_MODE`, remain
file-owned. Secrets stay in Cloudflare. Automatic request observability is disabled
to avoid collecting OAuth callback query strings. `preview_urls: false` explicitly
disables preview URLs on redeploy, independent of dashboard defaults. No calendar cron or AI processing
is enabled in this account config.

## Prepare on desktop now

1. Enable MFA on Cloudflare and GitHub. Keep access to your password manager and
   MFA available on your phone. Confirm the intended account owns the supplied KV
   namespace and private bucket, and the workers.dev subdomain is `atomsovic2`.
2. Choose one YNAB plan. Record its full lowercase UUID from the YNAB web app URL;
   do not use `last-used`, a plan name, or a default-plan alias as the restriction.
3. Record the exact HTTPS OAuth callback URL shown/documented by the MCP connector
   you intend to use. This is the **client's return address**, not the Worker URL
   below. There is no wildcard or guessed vendor callback. HTTP, localhost and IP
   literal callbacks are rejected. A connector that only supports loopback OAuth
   needs a separately reviewed design; do not weaken this allowlist casually.
4. At GitHub Settings → Developer settings → OAuth Apps, prepare an OAuth App with:
   - Homepage: `https://ynab-mcp-server.atomsovic2.workers.dev`
   - Authorization callback: `https://ynab-mcp-server.atomsovic2.workers.dev/callback`
   These come from the finalized `/callback` handler. Keep the client secret in
   your password manager, never chat, GitHub source or Build environment settings.
5. Prepare your YNAB PAT privately and record the allowed GitHub username. The PAT
   and GitHub client secret are the only required runtime secrets. If you already
   have these, reuse them without creating extra credentials for R2.

## Dashboard-first deployment after the tested commit is ready

Use Cloudflare Workers & Pages (a Worker, not a Pages site), select/connect the
user's `atomsovic/ynab-mcp-server` repository, and explicitly select the reviewed
`fix/read-only-durable-category-audit` branch. If the named Worker already exists,
configure that Worker instead of assuming a new one is needed; this task did not
inspect its live deployment state.

Use these build settings:

| Setting | Value |
| --- | --- |
| Root directory | Repository root |
| Node version | 24 (the tested major) |
| Build command | `npm ci && npm run test:run && npm run typecheck && npm run build` |
| Deploy command | `npx wrangler deploy --config wrangler.atomsovic.jsonc` |

The explicit config argument matters: `wrangler.jsonc` is gitignored and is not
present in a GitHub checkout. Do not rely on automatic framework detection. Keep
preview/nonproduction deployments disabled for this private service. Connecting
Git integration can start a deployment, so do it only when you are ready; the
public discovery metadata and unauthenticated MCP challenges remain available;
registration, sign-in, token issuance and credential-bearing MCP requests remain
closed with HTTP 503 until required runtime configuration is complete. Cloudflare Builds may ask you to authorize its Git
integration and deployment token; those are account actions you perform, not
credentials this task created. Review its permissions before approving.

Cloudflare's [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
distinguishes build-time settings from runtime settings. Put the following under
**Worker Settings → Variables & Secrets**, not Build variables:

| Name | Type | Required value |
| --- | --- | --- |
| `YNAB_ALLOWED_PLAN_ID` | Text | Your selected lowercase YNAB plan UUID |
| `ALLOWED_GITHUB_LOGIN` | Text | Your GitHub username (the intended owner is `atomsovic`) |
| `GITHUB_CLIENT_ID` | Text | ID from your GitHub OAuth App |
| `OAUTH_ALLOWED_REDIRECT_URIS` | Text | JSON text array containing the exact client callback, e.g. `["https://YOUR_CLIENT/EXACT_CALLBACK"]`; replace the example |
| `YNAB_API_TOKEN` | Secret | Your YNAB PAT |
| `GITHUB_CLIENT_SECRET` | Secret | Your GitHub OAuth App secret |
| `YNAB_READ_ONLY` | Text, optional | `true` for initial read-only use; `false` or absent permits audited category apply |
| `OAUTH_ALLOWED_CLIENT_IDS` | Text, optional | JSON array of exact already-registered MCP client IDs for additional pinning |

The ChatGPT allowlist means `OAUTH_ALLOWED_REDIRECT_URIS`: the exact OAuth return
address displayed for your intended ChatGPT MCP/plugin connection, as a JSON text
array. It is not the Worker `/callback` used by the GitHub OAuth App. Discovery
can now run before this value is known, but registration and authorization remain
denied until the correct URL is configured. Client support and when its setup UI
reveals the callback still need verification; public discovery does not guarantee
that the client can finish onboarding without its callback being configured.

Public endpoints (only the canonical `PUBLIC_ORIGIN` is accepted):

- `GET /.well-known/oauth-authorization-server` publishes provider capabilities.
- `GET /.well-known/oauth-protected-resource/mcp` and the root
  `/.well-known/oauth-protected-resource` publish resource `PUBLIC_ORIGIN/mcp`.
- An unauthenticated `/mcp` request receives `401` with `WWW-Authenticate` pointing
  to the resource metadata. This challenge does not list tools or access budgets.

Public metadata needs only a valid `PUBLIC_ORIGIN`; it exposes no plan IDs,
logins, allowlist contents, client IDs, storage bindings or credentials. Missing or
malformed private configuration continues to block protected operations. Browser
preflight is supported; preview-host and forwarded-host spoofing remain denied.

The allowlist settings are **Text containing JSON**, not Cloudflare JSON-object
bindings. Leave `YNAB_PLAN_ID`/`YNAB_BUDGET_ID` unset, or set them to exactly the
selected UUID. Omit optional client-ID pinning until you know your connector's
registered ID; the consent screen shows it. Redirect allowlisting and explicit
consent are mandatory even without ID pinning. Client names are unverified labels.
Existing bad/empty values fail closed, rather than silently broadening access.

Choose retention/backups for the audit bucket. Verify the deployed Bindings tab
shows all three bindings above. If the deployment account lacks Durable Object,
KV or R2 permissions, stop and resolve the account-specific error. Do not make a
new public bucket or substitute in-memory state. This guide cannot guarantee
account-specific dashboard actions or billing eligibility.

## Finish from your phone

After the tested deployment/build integration exists, a phone browser can be used
to enter/save runtime values, inspect build status, and open your MCP client's
connector settings. Dashboard/GitHub screens may require desktop-site mode; a
fully phone-only first deployment is not promised.

Set the MCP server URL to:
`https://ynab-mcp-server.atomsovic2.workers.dev/mcp`.
The connector discovers `/authorize`, `/token` and `/register`; do not register
those endpoints as the GitHub callback. Review the server's consent page for the
client ID, exact return address, selected plan and access mode, approve it, then
sign in to GitHub as the allowed account. Use one active login tab; starting a
second replaces the browser-binding cookie. Finish within ten minutes.

Start with `YNAB_READ_ONLY=true` if you want to verify reading first. To permit
category writes later, change it to `false` and reconnect. Grants bind to the
selected plan and effective mode; changing either requires reconnecting. A failed
or interrupted code exchange also requires starting again, not replaying an old
code. No unauthenticated route exposes the Durable Object's internal actions.

Missing configuration, denied identity, failed storage or old grants do not grant
access. Standard provider KV propagation can still cause transient connection
failures; retry by starting a new authorization. Token/grant revocation and refresh
rotation remain provider responsibilities; the added atomic guard specifically
covers consent, GitHub callback and authorization-code redemption. It is not a
blanket guarantee about every OAuth replay scenario.

For a local CLI deployment instead, after explicitly deciding to deploy:
`npx wrangler deploy --config wrangler.atomsovic.jsonc`. Other operators should
copy `wrangler.example.jsonc` to ignored `wrangler.jsonc`, replace placeholders and
configure their own resources. Avoid using the account-specific config elsewhere.

## Categorize reminders (optional)

The Worker can drop a reminder on a Google Calendar when transactions are
waiting to be categorized. It runs hourly and acts once a day, in the local
hour you choose. With no service account configured the job is a no-op, so this
is entirely opt-in. The account-specific config has no cron; add one explicitly
if enabling reminders. Reminders also use `YNAB_ALLOWED_PLAN_ID`.

### 1. Create a service account

In the [Google Cloud console](https://console.cloud.google.com/projectcreate):

1. Create a project, then enable the
   [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
2. APIs & Services → Credentials → Create credentials → Service account
3. On the new account, Keys → Add key → Create new key → JSON

A service account avoids the usual OAuth dance: there are no refresh tokens to
store and no consent screen, because access comes from sharing the calendar
with it directly.

### 2. Share the calendar with it

In Google Calendar, open the calendar's settings → "Share with specific people
or groups" → add the service account's email with **Make changes to events**.

### 3. Configure and deploy

Set the deployment-specific calendar ID and service-account key as Worker
secrets. Configure `NAG_TIMEZONE`, the `NAG_HOUR_MIN`/`NAG_HOUR_MAX` window,
and `NAG_SINCE_DAYS` in `wrangler.jsonc` if their defaults do not suit you:

```bash
npx wrangler secret put NAG_CALENDAR_ID
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < service-account.json
npm run deploy
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NAG_CALENDAR_ID` | — | Calendar to write to. Unset disables the job. |
| `NAG_TIMEZONE` | `America/Los_Angeles` | IANA zone the reminder is scheduled in |
| `NAG_HOUR_MIN` | `8` | Earliest local hour the event may land on |
| `NAG_HOUR_MAX` | `20` | Latest local hour, inclusive. Set equal to the minimum for a fixed time. |

### How it behaves

- **Nothing pending, no event.** The reminder only exists when there is work.
- **A different hour each day.** The slot is drawn from the configured window,
  derived from the date so that every hourly run agrees on it — a per-run
  random draw would fire several times some days and never on others.
- **One event per day.** The event id is derived from the date, so a re-run
  updates that day's event rather than stacking duplicates.
- **The count is the current month.** It resets on the 1st, so the month you
  are budgeting is the month you are reminded about. Anything older is a
  footnote in the description, not the headline.
- **Transfers are ignored.** Moving money between your own accounts shows up
  as uncategorized in YNAB but never needs a category. In the plan this was
  built against, 77 of 80 "uncategorized" items were transfer legs.
- **The wording rotates daily.** Same mechanism as the hour: derived from the
  date, so it is stable within a day and different the next.
- **Daylight saving is handled.** Cloudflare crons are UTC, so the job runs
  hourly and acts only in the configured local hour, holding its wall-clock
  slot year round.

## TypeSafe category preview (optional)

Set runtime Text `YNAB_AI_CATEGORIZATION=true` and runtime Secret
`TYPESAFE_API_KEY` to your existing TypeSafe key. Both are required; keep the key
out of Build variables and source. `category-only` includes
`ynab_suggest_categories` once enabled, including when `YNAB_READ_ONLY=true`.
Refresh the client tool list after enabling. This setting is preserved by
`keep_vars`; secrets are retained separately.

When enabled, `ynab_suggest_categories` proposes categories
for eligible uncategorized outflows. It is a preview only and never writes to
YNAB. Applying a proposal requires a separate explicit write; see
[Category suggestions](./README.md#category-suggestions-optional) for the apply
tool and its safeguards.

See [Category suggestions](./README.md#category-suggestions-optional) for the
authoritative data-sharing contract, model and cost limits, and evaluation
caveats.

## Category application audit

Live `ynab_apply_category_suggestions` changes require a dedicated private R2
bucket bound as `CATEGORY_AUDIT`. It is intentionally absent by default: preview
and other tools work without it, but category application fails closed before
mutation. No Worker-local filesystem or background `waitUntil` persistence is
used. The prepared object and outcome object are both awaited.

After separately provisioning a bucket in your own Cloudflare account, add:

```jsonc
"r2_buckets": [
  { "binding": "CATEGORY_AUDIT", "bucket_name": "YOUR_PRIVATE_AUDIT_BUCKET" }
]
```

This repository does not create the bucket, grant credentials, configure billing,
or deploy it for you. Keep public access disabled. Use a dedicated bucket, not
the OAuth KV namespace. Objects are stored under `category-audit/v1/` with
conditional create-only puts, using the
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
A successful put acknowledges durable storage; a failed conditional write is
an error. See [audit setup and recovery](./README.md#category-application-audit)
for record contents, lookup, retention responsibilities and recovery limits.

For local Wrangler work, keep the binding local (do not set `remote: true`).
Local emulation is useful for synthetic checks but does not prove production R2
configuration, permissions or durability. Choose retention and backups before
using live category writes. `YNAB_CATEGORY_AUDIT_DIR` is Node-only and is ignored
by the Worker.

## Read-only mode

To expose only the tools that read data and none that change it, set
`YNAB_READ_ONLY` to `"true"` in `wrangler.jsonc` and redeploy. The write tools
disappear from `tools/list`; direct calls to their names are rejected. Reconnect
after changing the effective mode. The
TypeSafe preview is registered as read-only and remains available in this mode
only when both its feature flag and secret are configured.

## Local development

```bash
npm run dev:worker
```

Uses `.dev.vars` for local synthetic values (git-ignored). Secure cookies and the
canonical HTTPS origin are required; do not disable these checks for HTTP
localhost. Use the synthetic test suite for offline authorization checks. The OAuth flow needs a real GitHub
app to complete end to end; without one you can still exercise the unauthorized
paths and the OAuth metadata endpoints.

## Layout

| Path | Purpose |
| --- | --- |
| `src/registry.ts` | The one tool list, shared by both entry points |
| `src/index.ts` | stdio entry (local Claude Code / Claude Desktop) |
| `src/worker/index.ts` | Worker entry: OAuth in front of the MCP handler |
| `src/worker/mcp.ts` | Builds the MCP server and serves `/mcp` |
| `src/worker/github-handler.ts` | GitHub sign-in and the single-user gate |

## Active-grant migration (local change; deployment requires approval)

This change adds `OAUTH_GRANTS`, class `OAuthGrantStore`, with SQLite migration
`v2-oauth-grants`, alongside the existing `OAUTH_FLOWS`. Both example and
account-specific configs include it. Keep the original `v1-oauth-flows` migration;
do not delete or recreate existing namespaces. The new authority is required for
authenticated operation and adds a Durable Object request per MCP request plus
storage/requests during login and renewal. Its generation/tombstones persist;
the ten-minute cleanup alarm deletes only pending candidates.

Before any separately approved deployment:

1. Review the local provider extension in `patches/README.md`. `npm ci` applies it;
   `npm run check:oauth-provider` verifies its pinned source and hashes. Both
   Wrangler configurations run the check in their custom build command. Keep that
   command if using another config; do not bypass it with build overrides.
2. Run the full test, typecheck, build and Worker dry-run checks. Review the new
   migration and ensure the Worker version exports both Durable Object classes.
3. Schedule **one reconnect for all existing version-1 connections**. They are
   intentionally rejected; a missing authority record never adopts an old grant.
4. Deploy only after approval, with the new binding/migration and existing private
   settings preserved. Connect once, select that connection, and verify reads and
   tool discovery. No live deployment or credentials were used during these tests.

Subsequent replacement consent keeps the existing connection until new tokens
are persisted and the authority atomically activates the replacement. Abandoned
or failed pre-activation attempts preserve the old connection. Same-user/client
parallel connections are not enabled. Token lifetimes remain one hour / seven
days (refresh lifetime is absolute, not sliding). Separate client IDs remain
independent, as before.

An activation can commit and its response be lost: a new connection may still be
needed then. Requests that already passed authorization cannot be retroactively
cancelled. Authority outages fail closed with temporary errors; do not delete its
storage or change bindings to recover them. Replaced provider records can remain
in KV until their existing TTL expires, but are not authorized.

**Rollback caution:** returning to pre-migration code removes authority enforcement
and may accept still-unexpired legacy/replaced provider records. Do not blindly
roll back to the old build or an unpatched provider. Use a forward fix, or a
separately reviewed revocation/migration procedure with planned reconnects.

### Diagnose discovery without reading financial data

An already-authorized client can request `GET /mcp/diagnostics` with its existing
Bearer token kept private. The response contains only authorization version,
effective mode/read-only, AI opt-in/key-present booleans, suggestion-registration
boolean and tool count. It is `no-store`, accepts GET only, and requires the same
valid active grant and policy as MCP. It returns no credentials, identities, plan
IDs or financial data. Do not paste tokens, cookies or a full browser HAR into chat.

This endpoint distinguishes effective Worker registration from client metadata;
it does not fix or reveal ChatGPT's internal **Refresh tools** failure. Keep that
issue separate and inspect its sanitized status/error using the newly valid
connection.
