# SurrealDB 生产维护围栏

仅适用于受审的 Caddy + systemd + Podman 主机拓扑。安装和执行都会改变主机，
必须在批准的维护窗内操作；本目录的沙箱测试不需要也不允许访问生产。

## 安装

从已审提交安装，不以 root 直接执行可被部署用户改写的仓库副本。需要 Python 3、
`/usr/bin/caddy`、`/usr/bin/systemctl`、`/usr/bin/ss`、`/usr/sbin/iptables` 和
`/usr/sbin/ip6tables`；两个地址族都须可操作。Ubuntu alternatives 的 root-owned
符号链接可用于这些系统工具。hook/helper/config/state 的父目录也必须由 root 控制，
不得允许 group/other 写入；Caddyfile 必须是普通 root-owned 0600 文件。

在仓库根目录执行以下安装命令（**不是围栏执行命令**）：

```sh
sudo install -d -o root -g root -m 0700 /etc/surreal-ck /var/lib/surreal-ck/maintenance-fence
sudo install -o root -g root -m 0600 scripts/deploy/maintenance-fence/sck_maintenance_fence.py /usr/local/sbin/sck_maintenance_fence.py
sudo install -o root -g root -m 0700 scripts/deploy/maintenance-fence/fence /usr/local/sbin/sck-surrealdb-fence
sudo install -o root -g root -m 0700 scripts/deploy/maintenance-fence/unfence /usr/local/sbin/sck-surrealdb-unfence
sudo test ! -e /etc/surreal-ck/surrealdb-upgrade.env && sudo install -o root -g root -m 0600 scripts/deploy/maintenance-fence/surrealdb-upgrade.env.example /etc/surreal-ck/surrealdb-upgrade.env
```

若 env 已存在，最后一条拒绝覆盖；先受控备份，再由运营安全合并以下两行。不要把
Caddyfile、数据库凭证或备份内容贴入终端证据/CI 日志：

```dotenv
SURREAL_UPGRADE_FENCE=/usr/local/sbin/sck-surrealdb-fence
SURREAL_UPGRADE_UNFENCE=/usr/local/sbin/sck-surrealdb-unfence
```

## 执行与恢复边界

upgrade workflow 自动调用 fence；默认模式自己启动兼容 origin 并检查健康后调用
unfence。`defer_origin_start=true` 时，只保留围栏，由运营另行发布兼容 origin/前端、
验收后执行 `sudo /usr/local/sbin/sck-surrealdb-unfence`。unfence **不启动 origin**，
要求它已 active 且 loopback `/health` 为 `status=ok,surrealdb=up`。

fence 停止 `surreal-ck-hono.service` 和 `sck-company-mcp.service`；从原文件生成新
配置，仅将显式 `data.maplayer.top` 站点最后一个无 matcher 的直接 `handle` 改成
`respond 503`。匹配不到唯一直接 `reverse_proxy 127.0.0.1:8000`、有额外 upstream、
heredoc、异常括号等情况会拒绝，不猜测配置。其他站点/handle 的文本逐字保持。
替换后对实际 `/etc/caddy/Caddyfile` 执行 `caddy validate --adapter caddyfile`，保证
相对 import 路径不变；失败恢复替换前文件且不 reload。验证成功后 reload Caddy，
再给 IPv4/IPv6 INPUT 插入非 lo、TCP 8000 的 DROP 规则，comment
固定为 `surreal-ck-maintenance-8000`。仅删除完全匹配的本 hook 规则，不 flush 链。
规则也阻断旧连接的数据包，避免仅匹配 NEW 时在途握手于最终检查后进入 established；
这不代替下述既有连接清空检查。

最后以 `ss` 最多等待 30 秒，确认 DB 服务端没有非 loopback established 连接，且
没有残留 Caddy→8000 的代理连接；不能仅凭 reload 返回 0 宣称旧 WSS 已断开。
直连 8000 的既有远端连接不会被 DROP 规则主动清除，仍存在则 fence 失败，DB 升级不得继续。
hook 不杀其他服务或任意连接，不操作 `sck-owner-*`。

unfence 校验 origin 健康后，恢复原 Caddyfile、validate/reload，删除 IPv4/IPv6 的
本 hook 规则，再启动并核对 MCP active。恢复公网不是原子操作；unfence 中途失败时，
可能已开放部分访问，必须按受控流程重新 fence 并确认现场，不得自动回退旧数据库。
放开后 8000 恢复安装前的防火墙策略，不把临时围栏当成长期网络加固。

## 状态与故障处置

`/var/lib/surreal-ck/maintenance-fence/` 为 root 0700；每轮 `session-*` 保存原始与
围栏 Caddyfile（0600），`state.json` 登记 active/released，文件锁串行化 hook。
同一 active 轮重复 fence 不覆盖原备份、不重复插入规则；重复 unfence 可安全恢复同一
轮。下一轮从当前正常配置新建备份。没有备份时 unfence 拒绝，不猜原配置。
备份可能含 secret，禁止上传 artifact；仅在核实 released、无需恢复后受控清理旧轮。

配置与本轮原始/围栏文件都不一致时拒绝覆写，保留现场人工核对；维护期间不得通过
其他工具修改 Caddy 或防火墙。进程被杀或 SSH 断开不是成功，须核对本轮状态、Caddy
加载状态、规则、两个写入服务和连接。失败不承诺自动恢复服务，也不重启数据库。
命令错误正文和配置内容不会输出；通过 root 受保护的现有观测路径诊断，不把 secret
传进流水线。这里只控制已核实的两个本机写入服务与公网入口；新增本机写入者必须先
扩展围栏并复核，不能依赖 loopback 放行替它隔离。

## 本地检查

```sh
python3 -B scripts/deploy/maintenance-fence/test_fence.py
pnpm exec bun test server/src/deploy/maintenance-fence.test.ts --preload ./server/test/setup-env.ts
pnpm lint
```

测试用合成 Caddyfile、临时目录和命令替身，覆盖路由保护、幂等、原备份、IPv4/IPv6、
连接残留、配置漂移、校验/reload/防火墙失败及 origin 未就绪；不证明真实 Caddy 版本、
iptables 后端、systemd 服务或生产 WSS 已验证。
