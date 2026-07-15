# Phase 169 Report: Organization Policy And Collaboration Templates

## Outcome

Projects can explicitly inherit an offline organization policy and reuse the same
bounded collaboration rules without copying large configuration files. Projects with
no policy retain the legacy behavior.

## Policy Model

- Changed-file and command budgets.
- Minimum artifact run retention.
- Strict health-debt requirement.
- Separate target edit, GitHub mutation and release mutation permissions.
- Stable SHA-256 over the fully resolved policy.

Built-in and example presets cover JS/TS monorepos, Go services and conservative
migrations. A preset may also be a JSON file inside the config directory; remote URLs
and parent-directory traversal are not supported.

## Conservative Merge

- Numeric edit/command budgets may only decrease.
- Artifact retention may only increase.
- Mutation permissions may only move from allowed to denied.
- Strict health may only move from disabled to enabled.
- Attempts to loosen a preset are capped and surfaced by `doctor` and `policy explain`.

## Enforcement

- New migration runs record `policyHash`.
- Handoffs bind the active policy hash and enforce edit/command budgets.
- Result import rejects changed policy, excess paths or denied target edits.
- Verify honors policy-required strict health debt.
- Artifact GC preserves at least the policy retention count.
- Policy changes invalidate old handoff result import plans.

## Validation

- Stable, distinct built-in hashes.
- Tightening succeeds while loosening is capped with findings.
- Local preset works without network and cannot escape the config directory.
- Test discovery floor raised to 157 tests.
