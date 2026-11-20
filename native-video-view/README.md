# NSH 原生视频视图

这是实际 RGBA 帧到平台原生纹理的组件，不是浏览器播放器，不经 PNG/JPEG 编码、data URI 或 NSH JSON 传递逐帧像素。当前启用 **Linux GTK4 / GdkMemoryTexture**。另有默认关闭的 macOS AppKit、Windows Direct2D 实验后端源码，尚未通过目标平台原生构建/画面验收。默认构建的支持声明 `rendering_supported()` 仍仅 Linux；macOS/Windows 必须额外启用默认关闭的 `experimental-host` 门闩与匹配后端。该显式实验接线不代表平台构建或设备验收完成。Android 渲染器仍未实现。

## 数据和生命周期

- `open_stream()` 返回可跨线程克隆的 `FramePublisher`。创建流不获取摄像头、屏幕、麦克风权限，也不启动媒体进程。
- `RgbaFrame::packed(width, height, bytes)` 接收现有解码器的 RGBA `bytes::Bytes`。像素顺序为 R/G/B/A，非预乘，从左上角开始。`new` 另支持带 padding 的行跨度。
- 构造边界验证非零尺寸、最大 4096 边长、精确缓冲区长度、行跨度及单帧 32 MiB 上限。进程最多同时注册 32 条流。
- 每条流只保留最新一帧。生产者覆盖积压帧，不创建逐帧 UI 消息或等待渲染。每个视图独立记录序号，显示器刷新时最多上传一帧；旧帧在纹理和邮箱都释放后回收。
- `FramePublisher::close()` 幂等，清空邮箱并拒绝后续帧。最后一个 publisher 克隆析构也关闭流。接收端保留引用不会让生产者继续存活。
- GTK UI 线程唯一持有 `Picture`、`MemoryTexture` 和 tick 回调。组件析构移除 tick、清除纹理、释放接收端。关闭流后下一次映射中的 UI tick 清画面；隐藏视图恢复时也先处理关闭状态。
- `streamId` 改绑会先清空旧图；错误不会继续显示上一位对端。`ready` 事件只在首帧/分辨率变化触发，不逐帧触发。关闭发 `closed`，无效流发 `error`。
- 没有采集源时不生成替代帧。测试中的小缓冲区仅测试长度、队列、并发和释放，不是演示视频源。

## 客户端接线：固定使用 NSH 0.4.0

客户端的普通 dependencies 中添加：

```toml
surreal-ck-native-video-view = { path = "../native-video-view", features = ["linux-gtk"] }
```

`linux-gtk` 的平台依赖只在 Linux 编译，其余平台仍可编译帧边界。若只启用于可选 feature，必须保证打包宿主也启用它，不能只在手写 `main` 的 `desktop` feature 下存在。

**发行宿主与 NSH 生成的 runner：** 必须在应用 **根 lib.rs** 放注册宏，不能只放 `main.rs` 或嵌套模块：

```rust
#[cfg(target_os = "linux")]
#[nsh_core::element::native_components(linux)]
fn video_components(components: &surreal_ck_native_video_view::linux::Components) {
    surreal_ck_native_video_view::linux::register(components);
}
```

安装的 NSH 0.4.0 在 `nsh_core::element` 和 `nsh_core::prelude` 导出此宏；常规应用已有 `use nsh_core::prelude::*` 时可直接写 `#[native_components(linux)]`。

**手写桌面 main：** 在 `run_app` 前注册至传入的 options，或 `nsh_platform_linux::set_components(surreal_ck_native_video_view::linux::register)`。不要以为根宏会自动改写自定义 main：

```rust
let components = nsh_platform_linux::Components::default();
surreal_ck_native_video_view::linux::register(&components);
let options = nsh_platform_linux::AppOptions {
    components,
    ..Default::default()
};
```

**视图：** 先建立 publisher，再传流标识；摄像头和屏幕共享应分开建立流。仅在 `rendering_supported()` 为 true 时挂载：

```rust
let publisher = surreal_ck_native_video_view::open_stream()?;
let stream_id = publisher.id().to_owned();
let element = nsh_core::element::native(surreal_ck_native_video_view::COMPONENT_NAME)
    .prop("streamId", serde_json::Value::String(stream_id));
// 对 element 设置明确宽高/布局；像素不会通过 prop。
```

**解码边界：** 在既有媒体任务里发布真实解码结果：

