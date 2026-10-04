# TypeSafe rounded-probability compatibility

## Conclusion and correction

Our parser's 1e-6 sum check was incompatible with TypeSafe's rounded probability
representation. A sum of 0.99 is not sufficient evidence of malformed provider
output. The initial investigation relied too heavily on documentation shorthand
saying probabilities sum to one; its conclusion that no correction was
justified is superseded by the primary schema and rounding contract below.

The corrected check matches Vercel AI SDK's TypeSafe provider contract:

```
absolute(sum - 1) <= 0.000001 + option_count * 0.005
```

TypeSafe probabilities are rounded to two decimal places. Each term can differ
from its underlying value by half a final decimal unit. Count every requested
option, including `leave_uncategorized`. With 3 options, the tolerance is
0.015001; with 53, it is 0.265001. This is a worst-case representation bound,
not a claim that any arbitrary response within that bound was rounded correctly.
There is no normalization, probability inflation, or recomputed confidence.

The strict 1e-6 highest-choice comparison is separate and unchanged. Required
Choice type, confidence, exact option keys, finite numeric values and [0,1]
bounds remain enforced. Missing/malformed responses, unknown options, sums
outside the rounding bound, and nonmaximum choices fail closed. Native TypeSafe
confidence/probabilities remain required despite cross-provider AI SDK schemas
allowing their absence for other models.

Existing confidence thresholds (0.80 suggested, 0.50 needs_review) use raw
provider confidence. Existing history conflicts still force review. Model rows
now report `provider_distribution` containing the raw sum, `probability_decimals:
2`, the applied `sum_tolerance`, and `normalized: false`. Winning probability and
displayed alternatives retain their raw provider values. No sensitive payload,
provider string, category label, header, or key is added to diagnostics.

## Primary evidence

- [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json) and the
  [generated Python Choice schema](https://github.com/typesafe-ai/typesafe-sdk-python/blob/f078f1e208a0d885154dc758344ae4fce77ac168/src/typesafe_sdk/_schemas/models.py)
  describe totals as approximate.
- [Vercel's TypeSafe adapter](https://github.com/vercel/ai/blob/main/packages/typesafe-ai/src/typesafe-ai-evaluation-model.ts)
  explicitly declares two-decimal probability rounding.
- [AI SDK validation](https://github.com/vercel/ai/blob/main/packages/ai/src/evaluate/validate-evaluation.ts)
  adds half a decimal unit per option to its 1e-6 tolerance, preserves native
  values, and keeps maximum-choice checking separate.
- [AI SDK evaluation documentation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation#question-types)
  explicitly explains that 0.99 can represent a valid rounded distribution.
- TypeSafe's own
  [JavaScript live integration test](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/test/integration/api.integration.ts)
  uses a broad approximate-sum check; its
  [Python live integration test](https://github.com/typesafe-ai/typesafe-sdk-python/blob/f078f1e208a0d885154dc758344ae4fce77ac168/tests/test_integration.py)
  likewise permits approximate totals. These corroborate approximation but are
  not used as arbitrary fixed thresholds in this implementation.

No live provider calls were made by this execution agent to gather this evidence.
Public source retrieval does not require or use provider credentials.

## End-to-end trace and observed evidence

The request contains `state`, pinned `model: jev-1.13.0`, and keyed Choice
questions with complete criteria. No output-token limit, probability precision,
or numeric coercion parameter is set. The provider receives typed questions;
there is no language-model-generated JSON parsing layer in this integration.

`response.json()` decodes the provider envelope. Per-row validation reads the
answer at the original question ID, checks the unmodified probability map,
and sums every value. Category lookup and top-three display filtering happen
only afterward. No option or value is removed before the sum check; no string
conversion or rounding is performed locally. The SDKs also preserve probability
values. The live failure therefore came from our representation assumption,
not evidence of local filtering loss or a broken provider distribution.

At deployed diagnostic SHA `51e0739d856dca42a4f6cb7d6d2a26233f154b33`, the
parent's authorized three-row preview returned two parsed rows and one rejected
sum: expected 53 options, received 53, sum 0.9900000000000002. This established
which check rejected that row. The original vector was not retained here; it
cannot establish every other check for that particular response. In particular,
the winner check ran after the sum check and could still reject a different
answer after this correction. The earlier all-three-failed preview did not
include diagnostics, so its individual failure causes remain unknown.

## Safeguards and limits

This is a correction for valid rounded provider output, not a degraded-result
bypass. No invalid-distribution candidate, review override, or change to the
apply input contract is introduced. OAuth, read-only enforcement, freshness,
eligibility, idempotency, audit preparation/outcome handling and undo safeguards
are unchanged. Category application remains a separate explicit operation.

The separate known near-tie issue where a chosen option is 0.01 below another
option is still rejected. No automatic winner substitution is performed.

Rounding can discard substantial aggregate information at large option counts.
At 255 options the worst-case bound is 1.275001; a truly diffuse distribution
can round every value to zero. A synthetic zero-confidence case remains
`uncertain`, with zero raw values and no invented mass. This faithfully reflects
the precision contract; it does not validate semantic correctness or calibration
of a model answer. Do not interpret rounded values as exact probabilities.

## Verification

Regression tests cover the observed 0.99 total with 53 complete options,
positive and negative rounding drift, boundaries just inside/outside the
three-option bound, 53-option bounds, and 255-option diffuse rounding. They
also verify unchanged raw confidence thresholds and probabilities, complete
keys/finite bounds, and rejection of wrong winners including the separate
0.01 near-tie case. All fixtures and YNAB/TypeSafe responses are synthetic.

Initial red run: 12 regression failures, 53 passes against the strict parser.
Subsequent tests refine the fixed-bound hypothesis to the source-backed
count-based precision contract. Final command results are recorded below.

- `npm run test:run -- src/tests/SuggestCategoriesTool.test.ts`: 71 passed.
- `YNAB_BROWSER_TESTS=true npm run test:run`: 537 passed in 40 files. First run
  passed all assertions but failed Chromium profile teardown with `ENOTEMPTY`;
  the complete rerun exited successfully without code changes.
- `npm run typecheck`: Node and Worker passed.
- `npm run build`: passed.
- `node scripts/verify-category-audit-restart.mjs`: persisted audit verified
  across two independent Node processes.
- `git diff --check`: passed. No lint script is configured.
- Isolated Worker bundle with synthetic bindings: 1815.66 KiB, gzip 295.56 KiB;
  exact dry-run command below, with no production configuration or credentials.
- Independent review: no actionable defects; independently verified 71 targeted
  tests, typechecks, and diff whitespace checks.

```sh
env -i PATH="$PATH" XDG_CONFIG_HOME=/tmp/ynab-discovery-bundle/config WRANGLER_SEND_METRICS=false node /workspace/ynab-mcp-server/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config /tmp/ynab-discovery-bundle/wrangler.json --outdir /tmp/ynab-discovery-bundle/dist
```

The user approved deployment of a tested parser correction. A final authorized
small native preview remains necessary to verify current live behavior; local
synthetic tests cannot establish how a future provider answer will be classified.
