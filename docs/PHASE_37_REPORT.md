# Phase 37: Proposal Gate Behavior Drift References Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 37 把 behavior consistency core 接回 proposal gate。失败 gate 不只说明命令失败，还会引用最新 compare report 中的具体 check/probe drift，让 replan 和 AI 修复有行为证据。

## 2. 新增能力

- failed proposal verification report 写入 `behaviorDrift`
- `behaviorDrift` 包含：
  - compare report path
  - baseline/current snapshot id
  - check/probe error/warn differences
  - 与 failed check command 相关的 drift 标记
- failure issue 和 replan task 写入 drift 摘要
- replan brief/context 写入 `Behavior Drift`
- issue sync gate context 导出 drift 摘要
- run report `Recent Proposal Gates` 展示 drift count 和第一条 drift

## 3. Safety Boundary

本阶段只引用已有 compare artifacts，不在 proposal apply/verify 中自动重跑完整 `baseline` / `verify` / `compare`。

自动执行 behavior snapshot 和 proposal 前后 diff 关联留给后续阶段。

## 4. Evidence Chain

```text
latest compare report
  -> failed proposal verification report
  -> failure issue
  -> replan task
  -> replan brief/context
  -> issue sync export
  -> run report
```

## 5. Verification

覆盖点：

- failed verification report 记录 check/probe drift
- scan info difference 不作为 gate drift
- replan brief/context 包含 drift
- issue sync export 包含 drift
- run report 显示 `behavior-drift:<count>`

验证命令：

```bash
npm test
```
