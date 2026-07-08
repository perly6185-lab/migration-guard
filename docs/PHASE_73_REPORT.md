# Phase 73: AI Repair Loop Practical Acceptance

生成日期：2026-07-08

## 1. 阶段目标

Phase 73 把 AI repair loop 从 API/unit coverage 推进到 CLI practical acceptance。目标是证明 operator 可以从一个可控失败 proposal 出发，沿着 CLI 完成 replan、retry、修复 retry patch、checked verify 和 repair acceptance。

## 2. 新增测试

- 新增 `src/core/repairLoopCli.test.ts`
- `npm test` 纳入该 CLI smoke

测试使用临时 git target 和最小 run artifact，制造一个会失败的 generated-script proposal，然后通过 `dist/cli.js` 执行真实命令链：

```bash
node dist/cli.js proposal batch apply --run <run-id> --limit 1 --json
node dist/cli.js proposal replan --run <run-id> --proposal patch-cli-fail --json
node dist/cli.js proposal retry --run <run-id> --proposal patch-cli-fail --json
node dist/cli.js proposal verify --run <run-id> --proposal <retry-id> --checks --json
node dist/cli.js proposal accept --run <run-id> --proposal <retry-id> --notes "cli smoke acceptance" --json
node dist/cli.js report --run <run-id>
```

## 3. Acceptance Coverage

The CLI smoke verifies:

- failed batch returns a failed batch report with `command-failed`
- `proposal replan` writes replan brief and context
- replan context includes latest failed stderr and acceptance checklist
- `proposal retry` creates a retry proposal linked to the source proposal
- retry proposal inherits source failure category
- retry scaffold can be replaced by a focused passing patch
- `proposal verify --checks` passes on the repaired retry proposal
- `proposal accept` writes an accepted repair report
- run report shows `Recent Repair Acceptances` and `repair:accepted`

## 4. Verification

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Current results:

- `npm test`: 42 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed
- target md repo: `## main...origin/main`

## 5. Exit Criteria

- Controlled failed proposal can be created and batch-applied through CLI: passed
- CLI replan produces repair brief/context: passed
- CLI retry creates source-linked retry proposal: passed
- Repaired retry proposal can pass checked verification: passed
- CLI accept writes repair acceptance artifact: passed
- Run report surfaces repair acceptance evidence: passed
