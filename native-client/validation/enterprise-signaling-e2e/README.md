# 企业信令到真实 P2P 聊天验收

本轮是默认关闭的实验后台接线，不是已交付的企业聊天UI或生产账号验收。

`build-harness.py`把实际identity、signaling和client enterprise_peer源码组合成独立测试crate；身份fixture只在cfg(test)存在，没有生产Session构造器、令牌导出或网络降级feature。root仅准备本机内存数据库/schema/fixture和模拟控制面撤销，业务用真实RECORD token；公司workspace API为本地测试服务。固定fork身份fixture加载061+062；完整001–062兼容验证另见native-signaling/FORK-RULES-RESULT.md。

两个显式ignored测试：
- 真实身份连接、数据库邀请和明确接受、完整绑定答复，真实UDP ICE/DTLS/SCTP双向中文聊天，再关闭。
- 相同聊天建立后停用对端，周期成员重验失败关闭本地通道，后续发送拒绝。

未使用虚拟网络；主exec两项实际失败于OS没有ICE候选，exit101，详见exec-real-udp.log。独立cloud desktop Xfce终端实跑两项通过（12.34秒，TEST_EXIT=0）；开始与结束核对99个源码输入hash和二进制hash均一致，见desktop三份日志。此结果只属于本轮固定二进制，不能继承给后续改动。无公网NAT/TURN、TLS生产端点、真实ma_hono账号、媒体轨、文件UI或跨机器验收。

二进制与源输入见build-receipt.json和source-receipt.json。初轮生成器遗漏crate alias所需Error re-export导致编译失败，修正后第二轮成功；原始build.log保留。harness生成根仅测试使用，未导出的生产API产生dead_code警告，未将harness称为严格clippy通过。正式crate的检查另行记录。

后台约束：每次发送检查会话仍有效；每10秒重验双方成员，锁等待/网络最多10秒，失败关闭通道。这是周期检测，不是即时全局撤销或通话租约。退出/切换必须await close，UI接线另行验证。当前close把本地失败与远端end失败合为Err；邀请120秒后远端end会拒绝，UI须保守提示，不能误报关闭完成。后续应区分两种结果，避免阻断已确认本地关闭的正常切换。

仅使用已有Rust工具链、离线依赖和共享target；不得为此删除任何源代码、安装包或验证证据。
