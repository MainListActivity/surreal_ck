# Linux 真实同机 UDP 验证

2026-11-10，使用云桌面的真实网络接口，而非虚拟网络模式，运行当前源码重编的 `encrypted_direct_data_channel_transfers_multichunk_file --ignored --exact`。

- 测试二进制 SHA256：`a4527b371fccef8a4b76a317bb2b829f25c400317f9a0c76da9947074d144f87`。
- 结果：1 passed、0 failed、0 ignored、3 filtered，0.13 秒，进程退出码 0。
- 两端均为同一云机内真实 Peer，`Route::Direct`，未配置或联系公共 STUN/TURN。
- 实际 IPv4 UDP syscall：132 次成功发送、130 次成功接收，目的地址均属于本机。
- ICE、DTLS、SCTP 完成后传输 65,659 字节合成文件并校验 SHA256，同时验证单条合成 RTP/SRTP 负载。
- IPv6 地址绑定未成功，因此本次不证明 IPv6 可用。

本次不是跨机器、公网 NAT 穿透、TURN 中继或真实摄像头/麦克风验收。它不经过业务 UI，也不绕过或解锁强制更新门禁。先前仅虚拟网络的测试结论不能替代本次真实 UDP 证据，反之本次也不能扩大为公网可用。

原始接口、测试输出、UDP syscall 和来源记录保留在独立构建证据目录 `linux-os-loopback-evidence-a4527b37`，未覆盖此前不同二进制的结果。测试二进制不是用户安装包。
