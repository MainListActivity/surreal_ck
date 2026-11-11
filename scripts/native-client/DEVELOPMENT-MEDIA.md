# Windows 安装包中的开发媒体候选

当前锁文件已启用补料后的 Windows 开发候选（run 42997627548，源码 bcd7fe7155c233165fe204148e9d033ccafc88c9），包含静态工具链运行时告知、最终链接映射及 package→notice hash 证据。它们仅证明材料收集和完整性，不构成最终法律批准；release_approved 仍为 false。

仅 `feat/native-collaboration-bootstrap` 的 push 安装器流水线消费独立锁定的 Windows 候选。`development-media-candidate.lock.json` 固定仓库、成功 run、源码 commit、artifact ID、ZIP SHA256、manifest SHA256；不查询 latest，不从候选自签声明推断可信来源。

该模式显式设置 `SURREAL_MEDIA_RUNTIME_MODE=development-candidate`。候选必须保留 `release_approved=false`，不表示许可证闭包审核、重新分发授权、签名或业务/设备验收完成。正式默认模式仍要求 `release_approved=true`；release 事件及 tag 构建拒绝开发模式。

固定 artifact 保留 14 天；本接线另设更早的 2026-11-24 00:00 UTC 截止时间。GitHub 报告 expired、下载失败、任何 hash/provenance 不匹配或超过截止时间均停止构建，没有 latest/无媒体降级。后续必须重新独立验证并审核更新锁文件。

打包前验证完整文件清单、每个文件 SHA256、上游来源材料、原生 smoke 证据、PE 架构和静态依赖；复制后再校验，封包时再次锁定。源代码、许可证和构建记录随 app-local `media-runtime` 安装。Windows 安装测试先校验实际安装树与封包 inventory，再对已安装的 bin 运行空 PATH、VP8/Opus pipe 往返、SDL dummy 和只读后端列表测试；不会打开摄像头、麦克风或屏幕。

安装器保留强制更新门，缺少真实配置时仍锁在更新页。测试通过也不等于聊天、会议、共享、文件传输或更新交付验收。macOS 正式 DMG 的 Sparkle、公钥/feed 和签名要求没有改变。无 Release 发布、部署或凭据创建。

正式资产验收 `check-release-readiness.py` 独立读取每个平台 package evidence，无论构建环境如何，都拒绝 development_only、未批准媒体、缺失媒体证据及 release_eligible 非 true 的桌面包。将测试包手工搬到 Release 不会自动获得验收。
