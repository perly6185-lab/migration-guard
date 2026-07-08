# Release Checklist: Phases 57-68

生成日期：2026-07-08

## 1. Release Scope

This checklist covers the Phase 57-68 release train:

- MD probe repair and real regression evidence
- Probe template registry
- Proposal lifecycle UX
- Evidence Graph / report convergence
- AI repair context and checked repair acceptance
- Config profiles, artifact GC, artifact schema migration
- Real MD medium batch validation
- Operator runbook and PR split plan

Use this checklist before opening the split PR chain described in `docs/PR_SPLIT_PLAN_57_68.md`.

## 2. Required Local Checks

Run from `D:/learn/migration-guard`:

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Current verified baseline:

- `npm test`: 38 tests passed
- `git diff --check`: passed with Windows LF/CRLF warnings only
- target md repo: `## main...origin/main`

## 3. Required Evidence Documents

Core phase reports:

- `docs/PHASE_57_REPORT.md`
- `docs/PHASE_58_REPORT.md`
- `docs/PHASE_59_REPORT.md`
- `docs/PHASE_60_REPORT.md`
- `docs/PHASE_61_REPORT.md`
- `docs/PHASE_62_REPORT.md`
- `docs/PHASE_63_REPORT.md`
- `docs/PHASE_64_REPORT.md`
- `docs/PHASE_65_REPORT.md`
- `docs/PHASE_66_REPORT.md`
- `docs/PHASE_67_REPORT.md`
- `docs/PHASE_68_REPORT.md`

Release handoff docs:

- `docs/PR_SPLIT_PLAN_57_68.md`
- `docs/MD_OPERATOR_RUNBOOK.md`
- `docs/PR_MERGE_READINESS.md`

## 4. PR Gates

PR A: Phase 57-58

- Shared TS proposal uses `ts-structural-probe`.
- MCP render smoke does not depend on remote CSS fetch.
- rejected / ignored proposals do not enter batch.
- Real MD small batch evidence exists.

PR B: Phase 59

- Probe template registry includes UI, TS structural, renderer, and API contract probes.
- Selection reasons are visible in action/proposal artifacts.
- Priority keeps shared TS before UI smoke.

PR C: Phase 60-61

- `proposal list` filters by state/action/risk.
- `proposal ignore --superseded-by` records replacement links.
- Batch reports distinguish excluded vs failure-skipped proposals.
- Run reports include Evidence Graph.

PR D: Phase 62 + 66

- Replan context includes template selection, check readiness, snippets, failed output summary, and checklist.
- Retry proposals inherit source failure category.
- `proposal accept` requires checked passing retry verification.
- Run report shows repair acceptance evidence.

PR E: Phase 63-64 + 67

- Config profiles merge safely.
- Unknown config schema versions fail fast.
- Artifact GC is dry-run-first.
- Artifact migration emits `planHash`.
- Artifact migration apply requires `--apply-confirm <plan-hash>`.

PR F: Phase 65 + 68

- Medium MD batch executed 5 proposals.
- First-round UI probe false positive is documented.
- Mixed Vue/TS UI probe fix is covered by tests.
- Second-round 5-proposal batch passed.
- All applied proposals rolled back and target md stayed clean.
- Operator runbook and PR split plan are linked from README.

## 5. Real MD Evidence

Phase 65 run:

- run: `run-2026-07-08T01-50-45-553Z-4kqioq`
- first failed batch: `proposal-batch-report-2026-07-08T01-55-47-353Z-psn13g`
- passing medium batch: `proposal-batch-report-2026-07-08T02-00-34-944Z-14155b`
- passing batch result: executed 5, skipped 0, excluded 4
- final target md repo: clean

Artifact migration smoke:

- dry-run plan hash: `d2eb4df3898a39197a57f4481bcd8fcf0df949d342fb459e10e223ad9e039f67`
- missing `--apply-confirm` apply was rejected
- no real artifact apply was performed

## 6. Release Boundaries

In scope:

- Local artifact evidence and CLI workflows
- MD real-project validation
- Local/provider-neutral issue evidence
- GitHub read/live issue sync safety boundaries already present from earlier phases

Out of scope:

- GitHub issue close/reopen
- assignee/milestone sync
- pagination hardening
- provider adapter expansion
- broad automated source rewriting

## 7. Pre-PR Working Tree Rules

- Do not commit `.migration-guard/` runtime artifacts.
- Do not commit target `md` repository changes.
- Keep phase reports with the PR that introduced the behavior they document.
- If a PR needs real smoke evidence, include the report markdown but not local runtime artifacts.

## 8. Ready To Open PRs

The release train is ready to split when:

- local checks pass
- target md is clean
- each PR scope from `docs/PR_SPLIT_PLAN_57_68.md` has a matching commit set
- README links resolve
- this checklist is included with the final PR or release-prep PR
