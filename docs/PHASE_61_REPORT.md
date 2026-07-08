# Phase 61: Evidence Graph and Report Convergence

生成日期：2026-07-08

## 1. 阶段目标

Phase 61 让 run report 更像迁移指挥台：把 proposal、gate、batch、behavior decision、replan 和 next action 串起来，并区分 batch failure skip 与 lifecycle exclusion。

## 2. 新增能力

- Run summary 前置最新 behavior decision gate 状态。
- Run report 新增 `Evidence Graph` section。
- Proposal compact summary 现在显示：
  - retry source
  - source failure category
  - template
  - exclusion reason
  - superseded-by
  - gate result / failure category
  - behavior decision status
  - batch id
  - retry/replan hint
- Batch report rendering 区分：
  - `failure-skipped`: 因前序 proposal failure 跳过
  - `excluded`: 因 rejected / ignored / already-applied 等 lifecycle 状态排除
- Recent Proposal Batches section 显示 `excluded-count` 和 excluded proposal ids。

## 3. Real MD Smoke

刷新 report：

```bash
node dist/cli.js report --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh
```

Observed report evidence:

```text
## Evidence Graph

- proposal:patch-2026-07-08T00-51-13-114Z-b2boml -> state:ignored excluded:superseded by Phase 60 lifecycle smoke
- proposal:patch-2026-07-08T01-32-23-492Z-pqggw1 -> state:proposed
```

Proposal compact summary also shows:

- `template:ts-structural-probe`
- `excluded:superseded by Phase 60 lifecycle smoke`
- `superseded-by:patch-2026-07-08T01-32-23-492Z-pqggw1`

## 4. Verification

```bash
npm test
git diff --check
```

Results:

- `npm test`: 36 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

## 5. Notes

This phase keeps report changes additive. Existing artifacts without `excluded` or `exclusion` fields still render through fallback state labels.

