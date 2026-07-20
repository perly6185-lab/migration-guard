# MG-180: Execute Verified TypeScript Method Extraction End to End

Status: completed in `5ad3b33`; automation follow-up MG-181 through MG-190 is in progress.

Priority: P0

Remote tracking:

- Epic: [#55](https://github.com/perly6185-lab/migration-guard/issues/55)
- MG-180A: [#56](https://github.com/perly6185-lab/migration-guard/issues/56)
- MG-180B: [#57](https://github.com/perly6185-lab/migration-guard/issues/57)
- MG-180C: [#58](https://github.com/perly6185-lab/migration-guard/issues/58)
- MG-180D: [#59](https://github.com/perly6185-lab/migration-guard/issues/59)
- MG-180E: [#60](https://github.com/perly6185-lab/migration-guard/issues/60)
- MG-180F: [#61](https://github.com/perly6185-lab/migration-guard/issues/61)
- MG-180G: [#62](https://github.com/perly6185-lab/migration-guard/issues/62)

## Problem

The original `method-refactor` adapter discovered symbols and produced structural
probes only. MG-180 now generates hash-bound Extract Method patches and proves
their contracts through temporary and post-apply verification.

## Outcome

Provide a guarded TypeScript execution lane that can generate, verify and apply
an atomic Extract Method patch. A successful execution must leave the extracted
method type-correct, callable and behaviorally equivalent within the configured
checks and baseline. A result without all required evidence is not successful.

## Version 1 Boundary

- Language: TypeScript and TSX parsed with the TypeScript compiler API.
- Target: one uniquely resolved function or class method at a time.
- Selection: an explicit statement range inside the target body; automatic range
  suggestion may be added, but execution always records the exact reviewed range.
- Supported flow: contiguous statements with statically resolved inputs, outputs,
  `this` usage and async behavior.
- Mutation: proposal and verification are non-persistent; apply requires explicit
  confirmation and uses one atomic patch.
- Unsupported constructs block execution with findings: generators, labels,
  cross-boundary `break`/`continue`, conditional declarations, unresolved dynamic
  calls, ambiguous writes, unsafe closure mutation and multiple incompatible exits.
- Other languages keep the existing inventory and planning behavior only.

## Execution Model

```text
inventory -> AST eligibility -> extraction plan -> atomic patch
          -> generated contract test -> temporary apply
          -> type/test/build gates -> behavior compare
          -> reviewed apply -> post-apply verify
```

Every artifact records the target source hash, compiler options, selected range,
symbol identity and parent artifact hashes. Source drift invalidates downstream
artifacts and requires replanning.

## Development Issues

### MG-180A: AST Symbol and Range Model

Build a TypeScript compiler-program adapter that resolves the selected symbol and
statement range by AST identity rather than regular expressions.

Implementation status: completed and merged in `5ad3b33`.

Acceptance:

- Resolve source file, declaration, body, statement boundaries and compiler options.
- Reject partial statements, declarations without bodies and ambiguous symbols.
- Write `method-extraction-eligibility.json|md` with stable reason codes.
- Characterization fixtures cover functions, class methods, arrow functions,
  overload implementations, TSX and unsupported declarations.

Evidence:

- `src/core/methodExtraction.ts` implements compiler-program loading, AST symbol
  resolution, exact statement-boundary validation, source/config hashes and
  stable eligibility reason codes.
- Explicit `extract-lines=<start>-<end>` goals write
  `method-extraction-eligibility.json|md` from the real executor path.
- Focused AST fixtures and executor artifact integration pass.
- Full suite: 209/209 tests passed on 2026-07-19.

### MG-180B: Data-Flow and Contract Analysis

Compute the extraction boundary before generating any source edit.

Implementation status: completed and merged in `5ad3b33`.

Acceptance:

- Classify free reads as inputs and values read after the range as outputs.
- Track declarations, assignments, closure captures, `this`, `super`, exceptions,
  early returns and awaited expressions.
- Preserve parameter and return types using checker-resolved types when printable.
- Produce an explicit block finding whenever a safe signature cannot be derived.
- Write `method-extraction-contract.json|md` bound to the eligibility artifact.

Evidence:

- TypeScript symbol declarations distinguish function-local inputs, declarations
  inside the range, values consumed after the range and reassigned outputs.
- Contracts record printable checker types, declaration/use lines, `this`, `super`,
  `await`, `throw`, `return` and async requirements.
- Source drift, nested closures and non-terminal returns block contract eligibility.
- The executor writes hash-bound `method-extraction-contract.json|md` artifacts.
- Focused extraction tests pass 7/7; full suite passes 212/212 on 2026-07-19.

### MG-180C: Atomic Extract Method Patch

Generate a real source patch from the reviewed extraction contract.

Implementation status: completed and merged in `5ad3b33`.

Acceptance:

- Insert the extracted function/method and replace the selected statements in one
  patch; a partial insertion or partial call-site replacement cannot be applied.
- Preserve async/await, `this` binding, returned values, thrown errors, comments,
  formatting boundaries and source encoding.
- Validate the transformed source by reparsing and TypeScript diagnostics.
- Patch paths remain inside the action budget and the target root.
- Identical inputs produce stable patch content and artifact hashes.

Evidence:

- Contract-bound generation supports functions and class methods with zero or one
  declared/reassigned output, terminal returns and async/await call sites.
- Insertion and call-site replacement are serialized as one Git patch, including
  correct handling for files without a trailing newline.
- The transformed file is reparsed and compared against existing TypeScript
  diagnostics; only new diagnostics block patch readiness.
- Arrow functions, invalid/reused names and multiple outputs remain explicitly blocked.
- The executor writes `method-extraction-patch.json|md|diff` only when both
  `extract-lines` and `extract-name` are reviewed; it never applies the patch.
- Generated patches pass a real `git apply` integration test; full suite passes
  215/215 on 2026-07-19.

### MG-180D: Generated Contract Tests

Generate focused evidence for the original entry point and extraction boundary.

Implementation status: completed and merged in `5ad3b33`.

Acceptance:

- Discover an existing test framework and colocated tests where possible.
- Generate a compile-safe contract test or fixture that exercises inputs, outputs,
  thrown/rejected errors and observable side effects identified by the contract.
- Never claim behavioral coverage when only a structural probe was generated.
- Block automatic apply when required observable behavior cannot be exercised;
  allow a reviewed manual-test handoff without marking the extraction verified.

Evidence:

- Test discovery recognizes Vitest, Jest and Node Test commands and related
  colocated test files.
- Exported top-level functions with deterministic primitive/array inputs receive a
  generated characterization test that records returned or thrown/rejected behavior.
- Generated tests are syntax-compiled in focused coverage and stored as run
  artifacts; the target project is not changed during planning.
- Instance construction, non-exported symbols, unknown runners and unsupported
  input types produce blocked plans with `structuralOnly=true`.
- The executor writes `method-extraction-test-plan.json|md` and the generated test
  source when coverage is executable.
- Full suite passes 218/218 on 2026-07-19.

### MG-180E: Temporary Verification Envelope

Verify the complete patch without leaving persistent target changes.

Implementation status: completed and merged in `5ad3b33`.

Acceptance:

- Capture a fresh baseline before temporary apply.
- Temporarily apply the atomic source-and-test patch in an isolated or restorable
  worktree state.
- Run TypeScript diagnostics plus detected test and build commands.
- Capture current behavior and compare it with the baseline.
- Always restore the pre-verification state, including on timeout or process error.
- Write a hash-bound verification report containing every gate result.

Evidence:

- Verification rejects stale source, patch/test hash mismatch, blocked coverage and
  pre-existing generated-test paths before temporary mutation.
- The generated characterization test runs before and after patch apply; returned
  or thrown observations are compared by normalized content and hash.
- Detected test/build commands run through the bounded command runner with timeout
  and output limits.
- Cleanup uses reverse Git apply first and an original-byte fallback, then proves
  the source is restored and the temporary test is absent.
- Success, command failure, behavior drift and hash mismatch integration tests all
  prove restoration.
- The executor writes `method-extraction-verification.json|md`; blocked plans do
  not touch the target.
- Full suite passes 221/221 on 2026-07-19.

### MG-180F: Apply, Rejection and Rollback

Connect verified extraction proposals to the guarded apply workflow.

Implementation status: completed and merged in `5ad3b33`.

Acceptance:

- Apply requires an unexpired passing verification for the exact patch and source hash.
- A failed diagnostic, check or behavior comparison rejects apply.
- Post-apply verification failure automatically restores the checkpoint and records
  rollback evidence.
- Applied, rejected, failed and rolled-back states are distinct and resumable.
- No source mutation occurs from inventory, planning, proposal or verify commands.

Evidence:

- `method-extraction apply` requires an exact `--confirm <patch-hash>`, a passing
  non-stale verification and matching source/patch/test lineage.
- A repository checkpoint is created immediately before persistent mutation.
- Post-apply characterization and recommended checks rerun before the extraction
  is marked applied.
- Failed checks or behavior drift trigger scoped reverse apply plus original-byte
  fallback; final source equality and temporary-test removal are recorded.
- Apply reports distinguish `applied`, `rejected`, `failed`, `rolled-back` and
  `rollback-failed`, and are written as `method-extraction-apply.json|md`.
- Integration tests prove successful persistence, zero-mutation rejection and
  exact rollback after a post-apply failure.
- Full suite passes 224/224 on 2026-07-19. One earlier full run had an unrelated UI
  job timeout; the focused retry and complete rerun both passed.
- Package smoke passes with 198 packed files; golden-path smoke passes 4/4 fixtures
  in run `golden-2026-07-19T14-22-06-231Z-610e16f9`.

### MG-180G: Layered Call-Chain Execution

Execute a planned call graph incrementally after single-extraction safety is proven.

Implementation status (2026-07-19): implemented locally.

- `method-extraction chain plan` creates an immutable, hash-bound execution ledger
  and prepares only the deepest pending layer.
- `method-extraction chain status` validates the ledger and reports the current
  reviewed boundary without changing source.
- `method-extraction chain next --confirm <patch-hash>` applies exactly one ready
  layer, runs its post-apply checks and prepares the next layer only after success.
- Every layer is replanned against current source and owns independent A-F artifacts;
  applied-source drift, ledger tampering and incorrect confirmation are rejected.
- Focused integration coverage passes 3/3: three-layer deepest-to-root success,
  middle-layer rollback with completed-child preservation, and tamper/drift handling.
- Full suite completed 226/227 on 2026-07-19; the sole failure was a transient Windows
  `EPERM` rename in the existing UI job test, whose immediate focused retry passed 1/1.
- Package smoke passes with 200 packed files and golden-path smoke passes 4/4 fixtures
  in run `golden-2026-07-19T14-45-33-295Z-98ed82d8`.

Acceptance:

- Default order is deepest selected callee to root caller so each parent is planned
  against the latest verified child source; the chosen order is recorded.
- Exactly one layer is mutated per transaction and each layer gets its own baseline,
  proposal, verification, checkpoint and compare evidence.
- The next layer cannot start until the current layer passes post-apply verification.
- Failure stops the chain, rolls back only the failing transaction and preserves
  evidence for previously completed layers.
- Resume validates all source and artifact hashes before continuing.
- `call-depth=6` remains a hard maximum and the node budget remains enforced.

## Required Artifacts

- `method-extraction-eligibility.json|md`
- `method-extraction-contract.json|md`
- `method-extraction-patch.diff`
- `method-extraction-test-plan.json|md`
- `method-extraction-verification.json|md`
- `method-extraction-execution-ledger.json|md`

## End-to-End Acceptance

- A supported TypeScript fixture is extracted, temporarily verified, explicitly
  applied and post-apply verified with unchanged observable behavior.
- Compile failure, test failure, behavior drift and source drift each prevent apply.
- A forced post-apply failure restores the exact checkpointed source tree.
- A three-layer fixture executes in dependency order and stops before the next
  layer when the middle extraction fails.
- Unsupported syntax produces actionable findings and no patch.
- Package and installed CLI smoke prove the workflow outside the source checkout.

## Delivery Order

1. MG-180A and MG-180B establish a read-only eligibility gate.
2. MG-180C generates patches but keeps apply unavailable.
3. MG-180D and MG-180E establish contract and temporary verification evidence.
4. MG-180F enables explicit single-method apply with rollback.
5. MG-180G enables bounded multi-layer execution.

Each item lands with focused unit tests and at least one filesystem integration
test. MG-180F and MG-180G require full suite, package smoke and golden-path evidence.

## Definition of Done

MG-180 is complete only when the end-to-end acceptance passes and the existing
structural probe is no longer presented as proof that an extraction is usable.
Remote issue creation, source mutation in external projects and release publication
remain separate reviewed operations.
