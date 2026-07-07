# Migration Guard 独立可运行开发阶段

本文档定义工程实施路线。它不替代 `PRODUCT_DESIGN.md` 的产品路线，而是把长期路线拆成可以逐步交付、逐步运行、逐步验证的开发阶段。

核心原则：

- 每个阶段都必须能 `npm run build`。
- 每个阶段都必须有至少一条可复制的 CLI happy path。
- 每个阶段都必须产出可检查 artifact。
- 每个阶段结束时，工具都应是一个可独立使用的产品切片。
- 不合入只有内部重构、没有用户可运行入口的阶段。
- 每个阶段发布时必须保留所有前置阶段的可运行能力；阶段命令是新增能力的 smoke path，而不是替代前置命令。

## 阶段总览

| 阶段 | 可运行形态 | 独立价值 |
| --- | --- | --- |
| Phase 0 | CLI bootstrap | 工具可安装、可构建、可显示帮助 |
| Phase 1 | Safety Core | 能采集基线、验证迁移后行为、对比差异 |
| Phase 2 | Planning + AI Brief | 能生成迁移计划和 AI 上下文包 |
| Phase 3 | Migration Run + Local Issues | 能把一次迁移作为长任务跟踪 |
| Phase 4 | Dynamic Task Graph Dry Run | 能生成结构化任务图并模拟调度 |
| Phase 5 | Checkpoint + Resume + Rollback | 能暂停、恢复、回退迁移运行 |
| Phase 6 | Verified Execution Loop | 能执行任务、验证、失败后重规划 |
| Phase 7 | First Same-Ecosystem Auto Adapter | 能自动完成一个高确定性迁移场景 |
| Phase 8 | Full Auto Large-Repo Orchestrator | 能长时间自治迁移大仓库 |
| Phase 9 | Team + CI + External Issues | 能接入团队协作和 CI 门禁 |
| Phase 10 | Cross-Language Behavior Replay | 能支持跨语言行为复刻迁移 |
| Phase 11 | Real-World Target Validation | 能在真实外部仓库上打穿 baseline/verify/report |
| Phase 12 | Assisted Migration Workflow | 能把真实仓库风险转成 action plan、issue dry-run 和 preview probe |
| Phase 13 | Executable Action Proposals | 能把 action plan 转成真实可应用的小步 probe patch |
| Phase 14 | Probe Patch Apply + Verification Gate | 能 apply proposal 并自动执行推荐检查、写入 evidence |
| Phase 15 | Proposal Lifecycle + Rollback | 能跟踪 proposal 状态、手动/自动回滚并汇总到 run report |
| Phase 16 | Playwright UI Probe Adapter | 能为 UI action 生成浏览器优先、HTTP fallback 的 smoke probe |
| Phase 17 | Managed Preview Server for UI Gates | 能在 apply 时自动启动、等待、使用并停止 UI preview server |
| Phase 18 | Proposal Check Classification | 能把 recommended checks 结构化为 kind/phase/timeout 的 check plan |
| Phase 19 | Proposal Gate Timeline | 能在 verification report 和 run report 中展示 gate 执行时间线 |
| Phase 20 | Failed Gate Replan Issues | 能把失败的 proposal gate 自动转成 replan/failure issue |
| Phase 21 | Adaptive Gate Policy + Flake Handling | 能对疑似环境抖动重试、按策略执行 gate，并批量推进低风险 proposal |
| Phase 22 | Gate Remediation Hints + Batch Stop Reporting | 能把 gate 失败转成修复建议，并解释 batch 为什么停止和跳过 |
| Phase 23 | Configurable Gate Policy + Batch Summary | 能用项目配置控制 gate policy/retry，并在 run report 汇总 batch |
| Phase 24 | External Issue Gate Context + CI Handoff | 能把 gate/batch 失败上下文导出给 issue sync 和 CI |
| Phase 25 | Provider Adapter + PR Comment Preview | 能生成 GitHub PR comment preview、provider mapping 和 CI summary |
| Phase 26 | GitHub Live Adapter Boundary + API Mock | 能用显式 live 开关和 mock API 验证 GitHub issue 创建边界 |

## Phase 0: CLI Bootstrap

目标：建立最小可运行 CLI。

新增能力：

- TypeScript 项目骨架
- CLI 入口
- help 输出
- 默认配置生成
- 基础测试框架

可运行命令：

```bash
npm install
npm run build
node dist/cli.js --help
node dist/cli.js init --target .
```

产物：

- `dist/`
- `.migration-guard.json`

完成标准：

- CLI 能在 Windows/macOS/Linux 上启动。
- `init` 不依赖目标项目技术栈。
- 没有目标项目时也能输出明确错误。

## Phase 1: Safety Core

目标：形成行为一致性验证闭环。

新增能力：

- scan
- baseline
- verify
- compare
- command probe
- HTTP probe
- normalize
- Markdown/JSON compare report

可运行命令：

```bash
node dist/cli.js scan
node dist/cli.js baseline
node dist/cli.js verify
node dist/cli.js compare
```

产物：

- `.migration-guard/scan/*.json`
- `.migration-guard/baselines/*.json`
- `.migration-guard/runs/*.json`
- `.migration-guard/compare/*.json`
- `.migration-guard/compare/*.md`

完成标准：

- critical check 从 passed 变为 failed 时，`verify` 返回非 0。
- probe normalized output 变化时，compare report 标记 error。
- 没有 AI、没有自动改写时，工具已经能独立保护迁移行为。

## Phase 2: Planning + AI Brief

目标：让工具能辅助人类或 AI 安全规划下一步。

新增能力：

- 风险文件摘要
- 迁移阶段建议
- 验证优先级建议
- AI 上下文包
- latest baseline/run/compare 摘要

可运行命令：

```bash
node dist/cli.js plan
node dist/cli.js ai-brief
```

产物：

- `.migration-guard/migration-plan.md`
- `.migration-guard/ai/brief-*.md`

完成标准：

- AI brief 能独立说明当前项目、风险、检查项、探针和下一步建议。
- plan 输出能指导一个小步迁移动作。
- 这一阶段仍不自动改源码。

## Phase 3: Migration Run + Local Issues

目标：把一次迁移升级为可跟踪的长任务。

新增能力：

- `MigrationRun`
- 本地 issue store
- run status
- evidence log
- estimate report
- status/report 命令

建议命令：

```bash
migration-guard run --source . --target . --goal "Webpack to Vite" --init-only
migration-guard status --run latest
migration-guard issues --run latest
migration-guard report --run latest
```

产物：

- `.migration-guard/migration-runs/run-*/run.json`
- `.migration-guard/migration-runs/run-*/estimate.json`
- `.migration-guard/migration-runs/run-*/issues.json`
- `.migration-guard/migration-runs/run-*/evidence.jsonl`
- `.migration-guard/migration-runs/run-*/reports/*.md`

完成标准：

- 不执行代码改写，也能创建完整迁移运行。
- 每个 issue 有状态、类型、风险、关联 run id。
- report 能汇总当前迁移目标、进度、风险和下一步。

## Phase 4: Dynamic Task Graph Dry Run

目标：引入动态任务图，但先以 dry run 方式交付。

