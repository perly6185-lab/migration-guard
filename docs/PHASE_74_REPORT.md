# Phase 74: Release Readiness And Quick Path

生成日期：2026-07-08

## 1. 阶段目标

Phase 74 把 Phase 70-73 的 post-merge hardening evidence 收束成当前发布准备材料，并让 README 顶部出现可直接执行的快速路径。

## 2. 文档更新

- README 增加 `Quick path`
- README 增加当前 release checklist 入口
- 新增 `docs/RELEASE_CHECKLIST_70_74.md`
- `docs/DEVELOPMENT_PHASES.md` 补 Phase 74

## 3. Quick Path 覆盖

README 顶部现在覆盖：

- 本仓库本地验证：`npm install` / `npm test` / `git diff --check`
- 真实 `md-fast` validation lane
- failed proposal repair loop：`replan` / `retry` / `verify --checks` / `accept`
- 当前 release readiness checklist
- `md` operator runbook

## 4. Release Checklist 覆盖

`docs/RELEASE_CHECKLIST_70_74.md` 覆盖：

- Phase 70 real `md` post-merge soak
- Phase 71 Ubuntu/Windows CI hardening
- Phase 72 artifact schema v1 freeze
- Phase 73 CLI repair-loop acceptance
- Phase 74 README and release-readiness consolidation

## 5. Verification

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Current expected baseline:

- `npm test`: 42 tests passed
- `git diff --check`: passes; Windows may print LF-to-CRLF warnings
- target md repo: `## main...origin/main`

## 6. Exit Criteria

- README has a current quick path: passed
- Current release checklist exists: passed
- Checklist links Phase 70-74 evidence: passed
- Release boundaries and gates are explicit: passed
