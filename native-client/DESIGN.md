# 协作原生客户端设计基础

目标：桌面 Linux/macOS/Windows 与 Android 原生视图，不使用 WebView。先做真实可用状态，再接聊天和传输，不用假成功状态。

- 颜色：使用 NSH theme 的 background/foreground/primary/input/muted_foreground 语义角色，支持明暗主题。
- 控件：src/ui 管理按钮和输入框；Android触摸尺寸至少48dp，桌面首版沿用宽松尺寸。
- 字号：标题24、分区20；间距16；圆角使用theme.radius。
- 动效清单：按钮hover/pressed透明度反馈；连接状态更新只反映真实传输事件；尊重减少动态效果，不添加无意义等待动画。
- 未完检查：明暗主题截图、平台键盘焦点、移动端安全区和返回行为需在实际窗口/模拟器验证。
- 数据：未接传输时保持离线，草稿明确标记仅当前会话、未发送、不持久化。
