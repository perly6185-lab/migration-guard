# Phase 71: CI / Cross-platform Hardening

生成日期：2026-07-08

## 1. 阶段目标

Phase 71 把 post-merge 稳定性继续推进到跨平台 gate：让路径归一化逻辑不依赖当前 OS 分隔符，并让 GitHub CI 同时在 Ubuntu 和 Windows 上跑同一套 build/test。

## 2. Runtime Changes

- `toPosixPath` 现在显式把 Windows `\` 分隔符转成 `/`。
- artifact migration 的 artifact 类型识别改为复用 `toPosixPath`。
- 新增 `src/core/files.test.ts` 覆盖 Windows、POSIX 和 mixed separator 输入。

## 3. CI Changes

`.github/workflows/ci.yml` 从单一 Ubuntu job 改为 OS matrix：

- `ubuntu-latest`
- `windows-latest`

Matrix 设置 `fail-fast: false`，避免一个平台失败时遮住另一个平台的信号。

## 4. Local Verification

```bash
npm test
git diff --check
git -C D:/learn/migration-guard-targets/md status --short --branch
```

Result:

- `npm test`: 40 tests passed
- `git diff --check`: passed; only Windows LF-to-CRLF warnings were printed
- target md repo: `## main...origin/main`

## 5. Exit Criteria

- Path helper handles Windows, POSIX and mixed separators: passed
- Artifact migration uses the shared path normalization helper: passed
- Local Windows test suite passes: passed
- CI runs on both Ubuntu and Windows: pending GitHub PR gate
