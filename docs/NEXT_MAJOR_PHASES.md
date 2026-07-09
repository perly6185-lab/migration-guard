# Next Major Phases

生成日期：2026-07-09

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

状态：Phase 37-89 已完成当前主线收敛，真实 `md.git` validation lane 已完成三条不同风险域 scoped real refactor、第一条 small multi-lane batch merge validation、一条 6-file larger multi-lane batch merge validation、one-shot 前置 web/MCP guard coverage、第一轮 bounded one-shot refactor merge closure，以及 one-shot evidence reporting 产品化。

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
- Phase 53: `actions handoff --create-replans` turns readiness attention items into issue-linked replan tasks.
- Phase 54: `actions handoff --repair-briefs` writes AI repair briefs for readiness failures.
- Phase 55: real `md` multi-domain proposal batch passed for MCP render, API contracts, and core renderer, then rolled back cleanly.
- Phase 56: PR split and release notes summarize PR #1/#3/#4/#5, CI status, operator commands, and follow-up repair inputs.
- Phase 57: shared TS actions use structural probes, MCP render smoke avoids remote CSS fetches, and proposed-only patches can be rejected or ignored before batch selection.
- Phase 58: a real MD small-batch regression verifies shared TS, MCP render, proposal exclusion, rollback, and clean target state.
- Phase 59: probe template selection is centralized in a registry with template selection reasons in action/proposal artifacts.
- Phase 60: proposal lifecycle UX exposes rejected/ignored reasons, proposal list filters, superseded-by links, and batch exclusion reporting.
- Phase 61: run reports include an evidence graph linking proposals, gates, batches, behavior decisions, replans, and next actions.
- Phase 62: AI repair contexts include template selection, check readiness, source snippets, failed output summaries, and retry failure inheritance.
- Phase 63: config profiles, schema guard, dry-run-first artifact GC, path tests, and README release-prep docs are in place.
- Phase 70: post-merge real `md` soak passed a 5-proposal batch and rolled back cleanly.
- Phase 71: CI now runs on Ubuntu and Windows with path normalization coverage.
- Phase 72: artifact schema v1 is frozen through a registry and migration compatibility gate.
- Phase 73: CLI repair-loop acceptance covers failed proposal -> replan -> retry -> verify -> accept.
- Phase 74: README quick path and Phase 70-74 release checklist consolidate current readiness.
- Phase 75: `readiness` adds a large-batch refactor gate across action plan, check readiness, proposal floor, template coverage, passing batch evidence, unresolved failures, confidence, and target clean status.
- Phase 76: real `md.git` run reached `readiness --strict: go` after a 3-proposal batch passed and all applied proposals rolled back cleanly.
- Phase 77: first scoped real `md.git` refactor PR opened after baseline/verify/compare proved no behavior differences.
- Phase 78: real `md.git` PR #1 was merged and post-merge verify/compare on target `main` still showed no behavior differences.
- Phase 79: second scoped real `md.git` refactor opened PR #2 in the API contract lane after baseline/verify/compare showed no behavior differences.
- Phase 80: real `md.git` PR #2 was merged and post-merge verify/compare on target `main` still showed no behavior differences.
- Phase 81: third scoped real `md.git` refactor opened PR #3 in the renderer/core lane after baseline/verify/compare showed no behavior differences.
- Phase 82: real `md.git` PR #3 was merged and post-merge verify/compare on target `main` still showed no behavior differences.
- Phase 83: first small multi-lane real `md.git` batch opened PR #4 across shared, API, and renderer lanes after fresh baseline/verify/compare showed no behavior differences.
- Phase 84: real `md.git` PR #4 was merged and post-merge verify/compare on target `main` still showed no behavior differences.
- Phase 85: larger multi-lane real `md.git` batch opened PR #5 across six shared/API/core files after fresh baseline/verify/compare showed no behavior differences.
- Phase 86: real `md.git` PR #5 was merged and post-merge verify/compare on target `main` still showed no behavior differences.
- Phase 87: `md-one-shot` guard lane adds critical web build/test/type-check coverage plus web static and MCP render probes; baseline/verify/compare passed with no differences.
- Phase 88: first bounded one-shot real `md.git` refactor opened and merged PR #6 across API, web, core, MCP, and shared lanes; post-commit and post-merge `md-one-shot` verify/compare passed.
- Phase 89: `one-shot report` turns latest baseline/run/compare, source-file budget, and target clean status into JSON/Markdown closure evidence; real `md-one-shot` post-merge evidence produced a `go` report.

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

Next focus:

- Phase 64 added dry-run-first artifact schema migration for proposal, verification, batch, and replan context artifacts.
- Expand artifact GC only after reports no longer reference the candidate evidence.
- Keep GitHub operational hardening deferred until release readiness is stronger.

Next candidate:

- Phase 65 completed a medium real MD batch regression across shared TS, renderer, API, web static, and MCP render lanes. The first batch exposed a UI probe false positive on TS support directories; the fix passed a second 5-proposal batch and rolled back cleanly.
- Phase 66 added checked repair acceptance reports for retry proposals and surfaces acceptance evidence in run reports.
- Phase 67 added reviewed-plan confirmation for artifact migration apply.
- Phase 68 added the Phase 57-68 PR split plan and real MD operator runbook.
- Phase 69 added the final Phase 57-68 release checklist.
- Next: add optional PR metadata to one-shot reports so branch, PR URL, target commit, merge commit, and merge time can be captured in the generated closure artifact.

## Major Phase D: AI Collaboration Loop

目标：把 Migration Guard 的证据包变成 AI 修复工作的最小上下文输入。

状态：Phase 62 已完成 proposal failure repair context 的第一轮强化；后续继续围绕任务级 repair prompts 和 acceptance automation。

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
