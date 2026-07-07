# Next Major Phases

生成日期：2026-07-06

## Major Phase A: Real GitHub Mutation Closure

目标：完成最小真实 GitHub mutation smoke，然后停止扩展 GitHub provider。

状态：已完成。见 `docs/PHASE_35_REPORT.md`。

阶段：

1. Authorized single-issue create/update smoke
2. Artifact sensitive-data scan
3. GitHub issue URL 回写验证
4. Post-mutation report

退出标准：

- 只创建或更新 1 个 issue。
- `github-live-sync.json` 记录真实 URL。
- 本地 run package 的匹配 issue 有 `externalUrl`。
- 无 token 或 Authorization header 落盘。
- 不继续追加 close/reopen、assignee、milestone、pagination 等 GitHub 功能。

## Major Phase B: Migration Runner Loop

目标：回到 Migration Guard 主产品线，让失败提案自动进入“证据 -> issue -> replan task -> AI brief -> retry proposal”的迁移循环。

状态：最小闭环已打通。见 `docs/PHASE_36_REPORT.md`。

候选能力：

- proposal failure 自动转成 replan task 和 replan brief
- status/report 输出唯一下一步动作
- replan context pack 面向 Codex/AI，包含失败 check、report、patch、issue、retry command
- proposal retry queue
- end-to-end migration session report

退出标准：

- 一个 failed proposal 可以自动形成 issue、task、handoff、replan context。
- 用户可以从 `status` / `report` 看到唯一推荐动作。
- AI 可以只凭 replan brief/context 修复下一步，而不是重新猜问题。
- retry proposal 能复用失败证据和前置 gate 结果。

## Major Phase C: Behavior Consistency Core

目标：强化 `baseline` / `verify` / `compare` 在真实项目里的行为守护能力，让 Migration Guard 更像迁移指挥系统的证据层。

状态：当前活跃主线。

Progress:

- Phase 37: gate failure can reference latest check/probe drift.
- Phase 38: apply can capture proposal-scoped before/after behavior diff with `--behavior-diff`.
- Phase 39: behavior differences can be classified through a local decision ledger.
- Phase 40: decision ledger now acts as a behavior decision gate.
- Phase 41: `pnpm-vite-vue` emits low-risk proposal candidates before source edits.
- Phase 42: `md` adds API contract and web static/build probes.
- Phase 43: `md-monorepo` emits a project-specific refactor task plan and action plan.
- Phase 44: first `md` domain action proposal passes apply checks, behavior diff, and rollback.
- Phase 45: `proposal verify --checks` temporarily applies generated-script proposals and rolls them back.
- Phase 46: proposal gates fail package-manager no-op checks and MD MCP uses a real render runtime smoke.
- Phase 47: MD action plans include static check-readiness hints for recommended commands.
- Phase 48: `action propose` blocks no-op-risk actions unless explicitly overridden.
- Phase 49: status/report summarize action check readiness and surface no-op-risk as next action.
- Phase 50: run reports emit action check readiness JSON/Markdown handoff artifacts.
- Phase 51: `actions handoff` generates readiness handoff artifacts on demand.
- Phase 52: GitHub Actions CI and PR merge readiness checklist close the development loop.

候选能力：

- 真实项目 baseline / verify / compare 覆盖扩展
- proposal apply 前后的 behavior diff 关联
- gate 失败自动引用具体 check/probe drift
- drift 分类：intentional / accidental / unknown
- report 中把 proposal、diff、probe、check 串成同一证据链

退出标准：

- 至少一个真实项目能展示 proposal 前后行为证据。
- gate 失败时可以直接定位到具体 check/probe drift。
- report 能说明“为什么停、下一步做什么、依据是什么”。
- PR CI 能在 GitHub 上报告 `npm test` 结果。

## Major Phase D: AI Collaboration Loop

目标：把 Migration Guard 的证据包变成 AI 修复工作的最小上下文输入。

候选能力：

- 自动生成 task-scoped replan brief
- 最小 Codex/AI context pack
- repair prompt 模板
- repaired proposal retry path
- AI 输出和 verification report 关联

退出标准：

- AI 下一步任务可以由 Migration Guard 证据直接驱动。
- replan brief 不要求 AI 重新扫描完整仓库才能理解失败。
- 修复后的 retry proposal 能回连原 failure issue/task。

## Deferred Backlog: GitHub Operational Hardening

这些能力有价值，但在完成 Runner Loop 主线前不继续展开：

- issue close/reopen policy
- label reconciliation policy
- assignee/milestone dry-run preview
- pagination for open issues
- idempotent update smoke
- provider adapter abstraction expansion
- GitLab/Jira/Linear live-plan mock
