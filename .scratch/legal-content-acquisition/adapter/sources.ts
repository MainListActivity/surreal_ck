/**
 * LCAQ-02 本地采集适配器 —— 来源准入配置。
 *
 * 来源清单严格来自 LCAQ-01 准入记录（.scratch/legal-content-acquisition/qualification/）：
 * 只有已登记且许可允许 submit（内部核验采集/暂存）的来源才能进入采集。
 * 源键与生产 content_source 注册值一致（fgk.chinatax.gov.cn / cicc.court.gov.cn）。
 *
 * 红线：不内置任何来源凭证 / root / publisher secret；robots 全站禁采的来源
 * （flk.npc.gov.cn、wenshu.court.gov.cn）显式列为拒绝采集，防止误采。
 */

export type QualifiedSourceConfig = Readonly<{
  sourceKey: string;
  kind: "legislation" | "judicial_document";
  label: string;
  /** 采集入口主机（origin），robots 检查与 URL 校验用。 */
  origin: string;
  /** 该来源的许可修订号与许可类型，来自 LCAQ-01 准入记录。 */
  license: Readonly<{ revision: number; licenseKind: string }>;
  /** LCAQ-01 当日已核验 robots.txt 无自动化禁令（404 或站点无 robots 文件）。 */
  robotsVerifiedNoRestrictions: boolean;
}>;
/** robots.txt 明确禁止自动化采集的站点（LCAQ-01 证据保全，禁止进入采集流程）。 */
export const ROBOTS_FORBIDDEN_SOURCES: Readonly<Record<string, string>> = {
  "flk.npc.gov.cn": "robots.txt：禁止使用任何自动化工具、脚本、爬虫程序采集或复制网站数据（User-agent: * Disallow: /）",
  "wenshu.court.gov.cn": "robots.txt：User-agent: * Disallow: /",
};

export const QUALIFIED_SOURCES: Readonly<Record<string, QualifiedSourceConfig>> = {
  "fgk.chinatax.gov.cn": {
    sourceKey: "fgk.chinatax.gov.cn",
    kind: "legislation",
    label: "国家税务总局政策法规库",
    origin: "https://fgk.chinatax.gov.cn",
    license: { revision: 1, licenseKind: "official-statutory-text-internal-verification" },
    robotsVerifiedNoRestrictions: true,
  },
  "cicc.court.gov.cn": {
    sourceKey: "cicc.court.gov.cn",
    kind: "judicial_document",
    label: "最高人民法院国际商事法庭（裁判文书）",
    origin: "https://cicc.court.gov.cn",
    license: { revision: 2, licenseKind: "site-statement-research-use-only" },
    robotsVerifiedNoRestrictions: true,
  },
};

/** 适配器只产成品并提交 staging，绝不发布；发布是运营在 MCP 端的动作。 */
export const ADAPTER_ALLOWED_ACTION = "submit" as const;

export function sourceKeyForUrl(url: string): string | null {
  const parsed = new URL(url);
  return `${parsed.host}`;
}

export function requireQualifiedSource(url: string): QualifiedSourceConfig {
  const key = sourceKeyForUrl(url);
  if (key && key in ROBOTS_FORBIDDEN_SOURCES) {
    throw new AccessRestrictedError(`来源 ${key} 被站点规则拒绝采集：${ROBOTS_FORBIDDEN_SOURCES[key]}`);
  }
  if (!key || !(key in QUALIFIED_SOURCES)) {
    throw new AccessRestrictedError(`来源 ${key ?? url} 未通过 LCAQ-01 准入，采集器拒绝工作`);
  }
  return QUALIFIED_SOURCES[key];
}

/** 访问限制或许可边界触发时抛出：采集必须立即停止，而不是重试或绕过。 */
export class AccessRestrictedError extends Error {}