```rust
let bytes = decoder.read_rgba().await?;
publisher.present(surreal_ck_native_video_view::RgbaFrame::packed(
    u32::from(video.width), u32::from(video.height), bytes,
)?)?;
```

`decoder` feature 还提供 `decoder::read_and_present`，它读取一帧并发布，不启动无归属任务。媒体任务必须负责供包、超时、取消、FFmpeg 退出和 AV 同步；本模块不替代 jitter buffer、网络拥塞控制或媒体协议。挂断、断线、切换对端时及时 `close()`，再取消媒体任务，防止旧会话图像留在界面上。重新通话必须创建新流，旧 ID 永不复用。

## Android 0.4 的真实扩展点

安装的 `nsh-platform-android-0.4.0/java/com/longbridge/nsh/NshComponent.java` 定义 `view()`、`setProp(...)`、`destroy()`。宿主必须在加载根组件之前调用：

```java
nshView.registerComponent("surreal-collaboration/rgba-video", context -> /* NshComponent */);
```

这里的工厂必须创建真正 SurfaceView/TextureView 等原生视图，并实现有界帧/Surface 的线程桥及 `destroy()` 清理。NSH 0.4 的 `#[native_components(...)]` 只接受 windows、macos、linux、ios，不能写 android。Java 注册不能被 Rust UI 注册表或单纯 JNI 符号代替。本 crate 尚未提供 Android JNI/Surface 后端，不能声称 Android 已可见播放视频。

## 校验

```sh
cargo test --manifest-path native-video-view/Cargo.toml
cargo check --manifest-path native-video-view/Cargo.toml --features linux-gtk,decoder
cargo clippy --manifest-path native-video-view/Cargo.toml --all-targets --features linux-gtk,decoder -- -D warnings
```

Linux 编译要求 NSH 0.4 的 GTK 4.14+ 开发库。17 项边界/并发测试不需要显示器。GUI 运行、真实屏幕、摄像头、两机通话仍需在图形桌面及真实设备验证；当前云环境无法提供可靠 GUI，不能把编译或单元测试当成可见画面验收。

2026-11-10 已执行：17 项测试全部通过；Linux `linux-gtk,decoder` check 与全部 targets 的严格 clippy 通过；`cargo fmt --check` 通过；Android aarch64/x86_64 的 `--all-features` check 通过（仅验证跨平台帧核心及 feature 隔离，不代表 Android 渲染器实现或运行）。没有执行真实 GUI/设备验收。


## 实验 macOS / Windows 后端

两个后端复用相同的 `FramePublisher`、`streamId`、`ready` / `closed` / `error` 事件及容量一帧边界。`default = []` 没有改变，Linux 路径没有改变，应用客户端只在显式实验 feature 下注册这两个后端，默认发行仍不启用。

- `macos-appkit`：公开 `surreal_ck_native_video_view::macos::register(&macos::Components)`。`NSImageView` 等比例居中显示，RGBA 直接写入 AppKit 自有 `NSBitmapImageRep` 并交给 `NSImage`，不调用任何图片编码器。主 RunLoop 的 60 Hz `NSTimer` 保留最新快照，只在可见视图上创建原生图像；隐藏时也处理关闭并清除旧图；目标 selector 仅弱引用视图，析构时先 invalidate timer，再释放图像与接收端。没有跨线程持有 AppKit 对象，也没有要求 Send 的 block 捕获 Rc。
- `windows-d2d`：公开 `surreal_ck_native_video_view::windows::register(&windows::Components)`。在 NSH 提供的 UI 线程 `ID2D1DeviceContext` 上创建/复用 `ID2D1Bitmap1`，把直通 RGBA 转成 Direct2D 支持的预乘 BGRA，`CopyFromMemory` 上传后 `DrawBitmap` 等比例居中绘制。检查设备对象，设备或分辨率变化时重新创建位图；旧帧、转换缓冲和 GPU 位图数量均有界。通知线程不持有 COM 对象，每次最多提交一个尚未消费的重绘通知，析构可立即取消并 join。

两个实验后端的默认固有尺寸都限制在 320×180 以内，不会按对端高分辨率撑大布局；宿主仍应给明确宽高。`ready` 只表示已把帧交给原生绘制对象，不等于显示器呈现或真实设备验收。

### 官方 0.4 API 核验

本实现读取了 crates.io 发布版本，不使用 NSH 最新 HEAD 的接口。发布归档与既有客户端锁文件的 SHA256 一致：

