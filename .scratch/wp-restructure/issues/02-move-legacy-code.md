Status: needs-triage
Label: needs-triage

# WP-A-02 — 旧代码迁入 legacy 目录

## Parent

`.scratch/wp-restructure/PRD.md`

## What to build

用 `git mv` 保留历史地搬代码：

```
src/main/**      → server/legacy/**
src/renderer/**  → web/legacy/**
src/shared/**    → shared/src/**
```

`shared/src/index.ts` 重新导出原 `src/shared/` 各个模块，让 `@surreal-ck/shared` 既有内容可用。

不要立刻改任何 import 路径——簇 B/C/D 会逐步搬运 legacy 内容到正确位置时一并改。本 issue 只搬，让仓库 typecheck 暂时挂在 legacy 也可以接受。

## Acceptance criteria

- [ ] `src/main/` `src/renderer/` `src/shared/` 三目录消失，对应内容出现在新位置。
- [ ] `git log --follow server/legacy/<某文件>` 能看到原 `src/main/<同名文件>` 的提交历史。
- [ ] 根 `vite.config.ts` 暂时原样挪到 `web/vite.config.ts`（不修复，让 web dev server 暂时跑不起来）。
- [ ] `scripts/` 内容如有引用 src/ 路径的，**先不改**，记录到本 issue Notes，留给 A-04 处理。

## Notes

- 选 legacy 而不是直接放到 `server/src` / `web/src` 的理由：让"这是历史代码，待迁"的状态在文件系统层面可见；簇 B/C/D 会按需把它们提到正确层级。
- 移动后 `git status` 应该全是 R（rename），不应该有大量 D + A。
