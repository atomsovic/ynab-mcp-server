# Deferred OAuth replacement — architecture proposal

Status: implementation/testing complete; merge and deployment approved on
2026-10-03. Deployment confirmation is reported separately. Based on main
`af5e6b7ede8ab88f4cca6547eceaa82c04b477ef` and installed OAuth provider 0.10.3.

## Required behavior

Keep the existing same-user/client connection usable when a replacement is
abandoned, denied, has invalid PKCE, expires, or fails before durable token
issuance and activation. Successful replacement activates exactly one new grant;
old grants cannot call MCP or refresh. Preserve selected-plan/read-only policy,
CSRF, browser binding, one-use codes, 1-hour access tokens and absolute 7-day
refresh grants. This does not diagnose or fix ChatGPT's metadata refresh error.

## Why a one-line change is unsafe

The provider revokes prior grants in `completeAuthorization`, before the client
redeems the replacement code. Its only token-exchange callback runs after
client/PKCE validation but BEFORE `saveGrantWithTTL` and `createAccessToken`.
Revoking in that callback still loses the working connection on storage failure.
There is no supported after-persistence callback. Performing KV deletions after a
200 response alone cannot atomically enforce one active grant across concurrent
redemptions, refreshes and partial deletion failures.

## Recommended architecture

Use a separate Durable Object authority per canonical user/client pair, alongside
the existing OAuth provider. This adds an explicit security-critical storage dependency. Implementation review
also required a pinned provider extension (see the amendment below). Do not repurpose the existing flow object's
`deleteAll` alarm: active records/tombstones must not disappear after ten minutes.

1. Record a pending replacement with a short expiry and the current active
   generation. Keep existing consent, identity and PKCE checks. Create the
   provider grant without immediately revoking existing grants. New grant props
   explicitly require activation; pending grants must never authenticate.
2. During code exchange, capture the provider-validated identity, grant and
   candidate in a request-local closure. Retain the atomic code-replay gate.
   Do not derive identity by trusting token request fields or parsing opaque codes.
3. Only after provider token issuance returns 200, commit an atomic activation
   comparing the candidate's expected generation with the current generation.
   Of competing replacements based on one generation, one wins; the loser must
   not receive usable tokens. An expired or consumed candidate cannot activate.
4. Every authenticated MCP request and token refresh checks this authority in
   addition to existing provider validation. Recheck refresh validity before
   returning credentials so a concurrent replacement cannot return apparently
   usable obsolete credentials. A check already passed by an in-flight API
   request cannot retroactively cancel that request.
5. Old KV grants may be cleaned up with supported helper APIs. Cleanup is not the
   authorization boundary: stale credentials remain denied even if deletion
   fails or an old refresh races with activation.
6. Fail closed with a temporary error when authority storage is unavailable.
   Never reset or roll back an activation merely because its response was lost.
   Preserve non-expiring generation/tombstone evidence so old grants cannot revive.

This is not permission for parallel active connections. Multiple pending grants
can exist briefly; only the authority-selected grant can serve requests.

## Approved migration

Legacy grant props have no activation requirement or registered active generation.
A deliberate migration is mandatory. The simplest safe rollout is versioned
props plus one planned reconnection for legacy grants; it preserves all policy
restrictions but interrupts existing connections once. Seamless migration would
need a separately reviewed, bounded bootstrap of a provider-validated existing
grant. Never accept arbitrary legacy grants whenever an authority record is
missing, and never silently fall back after an authority failure.

The approved and implemented choice is explicit one-time reconnection. Version-1
grants fail closed; the new authority does not bootstrap or adopt legacy grants.
A new binding/migration and its runtime costs also require deployment review.

## Failure and concurrency contract

- Abandonment, bad verifier, replay, failed provider persistence and rejected CAS:
  do not replace the previous active grant.
- Provider-created but unactivated credentials: remain unusable even if KV cleanup
  fails. The client must start a fresh consent if its one-use code was consumed.
