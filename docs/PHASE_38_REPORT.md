# Phase 38: Proposal-Scoped Behavior Diff Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 38 在 proposal apply 周围加入显式 before/after behavior diff。用户开启 `--behavior-diff` 后，Migration Guard 会捕获 apply 前后的 snapshots，生成 compare report，并把结果写回 proposal verification report。

## 2. 新增能力

- `task apply --behavior-diff`
- `action apply --behavior-diff`
- `proposal batch apply --behavior-diff`
- proposal 目录写入 before snapshot
- proposal 目录写入 after snapshot
- proposal 目录写入 compare JSON/Markdown
- verification report 写入 `behaviorDiff`
- run report 展示 behavior diff 路径和错误/警告数量

## 3. Artifacts

```text
.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-before.json
.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-after.json
.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-compare.json
.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-compare.md
```

## 4. Safety Boundary

Behavior diff is explicit opt-in. Normal apply behavior is unchanged unless the user passes `--behavior-diff`.

This keeps large real projects from paying the full snapshot cost on every proposal unless the migration operator wants that evidence.

## 5. Verification

覆盖点：

- apply with `behaviorDiff: true`
- before/after snapshot artifacts exist
- compare JSON/Markdown artifacts exist
- verification report contains `behaviorDiff`
- rendered verification report shows behavior diff summary

验证命令：

```bash
npm test
```
