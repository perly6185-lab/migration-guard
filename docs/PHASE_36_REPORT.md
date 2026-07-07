# Phase 36: Replan Task to Retry Proposal Loop Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 36 把 Runner Loop 从“失败后生成 replan brief”推进到“生成可跟踪的 retry proposal”。这让失败提案不再停在 handoff 文档，而是进入下一轮可验证 proposal。

## 2. 新增能力

- `proposal retry --proposal <failed-proposal-id>`
- retry proposal metadata 回连：
  - `retryOfProposalId`
  - `replanIssueId`
  - `replanTaskId`
  - `replanBriefPath`
  - `replanContextPath`
- failed verification report 写入 `retryProposalId`
- retry proposal 创建后 replan task 标记为 `done`
- `status` / `report` 的唯一下一步从 `proposal retry` 转到 retry proposal verify/apply

## 3. Runner Loop

```text
proposal failure
  -> failure issue
  -> replan task
  -> replan brief/context
  -> retry proposal
  -> verify/apply retry proposal
```

## 4. Safety Boundary

`proposal retry` 创建的是 retry scaffold，不自动修改业务代码。AI 或人类应使用 replan brief/context 替换 retry proposal 的 patch，然后再执行 verify/apply。

## 5. Verification

覆盖点：

- replan 后 next action 推荐 `proposal retry`
- retry proposal 创建并回连原 failed proposal
- retry proposal 复用已有 retry，避免重复创建
- failed verification report 记录 `retryProposalId`
- replan task 和对应 issue 标记为 `done`
- retry 后 next action 推荐验证 retry proposal

验证命令：

```bash
npm test
```