- Successful durable activation: new grant is active, prior grant is denied.
- Lost response after activation: the client may not receive credentials although
  replacement committed. No server can guarantee HTTP response receipt. Do not
  promise that every failed client-visible request preserves the old connection.
- Concurrent replacements: expected-generation comparison selects one winner.
- Concurrent old-grant refresh: cannot reactivate the old generation or authorize
  obsolete tokens; ordinary current-grant rotation retains the original deadline.
- Crash/restart: pending state, active generation and tombstones survive. No
  in-memory lock, Worker-local file or eventual KV listing is the authority.

## Required regression coverage before implementation approval for production

Use actual workerd, local KV/SQLite, synthetic OAuth identities and intercepted
outbound traffic. No live GitHub, YNAB, TypeSafe, credentials or budget data.

1. Existing connection survives abandoned/denied/expired replacement and invalid
   PKCE, including interruption after callback but before redemption.
2. Inject failure before/after provider grant/token writes: old connection remains
   active; candidate is unusable. Verify cleanup failures cannot grant access.
3. Successful activation denies old MCP and refresh credentials, while new
   discovery and refresh succeed with unchanged TTLs and plan/read-only guards.
4. Code/callback replay cannot switch the active generation or revoke its winner.
5. Deterministically race two redemptions and an old refresh; exactly one candidate
   activates and no obsolete tokens become usable. Cover ambiguous DO responses.
6. Restart authority and provider storage between stages; prove no resurrection.
7. Exercise the selected legacy migration and authority-unavailable behavior.
8. Retain Chromium consent/CSRF tests and run full tests, typechecks and builds.

## Evidence already collected

`node /tmp/ynab-connection-reliability.mjs` passes current-behavior checks:
metadata reads preserve grants, consent alone does not revoke, expired synthetic
access tokens carry a 401 challenge and renew successfully, three sequential
rotations work, same-client callback revokes early, distinct clients coexist.

`node /tmp/ynab-replacement-target-red.mjs` deliberately fails the desired
preservation assertion with **401 instead of 200** after the callback. It is a
throwaway reproduction, not a passing test of an implemented fix.

Independent security review confirmed the hook ordering and required atomic
activation/authorization checks. Implementation and verification are recorded in
`oauth-replacement-verification.md`. Those verification results were recorded before commit, push or deployment.

## Authenticated discovery diagnostics

The implemented `GET /mcp/diagnostics` is gated by the same provider, policy and
active-grant checks. It reports only authorization version, effective read-only /
tool mode, AI opt-in exact-match boolean, key-configured boolean,
suggestion-registered boolean and registered tool count. Build identifiers and
descriptor hashes are omitted from this scoped diagnostic. No keys, tokens, cookies,
plan names/IDs, login, client IDs or upstream error bodies. Return no-store.

It must be accessible independently of imported MCP tool metadata (an authenticated
HTTP diagnostic route, not merely a new tool that itself requires a successful
refresh). Public callers receive the normal authentication challenge. This still
requires an authorized client's authenticated request; it cannot by itself reveal
ChatGPT's internal refresh error. Prefer capturing that operation's sanitized
status/error first. Do not enable broad request tracing or log authorization URLs.

## Implementation amendment: explicit provider extension

The provider's used-code path can delete the active grant before the application
callback. It also has no validated refresh-token revocation callback; HTTP 200
on revocation includes unknown/wrong-client tokens and cannot establish ownership.
The local implementation therefore includes a checksum-guarded, version-pinned
0.10.3 extension: opt out of automatic revocation on code reuse while retaining
replay rejection, and invoke a validated grant-revocation hook before deletion.
See `patches/README.md`. This introduces an explicit dependency-maintenance cost.

Old replaced provider records are denied by authority checks and expire through
their existing KV TTLs; replacement does not rely on deleting them synchronously.
Only validated refresh-token revocation performs provider grant/token deletion.
The active generation/tombstone remains durable even if a racing refresh recreates
those provider records.
