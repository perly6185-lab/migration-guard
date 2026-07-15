# Phase 167 Report: Portable AI Handoff Contract v1

## Outcome

Migration Guard now produces a provider-neutral bounded-task package that a human,
Codex, or another external agent can consume without scanning the complete repository.
Existing replan briefs and one-shot artifacts remain readable and are referenced rather
than replaced.

## Contract

- Versioned `migration-guard.ai-handoff` schema with a stable contract hash.
- Goal, task identity, allowed paths, forbidden actions, verification commands,
  acceptance criteria, changed-file/command budgets, and run/task/proposal lineage.
- Explicit `read-only`, `target-edit`, `github-mutation`, and `release-mutation`
  permissions. Generated handoffs deny remote and release mutations by default.
- Evidence references use root-relative paths and SHA-256 hashes; large artifacts are
  not copied into the handoff.
- JSON, Markdown and compact prompt renderings are written together.

## Commands

```text
migration-guard handoff create --run latest --task <id>
migration-guard handoff create --run latest --proposal <id>
migration-guard handoff create --run latest --one-shot
migration-guard handoff validate --input <handoff.json>
migration-guard handoff explain --input <handoff.json>
migration-guard handoff redact --input <handoff.json> --output <path>
```

## Safety

- Exactly one task source is accepted per package.
- Absolute, traversing, or over-budget allowed paths are rejected.
- Validation detects contract or referenced-evidence tampering.
- Redaction removes common Authorization, bearer token, API key and password forms,
  then recalculates the contract hash.
- Handoff creation never runs an agent, edits business files, or performs remote
  mutations.

## Validation

- Portable three-rendering write and read path.
- Evidence hash verification and tamper rejection.
- Unsafe path rejection, permission explanation and secret redaction.
- Test discovery floor raised to 152 tests.
