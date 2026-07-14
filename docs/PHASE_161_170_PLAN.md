# Phase 161-170 Roadmap

规划日期：2026-07-14

## 规划依据

Phase 151-160 已完成 RC hardening 的功能骨架，本地 `release:gate` 当前可通过，126 个测试全部通过，package 与 UI smoke 均通过。

进入下一阶段前仍有四类闭环缺口：

- `pilot:smoke` 本轮可以全部跳过，但 `pilot:report` 仍会读取历史结果并给出 GO，发布证据缺少本轮运行绑定和 freshness 校验。
- `release:gate` 尚未串联 real-project pilot、pilot report、全安装模式 smoke 和统一 release evidence manifest。
- Artifact Schema v2 目前主要是独立 envelope/helper 与单元测试，snapshot、compare、UI job 的主写入和读取链路尚未整体切换。
- `issueControl.ts`、`patch.ts` 等核心模块持续膨胀，静态测试清单也可能漏掉新测试，不利于进入 0.3.x 后继续扩展 AI 协作能力。

因此下一阶段不直接追加更多 provider 或自动 mutation，而是先完成：

> 发布证据可信化 -> v2 artifact 真正落地 -> 安装后黄金路径 -> 长任务防重 -> 0.2.0 GA -> 核心边界收敛 -> 可移植 AI handoff -> 0.3.0 beta 验证

## 里程碑

- Phase 161-165：`0.2.0` GA Integrity Closure
- Phase 166-169：`0.3.0` Collaboration Foundation
- Phase 170：`0.3.0-beta.1` Readiness Gate

## Phase 161：发布证据账本与新鲜度门禁

目标：确保一次 GO 结论只能来自同一轮、同一提交、同一配置的完整验证。

状态：已完成，见 `docs/PHASE_161_REPORT.md`。

交付内容：

- 为 release gate 生成唯一 `releaseRunId`。
- 写出 release evidence manifest，记录版本、Git commit、dirty state、Node、OS、开始/结束时间、命令结果和 artifact hash。
- pilot artifact 增加 `releaseRunId`、项目根 fingerprint、配置 hash 和本轮执行时间。
- `pilot:report` 默认只接受当前 release run 产生的结果，不再静默复用历史 passed artifact。
- 任一配置项目 skipped、missing、stale 或 fingerprint 不一致时，GO 必须为 false。
- 将 `pilot:smoke`、`pilot:report`、`install:smoke` 和 `git diff --check` 纳入 release gate。
- 支持 `release:gate --resume <runId>`，只复用 hash 和环境一致的已通过步骤。

Artifacts：

- `.migration-guard/releases/<runId>/release-evidence.json`
- `.migration-guard/releases/<runId>/release-evidence.md`
- `.migration-guard/releases/<runId>/pilot-results/*.json`

退出标准：

- 本轮三个 pilot 全部跳过时 release gate 必须 NO-GO。
- 历史 pilot 结果不能使新 release run 变绿。
- manifest 可解释每个 gate 使用了哪一份证据。
- 中断后 resume 不重复执行仍有效的昂贵步骤。

## Phase 162：Artifact Schema v2 主链路落地

目标：让 Phase 156 的 schema v2 从独立 helper 变成真实运行格式。

状态：已完成，见 `docs/PHASE_162_REPORT.md`。

交付内容：

- snapshot、compare 和 UI job 新写入默认使用 v2 envelope。
- 所有读取入口统一支持 v1 payload 与 v2 envelope。
- snapshot v2 固化 normalization metadata、check health fingerprint 和 package scan summary。
- compare v2 固化 health debt reference、budget decision 和 source snapshot hash。
- UI job v2 固化 lease owner、attempt、heartbeat、capability 和执行结果引用。
- 合并 `artifactV2` 与现有 artifact migration registry 的版本判断，避免两套 schema 规则漂移。
- 提供 v1 fixture -> v2 -> read -> report 的端到端迁移测试。

退出标准：

- 新 baseline/verify/serve 流程不再写出伪 v2 或裸 v1 核心 artifact。
- 现有 v1 artifacts 保持只读兼容。
- future version、kind mismatch 和 payload hash mismatch 都明确失败。
- migration dry-run、apply hash 确认和幂等性保持有效。

## Phase 163：安装后黄金路径与配置生成闭环

目标：验证用户从空配置到可信 verify 的完整首次使用体验。

交付内容：

