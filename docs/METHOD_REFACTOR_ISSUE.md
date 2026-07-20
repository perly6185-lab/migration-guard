# Issue: Method-Level Refactor

Status: implemented as the `method-refactor` adapter.

Execution follow-up: [MG-180](METHOD_REFACTOR_EXECUTION_ISSUE.md) implements guarded
AST-based method extraction, contract verification, atomic apply and layered
call-chain execution. Persistent changes remain explicit reviewed operations: each
layer must pass verification and receive its exact patch-hash confirmation.

## Problem

Project-level and adapter-level refactors are too broad when the desired change is scoped to one function or class method.

## Goal

Support a method-level lane that can:

- identify one requested method or function symbol;
- report its file, line range, signature, and language;
- estimate call-site impact;
- optionally expand local downstream call chains up to six layers;
- create a method-level contract/action plan;
- generate a proposal-ready action without widening to the whole project.

## Command Shape

```sh
migration-guard run \
  --target ./service \
  --source ./service \
  --goal "method symbol=UserService.createUser call-depth=6: split validation without behavior drift" \
  --adapter method-refactor \
  --auto
```

Then continue through the existing proposal flow:

```sh
migration-guard actions --run latest
migration-guard action propose --run latest --action method-action-userservice-createuser
migration-guard proposal verify --run latest --proposal <proposal-id> --checks
```

For an AST extraction goal that has completed eligibility, contract, patch, test
and temporary verification, persistent apply remains an explicit reviewed step:

```sh
migration-guard method-extraction status --run latest
migration-guard method-extraction apply --run latest --confirm <patch-hash>
```

For a bounded multi-layer goal, declare each extraction and execute the immutable
plan one verified layer at a time. The engine orders the selected layers from the
deepest callee back to the root caller and replans after every successful apply:

```text
method symbol=entry call-depth=2
extract-layer=entry@3-3@entryCore
extract-layer=level1@3-3@level1Core
extract-layer=level2@2-2@level2Core
```

```sh
migration-guard method-extraction chain plan --run latest
migration-guard method-extraction chain status --run latest
migration-guard method-extraction chain next --run latest --confirm <patch-hash>
```

Repeat `status` and `next` with the newly prepared layer's patch hash. A failed layer
is rolled back and stops the chain; previously verified layers remain applied.

## Acceptance

- The run writes `method-refactor-inventory.json|md`.
- The run writes `method-refactor-plan.json|md`.
- The run writes `method-refactor-action-plan.json|md`.
- The action plan contains bounded method actions for the selected symbol and
  any resolved downstream calls within `call-depth`.
- The proposal template is method-specific.
- No target source file is changed unless a proposal is explicitly applied.

## Call Depth

- Default depth is `0`, which preserves the original single-method behavior.
- `call-depth=1` includes direct local calls from the selected method.
- `call-depth=6` includes up to six downstream layers.
- Calls that cannot be resolved to a unique local method/function are reported
  as unresolved instead of being silently included.
