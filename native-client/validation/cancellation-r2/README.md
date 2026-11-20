# 文件取消与会话关闭 r2

2026-11-11 UTC，本地隔离验证：transport 29单测、strict all-targets clippy通过；完整client `experimental-enterprise-media` 73单测+5Headless通过，feature lib strict clippy及默认lib check通过。构建前后113项输入哈希相同。准确命令/输出见同目录；transport原日志文件名日期误写12，实际执行为11日。

覆盖新增：阻塞任务真实退出/丢弃shutdown future、单文件和全局事件背压、取消与完成ACK竞态、槽位清理、发布准入线性化、256次会话上限、发布不确定状态；DC终止在满事件队列前同步置位，原生媒体独立监控触发实际停止；本地桥整体关闭等待网络、文件和媒体，不吞清理失败。已完成文件事实保留到CloseReport，不声称停止能撤回已保存文件。

真实WebRTC文件组合测试使用虚拟网络；无新公网/物理设备/生产身份验证。Android终止监控源码已改但本轮未交叉编译或设备验收。企业媒体无UI入口，企业文件wrapper/UI尚未接通，默认Release未启用。

已知r2边界：发布先赢后取消会抑制实时COMPLETE ACK和Completed显示通知，发送方可能超时；文件真实保存且ledger/CloseReport可靠，不是假取消/删除。下一阶段需分离已保存终态与普通可取消消息。

固定二进制另外保存在cloud工作区client-cancellation-final/binaries，未加入git：
- unit-tests SHA256 fb505ba86b8610237ea3f96e179046293a7f13dfb412aedbda257e52467b35a7
- ui-tests SHA256 19133aceae920540bb5a5fa15994f77ff1351291394ac0ed3e0fc3ecb70b8620
