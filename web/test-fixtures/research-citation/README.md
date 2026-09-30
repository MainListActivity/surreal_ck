# 研究引用回链夹具

运行 `rtk proxy pnpm --filter @surreal-ck/web exec vite --config test-fixtures/research-citation/vite.config.ts`，打开 `http://127.0.0.1:18524/` 并点击研究引用链接。

加载真实 ContentReaderScreen 与引用回链/摘要核验函数，仅替换已授权内容阅读会话和当前 workspace。链接固定 `a-v1`，页面应出现“研究引用的精确位置”及“第一条 设备须定期检查。”，无前言。`?mismatch` 的链接摘要错误，不能显示已核验引用片段。

该夹具不访问生产，不证明真实账号登录或线上内容许可；数据库会话授权另由研究真实引擎测试验证。
