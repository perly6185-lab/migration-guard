# Phase 59: Probe Template Registry

生成日期：2026-07-08

## 1. 阶段目标

Phase 59 将 probe template 选择从分散的 `inferMdActionTemplate` / patch generation 判断收敛成 registry，降低 shared TS 被误判为 UI probe 这类问题复发的概率。

## 2. 新增能力

- 新增 `src/core/probeTemplateRegistry.ts`。
- Registry 统一声明每个 probe template 的：
  - `needsPreview`
  - `defaultCheckKind`
  - `failureHint`
  - `scriptBuilder`
  - structural checks
  - selection match reason
- 已纳入模板：
  - `ui-smoke-probe`
  - `ts-structural-probe`
  - `renderer-probe`
  - `api-contract-probe`
  - `adapter-fixture-probe`
  - `normalization-probe`
- `MigrationAction` / `ProposedPatch` 新增 `templateSelection`，记录 `{ template, reason }`。
- `actions` 输出现在显示 template selection reason。
- md action plan JSON 写入 `templateSelection`，proposal JSON 继承该 selection。
- `proposeActionPatch` 的 preview 判断和 probe script checks 改为读取 registry definition。

## 3. Selection Priority

Registry selection 保持 Phase 57/58 的行为边界：

1. explicit `patchTemplate`
2. `packages/shared` -> `ts-structural-probe`
3. `md-web-static-contract` / web UI files -> `ui-smoke-probe`
4. `md-api-contract` / API action -> `api-contract-probe`
5. `md-renderer-behavior` / renderer action -> `renderer-probe`
6. adapter / normalization specialized templates
7. fallback `ui-smoke-probe` with review reason

实现过程中用真实 md planning smoke 捕获并修正过一次 priority drift：`action-md-web-editor-shell` 同时带 `md-web-static-contract` 和 `md-renderer-behavior` 时必须保持 `ui-smoke-probe`，不能被 renderer probe 抢先匹配。

## 4. Real MD Smoke

验证 run:

- run: `run-2026-07-08T00-50-09-687Z-hej4rh`
- goal: `Phase 59 probe template registry verification`
- config: `configs/md-fast.migration-guard.json`
- action readiness: 9 actions, 14 checks, 14 ready, 0 no-op-risk, 0 unknown
- target status after smoke: clean

Commands:

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Phase 59 probe template registry verification" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run run-2026-07-08T00-50-09-687Z-hej4rh
```

Observed action output:

- `action-md-shared-contracts`: `ts-structural-probe`, reason `packages/shared actions use TS structural probes instead of UI smoke probes.`
- `action-md-web-editor-shell`: `ui-smoke-probe`, reason `task requires md-web-static-contract.`
- `action-md-api-contracts`: `api-contract-probe`, reason `task requires md-api-contract.`
- `action-md-mcp-render`: `renderer-probe`, reason `task requires md-renderer-behavior.`

Action plan artifact:

```text
.migration-guard/external-targets/md-fast/migration-runs/run-2026-07-08T00-50-09-687Z-hej4rh/adapter/md-monorepo-action-plan.json
```

The JSON includes `templateSelection` for generated actions.

## 5. Proposal Artifact Smoke

Shared proposal:

- proposal: `patch-2026-07-08T00-51-13-114Z-b2boml`
- action: `action-md-shared-contracts`
- state: `proposed`
- generated file: `scripts/migration-guard/action-md-shared-contracts.mjs`

Evidence:

- proposal JSON includes:
  - `templateSelection.template: "ts-structural-probe"`
  - `templateSelection.reason: "packages/shared actions use TS structural probes instead of UI smoke probes."`
- generated patch contains `"template": "ts-structural-probe"`
- generated patch does not contain UI-only `missing-template` / `missing-script` checks

No proposal was applied in this smoke, so the target repository remained clean:

```text
## main...origin/main
```

## 6. Verification

```bash
npm test
git diff --check
```

Results:

- `npm test`: 33 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

New coverage:

- registry selects shared TS before UI smoke even when required probes include `md-web-static-contract`
- registry keeps web static + renderer actions on UI smoke
- `actions` rendering includes template selection reason
- shared proposal inherits `templateSelection`
- generated shared probe remains TS structural and avoids UI-only checks

## 7. Exit Criteria

- Probe templates centralized in registry: passed
- `ui-smoke-probe`, `ts-structural-probe`, `renderer-probe`, and `api-contract-probe` declared in registry: passed
- Template metadata includes preview/check/failure/script/check declarations: passed
- Action plan output shows template selection reason: passed
- Shared TS action no longer depends on scattered UI-probe inference: passed
- Existing Phase 57/58 behavior preserved: passed

