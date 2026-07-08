# Phase 65: Real MD Medium Batch Regression

生成日期：2026-07-08

## 1. 阶段目标

Phase 65 从小批量升级到真实 `md` medium batch，验证 probe registry、proposal lifecycle、evidence graph、AI repair context、artifact schema marker 在组合场景下能跑通。

## 2. Run

- run: `run-2026-07-08T01-50-45-553Z-4kqioq`
- goal: `Phase 65 MD medium batch regression`
- config: `configs/md-fast.migration-guard.json`
- adapter: `md-monorepo`
- action readiness: 9 actions, 14 checks, 14 ready, 0 no-op-risk, 0 unknown

Commands:

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Phase 65 MD medium batch regression" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run run-2026-07-08T01-50-45-553Z-4kqioq --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run run-2026-07-08T01-50-45-553Z-4kqioq
```

## 3. First Medium Batch: Failed as Useful Regression

Initial proposals:

- shared TS: `patch-2026-07-08T01-53-57-700Z-hvvea9`
- MCP render: `patch-2026-07-08T01-53-58-039Z-aiwrnl`
- core renderer: `patch-2026-07-08T01-53-57-785Z-bbnu04`
- web editor shell: `patch-2026-07-08T01-53-57-869Z-ahq3l9`
- API contracts: `patch-2026-07-08T01-53-57-959Z-0stxho`

Batch report:

- `proposal-batch-report-2026-07-08T01-55-47-353Z-psn13g`
- executed: 4
- skipped: 1
- excluded: 0
- first failed: `patch-2026-07-08T01-53-57-869Z-ahq3l9`
- failure category: `command-failed`

Failure summary:

`ui-smoke-probe` correctly reached the preview runtime, but still required Vue `<template>` / `<script>` signals for TS support directories:

- `apps/web/src/composables:missing-template`
- `apps/web/src/composables:missing-script`
- `apps/web/src/lib/markdown:missing-template`
- `apps/web/src/lib/markdown:missing-script`

The failed proposal was rolled back automatically. The three passed proposals were manually rolled back after the failed batch.

Replan generated:

```bash
node dist/cli.js proposal replan --config configs/md-fast.migration-guard.json --run run-2026-07-08T01-50-45-553Z-4kqioq --proposal patch-2026-07-08T01-53-57-869Z-ahq3l9
```

Artifacts:

- `replans/patch-2026-07-08T01-53-57-869Z-ahq3l9/replan-brief.md`
- `replans/patch-2026-07-08T01-53-57-869Z-ahq3l9/replan-context.json`

## 4. Fix

The UI smoke probe generator now distinguishes:

- `vue-sfc`: inspected files include `.vue`; require Vue template/script signals.
- `ts-support`: inspected files are TS/JS support files; require module/structure signals instead.

This keeps web-facing actions on `ui-smoke-probe` while avoiding false failures on composables and markdown helper directories.

New regression coverage:

- `ui smoke probes allow TypeScript support directories alongside Vue directories`

## 5. Second Medium Batch: Passed

Second batch selected:

- shared TS: `patch-2026-07-08T01-59-28-701Z-uu0808`
- MCP render: `patch-2026-07-08T01-59-29-080Z-k6p8xm`
- API contracts: `patch-2026-07-08T01-53-57-959Z-0stxho`
- core renderer: `patch-2026-07-08T01-59-28-813Z-6i5zgv`
- web editor shell: `patch-2026-07-08T01-59-28-927Z-bdjfb1`

Batch report:

- `proposal-batch-report-2026-07-08T02-00-34-944Z-14155b`
- passed: yes
- executed: 5
- skipped: 0
- excluded: 4

Excluded proposals were the first-round rolled-back proposals:

- `patch-2026-07-08T01-53-57-700Z-hvvea9`
- `patch-2026-07-08T01-53-58-039Z-aiwrnl`
- `patch-2026-07-08T01-53-57-785Z-bbnu04`
- `patch-2026-07-08T01-53-57-869Z-ahq3l9`

All five second-round applied proposals were rolled back successfully after validation.

## 6. Final Report Evidence

Refreshed report:

```bash
node dist/cli.js report --config configs/md-fast.migration-guard.json --run run-2026-07-08T01-50-45-553Z-4kqioq
```

Observed evidence graph:

- first batch failed with one failure-skipped proposal
- replan brief/context linked to the failed web proposal
- second batch passed with 5 executed and 4 excluded rolled-back proposals
- proposal compact summaries show template selection and gate status

## 7. Verification

```bash
npm test
git diff --check
```

Current results:

- `npm test`: 38 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

Target repository stayed clean:

```text
## main...origin/main
```

## 8. Exit Criteria

- Medium batch includes at least 5 proposals: passed
- Includes shared TS proposal: passed
- Includes renderer, API, web static, and MCP render lanes: passed
- Failed first-round evidence produced replan artifacts: passed
- Fixed second-round batch passes: passed
- Rolled-back proposals are excluded from later batch plans: passed
- Final target `md` repository clean: passed
- No CDN flake observed: passed
