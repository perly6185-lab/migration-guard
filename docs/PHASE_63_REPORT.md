# Phase 63: Generalization and Release Prep Foundation

生成日期：2026-07-08

## 1. 阶段目标

Phase 63 原计划在 60-62 之后做产品化整理。本次先落地不依赖 60-62 的发布准备底座：

- config profile：支持 `fast` / `full` / `ci` / `local` 这类 profile 覆盖。
- artifact GC：提供 dry-run-first 的旧 run artifact 清理入口。
- schema guard：拒绝未知 config schema version。
- Windows/Linux path 一致性：补充 profile 和 artifact path 测试。
- README 快速路径：补充 profile 和 artifact GC 用法。

未提前做的部分：

- schema artifact migration：等待 60-62 的 proposal/report/AI context artifact shape 稳定后再做。
- proposal report / preview screenshot 细粒度 GC：本阶段先清理旧 `migration-runs/run-*`，避免误删仍被 report 引用的细粒度证据。

## 2. 新增能力

### Config Profiles

`loadConfig` 现在支持第三个参数 `profileName`，CLI 支持通用 `--profile <name>`。

Profile 合并规则：

- base config 仍先提供默认值。
- profile 可覆盖 `targetRoot`、`artifactsDir`、`ignore`、`checks`、`probes`。
- `output`、`compare`、`proposalGate`、`variables` 做对象级合并。
- `MG_PROFILE=<name>` 可作为默认 profile。
- 未指定 profile 时，现有 config 行为不变。

CLI 示例：

```bash
node dist/cli.js baseline --config .migration-guard.json --profile fast
node dist/cli.js verify --config .migration-guard.json --profile full
MG_PROFILE=ci node dist/cli.js run --goal "CI migration lane" --dry-run
```

### Artifact GC

新增命令：

```bash
node dist/cli.js artifacts gc --config <config> --keep-runs 5
node dist/cli.js artifacts gc --config <config> --keep-runs 5 --apply
```

默认是 dry-run。`--apply` 才删除候选目录。

安全边界：

- 只扫描当前 config 的 `artifactsDir/migration-runs/run-*`。
- 始终保留 `migration-runs/latest.json` 指向的 latest run。
- 始终保留最新 `--keep-runs` 个 run。
- 删除前校验 candidate path 必须位于 `artifactsDir/migration-runs` 内。

### Schema Guard

`loadConfig` 现在拒绝非 `schemaVersion: 1` 的配置，避免后续 release 中旧/新 schema 混用时静默误读。

## 3. Real Artifact GC Smoke

执行命令：

```bash
node dist/cli.js artifacts gc --config configs/md-fast.migration-guard.json --keep-runs 3 --json
```

结果：

- artifacts dir: `D:\learn\migration-guard\.migration-guard\external-targets\md-fast`
- latest run: `run-2026-07-08T00-50-09-687Z-hej4rh`
- mode: dry-run
- kept: 3
- candidates: 9
- deleted: 0

该 smoke 未删除任何 artifact。

## 4. Documentation

README 增加：

- `profiles` 示例，覆盖 `local` / `ci` / `fast` / `full`。
- `artifacts gc` dry-run 和 apply 命令。

## 5. Verification

```bash
npm test
git diff --check
node dist/cli.js artifacts gc --config configs/md-fast.migration-guard.json --keep-runs 3 --json
node dist/cli.js --help
```

结果：

- `npm test`: 36 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed
- artifact GC real dry-run: passed, 0 deleted
- help output includes `artifacts gc`

新增测试覆盖：

- profile 覆盖 base config defaults。
- profile 合并 nested `output` / `proposalGate` / `variables`。
- unsupported config schema version fails fast。
- artifact GC dry-run does not delete old runs。
- artifact GC `apply` only deletes old run dirs and keeps latest/newest runs。

## 6. Exit Criteria

- Config profiles available for release lanes: passed
- Artifact GC has safe dry-run-first CLI: passed
- Unknown config schema versions fail fast: passed
- Windows path behavior covered by tests and real smoke: passed
- README quick path updated: passed
- 60-62 dependent artifact migrations deferred explicitly: passed

