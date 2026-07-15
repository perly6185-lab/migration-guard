# Phase 168 Report: AI Result Return and Acceptance

## Outcome

External agents can return a provider-neutral result manifest and Git patch without
being embedded in Migration Guard's state machine. Import uses a dry-run plan followed
by explicit hash-confirmed apply.

## Result Manifest

- Versioned `migration-guard.ai-result` v1 schema.
- Original handoff id, contract hash and path.
- Patch path and SHA-256, changed-file declaration, claimed commands and status.
- `completed`, `partial`, or `failed` declaration plus provider/model/session metadata.

## Import Guard

- Revalidates the handoff schema, evidence hashes, contract lineage and selected run.
- Requires `target-edit`; remote/release permissions do not grant local patch scope.
- Parses actual `diff --git` paths and compares them with agent-declared files.
- Rejects renames, traversal, out-of-scope files, artifact/Git/secret paths, path-budget
  overflow, command-budget overflow, patch tampering, dirty targets and stale patches.
- Treats agent-reported test passes as warnings, never local verification evidence.
- `partial` and `failed` results remain rejected and route back to a bounded repair
  handoff command tied to the original task when available.

## Apply And Audit

- Dry-run writes JSON and Markdown import plans with a stable plan hash.
- Apply recomputes the full plan and requires `--apply-confirm <plan-hash>`.
- A recovery checkpoint is created before `git apply`.
- Applied JSON/Markdown and run evidence retain handoff/result/patch lineage.
- Reimporting an already applied result is idempotent.
- The sole next action after apply is local `migration-guard verify`.

## Validation

- Real Git fixture covers no-mutation planning, confirmation mismatch, checkpointed
  apply, output content and idempotent reimport.
- A second fixture proves patch hash tampering and out-of-scope paths fail before
  mutation.
- Test discovery floor raised to 154 tests.
