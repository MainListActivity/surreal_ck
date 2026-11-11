# 发布门禁脚本回归

2026-11-11 00:23 UTC，在提交61fdc0a工作区运行已有Python行为测试：readiness 10、collect 3、Android host打包9，共22项通过。日志见tests.log，脚本运行后源码哈希见source-hashes.json；此次没有声称构建前后receipt。

这些测试包括不可用/错签策略、错误下载字节、旧包补标拒绝与Android宿主边界。它们使用测试夹具，不是生产端点、Actions平台构建或已发布安装器验收。没有网络发布、签发密钥或更改默认Release功能。