新增能力：

- 结构化 task graph
- task dependency
- ready/running/done/blocked 状态
- replanning trigger 记录
- task-scoped AI brief
- graph validation

建议命令：

```bash
migration-guard run --source . --target . --goal "Webpack to Vite" --dry-run
migration-guard tasks --run latest
migration-guard ai-brief --run latest --task <task-id>
```

产物：

- `.migration-guard/migration-runs/run-*/task-graph.json`
- `.migration-guard/migration-runs/run-*/ai/task-*.md`

完成标准：

- task graph 可以被校验为无环。
- dry run 能选出下一批 ready tasks。
- 发现缺失验证时，可以插入新任务，但不改源码。

## Phase 5: Checkpoint + Resume + Rollback

目标：让长任务具备恢复能力。

新增能力：

- checkpoint create/list
- patch capture
- resume
- rollback
- interrupted run recovery
- checkpoint evidence

建议命令：

```bash
migration-guard checkpoint create --run latest
migration-guard checkpoint list --run latest
migration-guard resume --run latest
migration-guard rollback --run latest --checkpoint <checkpoint-id>
```

产物：

- `.migration-guard/migration-runs/run-*/checkpoints/*/metadata.json`
- `.migration-guard/migration-runs/run-*/checkpoints/*/patch.diff`
- `.migration-guard/migration-runs/run-*/checkpoints/*/verification.json`

完成标准：

- 中断后能从 latest run state 恢复。
- rollback 不影响 run 之外的 unrelated workspace changes。
- 每次 checkpoint 都能追溯对应 task 和验证结果。

## Phase 6: Verified Execution Loop

目标：形成执行、验证、失败处理、重规划的闭环。

新增能力：

- task executor interface
- manual executor
- shell/codemod executor
- post-task verification
- failure issue
- diff issue
- replan decision

建议命令：

```bash
migration-guard run --source . --target . --goal "Webpack to Vite" --execute manual
migration-guard task run --run latest --task <task-id>
migration-guard verify --run latest
```

产物：

- task execution records
- verification records
- failure issues
- diff issues
- updated task graph

完成标准：

- 每个 task 执行后必须进入 verification。
- 验证失败会自动生成 issue，并触发重规划。
- 即使没有 AI provider，也可以通过 manual/shell executor 独立运行。

## Phase 7: First Same-Ecosystem Auto Adapter

目标：先让一个高确定性迁移场景能端到端自动完成。

建议首选场景：

- Webpack -> Vite

新增能力：

- JS/TS 项目 adapter
- Vite migration rules
- package/script/config migration
- alias/env/plugin compatibility checks
- focused verification
- adapter-specific replanning

建议命令：

```bash
migration-guard run --source . --target . --goal "Webpack to Vite" --auto --adapter js-vite
```

产物：

- migrated target workspace
- adapter task graph
- checkpoint history
- final compare report
- final migration report

完成标准：

- 在样例 Webpack 项目上能自动迁移到 Vite。
- 迁移后 build/test/verify 通过。
- 失败时能定位到 adapter task，而不是只返回一段构建日志。

## Phase 8: Full Auto Large-Repo Orchestrator

目标：把单场景自动迁移扩展到大仓库长时间自治运行。

新增能力：

- long-running scheduler
- budget tracking
- dynamic estimate
- task batching
- automatic retry
- partial rollback
- large output summarization
- final quality gate

建议命令：

```bash
migration-guard run --source . --target . --goal "Webpack to Vite" --auto --resume
```

产物：

- complete migration run
- full evidence log
- final quality report
- unresolved risk list
- accepted diff list

完成标准：

- 工具可以长时间运行并持续更新状态。
- 新发现的问题能插入新任务，而不是停止在固定计划上。
- 最终完成条件基于验证和风险收敛，不只是 task list 为空。

## Phase 9: Team + CI + External Issues

目标：让迁移过程进入团队协作和 CI 门禁。

新增能力：

- GitHub/GitLab/Jira/Linear issue sync
- PR comment
- CI verify command
- baseline artifact upload/download
- intentional diff approval record
- reviewer handoff report

建议命令：

```bash
migration-guard sync-issues --run latest --provider github
migration-guard ci verify --baseline <baseline-artifact>
```

产物：

- external issue mapping
- PR compare comment
- CI verification report
- approval records

完成标准：

- 本地 issue 和外部 issue 可双向同步。
- CI 能阻断关键行为漂移。
- 团队成员不运行本地长任务，也能看懂迁移状态。

## Phase 10: Cross-Language Behavior Replay

目标：支持跨语言迁移，重点从代码改写转为行为复刻。

新增能力：

- behavior baseline extraction
- API contract capture
- data model mapping
- dual-run comparison
- contract test generation
- difference allowlist
- staged traffic cutover record

建议命令：

```bash
migration-guard contract capture --source <source-service-url>
migration-guard dual-run --source <source-service-url> --target <target-service-url>
migration-guard contract test --target <target-service-url>
```

产物：

- behavior baseline corpus
- contract tests
- dual-run diff report
- data mapping report
- accepted differences

完成标准：

- 不依赖语法翻译，也能验证目标系统是否复刻关键行为。
- 同一请求能打到 source 和 target 并生成差异报告。
- 预期差异必须进入 allowlist，否则保持风险状态。

## Phase 11: Real-World Target Validation

目标：在真实外部仓库上证明工具可运行，而不是只在 fixture 上通过。

新增能力：

- 外部 target 配置
- 真实项目 checks/probes
- 真实项目基线和验证报告
- 大仓库风险扫描报告

建议命令：

```bash
migration-guard baseline --config configs/md-fast.migration-guard.json
migration-guard verify --config configs/md-fast.migration-guard.json
```

产物：

- 外部 target baseline/run/compare artifacts
- 真实项目验证计划和报告

完成标准：

- 至少一个真实仓库 baseline/verify 通过。
- compare report 能解释行为是否变化。
- 目标仓库工作树保持干净。

## Phase 12: Assisted Migration Workflow

目标：从只验证行为，推进到能提出可审计的迁移动作。

新增能力：

- portable target harness
- check output normalization
- `pnpm-vite-vue` action planner
- issue sync dry-run
- dry-run patch proposal
- preview/HTTP smoke probe

建议命令：

```bash
migration-guard run --config configs/md-full.migration-guard.json --adapter pnpm-vite-vue --dry-run
migration-guard resume --config configs/md-full.migration-guard.json --run latest --auto
migration-guard sync-issues --config configs/md-full.migration-guard.json --run latest --provider github --dry-run
```

产物：

- action plan JSON
- provider-neutral issue export
- proposal artifacts
- preview probe JSON

完成标准：

- 真实仓库 run 能完成。
- action plan 能转成 issue。
- preview URL 能被探测为 ready。

## Phase 13: Executable Action Proposals

目标：把 Phase 12 产生的 action plan 转为真实、可检查、可应用的小步 patch proposal。

新增能力：

- `actions` CLI 查看 action plan
- `action propose` CLI 从 action 生成 proposal
- action proposal 生成真实 git patch
- probe patch 新增可运行脚本，而不是只记录占位文本
- patch 生成器单元测试使用 `git apply --check` 验证

