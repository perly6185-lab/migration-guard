# Issue: Method-Level Refactor

Status: implemented as the `method-refactor` adapter.

## Problem

Project-level and adapter-level refactors are too broad when the desired change is scoped to one function or class method.

## Goal

Support a method-level lane that can:

- identify one requested method or function symbol;
- report its file, line range, signature, and language;
- estimate call-site impact;
- create a method-level contract/action plan;
- generate a proposal-ready action without widening to the whole project.

## Command Shape

```sh
migration-guard run \
  --target ./service \
  --source ./service \
  --goal "method symbol=UserService.createUser: split validation without behavior drift" \
  --adapter method-refactor \
  --auto
```

Then continue through the existing proposal flow:

```sh
migration-guard actions --run latest
migration-guard action propose --run latest --action method-action-userservice-createuser
migration-guard proposal verify --run latest --proposal <proposal-id> --checks
```

## Acceptance

- The run writes `method-refactor-inventory.json|md`.
- The run writes `method-refactor-plan.json|md`.
- The run writes `method-refactor-action-plan.json|md`.
- The action plan contains one bounded method action.
- The proposal template is method-specific.
- No target source file is changed unless a proposal is explicitly applied.
