# ynab-mcp-server

A Model Context Protocol (MCP) server for interacting with your YNAB plans at https://ynab.com

In order to have an AI interact with this tool, you will need to get your Personal Access Token
from YNAB: https://api.ynab.com/#personal-access-tokens. When adding this MCP server to any
client, you will need to provide your personal access token as YNAB_API_TOKEN. **This token
is never directly sent to the LLM.** It is stored privately in an environment variable for
use with the YNAB api.

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI
assistant read and modify a [YNAB](https://ynab.com) plan.

The server talks to the YNAB API through the official
[`ynab` SDK](https://github.com/ynab/ynab-sdk-js). Your Personal Access Token
lives in an environment variable and is never sent to the model.

It runs two ways from one codebase:

- **Local (stdio)** — a child process of Claude Code or Claude Desktop on your
  own machine. Simplest, but only works on that machine while it is running.
- **Remote (Cloudflare Worker)** — deployed behind GitHub sign-in and added to
  claude.ai as a custom connector, so it works from the web and the mobile app
  with your computer switched off. See [DEPLOY.md](./DEPLOY.md).

Both entry points use `src/registry.ts`. Worker-only private staging tools
are exposed when the authenticated `PLAN_STAGING` binding is configured. See
[private staging behavior and retention](./docs/private-plan-staging.md).

Other providers:

<a href="https://glama.ai/mcp/servers/@calebl/ynab-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@calebl/ynab-mcp-server/badge" alt="YNAB Server MCP server" />
</a>

[![LightNow](https://lightnow.ai/badge/io.github.calebl/ynab-mcp-server)](https://lightnow.ai/servers/io.github.calebl/ynab-mcp-server)


## Setup

Get a Personal Access Token from <https://api.ynab.com/#personal-access-tokens>, then:

```bash
npm install
npm run build
```

Environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `YNAB_API_TOKEN` | yes | Personal Access Token used for every API call |
| `YNAB_READ_ONLY` | no | Set to `"true"` to omit all write tools in both local and Worker servers. |
| `YNAB_CATEGORY_AUDIT_DIR` | for local category writes | Existing private directory on persistent storage for category audit files. See [audit setup](#category-application-audit). |
| `YNAB_ALLOWED_PLAN_ID` | yes | One explicit lowercase budget/plan UUID; enforced in both entry points. Omitted tool IDs use it and alternate IDs are rejected. Obtain it from your YNAB app before setup. |
| `YNAB_TOOL_MODE` | no | `category-only` (default), `read-only`, or explicit `full`. Safe mode exposes reviewed reads plus only audited category application. |
| `YNAB_PLAN_ID` / `YNAB_BUDGET_ID` | no | Compatibility defaults; if set, must equal `YNAB_ALLOWED_PLAN_ID`. They do not grant access. |
| `TYPESAFE_API_KEY` | no | Operator-owned TypeSafe credential. Required, but not sufficient, to enable category suggestions. |
| `YNAB_AI_CATEGORIZATION` | no | Set to `"true"` together with `TYPESAFE_API_KEY` to expose the opt-in suggestion tool. |

### Local: Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp-server/dist/index.js"],
      "env": {
        "YNAB_API_TOKEN": "your-token",
        "YNAB_ALLOWED_PLAN_ID": "11111111-1111-4111-8111-111111111111"
      }
    }
  }
}
```

### Remote: phone and claude.ai

The stdio server cannot be reached from a phone. Deploy `src/worker/` to
Cloudflare Workers and connect an MCP client using its exact approved callback
URL. [DEPLOY.md](./DEPLOY.md) includes the dashboard-first setup, required
bindings and settings, and a desktop-to-phone checklist.

GitHub sign-in admits only `ALLOWED_GITHUB_LOGIN`. Every connection requires
browser-bound consent, an approved client callback and PKCE. The Worker uses
one server-wide YNAB token, kept as a secret; MCP clients receive access only
to `YNAB_ALLOWED_PLAN_ID` and the configured tool mode. `ynab_list_plans`
returns only that plan. The token itself retains its underlying YNAB account
permissions, so protect it separately from the connector.

## Why not YNAB OAuth?

YNAB OAuth is deliberately not supported. Its token exchange requires a client
secret even with PKCE; an open-source package cannot ship a secret, so a local
package cannot honestly implement the authorization-code flow
([OAuth application requirements](https://api.ynab.com/#oauth-applications)).
The only secretless flow YNAB documents is the implicit grant, which expires in
two hours with no refresh
([OAuth application requirements](https://api.ynab.com/#oauth-applications)).
YNAB recommends a Personal Access Token for an individual accessing their own
account
([Personal Access Tokens](https://api.ynab.com/#personal-access-tokens)).

Setting `YNAB_READ_ONLY` to `"true"` drops every write tool from the tool list,
which is worth considering for a connector you will mostly use on a phone.

### Access boundary and migration

Both supported entry points now require `YNAB_ALLOWED_PLAN_ID`; startup or HTTP
authorization fails closed when it is absent/invalid or a default alias disagrees.
`ynab_list_plans` and its legacy alias return only that selected plan. Historical
audit reads for other plans are denied. OAuth grants created before this change,
or under a different plan/tool policy, require reconnecting.

`category-only` is the default: existing reviewed reads plus
`ynab_apply_category_suggestions`. General update/create/import/delete/approval,
budget updates, moves and auto-assign are absent and cannot be called by name.
`read-only` and `YNAB_READ_ONLY=true` also remove category application. `full`
explicitly restores general writes **without category audit coverage**, still
restricted to the selected plan. Do not choose `full` for the protected category
workflow. The table below catalogs tools, not a promise that every mode exposes
all of them. Optional TypeSafe processing still requires its separate opt-in.

These boundaries are enforced at server entry/registration, including injected
plan IDs. Exported tool functions called by custom code are not a security API.
A stolen YNAB PAT can still access whatever YNAB permits directly; rotate/revoke
it through YNAB. This server cannot attenuate the PAT itself.

## Tools

Plan-scoped tools accept only the configured `YNAB_ALLOWED_PLAN_ID`. An omitted
ID uses that plan; both `planId` and the legacy `budgetId` are checked if supplied.
Optional tool inputs may be `null`; the server treats `null`
the same as omitting that input. All monetary values — in both directions — are
plain currency amounts, never YNAB's milliunits; conversion happens in
`src/tools/money.ts`.

### Reading

| Tool | What it does |
| --- | --- |
| `ynab_list_plans` | Every plan on the account. Run this first to find a plan ID. |
| `ynab_plan_summary` | A month at a glance: income, budgeted, activity, Ready to Assign, plus categories split into `overspent`, `underfunded` (goal not yet met) and `positive_balance`. Hidden and deleted categories are excluded. |
| `ynab_list_accounts` | Accounts with balances. `includeClosedAccounts` to see closed ones. |
| `ynab_list_categories` | Categories grouped by category group, with goal info. |
| `ynab_list_payees` | Payees, for resolving payee IDs. |
| `ynab_list_months` | Every plan month with its summary numbers. |
| `ynab_list_scheduled_transactions` | Scheduled/recurring transactions. |
| `ynab_get_transactions` | Transactions filtered by `sinceDate`, `accountId`, `categoryId`, `payeeId`, `type` (`all`/`uncategorized`/`unapproved`) and `limit` (default 100). |
| `ynab_get_unapproved_transactions` | Unapproved transactions, optionally from `sinceDate` onward. |
| `ynab_get_category_audit` | Retrieve persisted preparation and outcome records by operation ID; no YNAB calls. |
| `ynab_suggest_categories` | Opt-in, read-only category previews for unapproved, uncategorized ordinary outflows. Deleted and categorized rows are dropped in default mode; approved, reconciled, balance-adjustment, transfer, split, and inflow rows are skipped as applicable. |

### Category application audit

For Node, create a private directory on a persistent local disk, then set an
absolute path before starting the server, for example:

```bash
install -d -m 700 /your/persistent/path/ynab-category-audit
export YNAB_CATEGORY_AUDIT_DIR=/your/persistent/path/ynab-category-audit
```

The directory must already exist and support file and directory `fsync`; the
server fails closed if durability cannot be acknowledged. Files use mode `0600`.
Do not point this at an ephemeral container disk. Windows/network filesystem
support depends on directory sync semantics; unsupported storage blocks writes.
For Workers, use [the R2 setup](./DEPLOY.md#category-application-audit) instead.

Each validated request gets a random `operation_id`. With storage configured,
`<operation_id>.prepared.json` is saved before mutation and a separate immutable
`<operation_id>.outcome.json` afterwards. Version 1 records contain the plan ID,
requested category changes, fingerprints, validation decisions, pre-write
category and approval state, and observed outcomes (including returned category, approval and deletion state). They do not contain raw
memos/payee descriptions, API credentials or raw API error bodies. They still
contain sensitive financial identifiers: keep storage private and backed up.
No automatic retention or deletion is configured.

Call `ynab_get_category_audit` with the operation ID to retrieve both records,
even in read-only mode, without a YNAB request. Operators can discover operations
whose response was lost by listing files or the R2 `category-audit/v1/` prefix;
there is no audit-list MCP tool. This audit covers only
`ynab_apply_category_suggestions`, not the other general write tools.

- `audit_status: recorded`: preparation and outcome were persisted, including
  dry runs, no-ops and rejected rows. Inspect each row for its actual result.
- `not_configured`: no durable audit exists; only a non-writing request can
  succeed this way. `unavailable` or `prepare_failed` means no YNAB write was
  attempted. A storage timeout may nevertheless leave a prepared record.
- `outcome_failed`: the before-state was saved, but the final record was not
  acknowledged. The response retains observed rows and the undo manifest and
  reports failure; YNAB may already have changed.
- `unknown` row: a thrown API call, omitted row, or mismatched response cannot
  prove whether the write took effect. Confirmed matching rows are `applied`;
  rows blocked by audit failure are `not_applied`.

**Recovery is manual.** A preparation without an outcome (including a crash)
does not prove that YNAB was changed or unchanged. Refetch each affected
transaction before deciding to retry or restore its old category. Preserve later
user changes and approval state; the undo manifest is evidence, not an automatic
rollback command. Do not blindly replay an uncertain batch. Already-categorized
retries remain no-ops. There is no transaction spanning YNAB and the audit store,
no cross-request lock, and no YNAB conditional-write support: another actor can
change a transaction between the fingerprint check and update. Invalid or partial
files from an interrupted disk write require operator inspection; read errors
are surfaced, never treated as missing records.

### Category suggestions (optional)

`ynab_apply_category_suggestions` is a separate write tool that is available
without enabling the TypeSafe preview. Provide up to 25 explicit
`transaction_id`, `category_id`, and `expected_content_fingerprint` rows. The
tool refetches each transaction and rejects stale or ineligible changes; a retry
whose category is already applied is a no-op. It supports validation-only dry
runs and returns a pre-write undo manifest, but does not perform the undo. It
never auto-applies suggestions, calls TypeSafe, or approves transactions.

Live category changes require durable audit storage: `YNAB_CATEGORY_AUDIT_DIR`
locally or the Worker `CATEGORY_AUDIT` R2 binding. Without storage the tool still
validates dry runs and no-ops, but refuses actual changes. See
[Category application audit](#category-application-audit) for setup and recovery.

`ynab_suggest_categories` is off by default. To expose it, set both an
operator-owned `TYPESAFE_API_KEY` and `YNAB_AI_CATEGORIZATION=true`, then restart
the server. The API key is read from the environment (or a Worker secret), never
from a tool argument. Omit `transactionIds`, pass `null`, or pass an empty
array to fetch unapproved transactions and retain only uncategorized rows;
provide IDs to inspect only those transactions. In default mode, the tool
checks every retained row for deterministic eligibility and then applies
`limit` to the first eligible outflows in YNAB's returned order. Skipped rows
do not consume the limit.

The tool is a dry-run preview: it never writes to YNAB, approves a transaction,
or changes the behavior of `ynab_update_transaction`. It first handles exact
facts in code—dropping deleted rows and handling approved or reconciled rows,
YNAB balance adjustments, transfers, splits, inflows, existing categories, and
hidden/internal categories. In default mode, `transactions` contains only the
eligible rows inspected, `transaction_count` is that row count, and
`eligible_transaction_count` reports all eligible rows available before the
limit. The top-level `skipped` object reports `total_count` and a `count` plus
`transaction_ids` for each reason: `skipped_approved`, `skipped_reconciled`,
`skipped_balance_adjustment`, `skipped_transfer`, `skipped_split`,
`skipped_inflow`, and `skipped_already_categorized`. With explicit
`transactionIds`, every non-deleted fetched row remains an individual result,
including rows carrying a `skipped_*` status; deleted rows are omitted.
Payee history uses the latest 12 months, capped at 50 qualifying rows. When the
payee has no qualifying rows with the same payee ID, history falls back to rows
from payees with a similar name: after Unicode NFC normalization, lowercasing,
and removing everything except letters and numbers, one name begins the other
and the shorter is at least six characters, so a truncated bank payee such as
"Better Bl" draws on "Better Blend" history. Each history summary reports
`match` (`payee`, `similar_payee_name`, or `null`) and
`matched_payee_names`. The deterministic history rule applies only when at
least three exact-payee rows all use the same still-eligible category. Similar-
name history always goes to the model as suggestive evidence and never bypasses
it. Every other eligible row goes to TypeSafe's pinned `jev-1.13.0` System One
model in batches of ten. A disagreement between exact-payee history plurality
and the model forces `needs_review`; similar-name disagreement is reported in
the history summary but does not force review because a prefix match does not
establish merchant identity. Every inspected eligible row includes a status,
content fingerprint, proposed category, confidence, winning probability, up to three
alternatives, and history summary. Applying a suggestion remains a separate,
explicit human decision using `ynab_apply_category_suggestions` (or the general
`ynab_update_transaction` tool).

TypeSafe reports probabilities rounded to two decimal places. The preview accepts
sum drift up to `0.000001 + option_count * 0.005`, including the leave option,
while still requiring all requested options, finite values in [0, 1], valid
confidence, and a maximum-probability choice. It never normalizes probabilities
or confidence, and keeps the existing confidence thresholds. Model rows include
`provider_distribution` with the raw sum, rounding precision, applied sum
tolerance, and `normalized: false`. See the investigation below for the source
contract and the limits of rounded distributions with many options.

Malformed TypeSafe answers fail closed per row. Their `provider_validation`
field identifies the rejected check using a fixed code, the expected option
count, and (where applicable) the received option count or probability sum.
It never includes provider payloads or option labels. See
[TypeSafe validation investigation](docs/typesafe-validation-investigation.md)
for the current investigation and diagnostic interpretation.

Enabling this feature sends the transaction's display payee, imported/original
payee, memo, amount, date, and account name/type/on-budget status, plus visible
category group and category names, to **TypeSafe as a third-party processor**.
For similar-name matches only, it also sends the matched payee names and
per-category key, group, name, and count. It does not send YNAB UUIDs, balances,
goals, approval/cleared state, or raw transaction history. TypeSafe's published
Jev 1.13 price at the time of this release is **$0.042 per million input tokens;
output tokens are free**. The tool returns preflight estimates, actual token
usage, and projected cost on each run
and refuses requests over its per-call token/cost ceilings. Pricing and
provider limits can change; check <https://docs.typesafe.ai/models>.

The prototype is intentionally narrow and not default-on. Its supporting
98.3% exact-label, 98.9% top-three, and 60/60 expected-abstention results came
from 40 synthetic, single-evaluator fixtures—not a production accuracy claim.

### Reporting

Splits are counted through their subtransactions and transfers between your own
accounts are excluded, so these report spending rather than money movement.

| Tool | What it does |
| --- | --- |
| `ynab_spending_by_category` | Total spend per category over a date range, biggest first, with share of total. Defaults to the last 30 days. |
| `ynab_spending_by_payee` | The same, grouped by merchant. |
| `ynab_cash_flow` | Income vs spending per month with the running net, from YNAB's own monthly totals. Defaults to the last 6 months. |

### Writing

| Tool | What it does |
| --- | --- |
| `ynab_create_transaction` | Creates a transaction. Needs `date`, `amount`, an account (`accountId` or `accountName`) and a payee (`payeeId` or `payeeName`); category optional as `categoryId` or `categoryName`, or `subtransactions` to split it. |
| `ynab_update_transaction` | Updates any subset of an existing transaction's fields, or splits an unsplit one with `subtransactions`. |
| `ynab_delete_transaction` | Deletes a transaction. Not undoable. |
| `ynab_approve_transaction` | Approves (or un-approves) one transaction. |
| `ynab_bulk_approve_transactions` | Approves an array of transaction IDs in one API call. |
| `ynab_apply_category_suggestions` | Applies up to 25 explicit category suggestions with refetch and stale-data checks, dry-run support, and a pre-write undo manifest. Never auto-applies or approves transactions. |
| `ynab_update_category_budget` | Sets the total budgeted amount for a category in a month. Not an increment. |
| `ynab_import_transactions` | Triggers an import from linked institutions, the same as hitting Import in the YNAB app. |
| `ynab_move_money` | Moves budgeted money between two categories in a month, for covering overspending. |
| `ynab_auto_assign` | Spreads Ready to Assign over categories with unmet monthly goals, largest shortfall first. `dryRun` to preview, `maxTotal` to cap it. |

#### Names instead of IDs

`ynab_create_transaction` accepts `accountName` and `categoryName` and matches
them loosely against the plan, so "ally checking" finds *Ally Checking*.
Closed accounts and hidden categories are never matched. If a name is ambiguous
or unrecognised the call fails and names the near misses rather than guessing,
and successful calls echo back `matchedAccount` / `matchedCategory` so a wrong
guess is visible.

#### Split transactions

`ynab_create_transaction` and `ynab_update_transaction` split a transaction
across categories when given `subtransactions`: two or more entries of
`{ amount, category_name, payee_name, memo }`, the same shape
`ynab_get_transactions` returns for a split. Amounts are in dollars and must add
up to the transaction amount exactly (on update, the new `amount` if given,
otherwise the current one); categories go on the splits, not on the parent.
Split category names are matched like `categoryName` and echoed back as
`matchedSplitCategories`.

YNAB cannot change the splits of a transaction that is already split, so
`ynab_update_transaction` refuses rather than silently dropping the change.
Delete and recreate the transaction to re-split it.

#### Writes that can half-succeed

YNAB has no endpoint for moving money between categories, so `ynab_move_money`
rewrites both categories' budgeted amounts in two calls. It takes from the
source first, so a failure in between leaves the money in Ready to Assign rather
than double-counted. When that happens the response sets `partial: true` and
carries a `recovery` line with the original amount to restore. `ynab_auto_assign`
behaves the same way: on failure it reports which categories were already funded
and which were left alone.

Tools never throw at the protocol level. Failures come back as an MCP error
result (`isError: true`) with `{ "success": false, "error": "..." }` in the
text content, so a failed write is never mistaken for a successful one.

#### Tool annotations

Every tool advertises MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) alongside its schema. Reading tools are
`readOnlyHint: true`; among the writing tools, only `ynab_delete_transaction`
sets `destructiveHint: true`. A client may use these hints to decide which
calls need a confirmation prompt.

#### `cleared` and `flagColor`

`ynab_create_transaction` and `ynab_update_transaction` accept `cleared` as
one of `cleared`, `uncleared`, or `reconciled`, and `flagColor` as one of
`red`, `orange`, `yellow`, `green`, `blue`, `purple`, or `""` to clear an
existing flag.

## Development

```bash
npm run watch          # rebuild on change
npm test               # vitest (watch mode)
npm run test:run       # vitest, single run
npm run test:coverage  # coverage report
npm run typecheck      # typecheck both the node and Worker targets
npm run debug          # build, then open the MCP inspector
npm run dev:worker     # run the Worker locally with wrangler
npm run deploy         # deploy the Worker to Cloudflare
```

`dist/` is a build artifact and is not tracked in git; `npm run build` regenerates it.

### Releasing

Bump the version in `package.json` and update `CHANGELOG.md`, then merge to `main` and create a GitHub release tagged in the existing `0.2.0` style (without a `v` prefix). The workflow stages that release with npm; it does not make the package public. The maintainer must run `npm stage list`, review it, and run `npm stage approve` with 2FA to promote it live. Configure a Trusted Publisher on npmjs.com for `ynab-mcp-server`, pointing at GitHub repository `calebl/ynab-mcp-server` and the exact workflow filename `.github/workflows/publish.yml` (the filename must match exactly); under Allowed actions select only `npm stage publish`.

### Adding a tool

Each tool is a self-contained module in `src/tools/` exporting `name`,
`description`, `inputSchema` (a Zod shape) and `execute(input, api)`. See
`CLAUDE.md` for the full template, then add the module to the `tools` array in
`src/registry.ts` and write a test in `src/tests/`. Registering it there serves
it from both the stdio server and the Worker; mark `writes: true` if the tool
changes data, which is what `YNAB_READ_ONLY` filters on.

Useful references:
- YNAB SDK types: `node_modules/ynab/dist/index.d.ts`
- YNAB OpenAPI spec: <https://api.ynab.com/papi/open_api_spec.yaml>

## Contributing

Pull requests targeting `main` must be raised through
[`no-mistakes`](https://github.com/kunchenguid/no-mistakes).
Install it, run `no-mistakes init`, commit your changes, and push with
`git push no-mistakes` so the review/test pipeline can open a compliant PR.
See the [no-mistakes quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/)
for setup.

## Compatibility

`ynab_list_budgets` and `ynab_budget_summary` remain accepted aliases for the
plan-named tools. `budgetId` and `YNAB_BUDGET_ID` are deprecated but still
accepted; there is no removal date. Use `planId` and `YNAB_PLAN_ID` for new
integrations.

## License

See [LICENSE](./LICENSE).
