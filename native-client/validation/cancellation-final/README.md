# 文件取消与终态回执最终验证

2026-11-11 UTC。r4关闭了r2记录的取消后ACK/通知缺口：仅本地已保存账本可发送COMPLETE，单文件取消不能抹掉保存事实，全局停止仍可阻断网络。终态通知使用独立有界工作，取得事件容量后重读账本，Completed优先；发送端取消与ACK并发的两条Completed路径也发送终态通知。取消仅代表本地停止，不保证对端未保存，UI文案明确这一点。

通过：
- transport 33单测、strict all-targets clippy、fmt。包含真实虚拟ICE/DTLS通道：发布准入后取消，实际文件落盘，接收端和发送端均收到完成通知，发送端依赖真实COMPLETE ACK；另有ACK先到/等待期间到的通知与槽位回归。
- 完整client实验企业媒体feature：73单测、5Headless；strict lib clippy和默认lib check。
- Android arm64/x86_64实验宿主：已安装NDK29下release-profile严格clippy，无新下载或链接。
- 113项输入构建前后相同，Android检查后再次核对仍一致。准确命令/日志/二进制hash见同目录。固定二进制保存在cloud工作区client-cancellation-r4/binaries，未加入git。

范围限制：虚拟网络测试不是公网NAT/TURN证明；没有真实摄像头/屏幕/麦克风新验收，没有Android设备运行或新APK。当前企业媒体无UI入口，企业文件wrapper/UI未接通。此前真实同机UDP企业文字会话证据独立保留，不冒认本轮全部代码重新做过公网或生产验证。更新门禁、生产身份和Release前置要求不变。
