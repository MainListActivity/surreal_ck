Status: needs-triage
Label: needs-triage

# WP-A-04 — Electrobun 退役

## Parent

`.scratch/wp-restructure/PRD.md`

## What to build

- 删 `electrobun.config.ts`。
- 顶层 `package.json` 移除 `electrobun` 相关 dependencies / devDependencies。
- `.gitignore` 加 `build/`、`dist/`、`data/`、`.build/` 等 Electrobun 输出目录（若未已加）。
- 检查 `scripts/` 目录下是否有 Electrobun 专用脚本（如 `electrobun-init.*`），删除或挪到 `scripts/legacy/`。
- CI 配置（如 `.github/workflows/*.yml`）删除 Electrobun 打包步骤——若 CI 还没就绪则跳过。

## Acceptance criteria

- [ ] `grep -ri electrobun .` 在源码 / 配置中无命中（legacy 目录里的引用允许保留，因为内容还没搬完）。
- [ ] `pnpm install` 成功后 node_modules 不含 electrobun 包。
- [ ] CI（如果已就绪）通过；如果 CI 还没有，本 issue 仅要求"不再尝试调 Electrobun"。

## Notes

- legacy 目录里的 `Electrobun.something` import 暂时报错可以接受；簇 D 在迁入业务代码时同步替换为 HTTP / WS 调用。