- 在隔离临时目录执行 package 安装后的 `init --detect -> config validate -> doctor -> scan -> baseline -> verify -> report`。
- 覆盖单包 TypeScript、pnpm workspace、Go，以及 Rust/Python 中至少一种 fixture。
- `init --detect` 输出配置来源、检测置信度和未采用建议。
- 配置写入采用 preview + explicit apply，不修改目标项目 `package.json`，不自动安装依赖。
- doctor 对 no-op check、缺失 cwd、未解析变量、不可执行命令和 artifact 权限给出具体修复建议。
- 记录首次黄金路径耗时和人工修改次数。

退出标准：

- 至少四类 fixture 可从无 Migration Guard 配置走到 no-change verify passed。
- generated config 可重复生成且 diff 稳定。
- 安装包内 README 命令与实际 CLI 参数一致。
- 默认流程不触碰目标项目依赖和业务源码。

## Phase 164：Job Lease 防重与崩溃恢复

目标：保证长任务在进程暂停、崩溃和恢复时不会被重复执行。

交付内容：

- lease 增加稳定 owner id、fencing token、attempt 和 command fingerprint。
- heartbeat 使用原子更新，并拒绝旧 fencing token 续租或提交结果。
- 区分 process dead、host mismatch、heartbeat stale 和 lease expired。
- recovery 先写 plan，确认后才重新排队或接管。
- UI 和 CLI status 展示 lease 年龄、最后 heartbeat、attempt 和恢复原因。
- 增加双进程竞争、stale owner、旧 worker 晚到结果和 artifacts 目录短暂不可用测试。

退出标准：

- 同一 job 在任意时刻最多一个有效 owner。
- 旧 worker 无法覆盖新 owner 的结果。
- 崩溃恢复保留原 attempt 证据和新 attempt lineage。
- recovery 默认不自动重放 mutation 类命令。

## Phase 165：`0.2.0` GA 候选冻结

目标：形成可人工发布、可复核、可回滚的正式版候选。

交付内容：

- 将版本从 `0.2.0-rc.1` 切换为 `0.2.0`。
- 更新 CHANGELOG、upgrade guide、known issues 和最终 release checklist。
- 生成最终 tarball 清单、sha256、unpacked size 和 release evidence manifest。
- 在 clean checkout 上执行完整 release gate。
- 执行本地 tarball、`npx`、全局安装三种黄金路径 smoke。
- 生成手工 `npm publish`、Git tag 和 GitHub Release 的 reviewed command handoff。

安全边界：

- 不在 CI 中自动执行 `npm publish`。
- 不自动创建或推送 Git tag。
- 不把 npm token、GitHub token 或 Authorization header 写入 artifact。

退出标准：

- 最终 checklist 无 pending gate。
- release evidence 绑定干净的 GA commit 和 `0.2.0` tarball hash。
- 三个真实 pilot 使用本轮证据通过。
- 发布后 smoke 操作有明确回滚和 deprecate 指引。

## Phase 166：测试发现与核心模块边界

目标：降低继续迭代时漏测和巨型模块回归的风险，不改变外部 CLI 行为。

交付内容：

- 测试 runner 自动发现 `dist/**/*.test.js`，保留稳定排序、耗时摘要和失败退出码。
- 增加 expected test count 或 manifest snapshot，防止构建配置错误导致零测试。
- 将 unit、integration、smoke、pilot 的责任和运行成本显式分层。
- 为 `issueControl.ts` 和 `patch.ts` 建立拆分边界、依赖图和 characterization tests。
- 优先抽离纯模型、选择策略、artifact I/O 和 renderer，不重写业务逻辑。
- CLI command dispatch 与核心服务之间增加窄接口。

退出标准：

- 新增测试文件无需手工修改静态数组即可进入 `npm test`。
- 模块拆分前后 artifact 与 CLI 输出保持兼容。
- 不进行与边界收敛无关的命令重命名或 schema 变化。
- Windows 与 Ubuntu 测试顺序和结果一致。

## Phase 167：可移植 AI Handoff Contract v1

目标：把现有 replan brief、one-shot context 和 issue-control handoff 收敛为一个 provider-neutral 协作协议。

交付内容：

- 定义 versioned handoff schema：目标、允许路径、禁止动作、输入证据、建议命令、验收标准、预算和 lineage。
- handoff 引用 artifact hash，不复制整份大 artifact。
- 支持 human、Codex、其他 agent 使用同一 handoff package。
- 提供 JSON、Markdown 和 compact prompt 三种渲染。
- 增加 handoff validate、explain 和 redact-sensitive-data。
- 将 proposal failure、replan task 和 one-shot next action 接入统一 schema。

