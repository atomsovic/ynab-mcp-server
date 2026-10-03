# Category application audit design and implementation plan

The task authorizes a local implementation and mock verification; no deployment,
remote resource creation, credentials, live API calls, or publication.

## Design

Keep the shared tool registry and existing eligibility/fingerprint checks. Pass
read-only mode explicitly from both entry points. Inject a category audit store
through registry execution context. Persist separate versioned `prepared` and
`outcome` records under a random operation UUID. Record plan ID, requested changes,
pre-write category/approval state and fingerprint, validation decisions, and
observed results; omit raw transaction descriptions and API error bodies.

Use synced exclusive files in an operator-selected persistent directory for Node
and a dedicated R2 bucket for Workers. R2 fits immutable objects and survives
Worker restarts; Worker filesystem and in-memory logging do not. KV would add
unnecessary eventual-consistency ambiguity. No new production dependency needed.
A read-only MCP tool retrieves one operation by ID, without contacting YNAB.

Before a live mutation, storage must acknowledge the prepared record. Abort on
missing storage or failed preparation. Await outcome persistence. Mark missing or
mismatched API rows and thrown/transport failures as unknown, never as definite
non-writes. A failed outcome save returns the operation ID, observed rows and undo
manifest, with an explicit error; the durable preparation remains for recovery.
Dry runs and no-ops need no configured store, but are recorded when one is present.

This is an audit trail, not a cross-service transaction, concurrency lock, or
rollback system. Pending-only records require manual reconciliation. Fingerprints
cannot close the interval between refetch and YNAB update. Undo manifests describe
before-state, not permission to overwrite later user edits. Retention, storage
backups, bucket provisioning and credential management remain operator decisions.

## Implementation checklist

- [x] Add a failing stdio registration regression; fix explicit read-only propagation.
- [x] Add failing audit tests for pre-write ordering, failures, partial/unknown
      outcomes, no-ops/dry runs, exclusions, and restart persistence.
- [x] Implement shared audit types, Node files, Worker R2 binding, retrieval, and
      guarded category application; retain undo and validation behavior.
- [x] Update README, DEPLOY, example binding and CHANGELOG.
- [x] Run full Vitest suite, Node/Worker typechecks, Node build and local Worker
      bundle. Check for lint command; review final diff and recovery semantics.

## Execution record

Worked in the supplied task checkout on branch `work`, as requested, with no
additional worktree, commits, publication or deployment. The task explicitly
allows choosing the scoped storage design; no external resources were created.
Dependencies were installed from the lockfile with lifecycle scripts disabled.
The first install failed because the default npm cache was unwritable; using
`--cache /tmp/ynab-npm-cache` succeeded without escalation.

The stdio regression failed with write tools exposed under `YNAB_READ_ONLY=true`
and passed after explicit option propagation. Audit regression tests failed
before implementation (missing durable records, unsafe unaudited writes and
uncertain result reporting). A fresh independent review found no blocking defect
and recommended fsync-failure tests and retaining minimal mismatched-response
state. Both were addressed. The fsync tests fail when sync calls are removed and
pass with the calls restored. Mismatched-response evidence had a failing test
before its implementation. The full existing TypeSafe suite uses mocked calls.

Additional verification finding: inherited TypeScript exclusions skipped Worker
sources. Overriding Worker exclusions now includes all eight Worker source files
in the compiler's file list, while keeping test files out of production checking.
No lint script or lint configuration exists in this repository.