建议命令：

```bash
migration-guard actions --run latest
migration-guard action propose --run latest --action action-renderer-probes
git apply --check <proposal.patch>
```

产物：

- `.migration-guard/migration-runs/run-*/proposals/patch-*/proposal.json`
- `.migration-guard/migration-runs/run-*/proposals/patch-*/patch.diff`
- 目标仓库内可新增的 `scripts/migration-guard/*.mjs` probe 脚本

完成标准：

- action plan 可以被 CLI 列出。
- action proposal patch 是合法 git patch。
- patch check 不修改目标仓库。
- 后续阶段可以在同一机制上扩展真实测试、Playwright 和 codemod patch。

## Phase 14: Probe Patch Apply + Verification Gate

目标：把 Phase 13 的可应用 proposal 接入验证门禁，形成“先检查、再应用、再跑推荐命令、最后写 evidence”的闭环。

新增能力：

- `proposal verify`
- `action apply`
- proposal verification report JSON
- apply 后自动执行 `recommendedChecks`
- proposal evidence event
- apply/check 失败时返回明确 artifact 路径

建议命令：

```bash
migration-guard proposal verify --run latest --proposal <proposal-id>
migration-guard action apply --run latest --proposal <proposal-id>
migration-guard action apply --run latest --proposal <proposal-id> --skip-checks
```

产物：

- `.migration-guard/migration-runs/run-*/proposals/patch-*/verification-*.json`
- `evidence.jsonl` 中的 `proposal` 事件
- proposal `applyState`

完成标准：

- `proposal verify` 能在不修改目标仓库时执行 `git apply --check`。
- `action apply` 能应用 patch，并默认执行 proposal 的推荐命令。
- recommended check 失败时，命令返回非 0，并保留 verification artifact。
- 真实外部仓库 smoke path 能证明 apply/check 通过，且收尾后目标仓库可恢复 clean。

## Phase 15: Proposal Lifecycle + Rollback

目标：让 proposal 具备完整生命周期和失败恢复能力，作为后续更大规模自动改写的安全兜底。

新增能力：

- proposal 状态扩展
- `proposal status`
- `proposal rollback`
- `action apply --rollback-on-fail`
- rollback report JSON
- run report proposal 汇总

建议命令：

```bash
migration-guard proposal status --run latest --proposal <proposal-id>
migration-guard proposal rollback --run latest --proposal <proposal-id>
migration-guard action apply --run latest --proposal <proposal-id> --rollback-on-fail
```

产物：

- `.migration-guard/migration-runs/run-*/proposals/patch-*/proposal.json`
- `.migration-guard/migration-runs/run-*/proposals/patch-*/verification-*.json`
- `.migration-guard/migration-runs/run-*/proposals/patch-*/rollback-*.json`
- run report 中的 proposal 状态汇总

完成标准：

- proposal 状态能从 `proposed` 流转到 `verified`、`applied`、`rolled-back`。
- verify 失败时能标记为 `verification-failed`。
- apply 后 checks 失败时能标记为 `applied-with-failed-checks`。
- `--rollback-on-fail` 能在 recommended checks 失败时自动反向应用 patch。
- `proposal rollback` 能手动恢复目标仓库。
- 真实外部仓库 smoke path 能跑通 propose、verify、apply、rollback、report，并保持目标仓库 clean。

## Phase 16: Playwright UI Probe Adapter

目标：把 `ui-smoke-probe` 从静态文件结构检查升级为可运行的 UI smoke probe。

新增能力：

- `ui-smoke-probe` 生成 Playwright-first probe script
- 未安装 Playwright 时自动 fallback 到 HTTP fetch smoke
- 支持 `MG_PREVIEW_URL`
- 支持 `MG_UI_PROBE_OUTPUT_DIR`
- UI probe report 默认写入系统临时目录，避免污染目标仓库
- proposal verification report 捕获 UI probe stdout/report path

建议命令：

```bash
migration-guard action propose --run latest --action action-large-vue-ui-probe
migration-guard proposal verify --run latest --proposal <proposal-id>
MG_PREVIEW_URL=http://127.0.0.1:5173/md/ migration-guard action apply --run latest --proposal <proposal-id>
migration-guard proposal rollback --run latest --proposal <proposal-id>
```

产物：

- `scripts/migration-guard/action-large-vue-ui-probe.mjs`
- proposal `verification-*.json`
- UI probe JSON report
- Playwright screenshot artifact when Playwright is installed

完成标准：

- UI action proposal 能生成可应用 patch。
- apply 后能执行 web test、web type-check 和 UI probe。
- 目标项目未安装 Playwright 时，fetch fallback 能验证 preview URL。
- rollback 后目标仓库保持 clean。
- UI probe 输出不默认写入目标仓库。

## Phase 17: Managed Preview Server for UI Gates

目标：把 UI action apply 里的 preview server 生命周期纳入工具托管，避免人工先启动 dev server。

新增能力：

- action/proposal 支持 `preview` 元数据
- UI action 自动推断常见 Vite preview command 和 preview URL
- `action apply` 在执行 recommended checks 前自动启动 preview server
- 普通 checks 先执行，preview server 只包裹依赖 UI preview 的 probe check
- 等待 preview URL ready 后给 UI probe 注入 `MG_PREVIEW_URL`
- preview ready 失败时写入 verification artifact 并阻断 gate
- checks 完成后自动停止 preview server
- preview stdout/stderr、ready URL、HTTP status、stop 状态写入 `preview-*.json` 和 verification report

建议命令：

```bash
migration-guard action propose --run latest --action action-large-vue-ui-probe
migration-guard action apply --run latest --proposal <proposal-id>
migration-guard proposal rollback --run latest --proposal <proposal-id>
```

产物：

- proposal `preview` 元数据
- `.migration-guard/migration-runs/run-*/proposals/patch-*/preview-*.json`
- proposal `verification-*.json` 中的 `preview`
- UI probe JSON report

完成标准：

- UI proposal 能声明或自动推断 preview command 和 URL。
- `action apply` 不需要人工启动 dev server，也能完成 UI probe。
- preview server 在 checks 完成后被停止。
- preview failure 会进入 verification report，而不是只表现为 probe 超时。
- 真实外部仓库 smoke path 能完成 propose、apply、rollback，并保持目标仓库 clean。

## Phase 18: Proposal Check Classification

目标：把字符串形式的 `recommendedChecks` 升级为结构化、可排序、可扩展的 proposal `checkPlan`。

新增能力：

- proposal 保留 legacy `recommendedChecks`
- proposal 新增 `checkPlan`
- check 分类：`unit-test`、`type-check`、`ui-probe`、`contract-probe`、`build`、`lint`、`other`
- check phase：`pre-preview`、`preview`、`post-preview`
- check-level timeout 和 critical 标记
- UI probe 自动归入 `ui-probe/preview`
- 普通 test/type-check 自动归入 `pre-preview`

建议命令：

```bash
migration-guard action propose --run latest --action action-large-vue-ui-probe
migration-guard proposal status --run latest --proposal <proposal-id>
```

产物：

- proposal `checkPlan`
- proposal status 中的 check plan 摘要

完成标准：

