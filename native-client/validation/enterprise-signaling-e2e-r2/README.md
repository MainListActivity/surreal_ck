# 企业聊天关闭与撤销队列回归（r2）

此轮候选新增只读LeaseObserver：UI在消费Open/Text/Queued时再次确认成员会话未失效，旧排队事件不能恢复连接或消息。CloseOutcome区分已确认本地关闭与远端end失败；邀请过期或信令离线不再把本地关闭成功误判为失败。

后台只有一个Chat.close所有者。停止通知可打断睡眠/成员检查，但不会abort已开始的清理；正常close等待该任务，Drop只通知并detach。UI先释放事件receiver再等待关闭，解除on_close回调背压。

准备的三项真实UDP验收：原双向中文聊天、成员撤销后关闭、发送140条消息后暂停消费时先撤销observer并拒绝发送，释放receiver后本地关闭完成。测试仍为本机真实RECORD+公司API fixture，无生产OAuth/TLS、公网NAT、媒体或文件。

旧fb878ea及enterprise-signaling-e2e目录的两项通过证据保持不变，不继承到此版本。本目录独立cloud desktop Xfce实际运行三项通过：23.07秒，TEST_EXIT=0，开始和结束101项源码输入及二进制hash均匹配。二进制40,295,376字节，SHA256见build-receipt.json。第三项没有直接断言Receiver.len()==capacity，不能单独宣称实际队列达到容量；满队列释放背压另由UI纯测试明确验证。
