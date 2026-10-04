# TypeSafe Choice validation investigation

2026-10-03; base `ea1c99c1bbd7722a170a6bb96dee3348b5015944`.

## Evidence and remaining uncertainty

The reported three-row dry run used `jev-1.13.0`, 52 eligible categories,
one provider call, and returned usage, but every row failed with the same
missing-or-malformed Choice error. No raw provider response is available.
The outer response passed validation; the individual answer validator rejected
all three rows. This establishes the failure boundary, not the failed predicate.

The official [HTTP API reference](https://docs.typesafe.ai/api),
[Choice documentation](https://docs.typesafe.ai/primitives/choice), and
[JavaScript response interface](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceResponse)
all specify `type: "choice"`, `choice`, `confidence`, and `probabilities`, with
answers keyed by the requested question IDs. Probabilities cover every option,
sum to one, and the choice is a maximum-probability option. The current parser
matches that documented shape. The preliminary suspicion that `type` was an
undocumented requirement was ruled out.

A synthetic three-row response with 52 categories plus `leave_uncategorized`
passes the existing contract. Rounding of a large distribution is a possible
cause, but there is no evidence yet that it caused the production failure.
The existing 1e-6 sum/winner tolerance is unchanged. No fallback category,
normalization, guessed missing option, relaxed type requirement, or retry was
added. This patch does not claim to fix the live failure.

## Diagnostic change

Failed Choice rows retain their existing error text and gain
`provider_validation`. Only fixed codes and aggregate numbers are returned;
provider strings, option labels, payload excerpts, headers, and credentials
are never copied into this field. No additional console logging or persistence
is introduced. Valid suggestions retain their existing response shape.

| Code | Rejected check |
| --- | --- |
| `missing_answer` | No answer at the requested question key |
| `invalid_answer` | Answer is null, primitive, or array |
| `invalid_answer_type` | Required `type: "choice"` is missing or different |
| `invalid_choice` | Selected option is not a permitted string key |
| `invalid_confidence` | Confidence is not a finite number in [0, 1] |
| `invalid_probabilities` | Probabilities is not an object map |
| `probability_keys_mismatch` | Options do not exactly match requested keys |
| `invalid_probability_value` | A probability is not a finite number in [0, 1] |
| `invalid_probability_sum` | Sum differs from one by more than 1e-6 |
| `choice_not_maximum` | Choice is below the maximum by more than 1e-6 |

Every diagnostic includes `expected_option_count`, including the leave option.
Checks after reading the probability map include `received_option_count`.
An invalid sum additionally includes `probability_sum`, sufficient to distinguish
small numeric drift from a materially incomplete distribution. Arrays are now
explicitly rejected as invalid maps; documented valid responses are unchanged.

A next authorized live dry run with this patch would reveal the reason without
sharing raw financial data. The user approved diagnostic deployment and a small live preview on
2026-10-04; the parent session will perform that preview through the authorized
connector. Alternatively, an existing response can be examined where it is
already held and only its rejected check and aggregate counts shared. Do not
request, log, or commit financial payloads or credentials for debugging.

## Verification

Synthetic/mocked data only; no live YNAB or TypeSafe calls.

- Regression red: targeted suite initially had 13 failures for absent diagnostics
  and 30 passes, including the large documented response fixture.
- `npm run test:run -- src/tests/SuggestCategoriesTool.test.ts`: 44 tests pass
  after implementation and an additional missing-type case (independent review).
- `YNAB_BROWSER_TESTS=true npm run test:run`: 510 tests pass in 40 files.
- `npm run typecheck`: passes for Node and Worker.
- `npm run build`: passes.
- `node scripts/verify-category-audit-restart.mjs`: passes across two independent
  Node processes.
- Worker bundle: passes with synthetic bindings, an empty environment except
  PATH/config/metrics settings, and `wrangler deploy --dry-run`; 1815.07 KiB,
  gzip 295.40 KiB. This is not a deployment.
- `git diff --check`: passes. No lint script is configured.
- Independent review: no actionable regression or safety findings; confirmed
  this is diagnostics, not a proven live fix.

Exact isolated bundle command, run from `/tmp` using the existing synthetic
config (no production configuration or credentials):

```sh
env -i PATH="$PATH" XDG_CONFIG_HOME=/tmp/ynab-discovery-bundle/config WRANGLER_SEND_METRICS=false node /workspace/ynab-mcp-server/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config /tmp/ynab-discovery-bundle/wrangler.json --outdir /tmp/ynab-discovery-bundle/dist
```

No authentication changes are part of this patch. On 2026-10-04 the user
approved merging and deploying these diagnostics, followed by a small preview
and a tested parser correction if the diagnostic evidence establishes one.
