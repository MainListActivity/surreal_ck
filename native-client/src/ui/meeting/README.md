# 原生会议视图（工作包 D）

此模块尚未接入 `lib.rs`；集成包 F 在会议路由中调用：

```rust,ignore
let state = MeetingState::new(); // 必须在 NSH component 的响应式作用域内创建
meeting_page(state, move |command| actor.send(command), Rc::new(placeholder_video))
```

- `MeetingView` 是可独立测试的纯数据；`MeetingState` 用 NSH `Signal` 持有它。F 将 B/C 类型转换为 `MeetingUpdate`，在 UI 线程调用 `apply`。
- `Capability` 默认 fail closed。所有设备默认 `Off`；不同会议不得复用旧采集。`UnavailableReason` 对应版本关闭/非企业包、未登录、无工作区、未迁移、平台不支持。
- `RoomSnapshot.version` 按 room_id 单调；相同/旧版本忽略。离开实例的迟到 Active 快照不会复活房间。F 仍必须丢弃跨身份/工作区、旧 join 的所有异步结果；`Device` 更新不含会话 ID，必须由 actor 门控。
- 页面在派发离开/结束/设备关闭命令**之前**调用 `prepare`，立即显示 `Stopping`。这只是视图状态，不是实际关闭设备；actor 收到命令必须优先禁用本机发送，不等待网络。身份失效以 `Capability(Unavailable)` 通知。仅 `Device(Off)` 是停止确认，停止失败用 `StopUnconfirmed`，任意阶段保留隐私告警并禁止重新入会。
- `StartShare` 仅请求系统选择器，不携带伪造的源；取消选择不改变设备状态。F 在系统授权/设备确认后推送 `Device` 与快照。`MockMeeting` 的共享成功仅是测试替身。
- `VideoSlot = Rc<dyn Fn(&str, &str, Source) -> AnyElement>`，键是 `(member_id, join_id, Source)`。成员/入会实例/源变化会卸载旧元素；闭包可返回原生视频元素。名字及设备/边状态由周围成员卡片显示。默认工厂不采集、不播放媒体。
- `MeetingCommand::End` 仅主持人可见且需确认；服务端/actor 必须再次授权。`RetryEdge` 仅对非本人的 `Failed { retryable: true }` 显示。
- `MeetingError::Retryable` 的横幅重发最近一次页面命令；无此前命令时不伪造重试操作。无效会议号和未邀请共用唯一错误变体与文案。
- 会议号采用原生可选择文字复制。共享源选择器由平台实现；模块不绘制假系统授权窗口。

`mock::MockMeeting::handle` 返回更新列表，按顺序 `apply`。`add_member` 用于预览远端加入，依次产生 Connecting、Direct；Invite 在替身中自动接受以方便演示。它不证明真实邀请授权、ICE 或媒体可用。

模块内 Headless 根组件无需修改应用根导出。覆盖不可用、创建、邀请三人、输入会议号、逐边状态、多共享切换/停止、主持人确认、成员无结束按钮、离开；纯模型测试覆盖版本、容量和设备隐私。