- 老 proposal 没有 `checkPlan` 时仍能运行。
- 新 action proposal 能自动生成结构化 `checkPlan`。
- UI probe check 能被识别为 preview phase。

## Phase 19: Proposal Gate Timeline

目标：让 proposal verification gate 的执行顺序、耗时和结果可审计。

新增能力：

- verification report 新增 `timeline`
- timeline 记录 patch check
- timeline 记录 regular checks
- timeline 记录 managed preview
- timeline 记录 preview checks
- run report 新增 Recent Proposal Gates 汇总

建议命令：

```bash
migration-guard action apply --run latest --proposal <proposal-id>
migration-guard report --run latest
```

产物：

- proposal `verification-*.json` 中的 `timeline`
- run report `Recent Proposal Gates`

完成标准：

- 用户无需阅读 stdout，也能知道 gate 先后顺序。
- timeline 能显示每个步骤 passed/failed/skipped。
- run report 能汇总最近 proposal gate 结果。

## Phase 20: Failed Gate Replan Issues

目标：让失败的 proposal gate 自动进入动态规划和 issue 管控层。

新增能力：

- apply gate 失败时创建 failure issue
- verification report 写入 `replanIssueId`
- evidence log 写入 `replan` 事件
- failure issue 记录 first failed check、check kind、check phase 和 report path

建议命令：

```bash
migration-guard action apply --run latest --proposal <proposal-id>
migration-guard issues --run latest
migration-guard report --run latest
```

产物：

- `issues.json` 中的 proposal failure issue
- `evidence.jsonl` 中的 `replan` 事件
- proposal `verification-*.json` 中的 `replanIssueId`

完成标准：

- gate 失败不是单次命令错误，而是可追踪 issue。
- 后续 replanner 能读取失败 check 的 kind/phase 决定插入什么补救任务。
- 成功 proposal 不创建额外 failure issue。

## Phase 21: Adaptive Gate Policy + Flake Handling

目标：让 proposal gate 能区分真实失败和疑似环境抖动，并支持更适合批量执行的 gate 策略。

新增能力：

- proposal `checkPlan` 支持 retry policy
- check result 记录 attempts、failure category 和 flake-suspected 标记
- check result 记录 resource profile
- gate policy 支持 `collect-all` 和 `fail-fast`
- `proposal replan` 可为已有失败 verification report 显式生成 replan task
- `proposal batch plan`
- `proposal batch apply`
- batch apply 默认使用 fail-fast 并在失败 proposal 后停止

建议命令：

```bash
migration-guard proposal verify --run latest --proposal <proposal-id> --checks --gate-policy collect-all
migration-guard proposal replan --run latest --proposal <proposal-id>
migration-guard proposal batch plan --run latest --limit 3
migration-guard proposal batch apply --run latest --limit 3 --gate-policy fail-fast
```

产物：

- proposal `verification-*.json` 中的 `gatePolicy`
- proposal check attempts
- proposal check failure category
- proposal `replanTaskId`
- `.migration-guard/migration-runs/run-*/proposal-batches/*/batch-plan.json`
- `.migration-guard/migration-runs/run-*/proposal-batches/*/proposal-batch-report-*.json`

完成标准：

- 疑似 flaky 的 unit/UI check 至少能按默认策略重试一次。
- `fail-fast` 能在第一个 critical check 失败后停止后续 checks。
- `collect-all` 能继续收集完整失败面。
- 失败 proposal 能生成可追踪 replan issue 和 replan task。
- batch apply 能按低风险优先顺序执行 proposal，并在失败时停止后续 proposal。

## Phase 22: Gate Remediation Hints + Batch Stop Reporting

目标：让失败的 proposal gate 不只记录“失败了”，还要说明“下一步该怎么处理”，并让 batch report 能解释停止和跳过原因。

新增能力：

- check failure 生成 remediation hints
- failure issue body 写入 hints
- replan task description 写入 hints
- run report Recent Proposal Gates 展示首个失败分类和第一条 hint
- batch report 记录 first failed check
- batch report 记录 skipped proposals
- batch report 记录 stop reason
- batch report 给出下一步 replan 命令

建议命令：

```bash
migration-guard proposal batch apply --run latest --limit 3 --gate-policy fail-fast
migration-guard proposal replan --run latest --proposal <failed-proposal-id>
migration-guard report --run latest
```

产物：

- proposal `verification-*.json` 中的 `checks[].remediationHints`
- `issues.json` 中 failure issue 的 hints
- `task-graph.json` 中 replan task 的 hints
- proposal batch report 中的 `stopReason`
- proposal batch report 中的 `skipped`
- proposal batch report 中的 `nextCommand`

完成标准：

- `command-failed`、`timeout`、`error`、`flake-suspected` 都能生成面向用户的下一步建议。
- proposal gate 失败创建的 issue/replan task 能展示 remediation hints。
- batch apply 失败后能记录首个失败 check、停止原因和跳过的 proposal。
- batch report 能给出下一条建议命令。
- 单元测试覆盖成功 batch 和失败 batch 两条路径。

## Phase 23: Configurable Gate Policy + Batch Summary

目标：把 proposal gate 的默认策略从代码常量升级为项目配置，并让 batch report/run report 对批量执行结果有完整摘要。

新增能力：

- `.migration-guard.json` 支持 `proposalGate.defaultPolicy`
- `.migration-guard.json` 支持 `proposalGate.batchPolicy`
- `.migration-guard.json` 支持按 check kind 配置 retry policy
- CLI `--gate-policy` 仍可覆盖配置默认值
- proposal checkPlan 未声明 retry 时使用配置默认 retry
- batch report 记录 `gatePolicy`
- batch report 记录 executed/skipped count
- batch report 记录 first failed proposal 和 verification path
- batch report 记录 recommended next actions
- run report 新增 `Recent Proposal Batches`

建议配置：

```json
{
  "proposalGate": {
    "defaultPolicy": "collect-all",
    "batchPolicy": "fail-fast",
    "retry": {
      "unit-test": {
        "maxAttempts": 2,
        "delayMs": 1000,
        "retryOn": ["flake-suspected"]
      },
      "ui-probe": {
        "maxAttempts": 2,
        "delayMs": 1000,
        "retryOn": ["flake-suspected", "timeout"]
      }
    }
  }
}
```

建议命令：

```bash
migration-guard proposal batch apply --run latest --limit 3
migration-guard proposal batch apply --run latest --limit 3 --gate-policy collect-all
migration-guard report --run latest
```

产物：

- proposal verification report 中的 config-resolved `gatePolicy`
- proposal check result 中的 config-resolved `retry`
- proposal batch report 中的 batch summary fields
- run report 中的 `Recent Proposal Batches`

完成标准：

- 配置默认 gate policy 能控制 proposal verify/apply。
- 配置 batch policy 能控制 batch apply。
- CLI gate policy 能覆盖配置。
- 配置 retry 能被没有显式 retry 的 checkPlan 使用。
- run report 能展示最近 batch 的通过状态、策略、执行数、跳过数和下一步命令。
- 单元测试覆盖配置 policy/retry 和 batch summary。

## Phase 24: External Issue Gate Context + CI Handoff

