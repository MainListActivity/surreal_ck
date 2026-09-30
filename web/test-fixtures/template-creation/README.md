# 模板创建入口交互夹具

加载真实 `TemplatesScreen.svelte`，仅替换 workspace 权限、模板 store、写入 store 和无关规则弹窗；模板 DTO 转换仍用真实函数。数据库事务与权限另由 `src/lib/template-creation.integration.test.ts` 验证。本夹具不连接生产，不是全站端到端验收。

从仓库根启动：

```sh
rtk proxy pnpm --filter @surreal-ck/web exec vite --config test-fixtures/template-creation/vite.config.ts
```

打开 `http://127.0.0.1:18523/`，实际点击并观察：

- 默认选择“包含样例数据”。点击模板后，`document.body.dataset.input` 的 `options.includeSampleData` 为 true，`dataset.opened` 为 `workbook:ui_created`。
- 刷新、选择“创建空台账”后再点击，为 false；输入仍携带模板记录引用和数据表定义。
- `?mode=member`：样例选项和模板按钮 disabled，文字“需要管理员权限”。即使对 `.use-template` dispatch click，dataset.input 仍为空。
- `?mode=empty`：展示空模板说明，无创建按钮。
- `?mode=invalid`：字段定义转换失败，出现 role=alert 的中文“模板创建失败”提示，写入 store 未调用，按钮可重试。修复前该场景是未处理 rejection 且无 alert。

2026-09-30 已用 ego-browser 实际完成以上交互。测试夹具不会被正常 web/index.html 引入，不进入生产 bundle。
