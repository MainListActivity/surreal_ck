Status: done

# 02 · VPS 未受控端口收口与退役服务清理

**目标**：处置 `surreal-ck-operations/landscape/company-landscape.json` 首轮实机核对暴露的安全面与遗留服务，确保生产 VPS 只暴露最小必要公网入口。

## 范围

1. **核查并收口通配监听端口**：在 `vps-data`（`129.146.179.37`）逐项核查并收口 `grafana-3000`（`*:3000`）、`prometheus-9090`（`*:9090`）、`node_exporter`（`*:9100`）、`blackbox_exporter`（`*:9115`）、`tikv-20160`（`*:20160`）、`pd-2379`（`*:2379/2380`）——确认公网防火墙拦截并按需改为仅绑定 `127.0.0.1`（改动前须先核实 `surrealdb` 与 TiKV/PD 的真实依赖关系，未确认前不停用 TiKV/PD）。
2. **清理退役服务与残留配置**：停止并禁用已退役的 `sck-company-mcp.service`（`127.0.0.1:38473`），删除 `/etc/caddy/Caddyfile` 中的 `/sck-mcp` 路由；确认 `podman` / `shadowsocks-rust` 真实用途并更新台账状态。
3. **关键人工配置脱敏归档**：明确 `magpie-web` 源码出处与 `/etc/caddy/Caddyfile` 脱敏版本备份方式，消除“单机人工维护且无备份”的隐患。
4. **同步台账复核**：更新 `landscape/company-landscape.json` 并跑一轮 `landscape.get` 实机核对确认状态收敛。

## 非目标

- 不改动生产 SurrealDB root 凭证与数据目录；不迁移或重装 VPS 操作系统。

## 独立验收标准

- [x] 从公网外部机器探测 `129.146.179.37` 的 `3000`、`9090`、`9100`、`9115`、`2379`、`2380`、`20160` 端口全部不可达（超时或拒绝）。
- [x] `sck-company-mcp.service` 已停止禁用且 Caddy `/sck-mcp` 路由返回 404/已移除；所有生产业务健康检查（`l.maplayer.top/health`、`data.maplayer.top/__company_owner/healthz`、`o.maplayer.top`）均正常。
- [x] `company-landscape.json` 同步登记并经实机核对通过；本机残留未加载 plist `org.surrealck.deliverable-preview.plist` 已删除。

**依赖**：无（已获老板授权并在 VPS 实机完成）。  
**验证方式**：公网端口探测证据 + Caddy/systemd 核对输出 + 业务健康检查通过。

## 2026-11-27 / 2026-11-28 UTC 实测记录

- `vps-data`（`129.146.179.37`）已收口 IPv4/IPv6 防火墙规则并通过 `netfilter-persistent` 持久化，外部探测 `3000`、`9090`、`9100`、`9115`、`2379`、`2380`、`20160`、`12020`、`3425` 全部拦截不可达。
- Caddy 已移除 `/sck-mcp/*` 路由（公网访问返回 `404`）；宿主机本机残留未加载的 `~/Library/LaunchAgents/org.surrealck.deliverable-preview.plist` 已删除。
- 收口后 `https://l.maplayer.top/health`、`https://data.maplayer.top/__company_owner/healthz`、`https://www.maplayer.top` 均持续返回 `200`。
