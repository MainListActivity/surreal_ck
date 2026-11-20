# 企业媒体与文件UI整合验证

2026-11-11 UTC。默认功能关闭，生产更新门不变。

通过的真实命令结果：
- client：103单测与6个Headless UI测试，无忽略；最终实验feature严格lib clippy通过，最终175项输入前后一致。
- transport：34单测，包含虚拟ICE/DTLS/SCTP的真实文件协议与保存ACK。虚拟网络不等于OS UDP或公网验证。
- native-call：21单测，包含独立播放consumer真实关闭结果watch，以及失败/取消不得确认停止。
- Android arm64/x86_64：NDK29 release-profile、enterprise-collaboration显式feature严格clippy。没有本轮链接、APK、安装或设备运行。

客户端、传输和call测试前后175项输入hash一致。Android宿主随后只补入signaling锁依赖，并独立复验两个ABI，锁摘要见android-lock-receipt.json。先前r2/r3客户端各有一个测试夹具失败（首次渲染等待及文本selector），修正夹具后本轮全部通过；没有掩盖原失败日志。

新增行为包括：账户设置折叠不能隐藏媒体隐私区；停止聊天先同步失效媒体再换代；逐源真实停止与播放最终状态可重放；唯一操作ID防止旧Stop回执清新Start；文件选择器迟到/取消、原身份回执、SAF暂存所有权与源别名释放保护。测试替身只用于受控故障/延迟注入，不宣称真实硬件已停止。

另已独立完成企业文件真实OS UDP 2/2闭环，见 ../enterprise-file-e2e-r3。

仍待：实际媒体设备/双机公网、生产OIDC和组织授权、Android SAF/媒体/升级设备验收、macOS/Windows构建与正式Release。既有文字真实UDP证据不可当作本轮文件或媒体通过。没有新增生产凭据、部署或绕过更新门。

入库日志副本仅删除尾部多余空行；原始cloud日志保持不变。
