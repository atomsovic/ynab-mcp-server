# Local Workers OAuth provider extension

This repository pins `@cloudflare/workers-oauth-provider` to **0.10.3** and applies
two opt-in extensions. Upstream behavior remains the default for other consumers.

- `revokeGrantOnCodeReuse: false` rejects an already-used code without deleting
  its active grant. This server retains its atomic Durable Object code-consumption
  gate; a replay never mints another token. The change prevents a holder of an
  already-used code from disconnecting the successful connection.
- `grantRevocationCallback({userId, clientId, grantId})` runs only after refresh
  token hash and client ownership validation, before deleting the grant. It
  persists the application's revocation fence before eventual KV cleanup. An
  unknown/wrong-client token does not trigger it. Access-token-only revocation is
  unchanged. Hook failure stops cleanup and is returned as a temporary failure.

The JSON manifest is authoritative: exact contextual replacements and original /
patched SHA-256 hashes for the JS and declaration files. The `.patch` files are
human-readable representations of the same changes. The upstream package retains
its MIT license and attribution; this directory contains the local modifications.

`npm ci` runs the pure-Node `postinstall` applicator. Re-running it is safe. Both
source hashes and the exact provider version must match; unknown versions or
modified source fail closed. No network, shell `patch` utility or credentials are
used. `npm run check:oauth-provider` only checks; it does not repair a missing
patch. Tests/build/type checks and both checked-in Wrangler build configurations
run this check. After `npm ci --ignore-scripts`, explicitly run
`node scripts/patch-oauth-provider.mjs` before those operations.

For a provider upgrade, review the upstream code-exchange, replay and revocation
paths first. Rebase both extensions, regenerate manifest hashes and readable diffs,
then pass installation, replacement/replay/revocation race and actual workerd
regressions. Do not merely change the version or relax the checksum check.

A separately bundled Worker using a different Wrangler configuration must retain
`build.command: "npm run check:oauth-provider"`. Do not bypass that build step.
The post-persistence active-grant check is implemented by the application, not
this dependency patch.
