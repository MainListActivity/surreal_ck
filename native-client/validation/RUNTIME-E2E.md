# 协同客户端隔离运行验证

2026-11-10；源码基线 `a3b89605996df66c0268eea8af21ad5f99bc1c6d`；独立分支 `test/collaboration-runtime-e2e`、独立工作树 `/workspace/scratch/115bfa675150/collaboration-runtime-e2e`。本轮没有修改原客户端工作树或共享构建目录，也未更改生产更新门、信令可用性、SQL或数据库。

## 实际运行结果

**45 项通过；1 项真实 OS UDP 用例失败，原因是当前执行环境 ICE 无候选地址。没有证明可交付客户端端到端可用。**

| 用例 | 实际结果 |
| --- | --- |
| 同一虚拟网会话的聊天、文件、三媒体轨闭环 | 1 通过 |
| 传输模块与安全文件接收 | 20 通过 |
| 实际 DTLS 证书核对与失效会话负例 | 4 通过 |
| FFmpeg → 虚拟网 WebRTC → 视频解码与缺设备负例 | 2 通过 |
| 通话停止、取消、隐私状态及迟到命令负例 | 18 通过 |
| 同一真实 OS UDP 会话闭环（显式 ignored） | 1 失败：ICE gathered no candidates |

同会话测试实际完成：双向中文和 emoji 收发；接收方明确接受前不传文件内容；82,057 字节跨块传输、独立预计算 SHA256、双方完成事件、真实无覆盖文件发布；摄像头/屏幕两条合成 VP8 轨解码成 320×180 RGBA；合成 Opus 通过 SRTP 到达并由入站统计确认。音频保持不播放，未把统计到包解释为听到声音。

同一连接的负例包括：篡改文件块后 SHA256 拒绝发布；文件 ACK 背压下聊天继续、媒体停止约 4.9ms；取消后无残留临时文件；迟到 ACK 不继续传输；停止后无 RGBA 交付；关闭后聊天、文件和三媒体轨全部拒绝发送。额外回归实际运行符号链接/FIFO拒绝、目标存在不覆盖、父目录替换不重定向落盘、真实证书不匹配拒绝、满事件队列仍撤销会话、缺摄像头不启用源等用例。

本轮未发现这些已运行路径中的新生产代码失败；改动是扩展既有集成测试，让同一套断言能显式选择 OS UDP，并保留环境失败证据。

## 编译与验证方式

磁盘仅余约 1GB，未运行会写入原共享 target 的 Cargo 命令，也未全量重复编译依赖。以 Rust 1.99.1，按既有 Cargo fingerprint 精确解析只读第三方 rlib，**从独立工作树当前源码重新编译** native-transport、native-media-platform、native-call 和各测试二进制；所有输出进入独立证据目录。该方法不是一次新的完整 Cargo/平台构建。

变更测试通过直接 clippy-driver `-D warnings`、rustfmt check 和 git diff check；四组额外回归也以 `-D warnings` 编译。build-receipt 记录确切命令、源码/依赖和输出 hash；结果收集时重新核对输入仍一致。原始日志、构建及回归脚本见 [runtime-e2e-a3b8960](runtime-e2e-a3b8960/)。脚本保留本次云机路径，用于审计本次运行，不宣称通用构建脚本。

具备足够磁盘和依赖的正常环境可通过现有 Cargo 工具复现：

```sh
cargo test --manifest-path native-call/Cargo.toml --test one_to_one_session
cargo test --manifest-path native-call/Cargo.toml --test one_to_one_session real_udp_same_session_chat_files_three_tracks_and_negative_cases -- --ignored --exact --nocapture
```

第二条仍要求环境提供真实 OS UDP 接口；不应跳过失败或改用虚拟网后标记通过。

## 真实网络与 fork 边界

首次尝试 strace 记录不含载荷的网络系统调用，被系统以 `PTRACE_TRACEME: Operation not permitted` 拒绝，测试未执行。没有提权重试或绕过 ptrace 限制。随后独立执行测试，启动两端 Peer 成功，但生成邀请时明确返回 `ICE gathered no candidates`，因此尚未进行真实 UDP 聊天/文件/媒体传输。没有改用外部 STUN/TURN、其他电脑执行或放宽网络权限来包装成成功。

本轮只核对已获授权 fork 二进制的实际 version：`3.3.0-native-quota.1+sha.f30704bce914 for linux on x86_64`，二进制 SHA256 `6f6bcc72f8c23848295ed32d6a265f5bf0baad11e7be446294a5ade1b06a84f2`。没有替换成 vanilla，也没有重试此前被阻断的权限验证。既有隔离 fork 身份风险证据仍见 [fork-identity/README.md](fork-identity/README.md)，本轮不追加权限探测。手工 P2P 路径本身不经过数据库，不能据此声称已完成 fork 认证集成。

## 未完成与阻塞

- 当前执行环境缺可用 ICE 候选；新增真实 UDP 用例已保留，尚需在获授权且有 OS 网络接口的正常运行环境执行。
- 双机/公网 NAT、TURN、IPv6、真实摄像头/麦克风采集、扬声器播放和声画同步未验收。
- 本轮没有 GUI 交互、系统安装/升级或生产登录验收；合成帧/协议测试不能替代这些结果。
- 企业认证信令仍禁用；身份字段与停用撤销问题尚无修复后的 fork 回归，且缺少仓库要求的 SurrealQL skill。不能将成员目录与手工 P2P 身份视为已绑定。
- 未发布、未推送分支或创建 PR；提交只在独立本地分支。

## 主工作树整合复验

`d2b4032` 已于2026-11-10 cherry-pick为 `8cc6edf`。整合后在主工作树使用正常Cargo、offline/locked及原共享target重新执行，不重用独立工作树的测试二进制：

- native-call `one_to_one_session`：默认1通过/1显式ignored；合成同会话闭环成功，停止耗时约6.7ms。
- 同测试的真实UDP用例使用 `--ignored --exact --nocapture` 单独执行：退出101，`ICE gathered no candidates`，0通过/1失败。没有fallback虚拟网络或改变环境权限。
- native-call `--lib --test desktop_call`：18+2通过。
- native-transport `--lib --test manual_verification`：20+4通过。
- 变更测试的正常Cargo clippy `--test one_to_one_session -- -D warnings`、native-call fmt及diff check通过。

本轮合计仍是45项通过、1项真实OS UDP失败，而不是46项通过。仅将native-call/transport本包test debug设为0并strip debuginfo以控制磁盘，不改协议、权限或断言。此前其他云桌面环境的同机UDP验收不能覆盖本次具体用例失败，也不等于公网、真实设备或生产身份验证。APK仍绑定444135d；本次只有测试及证据改动，没有重新打包或重新归因旧APK。
