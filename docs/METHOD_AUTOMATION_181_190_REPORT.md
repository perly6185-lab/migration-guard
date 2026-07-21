# MG-181 to MG-190 Method Automation Report

Updated: 2026-07-21

## Scope

This delivery takes guarded TypeScript Extract Method from explicit line-based
execution to candidate discovery, stable AST anchoring, resumable automation,
trust-tier policy and before/after quality evaluation.

## Delivery

| Issue | Capability | State |
| --- | --- | --- |
| MG-181 | Documentation and release-status alignment | completed |
| MG-182 | Isolated real-repository pilot runner with three-case minimum | completed |
| MG-183 | Beta, UI, desktop, package, golden and release gates | completed |
| MG-184 | Ranked checker-backed extraction candidates | completed |
| MG-185 | Deterministic conflict-free name suggestions | completed |
| MG-186 | AST kind/text/context anchors and safe relocation | completed |
| MG-187 | Idempotent persistent execution session | completed |
| MG-188 | Manual, supervised and unattended mutation policy | completed |
| MG-189 | Separate behavior, structure and operational decisions | completed |
| MG-190 | Before/after advanced metric gates with required-gate rollback | completed |

## Safety Model

- Candidate enumeration is bounded and reuses one TypeScript Program.
- Every executable candidate passes the existing AST and data-flow contract gates.
- Anchors bind symbol, file, statement kinds, normalized source and adjacent context.
- Semantic drift or ambiguous relocation requires replanning.
- Manual sessions always stop at exact patch-hash confirmation.
- Automatic tiers require a low-risk executable candidate and passing temporary verification.
- Required advanced gates compare pre-apply and post-apply evidence.
- A failed required gate reverses the patch and restores original source bytes as fallback.
- Completed sessions are idempotent and session ledgers are hash validated.

## Evaluation Semantics

The final report deliberately separates:

- `behaviorConfidence`: passing characterization and project checks;
- `structuralImprovement`: method-level lines, statements, complexity, locals and calls;
- `operationalRisk`: combined mutation and gate risk;
- advanced gates: coverage, mutation, benchmark, memory, bundle and API compatibility.

Missing optional evidence is `not-evaluated`. Missing required evidence fails the
quality decision and rolls back an applied extraction.

## Current Evidence

- `npm test`: 248/248 passed; 67.86 seconds in the final pre-release run.
- `npm run beta:readiness`: GO, 14/14 checks; report hash
  `0dcd7056fcd8812027584b75c100ed6ebd6e1a6160cc59ca2a2cb42c8f52ed0d`.
- `npm run ui:smoke`: passed.
- `npm run desktop:smoke`: passed.
- `npm run package:smoke`: passed; 208 files, 324458-byte tarball.
- `npm run package:audit`: passed; 208 files, 1598354 unpacked bytes.
- `npm run install:smoke`: npx and global installation passed.
- `npm run package:golden`: 4/4 fixtures passed; evidence run
  `golden-2026-07-21T01-49-31-137Z-984fde26`.
- `npm run method:pilot`: 3/3 isolated real-repository cases passed; report
  `method-pilot-2026-07-21T01-29-20-738Z`, hash
  `c851a295bdf40558dbc3c0a5b96180bd92cc3438712d31db44e88503e0f18750`.
- `npm run release:gate`: passed; release run
  `release-2026-07-21T01-54-11-550Z-c5a3bb9f`. All three existing project
  pilots executed and passed with zero differences; the release-bound method
  pilot passed 3/3 with hash
  `03bee7c55e48f41e18776a0ea6f07986a9f0186e2680ca380de7bbf85bcfeda6`.
- `git diff --check`: passed; CRLF conversion warnings only.

## Real-Repository Pilot

- Plain function: md2 `simpleHash`; completed, behavior passed, structure improved.
- Async class method: md `LocalStorageEngine.set`; completed, behavior passed.
- Three-layer chain: md2 `isAccountConfigured` -> `isShareConfigured` ->
  `isShareUiEnabled`; all layers completed after AST-anchor relocation.
- Every source repository remained unchanged and every successful temporary clone
  was removed.

The pilot found and closed three integration gaps: workspace observation files
needed a fixed repository-root environment, chain layers needed anchors captured
before the first mutation, and anchor resolution needed target-file-aware tsconfig
selection in monorepos.

## Release Decision

MG-181 through MG-190 are complete. The clean-checkout release ledger binds the
full automated test and packaging gates, all three existing project pilots and
all three method-automation pilot categories. Publishing and tagging remain
manual reviewed release actions and are outside this development scope.