目标：把 proposal gate/batch 的失败上下文从本地 artifact 推送到团队协作和 CI handoff 层。

新增能力：

- issue sync export 读取 proposal verification reports
- issue sync export 读取 proposal batch reports
- provider-neutral issue JSON 写入 `migrationGuard.gate`
- provider-neutral issue JSON 写入 `migrationGuard.batch`
- issue body/Markdown export 展示 proposal gate context
- issue body/Markdown export 展示 proposal batch context
- run report batch section 展示 batch report path、first failed verification、skipped proposals 和 recommended actions
- `ci verify --run <id|latest>` 额外写出 CI handoff report

建议命令：

```bash
migration-guard sync-issues --run latest --provider local
migration-guard sync-issues --run latest --provider github --dry-run
migration-guard ci verify --baseline .migration-guard/latest-baseline.json --run latest
```

产物：

- `.migration-guard/migration-runs/run-*/issue-sync/local-issues.json`
- `.migration-guard/migration-runs/run-*/issue-sync/<provider>-dry-run-issues.json`
- `.migration-guard/migration-runs/run-*/issue-sync/<provider>-dry-run-issues.md`
- `.migration-guard/migration-runs/run-*/reports/ci-handoff.md`

完成标准：

- failure issue export 包含 failed proposal id、verification path、failure category 和 remediation hints。
- batch context 包含 stopReason、skipped proposals、nextCommand 和 recommended next actions。
- CI handoff report 能展示最近 failed gate/batch 和下一步命令。
- 真实 local sync smoke 通过，目标仓库保持 clean。

## Phase 25: Provider Adapter + PR Comment Preview

目标：在不调用真实外部 API 的前提下，把 provider-neutral issue context 转换成接近真实协作平台可用的预览 artifact。

新增能力：

- provider mapping artifact
- GitHub dry-run PR comment preview
- external provider non-dry-run safety guard
- CI GitHub step summary artifact
- issue export 记录 provider field mapping

建议命令：

```bash
migration-guard sync-issues --run latest --provider github --dry-run
migration-guard ci verify --baseline .migration-guard/latest-baseline.json --run latest
```

产物：

- `.migration-guard/migration-runs/run-*/issue-sync/github-dry-run-issues.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-dry-run-issues.md`
- `.migration-guard/migration-runs/run-*/issue-sync/github-dry-run-mapping.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-pr-comment.md`
- `.migration-guard/migration-runs/run-*/reports/github-step-summary.md`

完成标准：

- GitHub dry-run export 包含 PR comment preview。
- Provider mapping 明确 title/body/labels/status 字段映射。
- 非 local provider 不带 `--dry-run` 时不会尝试外部 API，并输出明确错误。
- CI handoff 同时写出普通 report 和 GitHub Actions summary style artifact。
- 真实 GitHub dry-run smoke 通过，目标仓库保持 clean。

## Phase 26: GitHub Live Adapter Boundary + API Mock

目标：把 GitHub provider 从 dry-run preview 推进到可测试的 live adapter 边界，但仍要求显式 live 开关和严格安全校验。

新增能力：

- `sync-issues --provider github --live --repo owner/name --live-confirm <run-id>`
- GitHub repo 格式校验
- `GITHUB_TOKEN` 必填校验
- `--dry-run` 和 `--live` 互斥
- mockable GitHub issue adapter
- GitHub open issue lookup by `mg_issue_id`
- matching issue update via PATCH
- GitHub live sync summary artifact
- token 不写入 artifact

建议命令：

```bash
migration-guard sync-issues --run latest --provider github --dry-run
migration-guard sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id>
```

产物：

- `.migration-guard/migration-runs/run-*/issue-sync/github-live-sync.json`

完成标准：

- 不带 `--dry-run` 或 `--live` 时外部 provider 拒绝执行。
- `--live` 缺 repo/token 时拒绝执行。
- `--live` 缺 live-confirm 或 confirm 不匹配当前 run id 时拒绝执行。
- mock GitHub API 测试能验证 lookup/create/update URL、Authorization header、payload 和返回 URL。
- live summary 能区分 created/updated/failed。
- live summary 不包含 token。
- 安全 smoke 验证拒绝路径，不触发真实外部 API。

## Phase 27: GitHub Live Confirmation + Update Path

目标：把 GitHub live adapter 从 create-only 边界推进到可控的 lookup/update/create 流程，并增加 run id 二次确认。

新增能力：

- `sync-issues --provider github --live --repo owner/name --live-confirm <run-id>`
- GitHub open issue lookup by `mg_issue_id`
- matching issue update via PATCH
- missing/mismatched live confirmation 拒绝执行
- live summary 区分 created/updated/failed

建议命令：

```bash
migration-guard sync-issues --run latest --provider github --dry-run
migration-guard sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id>
```

产物：

- `.migration-guard/migration-runs/run-*/issue-sync/github-live-sync.json`

完成标准：

- 缺 live-confirm 或 confirm 不匹配当前 run id 时拒绝执行。
- mock GitHub API 测试能验证 lookup/update/create 顺序。
- token 不写入 summary artifact。

## Phase 28: GitHub Live Plan + Unchanged Skip Smoke

目标：在真实 live 变更前写出可审计 plan，并避免重复更新正文未变化的 GitHub issue，同时补齐可复用失败 batch smoke。

新增能力：

- GitHub live plan artifact
- issue body SHA-256 hash
- unchanged body skip
- live summary 区分 created/updated/skipped/failed
- mock create/update/skip 覆盖
- reusable failing proposal batch smoke helper

建议命令：

```bash
node scripts/smoke/create-failing-proposal-batch.mjs --config configs/md-fast.migration-guard.json --run latest
migration-guard proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 2 --gate-policy fail-fast
migration-guard sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run
```

产物：

- `.migration-guard/migration-runs/run-*/issue-sync/github-live-plan.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-live-sync.json`
- `.migration-guard/migration-runs/run-*/proposal-batches/*/proposal-batch-report-*.json`
- `scripts/smoke/create-failing-proposal-batch.mjs`

完成标准：

- live plan 包含 repo、matching strategy、willCreate/willUpdate/willSkip、issue id、existing number 和 body hash。
- 正文 hash 相同的 existing issue 不触发 PATCH。
- live summary 不包含 token，并记录 skippedCount。
- safe smoke 不调用真实 GitHub API，目标仓库保持 clean。

## Phase 29: GitHub Live Guardrails + Observability

目标：把 GitHub live sync 从“可执行”推进到“可控执行”，在真实 mutation 前提供更强护栏和排障信息。

新增能力：

- `sync-issues --provider github --live-plan --repo owner/name`
- `sync-issues --provider github --live --max-live-mutations <n>`
- `sync-issues --provider github --labels team:migration,phase-1`
- GitHub live 默认 mutation cap
- GitHub read-only live plan summary
- GitHub rate-limit 非敏感 header summary
- GitHub 429/5xx retry backoff
- mutation limit 超限时先写 plan 再拒绝 mutation

建议命令：

```bash
migration-guard sync-issues --run latest --provider github --dry-run --labels team:migration
migration-guard sync-issues --run latest --provider github --live-plan --repo owner/name
migration-guard sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id> --max-live-mutations 3
```

