# Migration Guard UI 操作手册

适用版本：`0.3.0-beta.1`  
适用范围：桌面端、本地单机操作

## 1. 使用目标

Migration Guard UI 用于按以下顺序完成一次受控重构：

1. 登记源项目和重构后的目标项目。
2. 扫描项目并识别技术栈、检查命令和风险。
3. 捕获变更前的行为基线。
4. 审查并执行边界明确的任务。
5. 验证目标项目行为。
6. 审查证据、差异和最终报告。

UI 默认只在本机监听，不是多人协作服务。项目代码、运行产物和任务记录都保存在本地目录中。

## 2. 启动 UI

### 从源码目录启动

要求 Node.js 20 或更高版本。

```powershell
npm install
npm run build
node dist/cli.js serve
```

浏览器打开：

```text
http://127.0.0.1:8787
```

指定端口：

```powershell
node dist/cli.js serve --port 8790
```

停止服务：在启动服务的终端中按 `Ctrl+C`。

### 从已安装的包启动

```powershell
migration-guard serve
```

如果端口被占用，使用 `--port <端口>` 指定其他端口。

## 3. 新建重构项目

1. 点击右上角 **New project**。
2. 填写 **Project name**，用于在项目列表中识别本次工作。
3. 填写 **Refactoring goal**，描述目标和必须保持的行为。
4. 在 **Source repository directory** 中填写当前稳定项目的绝对路径。
5. 在 **Refactored target directory** 中填写重构目标项目的绝对路径。
6. 点击 **Check project**。
7. 检查识别出的项目、包管理器、检查命令和警告。
8. 检查通过后点击 **Create project**。

路径要求：

- Source 和 Target 不能是同一目录。
- 两个目录不能互相嵌套。
- 应使用本机绝对路径。
- Target 中已有的未提交修改可能阻止自动执行。

创建后，项目会出现在顶部项目选择器和 **Project Portfolio** 中。

## 4. 主工作流

顶部阶段条展示当前进度：

| 阶段 | 含义 | 主要操作 |
| --- | --- | --- |
| Project | 项目已登记 | 检查项目名称、目标及路径 |
| Assess | 项目评估 | 点击 **Scan project** |
| Baseline | 行为基线 | 点击 **Capture baseline** |
| Execute | 执行变更 | 打开 **Execution** 并审查任务 |
| Verify | 行为验证 | 点击 **Verify** |
| Report | 证据审查 | 打开 **Reports** |

左侧 **Project Workflow** 中的 **Current step** 是当前推荐操作。正常情况下只需按这个主按钮向前推进。

### Auto advance

启用 **Auto advance** 后，UI 会连续执行被判定为安全的步骤。遇到代码变更、阻塞、报告审查或恢复操作时会停止。

首次使用建议关闭。确认扫描命令、基线和目标目录正确后，再用于重复性流程。

## 5. Workspace 页面

Workspace 用于判断“现在应该做什么”。

- **Project Workflow**：当前步骤、项目路径、检查命令和阶段证据。
- **Blockers**：首要阻塞默认展开，其余阻塞在 **Show more blockers** 中。
- **Run details**：运行 ID、模式、目标、checkpoint 和 Git 状态。
- **Project history**：历史运行记录，可切换顶部 Run selector 查看。
- **CLI and advanced next actions**：无法在 UI 内完成时提供可复制的 CLI 命令。

处理 blocker 时，先阅读原因，再执行其下方建议命令。点击 **Copy** 只复制命令，不会自动执行。

常见 blocker：

- `Target repository is not clean`：先提交、暂存、清理或回滚 Target 修改。
- `baseline missing`：返回 Workspace 捕获基线。
- `action plan missing`：先生成或审查执行计划。
- `run-progress`：当前运行尚未产生下一阶段需要的证据。

## 6. Execution 页面

Execution 用于执行受控任务。

1. 在 **Task Board** 找到状态为 `ready` 的任务。
2. 点击任务展开详情，检查风险、影响路径和检查命令。
3. 高风险或信息不足的任务先点击 **Review plan**。
4. 审查计划中的 Git HEAD、基线、影响路径和 plan hash。
5. 计划通过后点击 **Execute task**。
6. 在确认框中确认。系统会先创建 checkpoint，再执行任务和验证。

不要执行路径范围、命令或目标与预期不符的计划。修改任务条件后应重新生成计划，旧 plan hash 不应继续使用。

**Advanced guarded actions** 默认折叠，其中包括：

