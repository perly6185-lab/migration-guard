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
