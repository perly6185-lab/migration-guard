# Cross-Language HTTP Adapter

`cross-language-http` is the first behavior-first adapter for cross-language migration work.

It does not translate code automatically. It inventories source and target projects, detects HTTP route candidates, prepares contract replay evidence, and creates guarded migration slices that an AI or human executor can implement one at a time.

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
  - `cross-language-http-contract-plan.json|md`
  - `cross-language-http-slice-plan.json|md`

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
- `task-cross-language-contracts`
- `task-cross-language-slices`

The target verification task depends on the slice plan, so the lane stays behavior-first.

## Next implementation layer

The next adapter layer should add language-pair recipes, for example:

- `express-to-fastapi`
- `spring-to-fastapi`
- `spring-to-nestjs`
- `flask-to-express`

Each recipe should map route handlers, request/response DTOs, validation, error handling, and startup commands into small migration slices. Code generation should remain behind contract replay and normal verification gates.
