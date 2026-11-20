# Android 实验 OAuth 宿主

本桥只提供系统浏览器与内存回调通道，不进行注册、登录、令牌存储或绕过更新门禁。
候选回调 `top.maplayer.collaboration:/auth/callback` 尚未在身份提供方注册；默认关闭实验 feature。manifest 片段必须显式加入未来实验包，本轮不重打包。

- 独立非导出 AuthInitProvider 初始化 JVM/Context；导出 AuthCallbackActivity 仅接收 ACTION_VIEW/BROWSABLE 外部数据，不打开业务界面。
- Android scheme intent-filter 不能可靠约束无 authority 的 URI 路径，因此 Java 和 JNI 双重检查原始 URI 的精确前缀、无 fragment 与 16KiB 上限。该检查不是登录验证。
- AndroidReceiver 在浏览器打开前绑定唯一内存路由。仅允许打开该 LoginAttempt 自身的 authorization URL，Java 只允许 HTTPS。
- bounded 4 项回调候选由权威 LoginAttempt 验证完整 redirect/state/issuer/重复参数/时限。错误候选不消耗 attempt；有效成功或拒绝回调只返回一次，由 finish_async 再次校验并消费 attempt。
- Drop/取消关闭本代路由，旧代 Drop 不影响新代。进程重建无 pending attempt，导入回调即拒绝。没有持久化 URL/state/code，也不记录它们。
- 自定义 scheme 可能被其他应用抢占，不是 verified App Link。PKCE/state 必须保留；远端注册必须由获准流程另行完成。
- 纯路由/URI测试只证明本地状态与解析边界；没有真实浏览器返回/Android Activity生命周期验收。不继承任何旧 APK 设备结果。

## 显式构建/打包接口（默认关闭）

- `ANDROID_NATIVE_OAUTH=1 scripts/native-client/build-android-host.sh` 仅给实际宿主构建追加 `android-native-oauth`；可与 `ANDROID_NATIVE_MEDIA=1` 组合，两者独立，默认均为 0。
- 打包必须同时显式传 `--enable-experimental-oauth` 和 `--manifest-fragment native-media-platform/android/auth-manifest.xml`，并将实际 auth Java 目录纳入 `--java-source-dir`。只传一方会失败。原有媒体/SAF片段接口不变。
- 打包器严格限制 OAuth 组件属性和唯一 VIEW/DEFAULT/BROWSABLE 自定义 scheme filter，仅 callback Activity 可以 exported=true，Provider 必须私有。未来若调整回调注册或组件属性，必须重新审阅白名单与测试，不能靠宽泛 exported 放行。
- 两 ABI 的真实动态导出必须同时包含 AuthInitProvider_initialize 和 AuthBridge_callback；实际 DEX 类表必须含 callback/provider/bridge/URI validator。源码文件存在不是通过依据。签名与原资源保留校验沿用原流程。
- 此次仅修改脚本并运行负例，不重链接、不生成新 APK。现存 stage6-8e2c43e、c936、r2 APK 均不包含 OAuth 宿主，不可沿用其静态或设备结果声称 OAuth 已打包。
- 不自动设置生产 OIDC issuer/client ID/redirect，不注册远端应用、不进行登录。