产物：

- `.migration-guard/migration-runs/run-*/issue-sync/github-live-plan.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-live-plan-summary.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-live-sync.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-live-plan-issues.json`

完成标准：

- `--live-plan` 只查询 GitHub open issues，不触发 POST/PATCH。
- `--max-live-mutations` 超限时拒绝 live mutation，并保留 plan artifact。
- `--labels` 追加团队标签且不重复默认标签。
- live/live-plan summary 不包含 token。
- summary 写入 rate-limit remaining/reset 等非敏感信息。
- mock API 覆盖 429/5xx retry。
- safe smoke 不调用真实 GitHub API，目标仓库保持 clean。

## Phase 30: GitHub Live Plan Hash Confirmation

目标：把真实 GitHub live mutation 绑定到用户已审阅的 plan artifact，避免 read-only plan 和 live 执行之间出现未确认 drift。

新增能力：

- `github-live-plan.json` 写出稳定 `planHash`
- `github-live-plan-summary.json` 写出 `planHash`
- `github-live-sync.json` 写出 `planHash` 和 `livePlanConfirm`
- `sync-issues --provider github --live --live-plan-confirm <plan-hash>`
- live mutation 前校验当前计划 hash 与确认 hash 一致
- hash mismatch 时只执行 GET lookup，不执行 POST/PATCH

建议命令：

```bash
migration-guard sync-issues --run latest --provider github --live-plan --repo owner/name
migration-guard sync-issues --run latest --provider github --live --repo owner/name --live-confirm <run-id> --live-plan-confirm <plan-hash> --max-live-mutations 1
```

产物：

- `.migration-guard/migration-runs/run-*/issue-sync/github-live-plan.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-live-plan-summary.json`
- `.migration-guard/migration-runs/run-*/issue-sync/github-live-sync.json`

完成标准：

- read-only live plan 和 live sync 对相同 create/update/skip 决策生成相同 `planHash`。
- 缺 `--live-plan-confirm` 时 GitHub live 拒绝执行。
- hash mismatch 时拒绝 live mutation，并保留最新 plan artifact。
- live summary 记录 `planHash` 和用户确认的 hash。
- mock API 验证 hash mismatch 不触发 POST/PATCH。
- safe smoke 不调用真实 GitHub API，目标仓库保持 clean。

## Phase 31: Real GitHub Read-Only Smoke Prep

目标：准备真实 GitHub read-only smoke，但本阶段不需要真实 token，也不触发外部 API。

新增能力：

- GitHub read-only smoke runbook
- `--live-plan` 成功输出明确提示 read-only GET、无 POST/PATCH
- 本地 no-network planHash stability smoke helper
- 本地 no-network read-only smoke preflight helper

建议命令：

```bash
npm run build
node scripts/smoke/prepare-github-read-only-smoke.mjs --config configs/md-fast.migration-guard.json --run latest --repo owner/name
node scripts/smoke/check-live-plan-hash-stability.mjs
```

产物：

- `docs/GITHUB_READ_ONLY_SMOKE_RUNBOOK.md`
- `scripts/smoke/prepare-github-read-only-smoke.mjs`
- `scripts/smoke/check-live-plan-hash-stability.mjs`

完成标准：

- runbook 明确真实 read-only smoke 的前置授权、命令和禁止事项。
- CLI `--live-plan` 成功时明确声明不会 POST/PATCH。
- 预检脚本只读取本地 run/config 并打印真实 read-only 命令，不触发 GitHub API。
- 本地稳定性脚本连续生成两个 mocked live plan，确认 `planHash` 一致。
- 本阶段不需要 `GITHUB_TOKEN`，不触发真实 GitHub API。

## Phase 33: Single-Issue GitHub Mutation Smoke Plan

目标：为未来真实 GitHub mutation smoke 增加单 issue 限缩能力和 runbook，但本阶段不触发真实 mutation。

新增能力：

- `sync-issues --only-issue <issue-id>`
- dry-run/live-plan/live 均只导出或同步指定 issue
- live plan hash 基于过滤后的单 issue 计划
- local issue external URL 只回写到匹配 issue
- GitHub mutation smoke plan 文档

