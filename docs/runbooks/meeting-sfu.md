# 私有会议 SFU

生产默认关闭。先在公司资产清单登记独立媒体主机、服务和入站规则并取得授权；不在生产数据主机上运行 LiveKit。准备一个仅 Bun 可达的私网管理地址，以及一个独立信令域名。首期只运行一套 Bun 准入实例和一个专用 LiveKit 实例，房间/租约在进程内，重启不得视为无损滚动发布。

| 入口 | 允许来源 | 用途 |
| --- | --- | --- |
| 媒体主机私网 TCP 7880 | 仅 Bun 私网地址 | LiveKit 信令上游和管理 API |
| Bun 私网 HTTP(S) `POST /internal/meeting/sfu/livekit-webhook` | 仅 LiveKit 私网地址 | 签名的名册出席事件 |
| 信令域名 TCP 443 | 获准参会客户端 | 仅反代 `GET /api/meeting/sfu/signal/rtc` 和 `/rtc/validate` |
| 媒体主机 TCP 7881、UDP 7882–7889 | 参会端和托管 TURN | DTLS-SRTP 媒体 |

1. 固定 LiveKit 版本（隔离测试用 1.9.9）。按 `scripts/deploy/livekit/livekit.yaml` 配置私网监听、媒体公网候选地址及公司托管 STUN。使用受限环境文件向 LiveKit 注入 `LIVEKIT_KEYS`，不要把密钥写入模板。
2. 用 `scripts/deploy/livekit/Caddyfile` 配置信令 TLS，只转发上述路径至 Bun 私网地址。公开 Worker 不转发 SFU 信令。信令 ingress、反代和监控不得记录 WebSocket 查询参数；其中含短时令牌。
3. 配置 Bun 的 `MEETING_SFU_*`：私网管理 URL、独立 HTTPS 信令 URL、应用准确的 HTTPS origin、同一对密钥和席位上限。验证客户端侧无法连接 TCP 7880，且信令域名的 Twirp 路径返回 404，才开放私有大会。
4. 在 LiveKit 实际部署配置的顶层加入以下 `webhook` 段，使用 Bun 私网地址和与 `MEETING_SFU_KEY` 相同的 LiveKit API key 名称。必须将 webhook 请求原样交给 Bun（保留 `Authorization` 和原始请求体），不要经由公开信令 Caddy 或 Worker 转发该路径。两端启用时钟同步；私网不受信时用受信任的 HTTPS。

   ```yaml
   webhook:
     api_key: "__MEETING_SFU_KEY__"
     urls:
       - "https://__BUN_PRIVATE_ORIGIN__/internal/meeting/sfu/livekit-webhook"
   ```

## 名册出席和主持流水

- 上线前确认 Bun 已为 `PrivateMeetingSfu` 注册名册事件写入器。在隔离的名册会议实际连接媒体，主动离场、完整重连、替换并散会，验证账本中每对出入事件共享独立的连接编号、不同片段按同一名册记录归集。只发凭据、打开信令、未建立媒体的中止连接、仅续接同一 LiveKit 参与者的信令都不新增出席片段。新的 LiveKit 参与者 SID 开启新片段。
- `joined` 和正常 `left` 使用签名 LiveKit webhook 的 `createdAt`（UTC 秒转换为毫秒单位，不代表毫秒精度）。若替换、踢出、租约到期或散会时还未收到离场事件，旧片段最迟在 RoomService 确认删除后关闭；此时是 Bun 的操作完成时间。若新 SID 先于旧离场到达，以新入场时间为旧片段结束上界。不会为缺失的加入 webhook 伪造入场时间。
- `raised` 记录服务端首次接受的举手，`allowed`/`withdrawn` 记录 LiveKit 更新发布权限成功的操作（包括全员静音），时间来自 Bun。它们表示权限和申请，不表示实际发声。操作可能早于媒体加入，因而可以没有连接编号。
- Bun 按房间顺序投递事件，写入失败使用原事件键重试。已识别的名册 webhook 会等待当前队列写入，超时返回 `503`；归档也会在队列未写完时拒绝并提示重试。监控「名册遥测写入失败」和「收到缺少加入事件的名册离场」日志，并检查 LiveKit 投递失败告警。LiveKit 投递为尽力而为，Bun 队列不持久化：重启或长时间写入故障可能造成数据缺失或积压。计划停机前排空会议并检查账本；已移除席位的映射约保留 5 分钟以接收晚到 webhook。

## 容量与回滚

- 单实例共预留 30 席，含主持人；Bun 在房间创建前拒绝超额请求。媒体预算按 ADR 预留至少 135 Mb/s 出网；该预算不是实测值。
- 用隔离实例运行 `scripts/deploy/livekit/load.sh`。默认是 30 连接基线；若要测 31 连接，使用独立测试实例，先提高该实例的房间上限，再设 `LOAD_SUBSCRIBERS=29`。不在生产实例压测或提高上限。
- 在目标主机复测 CPU、RSS、出口带宽、丢包及恢复；资源余量不足时以下调后的席位上限重新验收，不沿用实验室的数字。当前准入按席位限制，不会按实时 CPU 或带宽自动降额。
- 排空大会后移除 Bun 的 SFU 配置并重启，关闭信令入口及媒体防火墙规则。未核验名册或强制存证的正式外部会议始终拒绝创建，不自动回退 Mesh。
