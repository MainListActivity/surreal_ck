# SCK-LCAQ-01 来源准入与真实样本证据

状态：done（2026-09-30）
执行：engineering-factory-droid-c9806f / task ea2c110c
关联：`../PRD.md`、`../issues/01-source-qualification.md`、`legal-data-product-wayfinder/research/legal-content-samples.md`

## 结论

- **法规来源：国家税务总局政策法规库（fgk.chinatax.gov.cn）— 准入（受限）**。已通过 `/api/content/sources` 建立来源 + 不可变许可修订 revision 1，动作范围仅 `submit`（内部核验采集/暂存）。
- **裁判文书来源：最高人民法院国际商事法庭（cicc.court.gov.cn）— 准入（受限）**。已建立 revision 1 → revision 2，动作范围仅 `submit`。
- **不合格候选**：国家法律法规数据库（flk.npc.gov.cn）与 中国裁判文书网（wenshu.court.gov.cn）robots 明确禁止自动化采集，均**不**作为采集来源，未注册。
- 所有「客户发布 / 浏览 / 检索 / 读取 / 引用 / 导出 / AI 使用」动作因站点许可未确认**全部拒绝**（allowedActions 仅含 `submit`）。未知权利未被改判为允许。

## 注册记录（真实 API 调用，可追溯）

本地隔离栈（非生产）真实调用 `POST /api/content/sources`：native-quota SurrealDB 引擎（ghcr.io/mainlistactivity/surrealdb-native-quota:3.3.0-native-quota.1，容器 lca01-qualification-sdb）+ Bun server（Hono，真实路由/校验/存储代码路径）+ fixture IdP（`.scratch/sck-lca-03-e2e/fixture-idp.ts`，ops1 运营身份，真实 ES256 JWT）。载荷与响应工件在本目录 `register-*.json`。

| sourceKey | 状态 | source.allowedActions | license revision | licenseKind | license.allowedActions |
|---|---|---|---|---|---|
| fgk.chinatax.gov.cn | active | submit | 1 | official-statutory-text-internal-verification | submit |
| cicc.court.gov.cn | active | submit | 1 → 2 | site-statement-research-use-only | submit |

直查 `platform_content.source_license_revision`（2026-09-30T08:30Z，created_by_subject=ops1）：

- `content_source:4221b7592d8744c98a48a96bc9e0083b` rev 1（fgk）
- `content_source:7812a6d9971c45a6a8964c8ea798c3c4` rev 1 与 rev 2（cicc，append-only，历史未改写）

批次提交时固化 `sourceLicenseSnapshot`、发布前复查 `allowedActions` 由现有 `PlatformContentService` 承担（`server/src/content/service.ts`）：submit 门 = active + submit；publish 门 = allowedActions 含 publish（当前两者都不含 publish → 发布必被 `source_not_authorized` 拒绝）。

## 候选一（法规）：国家税务总局政策法规库

| 项 | 记录 |
|---|---|
| 官方入口 | https://fgk.chinatax.gov.cn （政策法规 > 法律，栏目列表 https://fgk.chinatax.gov.cn/zcfgk/c100009/listflfg_fg.html） |
| 发布者 | 国家税务总局；页脚原文「主办单位：国家税务总局 版权所有：国家税务总局」「网站标识码：bm29000002 京ICP备13021685号-2」 |
| 获取日期 | 2026-09-30 |
| 文件形态/完整性证据 | 法规全文 HTML。样本《中华人民共和国公司法》（成文日期 2023-12-29，第二次修订）https://fgk.chinatax.gov.cn/zcfgk/c100009/c5233383/content.html ：HTTP 200，305,131 字节，正文完整至「第二百六十六条 本法自 2024 年 7 月 1 日起施行」（即最后一编最后一条），与 `legal-content-samples.md` 样本 A 相互印证 |
| 稳定记录键 | 站内内容 id（URL 路径段如 `c5233383`）+ 发文字号/成文日期（列表页列「序号/标题/发文字号/成文日期」） |
| 增量发现 | 栏目列表页 HTTP 200 可达；列表行为前端渲染，程序化增量接口待 LCA-02 确认（未知项） |
| 可访问方式 | 普通 HTTP GET；无需登录、无验证码 |
| 访问限制 | robots.txt 不存在（HTTP 404）→ 无站点级自动化禁令 |
| 许可原文/出处 | 站点无附加转载限制声明；法规文本依《著作权法》第五条系不适用著作权的官方文件（法律、法规）；证据 URL 即样本全文页 |
| 有效期 | effectiveFrom 2026-09-30T00:00:00.000Z；effectiveUntil 未设 |
| 未知项 | 批量程序化访问的速率/技术限制；数据库编排汇编权利归属；商用与 AI 授权 → 全部拒绝相应动作，留待运营/法务 |