建议命令：

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --dry-run --only-issue <issue-id>
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live-plan --repo perly6185-lab/migration-guard --only-issue <issue-id>
```

产物：

- `docs/GITHUB_MUTATION_SMOKE_PLAN.md`
- `.migration-guard/.../issue-sync/github-dry-run-issues.json`
- `.migration-guard/.../issue-sync/github-live-plan.json`
- `.migration-guard/.../issue-sync/github-live-plan-summary.json`

完成标准：

- `--only-issue` 不存在时拒绝执行。
- dry-run filtered export 只包含一个 issue。
- live-plan filtered summary 的 mutationCount 可降为 1。
- mocked live filtered sync 在 `--max-live-mutations 1` 下只执行一个 mutation。
- 不执行真实 GitHub POST/PATCH。

## Phase 34: Runner Loop Replan Brief + Next Action

目标：从 GitHub 配套建设回到 Migration Runner Loop，让失败 proposal 直接产出 AI/人类可执行的 replan 证据包，并在 status/report 中给出唯一下一步动作。

新增能力：

- `proposal replan` 写出 replan brief
- `proposal replan` 写出 JSON context pack
- verification report 回写 `replanBriefPath` 和 `replanContextPath`
- `status` 输出唯一 `Next action`
- `report` 新增 `Next Action` 区块

建议命令：

```bash
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 2 --gate-policy fail-fast
node dist/cli.js status --config configs/md-fast.migration-guard.json --run latest
node dist/cli.js proposal replan --config configs/md-fast.migration-guard.json --run latest --proposal <failed-proposal-id>
node dist/cli.js report --config configs/md-fast.migration-guard.json --run latest
```

产物：

- `.migration-guard/.../replans/<proposal-id>/replan-brief.md`
- `.migration-guard/.../replans/<proposal-id>/replan-context.json`
- verification report 中的 replan brief/context 路径
- run report `Next Action`

完成标准：

- 失败 batch 后，status/report 只推荐创建 replan brief。
- `proposal replan` 后，status/report 改为推荐使用 replan brief 修复 proposal。
- replan context 包含 failed check、report path、patch path、issue/task、retry command。
- `npm test` 覆盖 next action 和 replan artifact。

## Phase 35: Authorized Single-Issue GitHub Mutation Smoke

目标：在明确授权后完成一次真实 GitHub 单 issue mutation smoke，证明外部 handoff 可用，然后停止 GitHub provider 深挖。

新增能力：

- 无新增 provider 功能
- 真实 GitHub create/update smoke 记录
- local issue `externalUrl` 回写验证
- credential marker scan 记录

建议命令：

```bash
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live-plan --repo perly6185-lab/migration-guard --only-issue <issue-id>
node dist/cli.js sync-issues --config configs/md-fast.migration-guard.json --run latest --provider github --live --repo perly6185-lab/migration-guard --live-confirm <run-id> --live-plan-confirm <planHash> --max-live-mutations 1 --only-issue <issue-id>
```

产物：

- `.migration-guard/.../issue-sync/github-live-plan.json`
- `.migration-guard/.../issue-sync/github-live-sync.json`
- `docs/PHASE_35_REPORT.md`
- GitHub issue URL

完成标准：

- `mutationCount` 为 1。
- live sync 只 created/updated 一个 issue。
- 本地只有匹配 issue 写入 `externalUrl`。
- artifact 不包含真实 token 或 Authorization header。
- GitHub 后续扩展进入 deferred backlog，下一活跃主线回到 Runner Loop。

## Phase 36: Replan Task to Retry Proposal Loop

目标：把 Phase 34 的 replan brief/context 向前推进成可跟踪的 retry proposal，形成 `proposal failure -> issue -> replan task -> brief/context -> retry proposal` 的最小闭环。

新增能力：

- `proposal retry --proposal <failed-proposal-id>`
- retry proposal 回连原 failed proposal
- retry proposal 回连 replan issue/task/brief/context
- 原 verification report 写入 `retryProposalId`
- replan task 在 retry proposal 创建后标记为 done
- `status` / `report` 在 retry proposal 创建后推荐验证或应用 retry proposal

建议命令：

```bash
node dist/cli.js proposal replan --config configs/md-fast.migration-guard.json --run latest --proposal <failed-proposal-id>
node dist/cli.js proposal retry --config configs/md-fast.migration-guard.json --run latest --proposal <failed-proposal-id>
node dist/cli.js status --config configs/md-fast.migration-guard.json --run latest
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run latest --proposal <retry-proposal-id> --checks
```

产物：

- `.migration-guard/.../proposals/<retry-proposal-id>/proposal.json`
- `.migration-guard/.../proposals/<retry-proposal-id>/patch.diff`
- failed verification report 中的 `retryProposalId`
- run report `Next Action`

完成标准：

- replan 后，status/report 推荐 `proposal retry`。
- retry 后，status/report 推荐验证 retry proposal。
- retry proposal 可从 metadata 找回原 failed proposal 和 replan evidence。
- `npm test` 覆盖 retry proposal 创建、复用和 next action 转移。

## Phase 37: Proposal Gate Behavior Drift References

目标：把行为一致性证据链接回 proposal gate。gate 失败时，如果存在最新 compare report，verification report、failure issue、replan brief 和 run report 都应引用具体 check/probe drift。

新增能力：

- failed proposal verification report 写入 `behaviorDrift`
- behavior drift 只引用 check/probe error/warn，不把 scan info 当成 gate drift
- failure issue 和 replan task 写入 compare report path 与 drift 摘要
- replan brief/context 写入 drift 摘要
- issue sync gate context 导出 drift 摘要
- run report 的 Recent Proposal Gates 展示 drift count 和第一条 drift

建议命令：

```bash
node dist/cli.js verify --config configs/md-fast.migration-guard.json
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 2 --gate-policy fail-fast
node dist/cli.js proposal replan --config configs/md-fast.migration-guard.json --run latest --proposal <failed-proposal-id>
node dist/cli.js report --config configs/md-fast.migration-guard.json --run latest
```

产物：

- proposal verification report `behaviorDrift`
- replan brief/context 中的 `Behavior Drift`
- issue sync export 中的 behavior drift context
- run report `behavior-drift:<count>`

完成标准：

- gate 失败时能引用最新 compare report。
- 只展示具体 check/probe drift。
- replan brief 足以告诉 AI 哪个 probe/check drift 与失败相关。
- `npm test` 覆盖 verification report、replan brief、issue sync 和 run report。

## Phase 38: Proposal-Scoped Behavior Diff

目标：在 proposal apply 周围显式捕获 before/after behavior snapshots，并把 compare report 关联回 proposal verification report。

新增能力：

- `task apply --behavior-diff`
- `action apply --behavior-diff`
- `proposal batch apply --behavior-diff`
- proposal 目录写入 before snapshot
- proposal 目录写入 after snapshot
- proposal 目录写入 compare JSON/Markdown
- verification report 写入 `behaviorDiff`
- run report Recent Proposal Gates 展示 proposal-scoped behavior diff 摘要

建议命令：

```bash
node dist/cli.js action apply --config configs/md-fast.migration-guard.json --run latest --proposal <proposal-id> --rollback-on-fail --behavior-diff
node dist/cli.js proposal batch apply --config configs/md-fast.migration-guard.json --run latest --limit 1 --behavior-diff
```

产物：

- `.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-before.json`
- `.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-after.json`
- `.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-compare.json`
- `.migration-guard/.../proposals/<proposal-id>/behavior-diff-*-compare.md`
- verification report `behaviorDiff`

完成标准：

- 默认 apply 不增加完整 behavior snapshot 成本。
- 显式 `--behavior-diff` 时捕获 before/after。
- compare result 写入 verification report。
- `npm test` 覆盖 apply behavior diff artifact。

## Phase 39: Behavior Diff Decision Ledger

目标：把 behavior drift / proposal-scoped behavior diff 从“发现差异”推进到“记录决策”。每个 compare difference 可以被分类为 `intentional`、`accidental` 或 `unknown`，并带上原因和批准来源。

新增能力：

- `diff list --compare <compare.json>`
- `diff decide --compare <compare.json> --area <area> --name <name> --as <classification> --reason <text>`
- run-scoped diff decision ledger
- compare Markdown 刷新后展示 decision/reason
- run report Recent Proposal Gates 展示 decision coverage
- pending risk behavior diff 会成为 status/report 的下一步动作
- replan brief 中的 Behavior Drift 展示 decision 状态

建议命令：

```bash
node dist/cli.js diff list --config configs/md-fast.migration-guard.json --run latest --compare <compare.json>
node dist/cli.js diff decide --config configs/md-fast.migration-guard.json --run latest --compare <compare.json> --area probe --name md-renderer-behavior --as intentional --reason "expected renderer behavior change"
node dist/cli.js report --config configs/md-fast.migration-guard.json --run latest
```

产物：

- `.migration-guard/.../diff-decisions/decisions.json`
- refreshed compare Markdown with decision columns
- run report `behavior-decisions`
- replan brief `[pending]` / `[intentional]` drift labels

完成标准：

- 一个 compare difference 可以被分类并持久化。
- report 能显示 decided/pending/pending-risk 计数。
- 未分类 risk diff 会被推荐为下一步动作。
- `npm test` 覆盖 ledger、coverage 和 Markdown 刷新。

## Phase 40: Decision-Aware Behavior Gate

目标：让 Phase 39 的 diff decision ledger 进入迁移控制流，但不改变原始 compare 结果。

新增能力：

- decision policy：`clean` / `accepted` / `pending` / `blocked`
- raw compare failed 但全部 risk diff 为 `intentional` 时，run verify 可继续
- `accidental` risk diff 进入 blocked/replan 路径
- `unknown` 或未分类 risk diff 进入 pending/classify 路径
- run report 展示 `Decision gate`
- status/report next action 基于 accidental / unknown / pending 分类选择 replan 或 classify

建议命令：

```bash
node dist/cli.js diff decide --run latest --compare <compare.json> --area probe --name <probe-name> --as intentional --reason "approved expected behavior change"
node dist/cli.js resume --run latest --auto
node dist/cli.js report --run latest
```

产物：

- refreshed compare Markdown `Decision gate`
- run report `behavior-decisions`
- decision-aware next action

完成标准：

- 原始 compare report 仍保留 raw passed/failed。
- decision gate 可以说明是否可继续。
- `accidental` 推荐 replan。
- `unknown` / pending 推荐 classify。

## Phase 41: Low-Risk Adapter Proposal Generation

目标：让 `pnpm-vite-vue` adapter 从只读 inventory 进入可验证 proposal 候选生成，但仍不直接修改目标源码。

新增能力：

- action plan 增加 `action-adapter-fixture-inventory`
- action plan 增加 `action-normalize-check-noise`
- 新增 action patch template：`adapter-fixture-probe`
- 新增 action patch template：`normalization-probe`
- 低风险 action 通过现有 `action propose` 生成 probe proposal

建议命令：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "Vite/Vue monorepo safety validation" --dry-run --adapter pnpm-vite-vue
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run latest --auto
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run latest
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action action-adapter-fixture-inventory
```

