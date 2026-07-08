# Phase 62: AI Repair Loop Strengthening

生成日期：2026-07-08

## 1. 阶段目标

Phase 62 强化 proposal failure -> replan -> AI repair -> retry proposal 的闭环，让 AI/human 接手时拿到任务级上下文，而不是只看到失败文件路径后重新猜。

## 2. 新增能力

- Replan JSON context 增加 proposal task context：
  - `templateSelection`
  - `checkPlan`
  - `checkReadiness`
  - `sourceSnippets`
- Failure context 增加 `latestFailedOutput`，保留最新失败 check 的 stdout/stderr 摘要。
- Replan brief 增加：
  - Probe template selection reason
  - Check plan
  - Check readiness
  - Source Snippet Index
  - AI Repair Acceptance Checklist
- Retry proposal 继承 source proposal 的：
  - `templateSelection`
  - `retrySourceFailureCategory`
- Retry evidence 写入 `sourceFailureCategory`，方便 report 和 issue 追踪失败分类。

## 3. AI Repair Context Shape

`proposal replan` 写出的 `replan-context.json` 现在可以直接回答：

- 这个 proposal 为什么选这个 probe template？
- 原 action 推荐跑哪些 checks？
- 这些 checks 在 action planning 阶段是否 ready？
- 失败 check 最近输出了什么？
- 需要修的最小相关源码片段在哪里？
- AI 修复完成前需要核对哪些验收项？

Source snippet index 会从 proposal affected files 中挑选可读源码文件，并写入小段带行号 excerpt。该设计避免把整仓塞进上下文，同时给 AI 足够起步信息。

## 4. Retry Inheritance

`proposal retry` 生成的新 proposal 会记录：

- `retryOfProposalId`
- `retrySourceFailureCategory`
- inherited `templateSelection`

这样 retry 不再只是一个新的 patch scaffold，而是可以回连到源 proposal 的失败分类和 probe 选择依据。

## 5. Verification

```bash
npm test
git diff --check
```

Results:

- `npm test`: 36 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed

新增测试覆盖：

- failed proposal replan brief renders `Source Snippet Index`。
- failed proposal replan brief renders `AI Repair Acceptance Checklist`。
- replan context includes source snippets, check plan, failed stdout/stderr summary, and acceptance checklist。
- retry proposal records `retrySourceFailureCategory: "command-failed"`。

## 6. Exit Criteria

- Replan brief/context includes task-level repair evidence: passed
- Repair context includes template selection and check readiness: passed
- Latest failed stdout/stderr summary is captured: passed
- Retry proposal inherits source failure category: passed
- AI repair acceptance checklist is generated: passed
