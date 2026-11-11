# 企业媒体生命周期接线（实验）

默认关闭的 `experimental-enterprise-media` 在受成员身份约束的Peer中、SDP offer/answer之前附加媒体。它不自动启动采集或播放，尚无企业媒体UI入口。控制接口不暴露Chat，媒体通知只可取出一次。

关闭顺序为撤销租约、非阻塞请求设备停止、关闭网络、等待真实媒体关闭结果。任何失败不能报告local_closed=true。无人消费通知或满队列不能阻止清理；关闭阶段显示通知可能被丢弃，权威结果保存在watch并传回Peer.close，UI不能以缺少错误通知推断设备已停止。

## 本次证据边界

- 独立harness直接引用实际enterprise_peer/call_bridge源码，在media/plain两种cfg下类型检查通过（包括测试代码）；bridge::Update是最小替身。未完成链接，不能算完整客户端通过。
- 轻量actor测试9/9通过，集成负责人核对二进制SHA256后独立重跑9/9。此harness对Chat、Call及LeaseObserver使用替身，只证明队列、租约和清理结果状态机，不能证明WebRTC/设备关闭。二进制SHA256：5df99fd50956ebbc6dbb875b3bf58b85169af0d0637e583c19fc0e97c3a9f01e。
- 之前真实Call/native-transport rlib版本15项harness独立保留；它使用旧版包装与租约替身，不能冒认当前全部接线行为。
- 完整Cargo feature测试、真实成员会话媒体端到端和设备验证仍待完成。没有生产登录、更新门禁绕过、默认Release启用或远端发布。

## 后续完整回归

完整client feature现已在 cancellation-final/ 通过73单测+5Headless与strict clippy，替代上面的“完整Cargo待完成”状态；旧harness证据边界仍不变。企业媒体UI尚未开放：身份面板折叠可能隐藏隐私/停止控件，必须先移至常驻区域；关闭时总结果不能替代可重放的逐源停止快照，不能以通知缺失推断设备已停。真实设备、双端企业媒体与生产登录仍未验证。