退出标准：

- AI 不扫描完整仓库也能从 handoff 理解单个 bounded task。
- handoff 明确区分 read-only、target edit、GitHub mutation 和 release mutation 权限。
- 所有引用 artifact 均可通过 hash 和相对路径复核。
- 旧 replan brief 保持读取兼容或提供明确迁移说明。

## Phase 168：AI 结果回传与验收协议

目标：让外部 AI 的修改结果可被 Migration Guard 验证，而不是把 AI 进程直接内嵌进状态机。

交付内容：

- 定义 result manifest：handoff id、changed files、patch hash、执行命令、声明结果和 agent metadata。
- 新增 `handoff import-result` dry-run 与 apply-confirm 流程。
- 导入前验证路径预算、禁止文件、patch 基线、dirty state 和 handoff lineage。
- 导入后自动生成 proposal verify 或 bounded one-shot verify 的下一步动作。
- 失败结果回连原 issue/task，生成下一轮 repair handoff。
- 不默认信任 agent 自报的测试结果，以本地 verification evidence 为准。

退出标准：

- 外部 AI 结果不能绕过 path budget 和 behavior gate。
- 重复导入同一 result manifest 幂等。
- 过期 baseline 或错误 handoff lineage 明确阻断。
- accepted/rejected result 都有 JSON 与 Markdown 审计证据。

## Phase 169：组织级策略与协作模板

目标：让多个项目复用一致的安全策略，而不是复制大型配置文件。

交付内容：

- 支持本地 policy preset：check budget、health debt、artifact retention、allowed mutation 和 handoff limits。
- 项目配置可显式继承 preset，并展示最终合并来源。
- preset 默认只允许本地文件系统路径，不引入远程配置拉取。
- doctor 检测互相冲突、过期或放宽安全边界的 override。
- report 展示本次 run 使用的 policy hash。
- 提供 JS/TS monorepo、Go service 和 conservative migration 三个示例 preset。

退出标准：

- 相同 preset 在多个项目产生稳定 policy hash。
- 项目 override 不会静默放宽 mutation 权限。
- policy 变化会使 resume/reuse 证据失效并要求重新确认。
- 无网络环境下可以完整工作。

## Phase 170：`0.3.0-beta.1` 端到端验证门禁

目标：证明“证据驱动的外部 AI 协作”在真实项目中可以安全闭环。

验证场景：

- 单包 JS/TS：配置生成、baseline、handoff、result import、verify。
- monorepo：bounded multi-package task、path budget 和 policy preset。
- Go/Rust/Python：至少一个非 JS 项目的 scan、baseline、handoff 和 no-change verify。
- 失败恢复：注入一次 check failure，生成 repair handoff，并在第二次 result 中收敛。
- 长任务恢复：注入 worker crash，验证 fencing token 和 attempt lineage。

交付内容：

- `0.3.0-beta.1` release checklist。
- beta known issues、upgrade notes 和 operator runbook。
- 三类真实项目 validation report。
- handoff/result schema compatibility matrix。
- release evidence manifest 与 tarball smoke。

退出标准：

- 至少三个真实项目完成完整协作闭环。
- 无越界文件修改、无旧 worker 覆盖、无 stale evidence GO。
- 一次失败能够形成可执行 repair handoff 并成功重试。
- beta 发布仍保留人工 reviewed publish/tag 边界。

## 明确不做

Phase 161-170 不展开以下范围：

- GitHub close/reopen、assignee、milestone 或更多 provider mutation。
- GitLab、Jira、Linear 的 live adapter。
- CI 内自动 npm publish 或自动打 tag。
- 让 Migration Guard 直接托管第三方 AI 凭据。
- 无 path budget、无 verify gate 的全自动大仓源码修改。
- 远程 policy 下载和隐式组织级配置覆盖。

## 每阶段交付规则

每个阶段合入前必须回答：

1. 用户如何运行？
2. 会生成哪些 JSON/Markdown artifacts？
3. artifact 如何绑定 commit、配置、policy 和输入证据？
4. 失败时是否给出唯一下一步动作？
5. 是否保持 dry-run、explicit apply 和人工 mutation 边界？
6. 是否有 Windows、Ubuntu 和安装包路径验证？
7. 是否增加了真实主链路测试，而不只是孤立 helper 单测？
