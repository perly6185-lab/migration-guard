# Phase 56: PR Split and Release Notes

生成日期：2026-07-07

## 1. 阶段目标

Phase 56 收口 Phase 53-55 的 PR 拆分和 release note。前面的大批量开发已经拆成可独立 review 的 PR 链，本阶段把每个 PR 的交付、验证和后续风险整理成一份交接记录。

## 2. PR Split Result

| PR | Title | Scope | Merge commit | CI |
| --- | --- | --- | --- | --- |
| [#1](https://github.com/perly6185-lab/migration-guard/pull/1) | Add proposal gate handoff and MD behavior guardrails | Phase 36-52 runner loop, proposal gates, MD guardrails, CI readiness | `0f23a0953417ab23477743f93a8a2a1e72877796` | Build and Test passed |
| [#3](https://github.com/perly6185-lab/migration-guard/pull/3) | Create readiness replan tasks from handoff items | Phase 53 readiness handoff -> issue-linked replan tasks | `6b23bd353a581968d542dee8fbc66dc897c4bcf3` | Build and Test passed |
| [#4](https://github.com/perly6185-lab/migration-guard/pull/4) | Write readiness repair briefs | Phase 54 AI/human repair briefs for readiness failures | `adaed9f9fd99d7997b4ab38292fd4fb27d340faf` | Build and Test passed |
| [#5](https://github.com/perly6185-lab/migration-guard/pull/5) | Document MD multi-domain proposal batch | Phase 55 real MD multi-domain proposal batch evidence | `dd80cce93d8339d5665cc27eab9b8b6b16a754ee` | Build and Test passed |

结论：

- PR split 已完成，不需要在当前代码状态下再拆 PR。
- Phase 53、54、55 都已经独立 PR 合并。
- Release note 的主要用途是给下一轮修复和发布判断提供单页索引。

## 3. Release Highlights

- Readiness handoff can now create deterministic issue-linked replan tasks with `actions handoff --create-replans`.
- Readiness failures can now produce task-scoped AI repair briefs and JSON context with `actions handoff --repair-briefs`.
- Real MD proposal batching has been exercised across MCP render, API contracts, and core renderer proposals.
- Passing MD batch evidence includes true apply, recommended checks, batch report, and rollback back to a clean target repository.
- GitHub CI is active for pull requests and has reported passing `Build and Test` checks across the split PR chain.

## 4. Operator Notes

Common commands for the delivered workflow:

```bash
node dist/cli.js actions handoff --config configs/md-fast.migration-guard.json --run latest --create-replans --repair-briefs
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action <action-id>
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 3 --gate-policy fail-fast
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run latest --proposal <proposal-id>
```

Review entry points:

- `docs/PHASE_53_REPORT.md`
- `docs/PHASE_54_REPORT.md`
- `docs/PHASE_55_REPORT.md`
- `docs/PR_MERGE_READINESS.md`

## 5. Known Follow-Ups

The release is usable, but Phase 55 preserved three concrete repair inputs:

- Shared TS package actions need a structural TypeScript probe instead of `ui-smoke-probe`.
- MCP render smoke should avoid or control remote CSS fetches to reduce CDN-related flakes.
- Proposal lifecycle should gain an explicit reject/ignore state for proposed-only patches that should be excluded from a later batch.

Suggested next phase:

- Phase 57: repair probe-template selection and proposal exclusion semantics, then rerun a smaller MD batch.

Update:

- Phase 57 implemented the shared TS structural probe, MCP render no-remote-CSS smoke, and proposal `reject` / `ignore` exclusion flow. See `docs/PHASE_57_REPORT.md`.

## 6. Verification

GitHub PR checks:

- PR #1: Build and Test passed
- PR #3: Build and Test passed
- PR #4: Build and Test passed
- PR #5: Build and Test passed

Local verification for this release-note PR should remain:

```bash
npm test
git diff --check
```

Results:

- 30 tests passed
- `git diff --check` passed; Windows line-ending warnings only
