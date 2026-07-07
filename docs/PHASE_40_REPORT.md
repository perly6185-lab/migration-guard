# Phase 40: Decision-Aware Behavior Gate

生成日期：2026-07-07

## 1. 阶段目标

Phase 40 让 diff decision ledger 进入迁移控制流。原始 compare 结果仍保持不可篡改；decision gate 只解释这些差异是否已被接受、是否需要继续分类、或是否必须 replan。

## 2. 新增能力

- `clean`：没有 error/warn behavior differences
- `accepted`：所有 risk differences 都被分类为 `intentional`
- `pending`：存在未分类或 `unknown` risk differences
- `blocked`：存在 `accidental` risk differences

## 3. Safety Boundary

本阶段不修改 raw compare passed/failed，不自动把 intentional diff 写回 baseline，也不弱化 checks/probes。decision gate 只是运行控制层。

## 4. Verification

覆盖点：

- intentional risk diff 可继续
- accidental risk diff blocked
- unknown / pending risk diff pending
- run verify 使用 decision policy

验证命令：

```bash
npm test
```
