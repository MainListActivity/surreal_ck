# 桌面媒体运行时随包交付评估（尚未接入默认发布）

## 结论与边界

当前安装包不含 ffmpeg/ffplay；仅在 CI apt/brew 安装它们不能满足用户安装后直接使用。此文与同名审计脚本不改变已有 package 脚本，不代表正式安装包已验证。Android 不适用桌面 FFmpeg 进程方案。

2026-11-10 核实来源：

- [FFmpeg 官方下载页](https://ffmpeg.org/download.html) 明确项目只发布源码，链接 Gyan/BtbN Windows 构建与 evermeet macOS 构建。
- [Gyan 构建页](https://www.gyan.dev/ffmpeg/builds/)提供 Windows x64 静态 ffmpeg、ffplay、ffprobe，9.0.2 essentials 有 libvpx、libopus、SDL2，适合当前子进程调用。该发行包是 GPLv3，不能标成 LGPL。当前发行要求 Windows 10 或以后。
- [固定 ZIP 的发布 SHA256](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256)：`60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`。
- [同版本发布及 FFmpeg 源码指向](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)给出上游 FFmpeg revision `946fcce07b`。这不能替代所有静态链接第三方库的对应源码/构建材料。
- [evermeet](https://evermeet.cx/ffmpeg/)提供 Intel ffmpeg/ffplay；其[ARM说明](https://evermeet.cx/ffmpeg/apple-silicon-arm)明确不提供 Apple Silicon 原生构建，因此不能拿 Intel 包冒充 aarch64。不可把 Rosetta 自动安装当作免依赖交付。
- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)与实际包内许可证是合规核验起点；分发时需保留适用许可证、版权、完整对应源码及构建修改说明。使用独立子进程不免除二进制再分发义务。最终合规结论需项目方审查，不能仅给上游首页链接就声明已满足所有义务。

## 建议实施顺序

1. Windows：对固定版本 ZIP 验证仓库固定 SHA256，提取 ffmpeg.exe/ffplay.exe 到 app 相邻 `media-runtime/bin`。保留整个发行包的 LICENSE/README；收齐 FFmpeg 与静态依赖的对应源码和构建脚本后，作为同版本 sources 包与许可证随发布保存。先在 Windows runner 做 PE 导入闭包审计、空 PATH 启动、VP8/Opus编解码及 ffplay SDL dummy 播放；再接 Inno 文件列表。安装包声明 GPLv3 第三方组件，不能改变项目本身许可证以代替合规审核。
2. macOS ARM/Intel：优先从固定官方源码构建最小 FFmpeg + libvpx + libopus + SDL（排除 nonfree 与不需要的 GPL codec），保留各来源归档哈希和构建参数。原生 CI 分别构建，不从 Homebrew 随意拷贝单个 executable。此方案比全面第三方 FFmpeg 静态包更易控制依赖和对应源码，但需真实双架构编译才能写入可交付锁清单。
3. macOS 运行时布局 `Contents/Resources/media-runtime/bin` 与 `lib`。用 otool 遍历全部 Mach-O，拒绝 `/opt/homebrew`、`/usr/local` 或构建目录绝对依赖；非系统依赖收进 lib，再以 `@loader_path`/已核验 `@rpath` 重写。SDL框架/资源亦须闭合。先签内部 dylib/executable，再签 app，再公证/DMG；重写后必须重签，不能复用旧签名。
4. Linux 当前明确依赖发行版 GTK4/GStreamer、FFmpeg/ffplay（libvpx/libopus、Pulse/V4L2/X11支持）。这仍不是“所有依赖随包”的安装形式，下载说明要写明。若后续做 AppImage，另行处理 LGPL/GPL 对应源码及 glibc/音视频系统边界，不把构建机依赖当成目标机已具备。

## 发布阻断条件

没有完整对应源码材料、真实平台执行结果或原生动态依赖闭包，不将运行时加入默认发布；SHA256 只能证明字节一致，不证明运行、版权或代码签名可信。

当前需要的决策是确认可分发 GPLv3 第三方组件及对应源码托管方式，或选择自行构建尽量 LGPL 的最小组件集；这不是要求购买、开账号或创建凭据。macOS/Windows runner 权限仍沿用父任务限制，不能借本任务规避被拒发布路径。

## 本地已完成的真实只读审计

Gyan 9.0.2 essentials ZIP 实际下载完成，114,768,076 字节，SHA256 与上方固定发布值一致。归档含 GPLv3 LICENSE 与详细构建 README；已提取 ffmpeg.exe/ffplay.exe 供审计，未运行、未进入应用包。objdump 确认为 Windows x86-64；两程序的静态 PE imports 仅需所列 Windows 系统/UCRT DLL，没有发现归档外非系统静态导入。此结论不覆盖运行时 LoadLibrary、可选硬件驱动或实际声音/显示设备。

- ffmpeg.exe SHA256：`3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec`。
- ffplay.exe SHA256：`befbbd00a25965365f7fb3eed6ad5aa5f805eb70fabc567883a006de3b26c06f`。

运行时执行、对应源码完整性与 macOS 双架构依赖仍未验收，不启用默认捆绑。

## App-local 查找与离线打包输入契约

`native-media-platform/src/desktop_runtime.rs` 现为桌面媒体三个生产子进程入口解析工具：
Windows `<app.exe 所在目录>/media-runtime/bin/{ffmpeg,ffplay}.exe`；
macOS `Contents/Resources/media-runtime/bin/{ffmpeg,ffplay}`。
Windows/macOS 不回退 PATH、不支持环境变量覆盖，不下载或运行安装器；缺失时返回可定位的安装错误。
Linux 保持已声明的发行版 PATH 依赖。路径测试可在 Linux 运行，但不是 Windows/macOS 运行证据。

打包器接口（调用者负责将已验证目录纳入完整安装包）：

```sh
python3 scripts/native-client/prepare-media-runtime.py \
  --source /reviewed/runtime-tree \
  --manifest /reviewed/runtime-manifest.json \
  --manifest-sha256 <独立固定的64位小写SHA256> \
  --platform windows --arch x86_64 \
  --destination /staging/app/media-runtime
```

macOS destination 是 `.app/Contents/Resources/media-runtime`，arch 分别使用 `aarch64` 或 `x86_64`。
目标目录必须不存在且位于输入目录外；校验失败不复制。脚本不下载或执行 ffmpeg/ffplay，只调用本机 objdump/otool 作静态检查。
复制后仍须做目标平台原生安装/无开发工具环境测试；macOS 在重写依赖后、最终签名前准备运行时。

manifest 是**审查后的构建输入**，不是自动产生的信任凭证：构建配置须独立固定其 SHA256，不能从同一可变下载处获取 manifest 与期望 hash 后视为可信。
必填结构：

- `schema: 1`、`platform: "windows"|"macos"`、`arch: "x86_64"|"aarch64"`。
- `release_approved: true`：发布负责人对来源、许可证和对应源码完成审查后才填写，脚本不能证明法律义务完整。
- `files`：运行时树内**每个**文件相对 POSIX 路径到 SHA256 的对象；包括全部可执行文件、DLL/dylib、许可证、源代码归档、构建材料和测试证据。不接受符号链接、额外文件或路径穿越。
- `origins`：所有供应链归档的 `url`（HTTPS）、固定 `version`、`sha256`；来源必须经人工验证为官方或可信发布者，不能靠填写字段自证。现有 lock 只提供待审计候选，不是 release manifest。
- `license_files`、`corresponding_sources`、`build_records`：非空相对路径数组，必须全部列入 files。静态链接依赖的对应源码和构建修改亦须包含，不能仅放 FFmpeg 首页链接。
- `native_test_evidence`：已列入 files 的 JSON 路径，含相同 `platform/arch` 及 `clean_path`、`vp8_roundtrip`、`opus_roundtrip`、`ffplay_dummy`、`device_backends_listed`，各为 `"passed"`。证据应记录真实 runner、执行命令、日志与时间；禁止用 Linux 的测试结果或模拟输出填充 Windows/macOS 证据。设备后端枚举仅查询编译能力，不能启动用户设备。

脚本检查两个主程序 PE/薄 Mach-O 架构、全树 hash 与静态导入闭包。Windows 非系统 DLL 必须位于 bin；macOS 仅允许系统路径和可解析的包内 loader/executable-relative 路径，尚不接受未经验证的 rpath。静态检查不覆盖运行时动态加载、硬件驱动、沙盒/TCC 或签名兼容性，必须保留原生测试门槛。

当前没有满足条件的 release manifest：Windows 缺完整源码/合规审查和原生运行记录；macOS 缺固定来源构建产物、两架构依赖闭包和原生测试。这是明确发布阻碍，不是脚本失败或新授权被拒。本次未下载/运行候选二进制、未触发摄像头/麦克风/屏幕权限、未创建凭据或发布。

### 正式 builder 的可选接线

`build-desktop-app.py` 及调用它的 Windows/macOS 安装脚本现消费三个环境变量：
`SURREAL_MEDIA_RUNTIME_SOURCE`（已审核运行时树绝对路径）、
`SURREAL_MEDIA_RUNTIME_MANIFEST`（清单绝对路径）、
`SURREAL_MEDIA_RUNTIME_MANIFEST_SHA256`（独立固定 SHA256）。三项必须全有；未配置时不捆绑，证据明确标记 `not-bundled / not-configured`。

stage 先完整验证输入，再复制到上述 resolver 路径并重新验证复制结果。
`desktop-build.json` / `desktop-package-evidence.json` 保留清单 hash、输入/复制静态审计、全树文件 hash、外部提供的原生测试证据 hash 与真实复制结果。seal 再检查运行时树没有改变；证据里的 `not-run-by-packager` 表示本打包器未执行媒体，不把供应商记录当成本次原生验收。

运行时须作为已完成必要签名的固定输入提交；当前 seal 拒绝准备后再修改媒体二进制（含重签），若重签应重新产生并审核清单。应用主程序签名不受此限制。媒体组件签名、安装后设备权限和完整应用动态依赖仍需单独验收，`release_eligible=false` 不变。此接线本身不填补目前缺失的真实合格运行时来源/原生证据。

## 固定官方源码的原生候选构建（独立 CI）

新增 `.github/workflows/native-media-runtime-candidate.yml`，支持手动触发及授权开发分支的媒体相关路径 push，在 `macos-15` ARM、`macos-15-intel`、`windows-2022` 三个 runner 原生构建。通过官方 setup-python 固定 Python 3.12，macOS 继续使用 runner 已有 clang/make/pkg-config/otool；Windows 的必要工具准备见下节，未满足工具校验则失败，绝不修改凭据。该 workflow 保存短期候选 artifact，不发布正式安装包，也不修改更新、签名或许可批准门。

`media-sources.lock.json` 固定官方源码的版本、URL 与实际归档 SHA256：FFmpeg 9.0.2、libvpx 1.17.0、Opus 1.6.1、SDL2 2.32.10。四份实际源码归档均在 Linux 研究环境完成 hash 与安全解包验证，但未在该环境运行目标平台二进制。FFmpeg 官网 tarball 本次返回 HTTP 503，因此采用官方 FFmpeg GitHub tag 归档，两个归档不能混用 hash。Opus hash 与[官方网站](https://opus-codec.org/downloads/)一致，libvpx hash 与[Homebrew 公式](https://github.com/Homebrew/homebrew-core/blob/master/Formula/lib/libvpx.rb)一致。SDL 来自[官方 release](https://github.com/libsdl-org/SDL/releases/tag/release-2.32.10)，FFmpeg 许可依据[对应 tag 的 LICENSE](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/LICENSE.md)。不执行外部二进制下载器，不追踪 latest。

本机原生调用示例（工作目录必须不存在）：

```sh
python3 scripts/native-client/build-media-runtime.py --platform macos --arch aarch64 \
  --work /absolute/new-build --cache /absolute/source-cache --download
```

Windows 使用原生 Python，并把已有 `C:\msys64\mingw64\bin`、`C:\msys64\usr\bin` 放在本次进程 PATH 前端；`--platform windows --arch x86_64`。没有 `--download` 时仅接受本地且 hash 匹配的源归档。构建路径不接受跨编译作为原生证据。源码中的包内符号链接会物化为普通文件/目录，避免 Windows 提权；对应源码保留原始归档字节。

实现范围：

- 禁用 FFmpeg GPL、nonfree、version3、网络和第三方自动探测，仅显式启用 VP8/Opus、必要 PCM/rawvideo/MJPEG/BMP/DV（含 gdigrab 的 BMP 与 AVFoundation PCM 格式）、IVF/Ogg、scale/aresample，以及 AVFoundation 或 DirectShow/gdigrab。libvpx 首版采用 portable C 后端，实际通话实时性能另验，不能由合成 smoke 推断。
- 静态构建四个媒体项目；SDL 禁用不需要的第三方音频和设备插件，Windows 请求静态 GCC/C++ runtime。仍以实际 imports 审计为准，出现额外 DLL、Homebrew dylib 或未解析 rpath 就失败，不自动从 runner 偷拷库。
- 原生 smoke 清空 PATH、清除继承的动态库注入环境，仅使用合成 testsrc2/sine 和 SDL dummy。实际通过 pipe 输入/输出检查 VP8 六帧 RGBA 长度、Opus PCM 长度及非静音、ffplay Ogg/Opus 自动退出、编译设备后端列表；绝不打开真实采集设备。
- 候选目录保留四份完整源码归档、上游 license/patent notices、精确脚本/锁、配置日志、静态审计和原生测试命令/结果、仓库 commit/runner OS/架构/UTC；每条 smoke 完成即落盘，失败保留部分日志和 failed 状态；全部 hash 绑定到 `candidate-manifest.json`。
- 无论构建是否成功，生成器都不会写 `release_approved=true`。成功结果仍需项目方审核许可证、完整对应源码/可重建性及工具链 runtime 义务，完成必要签名，再重新审查并固定清单后才能进入现有 stage。CI artifact 到期前亦须落实长期对应源码分发安排。

当前只证明脚本/合约测试及源码归档校验已通过；此文不宣称三平台原生构建已经成功，不用 fixture 的 smoke 结果生成候选清单。未产生人工许可或签名证据。

### 下载及失败诊断

下载前即创建 `build-records/provenance.json`、固定 lock 和构建脚本快照。`downloads.jsonl` 同时写入 artifact 与 CI 控制台，逐项记录官方源名、固定 URL、阶段、UTC、尝试序号、curl/HTTP 状态及错误。
下载使用系统 curl，禁用用户 curlrc，限制初始 URL 和所有重定向为 HTTPS，保留证书验证并要求 TLS 1.2 以上；连接超时 20 秒、单次传输 180 秒、每源最多三次。只对暂时网络错误/指定暂时 HTTP 状态退避重试；证书验证失败、hash 不符立即失败，不换源、不变 hash、不运行未验证源码。即使下载失败，已有记录也会由原 workflow 的 `always()` artifact 步骤保留。构建失败同样通过 finally 保存已有 config.log、FFmpeg ffbuild/config.log 等配置诊断；失败不会产生成功候选清单。

Windows 构建工具查找现限定到现有 `C:/msys64/usr/bin`（bash/cygpath/make）与 `C:/msys64/mingw64/bin`（gcc/g++/pkg-config/objdump），验证解析结果仍在对应目录并记录绝对路径。启动 shell、路径转换和 imports 审计均使用这些绝对路径，shell 内 PATH 仅含已核验 MSYS2 目录和系统目录；不会误启 System32 的 WSL bash，也不配置 WSL。下载使用 Windows System32 的原生 curl。write-out 格式放入 ASCII 临时文件，避免 Windows 参数转换破坏 `%{http_code}`；只有真实三位 HTTP 码记入 `http_status`，异常原始输出单独保留，成功下载返回非 HTTP 状态则直接失败。


### Windows 官方工具包准备（代码待审查，未执行安装）

真实 CI 证明镜像的 `C:/msys64/usr/bin/make.exe` 缺失，不能再以别处的裸 `make` 代替。独立候选 workflow 改用官方 [msys2/setup-msys2](https://github.com/msys2/setup-msys2/tree/ec48f7c5447b3140e2b088413ae3a55687bccb6e)，固定提交 `ec48f7c5447b3140e2b088413ae3a55687bccb6e`。采用官方支持的完整流程：`MINGW64`、`release:true` 在 RUNNER_TEMP 新建临时安装、`update:true` 更新这个临时 MSYS2、`cache:false`。不使用不受支持的手工 `-Sy` 部分升级，不更新主机 OS、不启动 WSL、不增加 job 权限。

该 action 提交固定官方基础发行版 2026-09-27，校验 installer SHA256 `ad336cccfda47758b5e15cda993fbba421115cb0b126697daef1ee4dfe37209f`。使用 install 输入安装以下明确包及必要依赖：

- `make`：上游 Makefile 构建。
- `mingw-w64-x86_64-gcc`、`mingw-w64-x86_64-binutils`、`mingw-w64-x86_64-pkgconf`：MINGW64 C/C++、链接/归档/objdump、pkg-config。
- `bash coreutils diffutils file findutils gawk grep perl sed`：上游 configure/libtool 和 libvpx rtcd.pl 所需标准工具。

上游 action 内部 `--overwrite '*'` 仅用于新建的临时 MSYS2 pacman 安装，不关闭签名验证，不作用于主机 OS/WSL。使用 MSYS2 默认官方镜像配置，参考入口为 `https://repo.msys2.org/msys/x86_64/` 与 `https://repo.msys2.org/mingw/mingw64/`。包版本由当次官方仓库解析，并非逐包版本冻结；构建 provenance 记录固定 action 提交、请求包实际版本、`pacman -Q` 完整已安装版本清单和已验证工具路径。工具查找绑定 action 返回的 job-local 根目录。官方安装若遇到证书/签名/访问或权限阻碍，直接停止，不绕过验证或改变系统安全。

workflow 在原生构建前运行 `test_media_native_build.py`。主安装器 push/PR paths 只排除五个独立候选输入（build-media-native.sh、build-media-runtime.py、media-sources.lock.json、smoke-media-runtime.py、test_media_native_build.py）；正式 packager 消费的 media-runtime.py/prepare-media-runtime.py 以及身份、更新器仍触发完整安装器验证。
