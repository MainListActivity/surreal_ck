# 私有会议 SFU

生产默认关闭。先在公司资产清单登记独立媒体主机、服务和入站规则并取得授权；不在生产数据主机上运行 LiveKit。准备一个仅 Bun 可达的私网管理地址，以及一个独立信令域名。首期只运行一套 Bun 准入实例和一个专用 LiveKit 实例，房间/租约在进程内，重启不得视为无损滚动发布。

| 入口 | 允许来源 | 用途 |
| --- | --- | --- |
| 媒体主机私网 TCP 7880 | 仅 Bun 私网地址 | LiveKit 信令上游和管理 API |
| 信令域名 TCP 443 | 获准参会客户端 | 仅反代 `GET /api/meeting/sfu/signal/rtc` 和 `/rtc/validate` |
| 媒体主机 TCP 7881、UDP 7882–7889 | 参会端和托管 TURN | DTLS-SRTP 媒体 |

1. 固定 LiveKit 版本（隔离测试用 1.9.9）。按 `scripts/deploy/livekit/livekit.yaml` 配置私网监听、媒体公网候选地址及公司托管 STUN。使用受限环境文件向 LiveKit 注入 `LIVEKIT_KEYS`，不要把密钥写入模板。
2. 用 `scripts/deploy/livekit/Caddyfile` 配置信令 TLS，只转发上述路径至 Bun 私网地址。公开 Worker 不转发 SFU 信令。信令 ingress、反代和监控不得记录 WebSocket 查询参数；其中含短时令牌。
3. 配置 Bun 的 `MEETING_SFU_*`：私网管理 URL、独立 HTTPS 信令 URL、应用准确的 HTTPS origin、同一对密钥和席位上限。验证客户端侧无法连接 TCP 7880，且信令域名的 Twirp 路径返回 404，才开放私有大会。

## 容量与回滚

- 单实例共预留 30 席，含主持人；Bun 在房间创建前拒绝超额请求。媒体预算按 ADR 预留至少 135 Mb/s 出网；该预算不是实测值。
- 用隔离实例运行 `scripts/deploy/livekit/load.sh`。默认是 30 连接基线；若要测 31 连接，使用独立测试实例，先提高该实例的房间上限，再设 `LOAD_SUBSCRIBERS=29`。不在生产实例压测或提高上限。
- 在目标主机复测 CPU、RSS、出口带宽、丢包及恢复；资源余量不足时以下调后的席位上限重新验收，不沿用实验室的数字。当前准入按席位限制，不会按实时 CPU 或带宽自动降额。
- 排空大会后移除 Bun 的 SFU 配置并重启，关闭信令入口及媒体防火墙规则。未核验名册或强制存证的正式外部会议始终拒绝创建，不自动回退 Mesh。
