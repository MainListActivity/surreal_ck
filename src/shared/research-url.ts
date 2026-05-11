export type ResearchSearchEngineId = "baidu" | "bing-cn";

export type ResearchSearchEngine = {
  id: ResearchSearchEngineId;
  label: string;
  buildSearchUrl(query: string): string;
};

export const DEFAULT_RESEARCH_SEARCH_ENGINE: ResearchSearchEngineId = "baidu";

export const RESEARCH_SEARCH_ENGINES: readonly ResearchSearchEngine[] = [
  {
    id: "baidu",
    label: "百度",
    buildSearchUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  },
  {
    id: "bing-cn",
    label: "必应中国",
    buildSearchUrl: (query) => `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
  },
];

const SEARCH_ENGINE_BY_ID = new Map(RESEARCH_SEARCH_ENGINES.map((engine) => [engine.id, engine]));

export type ResearchNavigationTarget = {
  kind: "visit" | "search";
  url: string;
};

export function normalizeResearchVisitUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw || /\s/.test(raw)) return null;

  if (raw.startsWith("//")) return normalizeHttpUrl(`https:${raw}`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return normalizeHttpUrl(raw);

  return normalizeBareDomainUrl(raw);
}

export function resolveResearchNavigation(
  value: string,
  engineId: ResearchSearchEngineId = DEFAULT_RESEARCH_SEARCH_ENGINE,
): ResearchNavigationTarget | null {
  const visitUrl = normalizeResearchVisitUrl(value);
  if (visitUrl) return { kind: "visit", url: visitUrl };

  const query = value.trim();
  if (!query) return null;

  const engine = SEARCH_ENGINE_BY_ID.get(engineId) ?? SEARCH_ENGINE_BY_ID.get(DEFAULT_RESEARCH_SEARCH_ENGINE);
  return {
    kind: "search",
    url: engine?.buildSearchUrl(query) ?? RESEARCH_SEARCH_ENGINES[0].buildSearchUrl(query),
  };
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isStandardNavigableHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeBareDomainUrl(value: string): string | null {
  try {
    const url = new URL(`https://${value}`);
    if (!isStandardNavigableHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isStandardNavigableHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (isIpv4Address(normalized)) return true;
  if (normalized.includes(":")) return true;
  if (!normalized.includes(".")) return false;

  const labels = normalized.split(".");
  if (labels.some((label) => !isValidDomainLabel(label))) return false;

  const tld = labels[labels.length - 1] ?? "";
  return /[a-z]/.test(tld) && !/^\d+$/.test(tld);
}

function isValidDomainLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9-]+$/.test(label) &&
    !label.startsWith("-") &&
    !label.endsWith("-")
  );
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    return num >= 0 && num <= 255 && String(num) === part;
  });
}