## 候选二（裁判文书）：最高人民法院国际商事法庭

| 项 | 记录 |
|---|---|
| 官方入口 | https://cicc.court.gov.cn （裁判文书 > 判决书，列表 https://cicc.court.gov.cn/html/1/218/180/316/index.html） |
| 发布者 | 最高人民法院；判决书页脚原文「中华人民共和国最高人民法院 版权所有 京ICP备05023036号」；站点原「版权保护」专栏链接已 404 → 站点级书面许可声明缺失 |
| 获取日期 | 2026-09-30 |
| 文件形态/完整性证据 | 裁判文书全文 HTML。样本（2022）最高法商初7号民事判决书 https://cicc.court.gov.cn/html/1/218/180/316/12572.html ：全文可读，结构完整——法院名称、文书类型、案号、当事人、诉讼代理人、事实查明、本院认为、判决主文（两项）、终审说明、合议庭成员与书记员、落款 2024-01-24；页面注明「来源：中国裁判文书网 发布时间：2024-09-04」 |
| 稳定记录键 | 站内文档路径 id（如 `12572`）+ 案号（（2022）最高法商初7号） |
| 增量发现 | 列表页按发布日期降序、带「下一页」分页（list2.html）；2026-09-30 实测列有 2025-03-19 至 2024-09-04 各条目 |
| 可访问方式 | 普通 HTTP GET；无登录、无验证码。存在 CWAP-waf cookie 挑战：客户端按 302 携带 cookie 后即 HTTP 200（68,645 字节），属标准 HTTP 会话处理，未绕过任何访问限制 |
| 访问限制 | robots.txt 不存在（HTTP 404） |
| 许可原文/出处 | 判决书栏目自带免责声明（列表页 HTML title 属性原文）：「本网站所提供的法律资源，均基于公开渠道整理，仅限用于学习和研究目的，不对内容完整性、准确性、时效性作出任何保证。若需使用，建议通过官方渠道核实。」 |
| 有效期 | effectiveFrom 2026-09-30T00:00:00.000Z；免责声明文本以 2026-09-30 抓取为准，站点修订后需复核 |
| 未知项 | 程序化访问速率限制；中国裁判文书网原始授权链；商用与 AI 授权；页面文本与盖章送达原件的一致性（本票不宣称「原件」） |

补充样本（同一许可态势，未单独注册）：最高人民法院知识产权法庭（2023）最高法知民终203号 https://ipc.court.gov.cn/zh-cn/news/view-2950.html 2026-09-30 HTTP 200（56,241 字节），正文（当事人、本院认为、裁定主文、落款）存在于 HTML，页脚「中华人民共和国最高人民法院 版权所有」；与 `legal-content-samples.md` 样本 F 相互印证。

## 不合格候选（证据保全，未注册）

| 候选 | 证据（2026-09-30） | 结论 |
|---|---|---|
| 国家法律法规数据库 flk.npc.gov.cn | robots.txt 原文：「#禁止使用任何自动化工具、脚本、爬虫程序采集或复制网站数据」「User-agent: * Disallow: /」 | 站点明确禁止自动化采集；不绕过（红线）。法规文本本身无著作权，但该站不能作为程序化来源 |
| 中国裁判文书网 wenshu.court.gov.cn | robots.txt「User-agent: * Disallow: /」（仅放行列名搜索引擎）；且历史上需登录/验证码 | 不合格。CICC 页面注明其文书「来源：中国裁判文书网」，但原始授权链未知 |

## 样本与证据纪律

- 本票**未**在仓库或库内存放任何法规/文书全文：只有 URL、结构完整性核验描述与许可原文引用（免责声明/页脚声明），符合「仅保存许可允许留存的证据」。
- 全文（法规 HTML）、判决书正文、指导案例整理稿、裁判原件四类材料严格区分：本票只主张「公开 HTML 全文页面已核验」，**不宣称**取得盖章原件或与送达正本逐字一致。
- 真实样本与合成 fixture 的差别：本票注册的真实来源 URL/许可证据来自上述官方网站的当日抓取；测试与联调继续使用 `fixture.synthetic.cn` 等合成 fixture（`server/src/content/service.test.ts` 等），两者不得互称。真实来源进入批次（LCA-02/04）仍受 `submit` 门与运营审核约束。

## 交接与升级

- 生产库注册：生产 `/api/content/sources` 已上线（GET 实测 401 需运营 token），注册需运营真人登录（runbook：`docs/runbooks/platform-content-local-runner.md` 的 OAuth/ego-browser 流程）或由具备 `content.source.manage` 的运营在运营端执行；载荷可直接复用本目录 `register-*.json`。
- 商用 / AI / 客户读取授权属外部许可判断，需运营/法务确认后另立许可修订（不可变历史保证可审计）；在此之前 02–04 的真实来源推进应保持合成/离线验证。
