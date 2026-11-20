# 实验企业聊天UI验证

同一冻结源码：identity_ui.rs与enterprise_peer.rs的SHA256见verification-binding.json。

原作者工具输出记录61单测、5 Headless、实验feature clippy -D warnings、默认check、fmt通过。没有事前hash receipt；原编译绑定采用Cargo dep-info/fingerprint与文件/编译时间证据，不能伪称完整预构建hash验证。

整合时独立复跑已编译的两个固定二进制：61单测和5 Headless全部通过；运行前后两源码与二进制SHA256均匹配。见unit-rerun.log、headless-rerun.log、independent-rerun.json。没有为此新增构建。覆盖更新门关闭、无配置不能假登录、小窗口更新重试、epoch/generation迟到、显式邀请详情确认、发送回执与新草稿、撤销观察器、先释放队列再等待关闭。

这不是生产OAuth或真实双端GUI验收。实际后台真实UDP聊天/撤销验证见相邻enterprise-signaling-e2e-r2。实验feature默认关闭；Owner不是RECORD成员，不伪造sender；生产开启前必须确认061/062迁移、合法participant scope、受信任OIDC/更新配置。没有部署或创建凭据。
