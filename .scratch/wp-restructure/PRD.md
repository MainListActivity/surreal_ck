# 仓库重组 PRD（簇 A）

更新时间：2026-05-17

依据：
- [`docs/adr/web-only-pivot.md`](../../docs/adr/web-only-pivot.md)（部署形态）

## 一句话

把"Electrobun 桌面端 + 嵌入式 SurrealDB"的单工程结构拆为 **pnpm workspaces**：顶层 `server/` + `web/` + `shared/`，Electrobun 相关产物全部退役。本簇完成后仓库形态符合 web-only-pivot 的承诺，**不引入任何新业务代码**。

## 当前不解决

- 后端框架启动（簇 B）
- Mastra workflow 迁入（簇 D1）
- 前端 UI 迁入（簇 D2）
- SurrealDB schema 部署（簇 C）

本簇**只移动目录、改 package.json 与 CI，不写新逻辑**。

## 前置条件

无。本簇就是其它所有簇的前置条件。

## 完成定义

- `pnpm install` 在仓库根目录跑通；三个 workspace 都识别。
- `git mv` 历史保留，原文件改动可在 git log 中追踪。
- `electrobun.config.ts` 已删；CI 配置中没有 Electrobun 打包步骤。
- 旧 `src/main/**` 内代码暂时**移到** `server/legacy/` 子目录（不要立刻删；簇 B/C/D 会从这里"搬"代码到正确位置）。
- 旧 `src/renderer/**` 同样**移到** `web/legacy/`。
- 旧 `src/shared/**` 直接搬到 `shared/`（这部分零修改可用）。
- `tsconfig.json` / `tsconfig.renderer.json` 拆为 `server/tsconfig.json` + `web/tsconfig.json` + `shared/tsconfig.json`，path 别名指向 `shared/*`。
- `pnpm-lock.yaml` 更新但**不**改 packageManager 字段（保持 pnpm major）。

## 风险

- **`vite.config.ts`** 当前同时面向 Electrobun 渲染器，需要重写为纯 web 构建（簇 D2 再做）；本簇暂时把它原样挪到 `web/vite.config.ts`，让 web workspace 能识别但 dev server 跑不起来是可以接受的。
- **CI 关 Electrobun**：如果 CI 文件依赖 Electrobun 的某些 prebuilt artifact，要小心不要让 PR 检查直接挂。
- **`data/` / `build/` / `dist/`** 等目录是 Electrobun 输出物，加入 `.gitignore`（如未已加）。

## Issue 路线图

| # | 名称 | 主体 | 依赖 |
|---|---|---|---|
| 01 | pnpm workspaces 骨架 | 顶层 `pnpm-workspace.yaml` + 三 workspace 占位 package.json | — |
| 02 | 旧代码迁入 legacy 目录 | `git mv src/main/** server/legacy/`、`src/renderer/** web/legacy/`、`src/shared/** shared/` | 01 |
| 03 | tsconfig 拆分 | 三 workspace 各自 tsconfig + shared path 别名 | 02 |
| 04 | Electrobun 退役 | 删 `electrobun.config.ts`、CI 删 Electrobun 步骤、`.gitignore` 更新 | 03 |
| 05 | 根 README + AGENTS.md 更新 | 反映新目录形态；CLAUDE.md 的技术栈节同步 | 04 |

## 验收 KPI

- `pnpm install` 在干净 clone 上 0 错误。
- `pnpm -r run typecheck`（每 workspace 一个）退出码 0 或仅遗留 legacy 目录的 known errors（在簇 D 处理）。
- `git log --follow` 在迁入文件上仍能追溯历史。
