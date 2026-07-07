# Phase 34: Runner Loop Replan Brief + Next Action Report

生成日期：2026-07-06

## 1. 阶段目标

Phase 34 从 GitHub 配套建设回到 Migration Runner Loop 主线：当 proposal gate 失败后，Migration Guard 不只同步 issue，而是产出下一轮修复所需的最小证据包，并在 `status` / `report` 中给出唯一下一步动作。

## 2. 新增能力

- `proposal replan` 写出 `replan-brief.md`
- `proposal replan` 写出 `replan-context.json`
- verification report 回写 `replanBriefPath` 和 `replanContextPath`
- `status` 输出 `Next action`
- `report` 新增 `Next Action` 区块
- next action 会从“创建 replan brief”推进到“使用 replan brief 修复 proposal”

## 3. Artifacts

```text
.migration-guard/.../replans/<proposal-id>/replan-brief.md
.migration-guard/.../replans/<proposal-id>/replan-context.json
.migration-guard/.../proposals/<proposal-id>/verification-*.json
.migration-guard/.../reports/latest-report.md
```

## 4. Safety Boundary

本阶段没有继续扩展 GitHub provider，也没有执行真实 GitHub mutation。

GitHub 后续只保留一个短收口目标：

```text
authorized single-issue real mutation smoke
```

完成后立即回到 Runner Loop、行为一致性和 AI 协作闭环。

## 5. Verification

覆盖点：

- failed batch 后 next action 是 `proposal replan`
- `proposal replan` 生成 brief/context
- context 包含 failed check、issue/task、retry command
- replan 后 next action 指向 replan brief
- run report 渲染 `Next Action`

验证命令：

```bash
npm test
```
