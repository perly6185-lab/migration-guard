# Core Module Boundaries

## Dependency Direction

```text
cli.ts
  -> cliDispatch.ts (command registry contract)
  -> orchestration services
       -> issueControl.ts
            -> issueControlModel.ts (metadata parsing and plan selection)
       -> patch.ts
            -> patchModel.ts (portable path and patch construction)
       -> artifact/file adapters
```

Dependencies point from dispatch and orchestration toward pure models. Pure models do not read configuration, execute commands, mutate Git, or write artifacts.

## Responsibilities

| Module | Owns | Must not own |
| --- | --- | --- |
| `cliDispatch.ts` | Command-to-handler lookup | CLI parsing, output rendering, business logic |
| `issueControlModel.ts` | Remote metadata parsing and deterministic plan routing | GitHub requests, execution, artifact writes |
| `issueControl.ts` | Pull, supervision, recovery and artifact orchestration | New parsing/selection rules that can be pure |
| `patchModel.ts` | Portable patch paths and deterministic patch text | Filesystem writes, checks, rollback |
| `patch.ts` | Proposal lifecycle, checks, batch execution and artifacts | New deterministic patch primitives |

## Test Layers

- Unit: deterministic module behavior with no cross-process workflow.
- Integration: filesystem, Git, child process or multi-module workflow behavior.
- Smoke: installed package and operator UI workflows, run through explicit scripts.
- Pilot: behavior evidence against configured real projects, required by the release gate.

`scripts/ci/test-manifest.json` prevents accidental loss of discovered test files or test cases. New compiled `*.test.js` files enter `npm test` automatically.
