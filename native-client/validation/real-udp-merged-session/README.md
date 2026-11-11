# 整合同会话真实 OS UDP：独立桌面执行验收

2026-11-10T23:00:16Z，HEAD a39f2e14d7593545bbc2666af12b20a3232432da。

结果：同一 dot 云电脑的 CUA Xfce 桌面终端实际运行指定 ignored 用例，1 passed、0 failed、退出 0，0.53 秒。文件事件队列真实背压时，媒体停止耗时 7.377887ms。双向中文聊天、82,057 字节文件与独立 SHA256、三路 SRTP/双视频 RGBA、损坏文件拒绝、ACK 背压取消和迟到 ACK、停止后帧拒绝、关闭后发送拒绝全部通过。

## 执行与溯源

实际命令见 command.txt；通过新建终端窗口 37754831 执行 run-desktop.sh，timeout 60s。未操作其他终端或浏览器；验收后关闭该终端并核对窗口不存在。系统为 Linux 6.18.57 x86_64，FFmpeg /usr/bin/ffmpeg。桌面 /sys/class/net 不存在，首次只读 ls 因而没有提供接口证据；随后使用 Python socket.if_nameindex()，接口名称为 lo、eth0、eth1。未收集地址、SDP 或 token。

二进制 native-client/target/debug/deps/one_to_one_session-a63ad52b874eb132 SHA256：f7d0ba0463789852af48a0532bf6c7e37b5a561b56c63a86f07403dda66c6c3f。
测试源 native-call/tests/one_to_one_session.rs SHA256：2507c49d9f6c6ecc660e9ae85c612d5d6289ef4bd0f702c3ab4c869e3f49a3ea。

input-receipt.json 保存测试/本地库源码、合成fixture、Cargo fingerprint 和 dep-info hash；desktop-input-sha256.txt 是桌面执行前核对。执行后所有已记录输入hash不变，见 post-check.json。

使用原标准 Cargo 参数独立 --no-run 核验：CARGO_HOME=<probe>/cargo，RUSTUP_HOME=<probe>/rustup，PATH 包含 cargo/bin，CARGO_TARGET_DIR=<repo>/native-client/target，CARGO_INCREMENTAL=0，CARGO_BUILD_JOBS=1；cargo test --offline --locked --manifest-path native-call/Cargo.toml --test one_to_one_session --config 'profile.test.package.surreal-ck-native-call.debug=0' --config 'profile.test.package.surreal-ck-native-call.strip="debuginfo"' --no-run。0.22 秒完成，返回确切同一 binary，exit 0，见 cargo-fresh-no-run.log。

此前核验误用了全局 CARGO_PROFILE_TEST_DEBUG=0 / CARGO_PROFILE_TEST_STRIP=debuginfo，触发第三方依赖重编；当即 Ctrl-C，退出130，未运行测试，未覆盖指定二进制。该未完成构建日志保留为 cargo-no-run.log，不计成功。后续使用上述正确 per-package 参数核验。

## 结果边界

这是同云电脑的独立 CUA 桌面执行平面验收。原 RUNTIME-E2E.md 中主 exec 平面 ICE gathered no candidates 失败保持原样，并经hash核对未改。不得把旧失败改称通过。

两端均在同机；真实 OS UDP、ICE/DTLS/SCTP/SRTP。real_udp 分支直接 Chat::new(Route::Direct, vec![])，未注入虚拟网络，无外部 STUN/TURN。仅合成 FFmpeg 输入，无摄像头/麦克风采集、无扬声器播放。未更改网络/安全权限，未用 ptrace/strace、外部设备或生产身份。

这不证明双机、公网 NAT、TURN、IPv6、真实设备、声画同步、完整 GUI 操作或企业生产身份链路。无生产源码改动、无提交或发布。

工具输入记录：初始 clipboard paste 超时后检查空终端，确认未执行；使用同一终端的普通键盘输入完成。exit 后输入API返回窗口已消失错误，之后窗口列表确认关闭成功。二者均为UI操作状态，不是网络或权限拒绝。
