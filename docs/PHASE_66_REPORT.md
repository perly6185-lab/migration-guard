# Phase 66: AI Repair Acceptance Automation

生成日期：2026-07-08

## 1. 阶段目标

Phase 66 把 Phase 62 的 AI repair acceptance checklist 从 brief 文本推进为可记录的验收 artifact。目标是：AI/human 修完 retry proposal 后，不只口头说明“修好了”，而是由 Migration Guard 写出 source failure -> retry verification -> checklist acceptance 的证据。

## 2. 新增能力

新增命令：

```bash
node dist/cli.js proposal accept --run latest --proposal <retry-proposal-id>
node dist/cli.js proposal accept --run latest --proposal <retry-proposal-id> --notes "verified repair"
node dist/cli.js proposal accept --run latest --proposal <retry-proposal-id> --json
```

Acceptance guardrails:

- 只能接受 retry proposal。
- retry proposal 必须有 latest verification report。
- latest retry verification 必须 passed。
- latest retry verification 必须至少跑过一个 check，避免空 verification 被误当作修复验收。

Acceptance report 写入：

```text
replans/<source-proposal-id>/acceptance/repair-acceptance-*.json
```

Report 内容包括：

- source proposal id
- retry proposal id
- source verification path
- retry verification path
- replan brief/context path
- checklist item status
- notes
- accepted flag

## 3. Report / UX

- `proposal status` 显示 `Last acceptance`。
- run report 新增 `Recent Repair Acceptances` section。
- Evidence Graph 增加 repair acceptance line。
- Proposal compact summary 显示 `repair:accepted` / acceptance path。
- artifact migration scanner 支持 `proposal-repair-acceptance`。

## 4. Verification

```bash
npm test
git diff --check
node dist/cli.js --help
```

Current results:

- `npm test`: 38 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed
- CLI help includes `proposal accept`

新增测试覆盖：

- retry proposal verified with a real command check before acceptance
- `proposal accept` writes acceptance report
- source/retry proposal record `lastAcceptancePath`
- run report includes `Recent Repair Acceptances`
- run report compact proposal summary includes `repair:accepted`

## 5. Exit Criteria

- AI repair checklist can become a structured acceptance artifact: passed
- Acceptance requires checked retry verification: passed
- Acceptance is linked to source failure and retry proposal: passed
- Report surfaces acceptance evidence without opening artifact JSON: passed
- Artifact migration recognizes acceptance reports: passed
