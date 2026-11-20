# Android企业实验包stage9

源码提交9e9a60a09b6719657e9cf453b29e2d734e1e2777，构建和核验时工作树干净，全部跟踪输入前后匹配。显式启用media、OAuth及enterprise-collaboration；默认Release不变。

产物：native-client/android-host/build/stage9-9e9a60a/SurrealCK-stage9-9e9a60a-enterprise-test-only.apk

- 大小：138433269 bytes。
- SHA256：3dd52e5daf4380bd11f428f674b7f63d7c317749b16b1d79c634b337a86d60d1。
- 真实arm64/x86_64 release链接完成；Java严格编译、媒体/SAF/OAuth纯测试、9项打包器测试通过。
- 包内双ABI库与实际链接输出逐字节一致；全部JNI、实际DEX和manifest、现存测试key的v3签名、16KiB ZIP与ELF LOAD对齐通过。
- 没有新key、下载、删除旧产物、安装设备或更改生产配置。

此包仅用于验证，不是正式Release。启动仍需要有效生产更新策略与身份配置，不能通过安装成功推导业务可用；本轮没有运行设备界面、系统文件选择器、摄像头/屏幕、生产登录或真实升级。旧包的设备结果不能继承。

完整原始证据保留在产物目录；入库日志副本仅去掉尾部多余空行。该文档提交晚于构建源提交，不把包重标成文档提交。
