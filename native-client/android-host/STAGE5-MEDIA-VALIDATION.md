# 阶段五媒体实验APK（2026-11-10 UTC）

- 文件：`build/SurrealCK-stage5-media-test-only.apk`
- SHA256：`c936aad378916ff0edca7bfa758ae4c90d93f8961a03f02bf70eadf0e303a569`
- 大小：131,887,861字节。
- 构建基线：ef58a7e 加本次阶段五源码改动。启用实验宿主的 `android-native-media` feature；普通APK默认仍关闭。
- 使用既有测试签名，不是生产发布身份。没有覆盖阶段三 ab2e3d99 APK。

## 已验证

真实 arm64-v8a / x86_64 release 链接完成；packager检查更新、SAF与媒体全部JNI动态导出、实际DEX类、manifest、原资源保留、v3签名及16KiB对齐。真实API35 Java严格编译、JNI队列/状态测试与纯Java许可代际和停止边界测试通过。

客户端Linux集成39项测试与严格clippy通过。它们包括企业身份切换、手动中继、默认不采集、停止未确认和窗口滚动；不是Android硬件或系统权限验收。

## 尚未验证

这个新哈希APK的启动、Provider实际初始化、系统权限、Camera2/AudioRecord/MediaProjection、前台服务、MediaCodec/Surface和两设备P2P均未取得通过证据。旧APK的一次安装成功不能沿用到本包。独立只读模拟器验收仍在进行，结果另行补充。

所有设备与远端播放默认关闭。打开原生通话Activity不等于批准权限或开始采集；Stopping与Unconfirmed不被当作已释放。媒体/文件不经应用服务器中转。

生产更新信任配置仍未提供，本APK会保持启动门禁，不能由安装或打包成功推导业务可用。没有为验收添加绕过按钮、自动许可或隐藏入口。

## r2：再次打开窗口时不误报设备已停

后续补丁仅修改NativeCallActivity初始化提示：若前一采集owner仍存在，明确显示“尚未确认停止”，而非“尚未启动”。对应产物为 `build/SurrealCK-stage5-media-r2-test-only.apk`，131,887,861字节，SHA256 `4a2c491d5974545f3de4deef08641ecaf9caf8b7fc73c28377641f8267cb23b8`。真实Java严格编译、纯安全边界测试与打包静态验证通过。r2尚未安装，不继承c936 APK正在进行的运行检查。
