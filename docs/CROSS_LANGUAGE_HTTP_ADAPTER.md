# Cross-Language HTTP Adapter

`cross-language-http` is the first behavior-first adapter for cross-language migration work.

It does not translate code automatically. It inventories source and target projects, detects HTTP route candidates, prepares contract replay evidence, and creates guarded migration slices that an AI or human executor can implement one at a time.

## Capability levels

- CL1: inventory source and target languages, framework signals, route candidates, and recommended checks.
- CL2: create a language-pair recipe that maps route translation risks and required review points.
- CL3: create a contract corpus draft with request templates for capture and dual-run replay.
- CL4: create proposal-ready migration actions that stay behind patch review and target checks.
- CL5: create a readiness report with verification gates, local issue candidates, and next commands for proposal and issue sync.

## Current scope

- Detect primary language signals for TypeScript/Node, Python, Java, and Go projects.
- Detect common HTTP framework signals:
  - TypeScript/Node: Express, Koa, Fastify, NestJS, Hono
  - Python: FastAPI, Flask, Django
  - Java: Spring controller annotations
  - Go: net/http, Gin, Chi, Fiber
- Extract route candidates from common route declarations.
- Compare source and target route surfaces by `METHOD path`.
- Generate:
  - `cross-language-http-inventory.json|md`
  - `cross-language-http-recipe-plan.json|md`
  - `cross-language-http-contract-plan.json|md`
  - `cross-language-http-contract-corpus-draft.json|md`
  - `cross-language-http-slice-plan.json|md`
  - `cross-language-http-action-plan.json|md`
  - `cross-language-http-readiness-report.json|md`

## Run shape

```sh
migration-guard run \
  --source ./legacy-service \
  --target ./new-service \
  --goal "Port legacy API into new service" \
  --adapter cross-language-http \
  --dry-run
```

The generated task graph adds:

- `task-cross-language-inventory`
- `task-cross-language-recipes`
- `task-cross-language-contracts`
- `task-cross-language-corpus`
- `task-cross-language-slices`
- `task-cross-language-actions`
- `task-cross-language-readiness`

The target verification task depends on the CL5 readiness report, so the lane stays behavior-first and issue-aware.

## CL5 gates

The readiness report separates generated evidence from runtime gates:

- target checks come from the target inventory and are safe for proposal verification;
- source capture and dual-run require running services and explicit base URLs;
- follow-up issues are created locally first and can be exported with `sync-issues --dry-run` before any live provider mutation.

## Next implementation layer

The next adapter layer should turn recipe hints into pair-specific source edit proposals, for example:

- `express-to-fastapi`
- `spring-to-fastapi`
- `spring-to-nestjs`
- `flask-to-express`

Each recipe should map route handlers, request/response DTOs, validation, error handling, and startup commands into small migration slices. Code generation should remain behind contract replay and normal verification gates.
