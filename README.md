# Migration Guard

Migration Guard is a behavior-consistency guardrail CLI for important refactoring
and migration projects.

It does not rewrite code in the first version. It helps you prove that behavior
stayed consistent by capturing a baseline, running repeatable checks and probes,
and comparing later runs against that baseline.

The long-term product direction is larger: Migration Guard should become an AI
autonomous migration runner for large repositories. Users submit a source
project, target project and migration goal; the tool then analyzes, estimates,
plans, executes, verifies, checkpoints, replans and reports until the migration
converges. The current CLI is the safety core for that future system.

## Core idea

Every migration step should answer:

- What behavior was protected before the change?
- What checks and probes were run after the change?
- Which outputs changed?
- Are the differences expected or risky?

## Commands

```bash
npm install
npm run build
node dist/cli.js init --target ../your-project
node dist/cli.js scan
node dist/cli.js baseline
node dist/cli.js verify
node dist/cli.js compare
node dist/cli.js plan
node dist/cli.js ai-brief
```

After `init`, edit `.migration-guard.json` to add behavior probes that represent
your critical paths.

## Probe types

Command probe:

```json
{
  "type": "command",
  "name": "pricing-rules",
  "command": "node scripts/print-pricing-cases.js",
  "normalize": {
    "stripAnsi": true,
    "trimWhitespace": true,
    "json": {
      "sortKeys": true,
      "ignoreFields": ["generatedAt"]
    }
  }
}
```

HTTP probe:

```json
{
  "type": "http",
  "name": "health-api",
  "url": "http://localhost:3000/api/health",
  "method": "GET",
  "normalize": {
    "trimWhitespace": true,
    "json": {
      "sortKeys": true
    }
  }
}
```

## Suggested workflow

1. Run `baseline` before touching code.
2. Make one small migration change.
3. Run `verify` after the change.
4. Inspect the generated compare report.
5. Record intentional differences explicitly before continuing.

The goal is not to make change impossible. The goal is to make behavior drift
visible as soon as it appears.

## AI-assisted migration

The migration process can include AI, but AI should work inside the same
verification loop:

1. Run `baseline` before risky changes.
2. Run `ai-brief` to generate a context pack for the AI assistant.
3. Ask the AI to make one small scoped change.
4. Run `verify` immediately after the change.
5. Review the compare report before continuing.

`ai-brief` is intentionally offline and provider-neutral. It does not call an AI
API by itself. It packages the project signals, high-risk files, configured
checks, behavior probes, latest baseline, latest run, and operating rules into a
Markdown file that can be given to Codex, Claude, OpenAI models, local models, or
human reviewers.

The intended responsibility split is:

- AI proposes and implements small migration steps.
- Migration Guard proves whether protected behavior stayed consistent.
- Humans approve intentional behavior changes and update probes/tests.

## Product design

See [docs/PRODUCT_DESIGN.md](docs/PRODUCT_DESIGN.md) for the planned evolution
from the current verification CLI into a full autonomous migration system with
dynamic task graphs, checkpoints, issue-based control, evidence logs and
continuous replanning.
