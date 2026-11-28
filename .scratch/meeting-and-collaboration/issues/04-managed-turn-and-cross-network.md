Status: ready-for-human

# 04 · 托管短时 STUN/TURN 凭据签发与跨网络公网互通

**目标**：消灭当前客户端“无内置公网配置、需用户手工填写 STUN/TURN”的不可用门槛，在后端提供按会话签发的短期临时 ICE 凭据，并完成真实跨网络三账号验收。

## 范围

1. **受控 ICE 凭据签发接口**：在 Bun origin 新增短期 ICE 凭据接口（基于 TURN REST HMAC 机制，TTL ≤ 15 分钟），仅对已认证工作区成员或已核验会议会话签发，绝不在客户端或前端包中硬编码静态 TURN 密码。
2. **TURN 服务部署与登记**：部署/配置公司受控 TURN（如 coturn，限制中继端口范围与仅允许白名单目标，防止开放中继滥用），并在 `company-landscape.json` 按规程登记（如新增端口/服务需任务卡授权）。
3. **客户端自动接入与降级**：原生客户端与后续 Web 客户端入会自动拉取短期 ICE 配置，优先直连（host/srflx），失败自动切换 TURN relay；凭据临近过期时在重连场景自动续签；保留「开发者诊断」查看实际选中候选类型（direct/relay）。
4. **跨网络实测闭环**：按 `docs/runbooks/native-meeting-acceptance.md` 完成同机三账号与跨至少两个不同网络（含对称 NAT / 4G 热点）的音视频与共享互通实测。

## 非目标

- 不提供永久有效的静态 TURN 账号；不开放未鉴权匿名客户端拉取 TURN 凭据。

## 独立验收标准

- [x] 未登录或会话已吊销的调用请求被 `401/403` 拒绝；合法会话拿到带有限过期时间的临时 `username`/`credential` 及 ICE 服务器列表（Bun 接口自动化）。
- [ ] TURN 服务拒绝过期凭据与错误签名凭据，且配置禁止中继到私网/回环地址（SSRF 防护）。
- [ ] 普通用户不填写任何网络参数即可在跨网络（如公司 Wi-Fi ↔ 手机 4G/5G 热点）稳定建立双人与三人音视频及屏幕共享。
- [ ] 按 `docs/runbooks/native-meeting-evidence.md` 归档完整脱敏验收记录（区分直连与 relay 选中路径，含真实设备/网络代号，不含敏感地址与凭据）。

**依赖**：`01`。  
**验证方式**：后端签发与安全负例单测 + coturn 过期凭据负例 + 真实跨网络三端实测证据。

## 本轮证据

- `main` 已合入鉴权签发、原生自动配置、部署手册和同机中继对端配置修正。签发套件 6 项通过，覆盖未登录、成员撤权、跨工作区、过期、配置缺失及有效期边界。原生身份库的短期配置请求测试和 Web 直连失败回退状态机已过。[PR #305](https://github.com/MainListActivity/surreal_ck/pull/305) · [PR #306](https://github.com/MainListActivity/surreal_ck/pull/306) · [PR #307](https://github.com/MainListActivity/surreal_ck/pull/307) · [PR #318](https://github.com/MainListActivity/surreal_ck/pull/318)
- 隔离 coturn 4.6.3 实测两端选中 relay 并双向收到音频包。有效、错签、过期短期认证三项实测符合预期。部署版本、准入对端策略及公网路径待另验。[本轮回执](12-meeting-e2e-and-pilot-acceptance.md#本地验收回执)
- 等待在经授权的候选环境复核 coturn 过期和错签拒绝、对端允许清单及实际 TLS/UDP/TCP，完成同机三账号与至少双网络、对称 NAT 或热点的双向 RTP 和共享。按边记录选中路径、无授权回退负例、续租和分配回收。[TURN 手册](../../../docs/runbooks/meeting-turn.md) · [原生验收证据模板](../../../docs/runbooks/native-meeting-evidence.md)

## Comments

- 2026-11-28 本地验收。本轮真实 coturn 选中 relay 并双向收发 RTP，实验室 Rust 用例 2060 毫秒。日常 Web 访客的实际选中路径是 host/host UDP。跨公网、单边路径故障和授权部署端口核验仍待执行。[Web 与无证书原生本地验收](../../../docs/runbooks/meeting-pilot-web-verification.md)
