# PR Split Plan: Phases 57-68

生成日期：2026-07-08

## 1. Goal

This plan splits the current Phase 57-68 working tree into reviewable PRs. The split keeps real MD evidence, probe generalization, lifecycle UX, AI repair, artifact release hardening, and docs/runbook changes understandable without asking reviewers to audit one large mixed PR.

## 2. Proposed PR Chain

| PR | Title | Phases | Scope | Primary verification |
| --- | --- | --- | --- | --- |
| PR A | Repair MD probe selection and prove small batch recovery | 57-58 | Shared TS structural probe, MCP render no-remote-CSS smoke, reject/ignore states, real MD small batch report | `npm test`, `git diff --check`, Phase 58 md-fast smoke |
| PR B | Centralize probe template selection | 59 | Probe template registry, template selection reasons in action/proposal artifacts, priority coverage | `npm test`, registry unit coverage |
| PR C | Improve proposal lifecycle and evidence reports | 60-61 | `proposal list`, exclusion metadata, superseded-by links, batch exclusion reporting, Evidence Graph | `npm test`, Phase 60/61 real MD report smoke |
| PR D | Strengthen AI repair loop | 62, 66 | Replan context source snippets/check readiness/latest failed output, retry failure inheritance, checked repair acceptance reports | `npm test`, repair acceptance unit coverage |
| PR E | Release hardening for artifacts and config | 63-64, 67 | Config profiles, schema guard, artifact GC, artifact migration, migration plan hash confirmation | `npm test`, artifact GC/migration dry-run smoke |
| PR F | Real MD medium batch evidence and runbook | 65, 68 | Medium MD batch regression, UI mixed Vue/TS probe fix, operator runbook, PR split docs | `npm test`, Phase 65 md-fast batch evidence |

## 3. Dependency Order

1. PR A must land before PR B because the registry preserves the repaired shared/MCP behavior.
2. PR B should land before PR C because lifecycle reports include template selection summaries.
3. PR C should land before PR D because AI repair reports rely on clearer proposal/batch evidence.
4. PR D and PR E can be reviewed in parallel after PR C, but PR E should land before broader release tagging.
5. PR F should land last because it proves the integrated behavior across the prior PRs.

## 4. Review Focus

PR A:

- Shared TS actions no longer use Vue-only probes.
- MCP render smoke avoids remote CSS fetches.
- Proposed-only reject/ignore cannot accidentally rollback unapplied patches.

PR B:

- Registry priority preserves Phase 57 behavior.
- Selection reason is visible in action/proposal artifacts.

PR C:

- Exclusion metadata is stable and visible.
- Batch plan/report distinguishes excluded vs failure-skipped proposals.
- Run report Evidence Graph stays additive for old artifacts.

PR D:

- Replan context is useful but bounded.
- Retry proposal inherits failure classification.
- `proposal accept` requires a checked passing retry verification.

PR E:

- Profile merge rules do not surprise existing configs.
- Artifact GC remains dry-run-first.
- Artifact migration apply requires matching `planHash`.

PR F:

- Phase 65 first-round failure is documented as a useful regression.
- UI mixed Vue/TS probe fix is covered.
- Second medium batch passes and all applied proposals rollback cleanly.

## 5. Required Checks Per PR

Run locally before each PR:

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Expected current baseline:

- `npm test`: 38 tests passed
- `git diff --check`: passes with Windows LF/CRLF warnings only
- target md repo: `## main...origin/main`

## 6. Files To Group

Core implementation files:

- `src/core/probeTemplateRegistry.ts`
- `src/core/artifactGc.ts`
- `src/core/artifactMigration.ts`
- `src/core/patch.ts`
- `src/core/migrationRun.ts`
- `src/core/config.ts`
- `src/core/executor.ts`
- `src/core/actionPlan.ts`
- `src/core/taskGraph.test.ts`
- `src/core/config.test.ts`
- `src/core/patch.test.ts`
- `src/types.ts`
- `src/cli.ts`

Documentation:

- `docs/PHASE_57_REPORT.md` through `docs/PHASE_68_REPORT.md`
- `docs/MD_OPERATOR_RUNBOOK.md`
- `docs/PR_SPLIT_PLAN_57_68.md`
- `docs/DEVELOPMENT_PHASES.md`
- `docs/NEXT_MAJOR_PHASES.md`
- `README.md`

## 7. Commit Guidance

Keep commits aligned to PR scope:

- Avoid mixing real smoke report edits into low-level registry/code commits unless the report is the evidence for that PR.
- Keep generated runtime artifacts under `.migration-guard/` uncommitted.
- Do not include target `md` repository changes; all smokes should end with target clean.

## 8. Residual Risk

- Phase 65 exercised five proposal lanes, not every generated MD action.
- Artifact migration `--apply` was intentionally not run against real md-fast artifacts; only dry-run and missing-confirm rejection were smoked.
- GitHub operational hardening remains deferred.
