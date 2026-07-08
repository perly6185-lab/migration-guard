# Phase 67: Artifact Migration Apply Confirmation

生成日期：2026-07-08

## 1. 阶段目标

Phase 67 做 release hardening 的第一步：给 `artifacts migrate --apply` 增加 reviewed-plan confirmation，避免 operator 误写旧 evidence artifacts。

## 2. 新增能力

`artifacts migrate` dry-run report 现在包含 `planHash`。

Apply 需要显式确认：

```bash
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --json
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --apply --apply-confirm <plan-hash>
```

保护策略：

- dry-run 只计划，不写文件。
- `--apply` 如果存在 would-migrate entries，必须带匹配的 `--apply-confirm <planHash>`。
- `--apply` 遇到 invalid JSON artifact 会拒绝执行。
- plan hash 基于 artifact kind、path、change list 和 current artifact schema version 计算。

## 3. Real CLI Smoke

Dry-run:

```bash
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --json
```

Observed:

- planHash: `d2eb4df3898a39197a57f4481bcd8fcf0df949d342fb459e10e223ad9e039f67`
- migratedCount: 91
- applied: false

Missing confirmation apply:

```bash
node dist/cli.js artifacts migrate --config configs/md-fast.migration-guard.json --apply
```

Result:

```text
Artifact migration apply requires --apply-confirm d2eb4df3898a39197a57f4481bcd8fcf0df949d342fb459e10e223ad9e039f67. Re-run dry-run, review the plan, then apply with that hash.
```

No artifact apply was performed in this smoke.

## 4. Verification

```bash
npm test
git diff --check
node dist/cli.js --help
```

Current results:

- `npm test`: 38 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed
- CLI help includes `--apply-confirm <plan-hash>`

Target repository stayed clean:

```text
## main...origin/main
```

## 5. Exit Criteria

- Dry-run emits a reviewable plan hash: passed
- Apply without confirmation is rejected: passed
- Tests cover confirmation requirement: passed
- Real md-fast smoke did not mutate artifacts: passed
- Target repository remains clean: passed
