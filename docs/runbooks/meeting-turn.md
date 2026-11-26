# M-04 托管会议 TURN

本手册不会自动部署。先合入 M-04、登记 `surreal-ck-operations/landscape/company-landscape.json`，并取得 OCI、主机防火墙及对端地址授权。目的主机是 `data.maplayer.top`（`vps-data`，OCI 公网 IPv4 `129.146.179.37` → VNIC `10.0.0.112`）；上线前从资产台账及主机复核此映射。TURN 直达主机，不走 Caddy/Cloudflare 的 HTTP 反代。

## 部署

1. 在维护窗口用 `sudo apt update && sudo apt install coturn` 安装系统包。先保持 OCI 新端口关闭；确认软件包的默认服务未对外监听，停用它后再写入最终配置。运行 `systemctl cat coturn.service` 确认服务用户和组为 `turnserver`、`ExecStart` 参数和下文一致。不开启 CLI、DTLS 或 TCP relay：客户端仍可用 TURN/TCP 或 TURNS/TCP 连接，分配的中继为 UDP。
2. 在不录屏、无命令跟踪（`set +x`）的 root 会话中，用 `install -d -m 0700 /etc/coturn` 建目录。在受保护位置以 `umask 077; openssl rand -hex 32 > /etc/coturn/shared-secret` 首次生成密钥；已有密钥不覆盖。复制 [配置模板](../../scripts/deploy/coturn/turnserver.conf) 为 root:root、0600 的 `/etc/coturn/turnserver.conf`，在该文件追加 `static-auth-secret=<密钥>`，例如在 root shell 执行 `{ printf 'static-auth-secret='; cat /etc/coturn/shared-secret; } >> /etc/coturn/turnserver.conf`（只执行一次）。不在 argv、日志或工单中放密钥。该 coturn 版本不依赖配置 include，也不以 root 身份运行；通过 `systemctl edit coturn.service` 让 systemd 以运行时凭据向服务提供配置：

   ```ini
   [Service]
   LoadCredential=turnserver.conf:/etc/coturn/turnserver.conf
   ExecStart=
   ExecStart=/usr/bin/turnserver -c ${CREDENTIALS_DIRECTORY}/turnserver.conf --pidfile=
   ```

3. 复用 Caddy 为 `data.maplayer.top` 管理的 TLS 证书。默认 Caddy systemd 数据目录在 `/var/lib/caddy/.local/share/caddy/certificates/`，签发者和路径以主机的 Caddy 存储配置为准。由 root 的证书复制步骤将完整证书链和匹配私钥安装到 `/etc/coturn/tls/fullchain.pem`、`/etc/coturn/tls/privkey.pem`，均为 `root:turnserver` 0640；将 `/etc/coturn` 和 TLS 子目录设为 `root:turnserver` 0750，使服务能读取 TLS 文件，但不能读取 0600 的源配置或密钥文件。先验证证书包含该域名、链有效且两者公钥对应，再替换目标文件。将相同复制和校验步骤接到**现有**证书续期流程，安排重启 coturn 使其重新读盘；不新增定时器，也不给 coturn 访问整个 Caddy 私钥目录的权限。
4. 本机只有一个 IPv4 中继地址，`relay-ip` 绑定 VNIC 私网 IP，`external-ip` 只写公网 IP。coturn 4.5.2 的 `公网/私网` 写法会自动把私网 IP 加入对端允许列表，绕过拒绝规则。最终配置只为经批准的公网 IPv4 地址或连续网段增加 `allowed-peer-ip=<IPv4>` 或 `allowed-peer-ip=<起始 IPv4>-<结束 IPv4>`。模板默认拒绝所有对端；coturn 中 allow 优先于 deny，因此每项都必须核对，不能与特殊用途地址、私网、回环、云元数据或主机自身地址重叠，不能用全网段代替。验收只允许获准测试网络的公网出口，对称 NAT 出口变更时按授权更新。没有获准的目的地址时不得上线宣称公网可用。
5. 客户端可从任意网络入会，OCI NSG/安全列表和主机 IPv4 入站规则的来源均为 `0.0.0.0/0`：允许 `3478/udp`、`3478/tcp`、`5349/tcp` 和 `49160–49359/udp`。OCI 使用有状态规则；不要开启 `5349/udp` 或中继 TCP。公网入站放行不改变 TURN 对端允许列表：中继出口仍只允许获准的公网媒体对端（若 VNIC 有更宽的出口规则，用主机规则兜底）。用 `iptables -L INPUT -n --line-numbers` 核对最终 DROP 的行号，填入 `DROP_RULE`，将三条规则插在它之前，不改动已有 SSH、HTTPS/WSS 或数据库规则：

   ```sh
   iptables -I INPUT "$DROP_RULE" -s 0.0.0.0/0 -d 10.0.0.112 -p udp --dport 3478 -j ACCEPT
   iptables -I INPUT "$((DROP_RULE + 1))" -s 0.0.0.0/0 -d 10.0.0.112 -p tcp -m multiport --dports 3478,5349 -j ACCEPT
   iptables -I INPUT "$((DROP_RULE + 2))" -s 0.0.0.0/0 -d 10.0.0.112 -p udp --dport 49160:49359 -j ACCEPT
   ```

   对本机 coturn 用户且源端口为 `49160:49359/udp` 的 OUTPUT 流量，在任何通用放行前先拒绝上述禁用地址（含主机自身公网 IP），再按批准的 `PEER_CIDR` 放行，最后拒绝剩余中继流量。例如每个批准网段的中继放行规则匹配 `-m owner --uid-owner turnserver -p udp --sport 49160:49359 -d "$PEER_CIDR" -j ACCEPT`；对应的兜底规则使用相同匹配（省略 `-d`），目标为 `REJECT`。核对规则顺序和变更范围，将 `iptables-save` 的 IPv4 输出写入临时文件，经 `iptables-restore --test` 验证后替换 netfilter-persistent 的 `/etc/iptables/rules.v4`，再比对运行规则与保存文件。
