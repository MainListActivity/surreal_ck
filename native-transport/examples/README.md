# Chrome ↔ 原生会议媒体互通工具

在同一台 Linux VM 上运行真实 `MeetingEdge` 和无头 Chrome，不用摄像头、STUN/TURN、数据库或登录。仅验证会议 V1 媒体的直连互通，不验证工作区信令鉴权或完整的入会流程。无认证 HTTP 邮箱仅监听 `127.0.0.1`，不要将它代理到外部。

## 复现

需要 Rust/Cargo、Node、pnpm、FFmpeg（含 `libvpx` / `libopus`）及 Chrome。从仓库根目录运行，Playwright 装在仓库外：

```sh
mkdir -p "$HOME/interop-logs"
pnpm --dir "$HOME/interop-logs" init # 仅首次执行
pnpm --dir "$HOME/interop-logs" add --save-exact playwright@1.61.1
export PLAYWRIGHT_MODULE="$HOME/interop-logs/node_modules/playwright/index.mjs"
export CHROME_BIN="$(command -v google-chrome)"

cargo build --locked --manifest-path native-transport/Cargo.toml --example meeting_interop_peer
node native-transport/examples/meeting_interop_drive.mjs offerer 8765 20 > "$HOME/interop-logs/native-offerer.log" 2>&1
node native-transport/examples/meeting_interop_drive.mjs answerer 8766 20 > "$HOME/interop-logs/native-answerer.log" 2>&1
```

每个命令都会启动原生进程及相反角色的 Chrome，并检查三个源在两个方向都收到至少 10 帧（Chrome 的 Opus 以入站 RTP 包计）。支持 `INTEROP_PEER` 指定自定义构建产物。原生 `sent` 统计提交给媒体发送通道的样本数，不等于对端确认；Chrome 的视频 `received` 取自 `framesDecoded`，不以无头渲染回调次数为准。

手动运行示例：`native-transport/target/debug/examples/meeting_interop_peer --role offerer --port 8765 --seconds 20 --expect microphone,camera,screen`。用带 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --disable-features=WebRtcHideLocalIpsWithMdns` 的 Chrome 打开 `http://127.0.0.1:8765/?role=answerer`；互换两端角色可测另一方向。原生进程默认交换媒体 20 秒、要求三路均收到至少 10 帧；`--expect` 可选择子集，空字符串不检查帧数。原生端从接通起循环发送 FFmpeg 编码的正弦 Opus 和两路 VP8，收到视频 PLI 时将对应视频流的下一帧重置为关键帧。

邮箱提供 `GET /offer`、`POST /answer`（原生发起）或 `POST /offer`、`GET /answer`（原生应答），请求及响应里的 SDP 均是原始 `{"type","sdp"}` JSON 字符串的内容，GET 在 SDP 就绪前返回 404。`GET /report` 返回原生收发统计。原生退出时也打印最终统计。

## 联调注意点

- Chrome 在两种角色中都优先选择 Opus / VP8。Chrome 的媒体段及 SSRC 级 `msid` track id 都会改为 `microphone`、`camera`、`screen`；原生接收按此识别。Chrome 接收则使用对端 SDP 的 `mid → msid`，不依赖事件顺序。
- Chrome 发起时创建三个 `sendrecv` transceiver；Chrome 应答时将本地轨绑定到远端 offer 建立的 transceiver，不另建三条。原生应答使用实际的 `MeetingEdge::answer`，没有额外映射或修改库。
- 两端等待 ICE 收集完成后交换 SDP。原生启用回环候选、禁用 mDNS；Chrome 的测试启动参数禁用 mDNS 地址遮盖。日志记录候选类型、选中的候选类型及最终直连结果；不会输出 SDP 内容。两端都校验会议信令的 49,152 字节 ASCII 限制。
