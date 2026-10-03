# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Require an explicit selected plan UUID in both entry points; reject conflicting aliases, restrict plan enumeration and audit lookup, and default to reviewed reads plus audited category apply. General writes require explicit `full` mode.
- Replace unsigned browser-carried OAuth requests with opaque, browser-bound, expiring Durable Object state and explicit CSRF-protected client consent. Restrict registration/authorization to configured exact HTTPS callback URLs, require S256 PKCE and enforce the canonical resource origin.
- Add atomic authorization-code redemption after provider client/PKCE validation, and reject legacy or changed-policy grants. Preserve provider token validation; direct use of a stolen YNAB PAT is outside this boundary.
- Add account-specific nonsecret deployment configuration and desktop/phone setup instructions without deploying resources.

### Fixed
- OAuth discovery and unauthenticated MCP challenges now work before private configuration is complete; registration, sign-in, token issuance and authenticated MCP requests still fail closed. Canonical-origin checks apply to discovery too.
- Worker deployment configs explicitly disable preview URLs instead of relying on dashboard defaults.
- Worker typechecking no longer inherits the Node configuration’s exclusion of `src/worker`.
- The local stdio entry point now honors `YNAB_READ_ONLY=true`, matching the Worker.
- Category application reports missing/mismatched bulk responses and API errors as unknown outcomes rather than claiming definite failure or success.

### Added
- Durable category application audit records with pre-write category/approval state, fingerprints, validation decisions, and separate observed outcomes.
- Synced private files for Node (`YNAB_CATEGORY_AUDIT_DIR`) and private R2 storage for Workers (`CATEGORY_AUDIT`), plus the read-only `ynab_get_category_audit` tool.
- Regression coverage for entry-point configuration, audit failures, partial writes, excluded/stale transactions, no-ops, dry runs and persistence across store/server instances.

### Changed
- **Migration required for live category application:** configure durable audit storage before using `ynab_apply_category_suggestions` to change categories. Missing/failed preparation blocks mutation; a failed outcome save explicitly reports possible writes and retains the undo manifest. Dry runs and no-ops remain usable without storage.

## [0.4.0] - 2026-10-02

### Added
- Added `ynab_apply_category_suggestions` for explicit, guarded bulk application with dry-run and undo manifests.
- `ynab_create_transaction` and `ynab_update_transaction` accept `subtransactions` to split a transaction, in the same shape transaction listings return. Update refuses to re-split an already-split transaction, which YNAB does not support.

## [0.3.0] - 2026-09-20

### Added
- Added the opt-in read-only `ynab_suggest_categories` preview tool with TypeSafe Jev eligibility rules and skip summaries.
- Added MCP tool annotations.
- Added plan-named tools `ynab_list_plans` and `ynab_plan_summary` with `planId` and `YNAB_PLAN_ID`.

### Changed
- Upgraded the `ynab` SDK from 2.10 to 4.5, including its budget-to-plan internal rename.
- Reported tool failures as MCP error results and restored field descriptions in advertised schemas.
- Used YNAB enums for create-transaction cleared/flagColor values, including reconciled and flag clearing.
- Tightened input validation, allowed null optional inputs, and pinned the MCP inspector dev dependency.

### Deprecated
- `ynab_list_budgets`, `ynab_budget_summary`, `budgetId`, and `YNAB_BUDGET_ID` remain accepted aliases. `YNAB_BUDGET_ID` is deprecated and still accepted, with no removal date stated.

### Fixed
- Fixed transaction-listing filter argument order after the SDK upgrade.
- Accepted empty or null `transactionIds`.

## [0.2.1] - 2026-09-17

### Changed
- Verified compatibility across Node.js 22, 24, and 26 in the CI matrix. Node.js 22 reaches end of life on April 30, 2027, and Node.js 24 reaches end of life on April 30, 2028, according to the Node.js release schedule.
- Bumped `@types/node` to the Node.js 22 line.
- Credited the 0.2.0 release contributors by GitHub username and profile URL.

## [0.2.0] - 2026-09-17

### Added
- Added money movement, auto-assignment, spending-by-category and spending-by-payee reporting, and cash-flow reporting tools.
- Added account and category name matching for transaction creation, including near-miss feedback and matched-name echoes.
- Added a Cloudflare Worker remote entry point with GitHub OAuth and a read-only deployment mode.
- Added tools for listing categories, accounts, scheduled transactions, months, payees and transactions, importing transactions, bulk approval, and transaction updates/deletion.
- Added split-transaction category exposure and improved budget summaries.

### Changed
- **Breaking:** all tool names now carry the `ynab_` prefix; clients must update tool references.
- **Breaking:** upgraded to Zod 4 and MCP SDK 1.30; integrations should verify schemas and SDK compatibility.
- **Breaking:** transaction creation now supports (and may resolve) account/category names, while monetary inputs and outputs consistently use plain currency amounts rather than milliunits.
- **Breaking:** the remote Worker requires Cloudflare and GitHub OAuth configuration; local stdio remains available.
- Improved error handling so failures are returned consistently through the protocol.

### Fixed
- Excluded transfers from spending reports and categorization reminders.
- npm publishing now uses npm Trusted Publishing (OIDC) and staged publishing: the maintainer reviews with `npm stage list` and promotes with `npm stage approve` (2FA). The package does not become public until approval.
- Categorization reminders now focus on the current month and run at a randomized hour.

## [0.1.2] - 2024-03-26

### Added
- New `ApproveTransaction` tool for approving existing transactions in YNAB
  - Can approve/unapprove transactions by ID
  - Works in conjunction with GetUnapprovedTransactions tool
  - Preserves existing transaction data when updating approval status
- Added Cursor rules for YNAB API development
  - New `.cursor/rules/ynabapi.mdc` file
  - Provides guidance for working with YNAB types and API endpoints
  - Helps maintain consistency in tool development

### Changed
- Updated project structure documentation to include `.cursor/rules` directory
- Enhanced README with documentation for the new ApproveTransaction tool 