- **Write Readiness**：写入当前重构就绪度证据。
- **Issue Dry-run**：读取配置并生成 Issue Control 演练，不执行真实 GitHub 变更。

## 7. Monitoring 页面

Monitoring 用于观察后台任务及失败原因。

- **Status**：就绪度、blocker、warning、ready task 和运行数量。
- **Recent Jobs**：按状态或当前 run 筛选任务。
- **Job Detail**：查看参数、结果、耗时、时间线和产物。
- **Cancel**：只能取消仍在队列中的任务。
- **Retry**：按原始参数重试失败任务，并保留重试链。

Job GC 清理的是终态 UI job 记录：

1. 设置 **Keep** 数量。
2. 点击 **Plan GC** 查看将被删除的记录。
3. 确认计划后点击 **Apply GC**。
4. 在确认框中再次确认。

## 8. Reports 页面

Reports 用于完成最终审查。

- **Deliverables**：本次运行生成的报告和交付物。
- **Evidence / Diff**：基线与当前行为的差异。
- **Project history**：切换和回看历史运行。
- **Unattended Audit**：自动执行决策的审计记录。

差异判定：

- `intentional`：符合已审查的重构目标。
- `accidental`：非预期行为变化，需要修复或回滚。
- `unknown`：证据不足，暂时不能继续自动推进。

记录差异时必须填写原因。只有相同性质的一组差异才使用批量判定；不确定时逐项判定。

## 9. 失败恢复

Execution 和 Monitoring 中的 **Recovery Center** 会列出可用 checkpoint。

1. 展开目标 checkpoint，核对创建时间、分支、HEAD 和备注。
2. 点击 **Plan recovery**。
3. 检查恢复策略、当前 HEAD、checkpoint 和 blocker。
4. 只有计划状态为 ready 时才会出现 **Apply recovery**。
5. 点击后阅读影响警告并确认。
6. 恢复完成后重新扫描或验证项目。

恢复可能改变 Target 文件和 Git 状态。不要仅凭时间选择 checkpoint，应核对分支、HEAD 和对应 run。

## 10. 推荐操作顺序

一次标准操作可按以下清单执行：

```text
New project
  -> Check project
  -> Create project
  -> Scan project
  -> Capture baseline
  -> Review plan / Execute task
  -> Monitoring 查看执行结果
  -> Verify
  -> Reports 审查差异
  -> 对差异分类
  -> 审查 Deliverables
```

进入下一阶段前确认：

- Target Git 状态符合预期。
- 当前步骤没有未处理 blocker。
- 后台 job 已结束且结果为 succeeded。
- 差异已经逐项审查，不将 unknown 当作通过。
- 报告和证据属于当前选择的 run。

## 11. 故障排查

建议先运行统一只读诊断：

```powershell
node dist/cli.js troubleshoot --run latest --json
```

输出中的 `causes` 会列出问题区域、原因和推荐的下一条命令。该命令不会修改项目、Job 或证据。

### 页面没有最新状态

点击右上角 **Refresh**，并确认顶部选择的是正确项目和 run。

### 按钮不可用

查看按钮附近的提示或 Workspace blocker。常见原因是缺少 baseline、Git 工作区不干净、配置缺少 GitHub repo，或选择了历史 run。

### Job 一直显示 running

先查看 Job Detail。服务异常退出后重新启动 UI，孤立的 queued/running job 会被恢复为终态，然后可以重试。

也可以通过 CLI 先查看恢复计划，再显式应用：

```powershell
node dist/cli.js jobs list --status active --json
node dist/cli.js jobs recover --json
node dist/cli.js jobs recover --apply --json
```

### 证据链接无法打开

UI 只允许读取当前项目 `artifactsDir` 内的文件。确认选择了正确项目和 run，且文件没有被外部清理。

```powershell
node dist/cli.js artifacts inspect --run latest --json
```

### UI 启动失败

```powershell
npm run build
npm run ui:smoke
```

如果 smoke 通过但服务端口不可用，请更换端口后重新启动。

检查端口是否空闲、被其他程序占用，或已经运行 Migration Guard：

```powershell
node dist/cli.js serve doctor --host 127.0.0.1 --port 8787 --json
```

### Job 命令速查

```powershell
node dist/cli.js jobs list --status failed --json
node dist/cli.js jobs inspect --job <job-id> --json
node dist/cli.js jobs retry --job <job-id> --confirm <job-id> --json
node dist/cli.js jobs cancel --job <job-id> --confirm <job-id> --json
node dist/cli.js jobs gc --keep 50 --json
node dist/cli.js jobs gc --keep 50 --apply --json
```
