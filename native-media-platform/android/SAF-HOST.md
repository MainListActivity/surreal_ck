# Android SAF 宿主桥

`documents/` 是可合并进入 NSH APK 的原生文件桥，非完整文件传输 UI。`documents-manifest.xml` 中 Activity/Provider 均不导出，不申请广泛存储权限，也不把 content URI 假装成路径。

- Rust 桥：`native-client/src/android_documents.rs`，由应用 crate 编译，独立 Android host 保留 JNI 符号；Provider 初始化真实 Context/JavaVM，保留 NSH 的 JNI_OnLoad。
- 用户前台操作后调用 `open()`，系统 ACTION_OPEN_DOCUMENT 授予仅选中文档访问。后台有界复制到私有 cache，保留安全的文件名，返回 `imported` 和真实路径。每文件最多 256 MiB，不自动发送。导入前预留完整256MiB，使总私有导入缓存最多512MiB，超额拒绝而不删除活动文件。`release(Context,String)` 仅清理桥生成的UUID目录下规范普通文件，拒绝符号链接/越界；宿主在发送结束、取消或选新文件时调用。
- `save(path)` 仅接受真实 filesDir 下已完成、已经完整校验的文件，系统 ACTION_CREATE_DOCUMENT 让用户选择导出位置。成功关闭输出流才报告 `exported`。不自动打开；原始私有文件保留，宿主决定何时清理。
- `poll(id)` 空返回代表 pending；终态 JSON `state/path/detail` 只消费一次。取消为 `cancelled`，异常为 `failed`。同一时刻最多一个选择请求，最多16条未消费结果。
- 云端/文档提供商可能在失败时留下部分导出文件，错误明确提醒；不自动删除用户文档。导出流关闭并不能证明云端已完成远端持久化。

## UI 接线限制

桥模块已移至应用 crate，宿主只引用其 JNI 入口；不能再编译两份独立静态状态。UI 接线由主客户端负责，下面描述必须保留的语义。

接收协议目前路径事务在私有文件完整校验后才完成。若加入 SAF 导出，界面必须区分“已收取到私有暂存”与“已导出至用户选择位置”，不得在用户取消导出时声称导出成功。不能让原有原子 rename/新文件约束假装适用于任意 SAF provider。超时/进程死亡需由 UI 结束等待并让用户重试；当前没有跨进程恢复承诺。

## 检查

`ANDROID_HOME=/path/to/sdk sh native-media-platform/scripts/check-android.sh` 编译媒体和文件 Java，API35 Android bootclasspath + Java8 `-Xlint:all,-options -Werror`，不以桌面JDK类库冒充Android运行库。

编译或 DEX 存在不等于设备验收。必须在设备逐项测试：用户取消、拒绝提供商访问、空文件、未知大小与超限文件、导出异常、旋转、进程重建、重复请求、选新文件和临时副本清理。摄像头/麦克风/屏幕共享未因文件桥获得权限或前台服务支持；媒体类打进 DEX 不等于完整视频通话。
