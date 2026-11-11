# 企业合成 VP8 闭环（源码阶段，未编译/执行）

只验证 local RECORD/company API → 真实 EnterprisePeer/EnterpriseCall/CallSession → OS UDP/WebRTC → FFmpeg VP8 decode → 原 FramePublisher → subscribe RGBA，以及成员撤销后的真实媒体关闭。没有摄像头、屏幕、麦克风、扬声器或 GUI 呈现验收。生产发布门禁不变。

## 精确测试边界

- generate.py 使用原样生产模块路径；enterprise_peer.rs 是生产原文件完整字节前缀加 peer-seam.rs。没有改写生产代码，也没有修改主工程。
- 唯一输入 seam 取现有真实 camera RTP track，写合成 VP8 sample。明确绕过 CaptureInput 与 Media.enabled，因此不证明设备采集或生产 Media.send gate。seam 自身拒绝撤销后输入仅是测试输入门。
- 输出 bridge::Update 仅保留 Media 与占位 Unused；不是 UI 接线验收。Call、EnterpriseCall、CallSession、原 sink、FramePublisher 和 subscribe 均为真实实现。
- 使用真实 linux-gtk 编译 feature，让原 video_supported 判断执行；不伪造 ready，不运行 GTK widget，不声称画面显示。
- 撤销测试在显式 Peer.close 前先等待两端真实 shutdown watch，要求原 FrameReceiver 已 Closed；真实 EnterpriseMediaHandle 必须拒绝再次开启。随后再等待 close 回执，读取逐源 capture/playback watch。capture 一直未启动，Stopped 不代表测试过设备释放。
- 真实帧断言要求 64×48 RGBA、alpha=255、红色容差、递增序号；关闭后多次 poll 只能 Closed。未以 write_sample 成功当作已收到帧。

## 计划执行

先核对源摘要。由协调者在单一构建窗口使用现有 native-client/target，不创建新 target。Cargo.lock 来自 native-client，首次添加新叶包仍可能需要更新 lock，不能假称 --locked 一定接受新包。

合成数据命令（尚未执行，输出需记录 SHA256 和 ffmpeg -version）：

    ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i color=c=red:s=64x48:r=10 -frames:v 4 -an -c:v libvpx -g 1 -deadline realtime -f ivf red.ivf

只运行这两个 ignored tests，要求列表和结果恰好 2 条：

    enterprise_peer::enterprise_media_e2e::authenticated_vp8_decode_publish_and_close
    enterprise_peer::enterprise_media_e2e::authenticated_revocation_closes_real_playback

运行环境需 MEDIA_E2E_IVF（合成文件绝对路径）、SURREAL_TEST_BINARY（已核验固定本地 fork）。真实 OS UDP 不可用必须失败，不回退 VNet。外层 run 超时 90 秒。

## 缓存和预算

生成源码与锁合计低于 1 MB。复用 native-client 现有 target 的 native-call、native-video-view/linux-gtk、transport/WebRTC 和身份依赖；新增 package 的依赖 feature 统一仍可能产生不同 fingerprint，未运行 Cargo 不能保证全部命中或给出准确峰值。只为本叶包设置 debug=0/strip，不修改全局 profile。预计叶包测试二进制为数十 MB 量级，但这是估计；若出现 GTK/WebRTC 大规模重编应停止，先重新核对 feature/profile。不得消耗整个约 1.7 GiB 余量。

## 输入证据绑定

prepare-input.py 是后续明确执行步骤，当前未运行。它只允许固定 lavfi 红色输入、4帧、全关键帧；记录实际 IVF、FFmpeg binary、命令和版本摘要，然后将 input-receipt.json 摘要绑定到 source-receipt.json。run.py 固定使用该输入，前后校验源/锁/输入/FFmpeg/测试 binary/fork 摘要并要求恰好2测试通过。不得把未生成输入称为已绑定实物证据。已有输入回执时 generator 拒绝静默重建。bridge::Update 是最小事件承载替身，不是完整 UI 路径证明。
