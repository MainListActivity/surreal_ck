# 企业合成VP8真实OS UDP闭环

2026-11-11 UTC。独立dot Xfce终端实际运行：2 passed，0 failed，13.21秒，TEST_EXIT=0、POST_HASH_EXIT=0。前后163项源码输入与素材、FFmpeg、测试binary、本地fork摘要一致。首次外部包装器使用不存在的python命令退出127，测试未执行；保留原记录，改用既有python3后执行相同固定二进制与输入。

## 实际验证

- local RECORD/company workspace API夹具、真实企业信令与EnterprisePeer/EnterpriseCall/CallSession。
- 同机真实OS UDP/WebRTC，固定64×48纯红合成VP8经真实FFmpeg解码，原FramePublisher/subscribe读取递增RGBA帧，校验尺寸、alpha与红色像素容差。
- 撤销成员后，在测试显式Peer.close之前等待两端真实自动shutdown；原FrameReceiver已Closed，真实媒体handle拒绝重新开启。随后close回执与逐源最终状态通过，后续poll持续Closed。
- 2个指定ignored用例实际运行，其余67个过滤用例未在此轮执行。

## 必须保留的边界

本目录是独立测试宿主，不是生产客户端或APK。原生产Peer字节前缀仅附加测试输入方法，从既有camera RTP track写合成样本，明确绕过设备CaptureInput和Media.enabled，不证明设备采集或生产Media.send拒绝逻辑。bridge::Update是缩小的事件承载替身，不是完整UI验收。

Call、EnterpriseCall、CallSession、解码、原sink与FramePublisher保持真实实现。linux-gtk编译能力门保留，但本轮没有创建GTK widget，不宣称屏幕上可见。没有摄像头、屏幕、麦克风、扬声器、生产OIDC、跨机公网TURN或真实设备释放验收。capture源始终未启动，Stopped只证明它未启动。

生产源码未修改，更新门禁未绕过。实际运行使用既有已核验fork 3.3.0-native-quota.1+sha.f30704bce914；root只用于本地合成夹具管理，业务使用RECORD主体。

## 构建与证据

build-result.json保留实际offline/locked构建命令、exit0和1GiB空间守护结果。最低剩余1,127,968,768 bytes，未触发停止。source-receipt.json记录离线Linux lock解析后的精确输入；全平台metadata因非Linux未缓存包离线失败，未下载，随后限定Linux解析通过。

测试二进制50,058,264 bytes，SHA256 c149fa2226a87461d38080ed91e715b4de11a1f1d87a8d96da1c9c35134ced50。IVF SHA256 3b8123a8456c9c06d9aa522e86de7334dbd8259cc4726272ab3d3d8a2be9235b。完整绑定见build/input/source receipt。

原始生成目录与日志保留在cloud工作区enterprise-signaling-media-e2e-harness；入库日志副本仅去尾部多余空行，生成器与回执中的绝对路径为当次位置。README-source-plan.md是执行前计划，不能用其中“未运行”状态覆盖本报告的实际结果，也不能据计划扩张验收范围。
