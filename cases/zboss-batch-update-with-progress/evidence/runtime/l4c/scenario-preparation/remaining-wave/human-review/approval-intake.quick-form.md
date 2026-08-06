# SH-3C remaining-wave approval quick form

You do not need to edit the large JSON by hand. Provide only the real values
below; the approval intake JSON will keep all existing hashes and scenario
paths unchanged.

## 1. Reviewer

- Reviewer identity:
- Review ticket:
- Confirmation time:
- Notes:

## 2. Disposable-write authorization

- Approver:
- Authorization ticket:
- Approved at:
- Expires at:

The expiry must be in the future and no more than 24 hours after approval.

## 3. Resource scope

- Database host:
- Database name:
- Approved table names:
- Marker field:
- Marker prefix:
- Max rows per scenario:
- Redis status: approved / not-applicable
- Redis endpoint:
- Redis key prefixes:
- Redis key types:
- Redis not-applicable reason:
- WebSocket endpoint:
- WebSocket subscription scope:
- WebSocket terminal statuses:
- WebSocket no-event window ms:

## 4. Fault endpoints

Provide source and target control URLs for these four scenarios. The approved
host list must contain the hostname from each URL.

| Scenario | Source control URL | Source approved hosts | Target control URL | Target approved hosts |
|---|---|---|---|---|
| post-commit-effect-failure |  |  |  |  |
| schema-transition-failure |  |  |  |  |
| transaction-failure |  |  |  |  |
| undo-excludes-failed-rows |  |  |  |  |

## 5. Semantic approval

Confirm one of the following:

- Approved: all 14 scenarios have reviewed Java Seed, Rust Seed, events/mysql/redis collectors, binding and resource scope.
- Not approved yet: list the scenario IDs or components that still need review.
