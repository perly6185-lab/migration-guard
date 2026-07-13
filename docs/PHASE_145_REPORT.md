# Phase 145 Report: Real-Project Pilot Validation

## Summary

Validated Migration Guard against two existing projects with different stacks without modifying their source trees.

## Pilot A: ascllcreator

- Stack: pnpm workspace, TypeScript/React desktop application, Rust/Tauri files.
- Scan: 60 files, 10,282 lines, 6 source files detected.
- Baseline checks: shared typecheck passed, shared build failed, desktop build passed.
- Existing failure: shared package invokes `tsup` without input files.
- Verify preserved the same check states.
- Compare passed with one non-blocking stdout-change warning.
- Baseline duration: about 30 seconds; verify duration: about 21 seconds.

## Pilot B: cursormade

- Stack: VS Code extension, TypeScript, Webpack and Jest.
- Baseline checks: typecheck passed, test failed, build passed.
- Existing failure: Jest configuration/types prevent the test suite from compiling.
- Verify preserved the same check states.
- Compare passed with one non-blocking build stdout-change warning.
- Baseline duration: about 90 seconds; verify duration: about 14 seconds.

## Findings

- Existing target failures can be captured as a stable baseline without being misreported as new regressions.
- Build stdout remains a useful warning but needs project-specific normalization to reduce noise.
- Scan risk ranking highlights source files without nearby tests, but monorepo source-file classification should be improved.
- Pilot configurations are preserved under `pilots/` for repeatable local validation.

## Validation

- `npm run pilot:smoke`
- Both baseline and verify commands exited successfully.
- Both compare reports passed.
- No target source files were edited by Migration Guard.