- [nsh-platform-macos 0.4.0 官方归档](https://static.crates.io/crates/nsh-platform-macos/nsh-platform-macos-0.4.0.crate)：`6e6f8b7c6e28d04c50c89c0d14482f66890d54edfed46418e2a7ba8c6d6786d6`。`NativeComponent::view()` 返回 `Retained<NSView>`。
- [nsh-platform-windows 0.4.0 官方归档](https://static.crates.io/crates/nsh-platform-windows/nsh-platform-windows-0.4.0.crate)：`5058703e4e6f4beef699f9eb75434455f973d58d36a21658161cae89cea433fd`。`NativeComponent::draw(&ID2D1DeviceContext, (f32, f32))` 提供视图局部坐标和裁剪，`ComponentContext::redraw()` 可从通知线程触发。

Windows 上游 NSH 0.4 无条件依赖 `webview2-com`；本组件只使用 Direct2D，不创建 WebView，也不调用该依赖。不能把“未使用 WebView 绘制”说成“整个上游依赖树没有 WebView 库”。

### 目标构建与未来接线

必须先在对应原生 runner 验证，不应只在 Linux 打开所有 feature 后就认为其它目标已编译：

```sh
# macOS ARM / Intel runner，安装 Xcode/Command Line Tools 和对应 Rust target
cargo check --manifest-path native-video-view/Cargo.toml --features macos-appkit
cargo test --manifest-path native-video-view/Cargo.toml --features macos-appkit
cargo clippy --manifest-path native-video-view/Cargo.toml --all-targets --features macos-appkit -- -D warnings

# Windows MSVC runner，安装 Visual Studio C++ 与 Windows SDK
cargo check --manifest-path native-video-view/Cargo.toml --features windows-d2d
cargo test --manifest-path native-video-view/Cargo.toml --features windows-d2d
cargo clippy --manifest-path native-video-view/Cargo.toml --all-targets --features windows-d2d -- -D warnings
```

原生 runner 可通过显式实验 feature 验证目标后端和宿主接线。宿主需同时启用匹配后端与 `experimental-host`，在根 `lib.rs` 使用 `#[nsh_core::element::native_components(macos)]` / `#[nsh_core::element::native_components(windows)]` 注册，并为手写 main 设置 `AppOptions.components` 或 `set_components(...)`。默认发行启用之前，仍须完成对应目标的完整构建和真实设备运行验收。

目标平台运行验收至少覆盖：真实解码颜色/方向、contain 和高分辨率限制、视图隐藏/恢复、改绑时立即清除上一对端、关闭和断线、反复挂载/卸载、慢 UI 下有界内存，以及 Windows 设备重建后的纹理恢复。不得使用假设备视频替代上述验证。


### 本轮可复现验证与缺口

新增 `tests/platform-api/` 是独立系统 API 检查入口，直接包含生产 `appkit.rs` / `direct2d.rs` / `redraw.rs`，并依赖真实 `objc2` / `windows` crate 和本 crate 的实际帧核心。它不包含或替换 NSH trait、宿主、注册表，也没有假实现；不运行设备或图形窗口。

```sh
cargo clippy --manifest-path native-video-view/tests/platform-api/Cargo.toml \
  --target aarch64-apple-darwin --features macos-appkit -- -D warnings
cargo clippy --manifest-path native-video-view/tests/platform-api/Cargo.toml \
  --target x86_64-pc-windows-gnu --features windows-d2d -- -D warnings
```

2026-11-10 验证结果：上述两项针对实际绘制源码的目标 API 检查及严格 clippy 已通过；25 项通用测试通过（原17项帧边界，加8项像素转换/contain/合并通知与析构测试）。完整 NSH 宿主跨目标检查未通过环境前置：Apple 目标停在上游 `ring` 的 C 编译，云机没有 Apple SDK 标准头；Windows GNU 目标缺少 `x86_64-w64-mingw32-gcc`。未尝试用宿主 Linux 库或伪造 SDK/NSH 接口绕过这些限制。

因此：绘制实现的系统绑定已做目标类型检查，薄 NSH 注册适配器仅按官方0.4签名审阅；完整 macOS ARM/Intel、Windows MSVC 编译和链接仍待目标 runner，实际窗口/设备/两机通话仍未验收。平台 CI 和运行验证前，两个实验后端与客户端 opt-in feature 继续默认关闭；手动启用只进入实验路径，不代表已经验收。


### 注册接入审查与启用门槛

`tests/registration.rs` 使用真实发布版 NSH 0.4 宏和平台类型，不复制或伪造 `NativeComponent`：在测试 crate 根展开 `native_components(...)`，实际调用生成的 `__nsh_native_components_<platform>`，核验精确组件名、注册表克隆共享与独立宿主隔离、重复注册替换、`AppOptions.components` / `set_components` 回调类型，以及 `ComponentContext: Send + Sync` 与 `experimental-host` 支持门闩。只登记工厂，不调用工厂、不初始化 AppKit/GTK/COM、不打开窗口或媒体设备。仅在目标系统与其 renderer feature 同时匹配时编译这三个测试。直接宏依赖 `nsh-core` 只随 renderer feature 启用，默认帧核心不依赖 NSH。

```sh
# Linux 对照，不要求有可用的显示器，但需要 GTK 构建/动态库。
cargo test --manifest-path native-video-view/Cargo.toml --features linux-gtk --test registration
# 对应原生 runner；已有 check-renderer.sh 的 cargo test 会自动包含它们。
cargo test --manifest-path native-video-view/Cargo.toml --features macos-appkit --test registration
cargo test --manifest-path native-video-view/Cargo.toml --features windows-d2d --test registration
# 显式实验宿主的同一契约；分别在对应平台 runner 上运行。
cargo test --manifest-path native-video-view/Cargo.toml --features macos-appkit,experimental-host --test registration --test support
cargo test --manifest-path native-video-view/Cargo.toml --features windows-d2d,experimental-host --test registration --test support
```

这些测试核验注册接线，不验证工厂执行、GUI 生命周期或像素呈现。`tests/platform-api` 仍只检查真实绘制源码，不能替代完整平台 crate 的测试。

宿主按以下同一组条件接线，单独开启某个依赖 feature 不应绕过客户端许可：

1. video crate 的 `macos-appkit` / `windows-d2d` 只编译后端。`experimental-host = []` 是独立、默认关闭的显式门闩；`rendering_supported()` 在 Linux GTK 保持原行为，在 macOS/Windows 则要求目标、后端 feature、门闩同时匹配。门闩不能单独启用不存在的渲染器，也不为 Android 开放支持。
2. 客户端 `experimental-macos-video` 转发 `macos-appkit` + `experimental-host`；`experimental-windows-video` 转发 `windows-d2d` + `experimental-host`。这两个 feature 不在 default 或常规 Release 参数中，也不由 `desktop` 隐式启用。
3. 客户端根 `lib.rs` 的 `native_components(macos)` / `native_components(windows)` 宏与手写 `main.rs` 的 `platform::set_components(...)` 使用相同的 `target_os` 和对应客户端 feature 条件。根宏不能仅放在 main 或嵌套模块；也不能靠二进制 `desktop` feature 代替，以免 NSH 生成的 runner 漏注册。
4. `call_bridge::video_supported()` 再以相同客户端目标/feature 条件与 crate 的 `rendering_supported()` 做 AND。这样 Cargo 依赖 feature 合并或直接打开依赖 feature，不会让未接线客户端误开放接收。远端音频/视频仍须独立显式允许；UI 对实验路径明确说明尚未设备验收。
5. 共用 UI 使用同一个原生组件名，分别传入摄像头和屏幕流，显示边界固定320×180；不需要替换成图像 URL。断线和关闭必须清流，真实解码帧到达不能等同于屏幕呈现。正常默认构建不改变这些行为。

可供目标 runner 验证的客户端命令如下，当前云机没有执行它们，不表示已可运行：

```sh
# macOS 原生环境
cargo check --manifest-path native-client/Cargo.toml --features desktop,experimental-macos-video
# Windows MSVC 原生环境
cargo check --manifest-path native-client/Cargo.toml --features desktop,experimental-windows-video
```

`tests/support.rs` 另外检查“仅门闩，没有匹配后端”的拒绝路径和各目标的支持条件，不打开窗口或设备。当前云机没有 Apple SDK 和 Windows C++ SDK/MinGW 编译器，完整 macOS / Windows 依赖图仍被上游 C 编译阻塞；`tests/platform-api` 的系统绑定检查或帧核心目标检查都不能替代完整 adapter/宿主构建。已有平台 CI 是验证入口，不是已经运行通过的证据。平台构建、真实解码画面、设备和两机通话验收完成前，不应默认开启实验 feature。