产物：

- `adapter/pnpm-vite-vue-action-plan.json`
- proposal `patch.diff`
- generated low-risk probe under `scripts/migration-guard/`

完成标准：

- adapter action plan 至少包含两个 low-risk action。
- action proposal 不直接改目标业务源码。
- proposal 仍走现有 verification/apply gate。

## Phase 42: MD UI/API Contract Probe Expansion

目标：回到 `perly6185-lab/md` 真实项目，为整仓自动重构补关键行为证据。先覆盖 API 路由/CORS/鉴权边界和 web app build/static 入口契约，不修改目标业务源码。

新增能力：

- `md-api-contract` command probe
- `md-web-static-contract` command probe
- fast config 增加 API contract probe
- full config 增加 API contract + web static/build probe

建议命令：

```bash
pnpm --dir D:/learn/migration-guard-targets/md exec tsx D:/learn/migration-guard/scripts/probes/md-api-contract-probe.mjs
pnpm --dir D:/learn/migration-guard-targets/md exec tsx D:/learn/migration-guard/scripts/probes/md-web-static-probe.mjs
node dist/cli.js baseline --config configs/md-fast.migration-guard.json
node dist/cli.js verify --config configs/md-fast.migration-guard.json
```

产物：

- API contract JSON output
- web source/build contract JSON output
- updated `md-fast` / `md-full` snapshots containing the new probes

完成标准：

- API probe 覆盖 root health、CORS preflight、upload disabled、unauthenticated `/me`。
- web probe 覆盖 app bootstrap、root component、Vite base、dist index、JS/CSS assets。
- fast lane 可不启动 web dev server。
- full lane 在 `web-build` 后校验 build artifact。

## Phase 43: MD Adapter Task Graph

目标：把 `perly6185-lab/md` 的整仓重构准备路线固化为 adapter 任务图和可审计 action plan。仍不修改目标业务源码，而是产出按 domain 切分的任务、风险、probe、验收标准和回滚边界。

新增能力：

- `md-monorepo` adapter task graph
- `adapter/md-monorepo-task-plan.json`
- `adapter/md-monorepo-task-plan.md`
- `adapter/md-monorepo-action-plan.json`
- MD domain 任务覆盖 core/shared/web/api/vscode/cli/mcp/cross-package verification

建议命令：

```bash
node dist/cli.js run --config configs/md-fast.migration-guard.json --source D:/learn/migration-guard-targets/md --target D:/learn/migration-guard-targets/md --goal "MD monorepo refactor task planning" --dry-run --adapter md-monorepo --issue-provider local
node dist/cli.js resume --config configs/md-fast.migration-guard.json --run latest --auto
node dist/cli.js tasks --config configs/md-fast.migration-guard.json --run latest
node dist/cli.js actions --config configs/md-fast.migration-guard.json --run latest
```

产物：

- run task graph 中的 `task-md-monorepo-plan`
- run task graph 中的 `task-md-monorepo-actions`
- task issues：每个 MD refactor domain 一个 planned issue
- action issues：每个 AI-owned domain 一个 proposal candidate issue

完成标准：

- `md-monorepo` graph 通过 DAG 校验。
- action plan 绑定 Phase 42 的 renderer/API/web probes。
- 高风险 domain 默认 `manual-approval-required`。
- 任务计划可作为后续整仓自动重构的执行边界，而不是临时口头计划。

## Phase 44: First MD Domain Gated Proposal

目标：从 Phase 43 的 `md-monorepo` action candidates 中选择一个低风险 domain，生成真实 proposal，跑通 patch verify、apply checks、proposal-scoped behavior diff 和 rollback。

新增能力：

- action probe script 支持 affected path 为目录
- 非 UI action probe 对整个 action 范围聚合检查信号
- `action-md-mcp-render` 可生成目录型 renderer probe proposal
- 单测覆盖目录型 generated probe
- 首个 MD domain proposal smoke 记录 apply/behavior-diff/rollback artifact

建议命令：

```bash
node dist/cli.js action propose --config configs/md-fast.migration-guard.json --run latest --action action-md-mcp-render
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run latest --proposal <proposal-id>
node dist/cli.js action apply --config configs/md-fast.migration-guard.json --run latest --proposal <proposal-id> --rollback-on-fail --behavior-diff
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run latest --proposal <proposal-id>
```

产物：

- `proposals/<proposal-id>/patch.diff`
- `proposals/<proposal-id>/verification-*.json`
- `proposals/<proposal-id>/behavior-diff-*-compare.json`
- `proposals/<proposal-id>/rollback-*.json`

完成标准：

- patch-only verify 通过。
- apply checks 通过。
- behavior diff 通过且无 error/warn drift。
- rollback 后目标 `md` 仓库保持 clean。
- `npm test` 覆盖目录型 action probe。

## Phase 45: Verify Checks Temporary Apply

目标：补齐 `proposal verify --checks` 对 generated-script proposal 的语义。verify 模式不应把 proposal 标记为 applied，但必须能让新增的 probe/check 脚本在检查期间存在。

新增能力：

- `proposal verify --checks` 对 git patch 临时 apply
- checks 完成后自动 `git apply -R` 回滚
- verification report 写入 `temporaryApply`
- report 文本展示 temporary apply/rollback 状态
- verify-with-checks 复用 preview-aware check runner

建议命令：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run latest --proposal <proposal-id> --checks
```

产物：

- `proposals/<proposal-id>/verification-*.json`
- verification report `temporaryApply`

完成标准：

- 新增脚本型 proposal 可以在 verify mode 跑 checks。
- verify 后 proposal 仍未持久 applied。
- verify 后目标工作树恢复 clean。
- apply gate 语义保持不变。

## 阶段交付规则

每个阶段合入前都必须回答：

1. 用户如何运行这个阶段？
2. 这个阶段会生成什么 artifact？
3. 如果停止在这个阶段，工具能解决什么真实问题？
4. 失败时用户能看到什么证据？
5. 下一阶段是否只是在这个阶段之上增强，而不是推倒重来？

建议每个阶段至少保留：

- CLI happy path
- JSON artifact
- Markdown report
- Windows 验证
- 单元测试或 fixture 测试
- README 或 docs 入口
