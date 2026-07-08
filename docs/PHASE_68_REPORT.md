# Phase 68: PR Split Plan and Operator Runbook

生成日期：2026-07-08

## 1. 阶段目标

Phase 68 做 release hardening 的文档收口：把 Phase 57-67 拆成 reviewer 可理解的 PR 链，并把真实 `md` 操作路径从 README 长命令段收敛到专门 runbook。

## 2. 新增文档

- `docs/PR_SPLIT_PLAN_57_68.md`
- `docs/MD_OPERATOR_RUNBOOK.md`

## 3. PR Split Plan

建议拆成 6 个 PR：

1. PR A: Phase 57-58，MD probe repair and small batch recovery。
2. PR B: Phase 59，Probe Template Registry。
3. PR C: Phase 60-61，Proposal lifecycle UX and Evidence Graph。
4. PR D: Phase 62 + 66，AI repair context and checked repair acceptance。
5. PR E: Phase 63-64 + 67，Config/artifact release hardening。
6. PR F: Phase 65 + 68，Real MD medium batch evidence and runbook。

该拆法把真实 smoke evidence 放在对应功能 PR 中，同时保留 Phase 65 作为集成验证 PR。

## 4. Operator Runbook

`docs/MD_OPERATOR_RUNBOOK.md` 覆盖：

- precondition clean check
- create/resume md-fast run
- proposal generation
- template coverage expectations
- batch plan/apply
- failure replan/retry/acceptance loop
- superseded proposal exclusion
- report refresh
- artifact GC/migration dry-run and confirmed apply
- final verification

## 5. README Update

README 保留核心命令入口，并指向:

- `docs/MD_OPERATOR_RUNBOOK.md`
- `docs/PR_SPLIT_PLAN_57_68.md`
- `docs/PR_MERGE_READINESS.md`

## 6. Verification

```bash
npm test
git diff --check
```

Current results:

- `npm test`: 38 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

Target repository status before final verification:

```text
## main...origin/main
```

## 7. Exit Criteria

- PR split plan exists for Phase 57-68: passed
- Real md operator runbook exists: passed
- README points to runbook / split plan: passed
- Detailed phase reports remain available: passed
