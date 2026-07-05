# Phase 17: Managed Preview Server for UI Gates Report

生成日期：2026-07-05

## 1. 阶段目标

Phase 17 的目标是让 UI proposal apply 不再依赖人工提前启动 dev server。

本阶段把 preview server 生命周期纳入 proposal verification gate：

- proposal 可声明 `preview` 元数据
- UI action 可自动推断 Vite preview command 和 URL
- `action apply` 自动启动 preview server
- 等待 preview URL ready
- 给 UI probe 注入 `MG_PREVIEW_URL`
- checks 完成后自动停止 preview server
- preview stdout/stderr、ready 状态和 URL 写入 artifact

## 2. 已实现能力

### 2.1 Proposal Preview Metadata

`ProposedPatch` 新增：

```json
{
  "preview": {
    "command": "pnpm web dev --host 127.0.0.1",
    "url": "http://127.0.0.1:5173/md/",
    "timeoutMs": 180000
  }
}
```

UI action 会优先使用 action plan 中显式声明的 `preview`；没有声明时，工具会对常见 pnpm/Vite/Vue monorepo 自动推断。

### 2.2 Managed Preview Session

`src/core/preview.ts` 支持：

- 启动 dev/preview command
- 捕获 stdout/stderr
- 轮询 URL ready
- 写出 `preview-*.json`
- 返回 `MG_PREVIEW_URL` env
- checks 结束后停止进程树
- Windows 下通过 `taskkill /t /f` 清理子进程

### 2.3 Preview-Scoped Checks

真实验证中发现 preview server 不应包住所有 recommended checks。

最终策略：

1. 先运行普通 checks，例如 web test 和 type-check。
2. 再启动 preview server。
3. 只对真正依赖 preview 的 UI probe 注入 `MG_PREVIEW_URL`。
4. UI probe 完成后停止 preview server。

这避免了 preview server 与 Vitest worker 抢资源。

## 3. 验证结果

### 3.1 单元测试

命令：

```bash
npm test
```

结果：

- TypeScript build 通过
- 共 14 个测试通过
- 新增测试覆盖 managed preview server apply gate
- 新增测试验证 UI action proposal 自动推断 preview command 和 URL

### 3.2 真实 md Proposal

最终成功 proposal：

```text
patch-2026-07-05T02-06-25-726Z-bhgl7i
```

生成的 preview metadata：

```text
pnpm web dev --host 127.0.0.1 -> http://127.0.0.1:5173/md/
```

### 3.3 Patch Verify

命令：

```bash
node dist/cli.js proposal verify --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T02-06-25-726Z-bhgl7i
```

结果：

- patch check: `passed`
- output: `verification-1783217192100.json`

### 3.4 Managed Preview Apply

命令：

```bash
node dist/cli.js action apply --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T02-06-25-726Z-bhgl7i
```

结果：

- patch check: `passed`
- preview: `ready`
- preview URL: `http://127.0.0.1:5173/md/`
- HTTP status: `200`
- preview stopped: `true`
- checks: `3/3 passed`
- verification output: `verification-1783217231546.json`
- preview output: `preview-1783217225209.json`

通过的 checks：

- `pnpm --filter @md/web test`
- `pnpm type-check:web`
- `node scripts/migration-guard/action-large-vue-ui-probe.mjs`

UI probe runtime result：

- mode: `fetch`
- status: `200`
- bodyLength: `8295`
- fallback reason: target `md` does not install `playwright`
- report path: `C:\Users\PSY\AppData\Local\Temp\migration-guard-ui-probes\action-large-vue-ui-probe\action-large-vue-ui-probe.json`

### 3.5 Rollback

命令：

```bash
node dist/cli.js proposal rollback --config configs/md-fast.migration-guard.json --run latest --proposal patch-2026-07-05T02-06-25-726Z-bhgl7i
```

结果：

- reverse check: `passed`
- reverse apply: `passed`
- rollback output: `rollback-1783217242452.json`

### 3.6 目标仓库清洁度

命令：

```bash
git -C D:\learn\migration-guard-targets\md status --short --branch
```

结果：

```text
## main...origin/main
```

额外确认：

- `5173` 端口无遗留监听
- 目标 `md` 仓库保持 clean

## 4. 动态调整记录

本阶段真实执行中插入了两次动态修正：

1. 初始 preview timeout 为 60 秒，真实 md 冷启动未能稳定 ready。
   - 失败 proposal: `patch-2026-07-05T02-00-08-454Z-848i1u`
   - 失败 evidence: `verification-1783216890810.json`
   - 修正：自动推断 preview timeout 提升到 180 秒。

2. preview server 最初包住所有 recommended checks，导致 Vitest worker 超时。
   - 失败 proposal: `patch-2026-07-05T02-02-48-311Z-apcqmp`
   - 失败 evidence: `verification-1783217067345.json`
   - 修正：普通 checks 先跑，只让 UI probe 进入 managed preview session。

最终 proposal `patch-2026-07-05T02-06-25-726Z-bhgl7i` 通过完整闭环。

## 5. 下阶段建议

Phase 18 建议进入 “Proposal Dependency Ordering + Check Classification”：

1. 给 recommended checks 增加结构化分类，例如 `unit-test`、`type-check`、`ui-probe`、`contract-probe`。
2. 让 proposal gate 基于分类决定执行顺序和资源隔离。
3. 支持 check-level timeout 覆盖。
4. 将失败 check 自动转成 replan issue。
5. 在 run report 中展示 proposal gate 的阶段化执行时间线。
