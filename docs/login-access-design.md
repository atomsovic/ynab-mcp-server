# Login and access hardening

Scope: code, synthetic tests and independent review in the task checkout on
`fix/read-only-durable-category-audit`. Account changes, deployment, credential
creation, live budget calls, merge and PR publication are separate actions.

## Decisions

- Require `YNAB_ALLOWED_PLAN_ID` as the single real UUID in both entry points.
  Defaults and legacy aliases must agree if present. Reject both conflicting
  input aliases before an API call; inject the selected plan into every plan tool.
  Restrict list-plans and historical audit reads too.
- Default `YNAB_TOOL_MODE=category-only`: an explicit read-tool allowlist plus
  `ynab_apply_category_suggestions`. `read-only` drops that write. Retain an
  explicit `full` mode for operators, still restricted to the selected plan;
  document that full-mode general mutations bypass category auditing.
  `YNAB_READ_ONLY=true` overrides every mode; malformed flags/modes fail closed.
- Require a canonical HTTPS `PUBLIC_ORIGIN` and exact HTTPS MCP callback URLs in
  `OAUTH_ALLOWED_REDIRECT_URIS` (JSON array). Dynamic registration may only use
  those URLs; no wildcard, localhost or metadata-URL client registration.
  Optional `OAUTH_ALLOWED_CLIENT_IDS` further pins registered IDs.
- Always show escaped client ID/name/redirect, selected plan and effective access
  on a no-cache, non-frameable consent page before GitHub. Require same-origin
  form POST, CSRF token and a separate HttpOnly Secure __Host- browser cookie.
  No remembered client consent cookie. Require code flow + S256 PKCE.
- Store a random opaque flow ID with hashed browser/CSRF secrets and the validated
  request in a SQLite-backed Durable Object. Atomically advance consent once and
  consume callback once, with a ten-minute absolute lifetime and alarm cleanup.
  Never treat Worker KV read/delete as an atomic replay defense. OAuth grants
  remain in the provider's OAUTH_KV. No new signing secret is necessary.
- Revalidate client/redirect policy on callback and pin budget/effective mode into
  grant props. Check identity, policy version and those props on every MCP request
  so legacy or changed-policy grants require reconnecting. Keep provider token
  validation and resource audience enforcement; do not trust request headers for
  origin, identity or grant props. Consume state before upstream token exchange.
- Disable outbound redirects during GitHub token/profile fetches, sanitize errors,
  clear browser cookie on callback, and deny malformed/missing configuration.
- Scheduled reminders must use the selected plan too. A stolen YNAB PAT remains
  usable directly against YNAB; these are server boundaries, not PAT attenuation.

## Verification plan

Add failing regressions for budget aliases/omissions, hidden direct tool calls,
plan enumeration/audit isolation, bad configuration and stale grant props.
Exercise consent, origin/cookie/CSRF mismatches, tampering, denied consent, replay
(including concurrent consumption), expiry, callback validation, XSS and upstream
failures with synthetic provider/storage/fetches. Include actual provider endpoint
integration and local Worker bundling; no live accounts. Review independently,
run full suite/typechecks/build/restart smoke and preserve a reviewable diff.

## Review follow-up

Independent review found HTTPS loopback callbacks were not yet rejected; explicit
hostname/IP-literal rejection and failing regressions address it. A further
end-to-end test reproduced two successful concurrent code redemptions in the
installed provider's KV path. Added a separate random authorization ID to encrypted
grant props, with a ten-minute Durable Object code gate. The provider callback
consumes it after client authentication and PKCE verification, before issuance.
Expired/duplicate code gates and changed-policy refreshes fail closed. Transport
failure after consumption requires reconnecting; refresh-token rotation and
revocation semantics otherwise remain provider-owned.

## Setup decisions left to the operator

Choose one YNAB plan UUID and the exact callback URI shown by the intended MCP
connector. Never guess or wildcard the callback. R2/KV
must be in the user's account; the Durable Object binding/migration is created
when the Worker is eventually deployed. Setup instructions will distinguish what
can be prepared on desktop now from phone-accessible configuration later.

Operator supplied hostname `ynab-mcp-server.atomsovic2.workers.dev`, namespace
`44062199539d467695b9db319996689d` and bucket `ynab-category-audit` during execution.
These nonsecret identifiers are in `wrangler.atomsovic.jsonc`; selected-plan UUID
and MCP-client callback remain required runtime setup inputs. No live state was
inspected or changed.