6. `systemctl daemon-reload` 后启用 `coturn.service`，检查监听与 TLS，再用批准的配置变更流程将同一密钥写入 `/etc/surreal-ck/server.env` 的 `TURN_SHARED_SECRET`；不要将密钥写到仓库、CLI 参数或前端环境。其余键如下：

   ```dotenv
   TURN_URLS=turn:data.maplayer.top:3478?transport=udp,turn:data.maplayer.top:3478?transport=tcp,turns:data.maplayer.top:5349?transport=tcp
   STUN_URLS=stun:data.maplayer.top:3478
   TURN_CREDENTIAL_TTL_SECONDS=600
   ```

   按 [origin 发布手册](production-release.md) 激活并核对 Bun 服务。签发必须使用已经配置的 IdP confidential client introspection；IdP 不可用时不会签发。coturn 日志走 syslog，不启用 verbose；不转存日志中的对端地址或原始 TURN 用户名。

## 验证

- `systemctl is-active coturn.service`、`ss -lnut` 核对监听；从准许的网络以 `openssl s_client -connect data.maplayer.top:5349 -servername data.maplayer.top -verify_hostname data.maplayer.top -verify_return_error </dev/null` 验证证书。同时以 `turnutils_stunclient -p 3478 data.maplayer.top` 验证 STUN。
- 先从经过授权的测试工作区取得有效临时凭据，在获准的网络和隔离的测试账户中，用一个批准的 UDP echo 测试对端（在对端启动 `turnutils_peer -L <本地测试地址> -p 3480`）检查 UDP 数据确有回包。只使用短期测试凭据，`turnutils_uclient` 的用户名和密码会进本机进程参数；使用不共享进程可见性的测试机，禁止录制、跟踪、保存原始输出或使用 `-W` 挂载共享密钥。以下变量在测试会话通过安全渠道填入，终止后清除。

  ```sh
  turnutils_uclient -c -m 1 -n 5 -p 3478 -e "$APPROVED_PEER" -r 3480 -u "$TURN_USER" -w "$TURN_PASS" data.maplayer.top
  ```

  重复时加 `-t` 验证 TCP；加 `-t -S -E /etc/ssl/certs/ca-certificates.crt -i "$TEST_CLIENT_CERT" -k "$TEST_CLIENT_KEY"` 并改为 `-p 5349` 验证 TLS。Ubuntu coturn 4.5.2 的测试工具要求客户端私钥；在隔离测试机上临时生成自签测试证书与匹配私钥，不能使用生产证书私钥（服务端不要求 mTLS）。在相同批准对端上将 `-w` 换成错误密码，随后将原凭据保留至 `expiresAt` 过期，再各开一个新客户端执行同一条命令：初始 401 nonce challenge 是正常的，但之后必须持续拒绝 Allocate（4.5.2 工具可能只报 `Cannot complete Allocation`），没有中继分配或 RTP；不要只以进程退出码判断。
- 用新的有效凭据把 `-e` 分别换成隔离环境中的 `10.x` 测试地址、`127.0.0.1` 及另一个批准用于负例但未列入 relay allowlist 的公网测试地址。应能分配 relay，随后 CreatePermission/ChannelBind 被拒（通常 403），对端没有收到数据。在受控测试网络验证即可，不以生产内网服务作探针。
- 按 [三账号验收](native-meeting-acceptance.md) 分别验证直连、单边回退及真实跨 NAT/热点；用 [证据模板](native-meeting-evidence.md) 只存脱敏结论。不以 TLS 握手或单端连通代替媒体验收。通过后才将台账改为 `verified: true`。

## 回滚

通过批准的 origin 发布流程移除 `TURN_SHARED_SECRET` 或 `TURN_URLS` 并重启 Bun，确认不再签发（503）。停止并禁用 `coturn.service`，关闭本次新增的 OCI 与主机防火墙规则，不改 HTTPS/WSS 或数据库规则。停止进程会结束现有分配；核对相应监听已消失。按凭据管理规程撤销、轮换或归档 0600 配置和密钥，并按资产管理规程更新台账。如果恢复前一版本，必须重新通过证书、限权及过期凭据检查。
