export type ResearchSearchEngineId = "baidu" | "bing-cn";
export type ResearchSearchEngine = {
    id: ResearchSearchEngineId;
    label: string;
    buildSearchUrl(query: string): string;
};
export declare const DEFAULT_RESEARCH_SEARCH_ENGINE: ResearchSearchEngineId;
export declare const RESEARCH_SEARCH_ENGINES: readonly ResearchSearchEngine[];
export type ResearchNavigationTarget = {
    kind: "visit" | "search";
    url: string;
};
export declare function normalizeResearchVisitUrl(value: string | undefined): string | null;
export declare function resolveResearchNavigation(value: string, engineId?: ResearchSearchEngineId): ResearchNavigationTarget | null;
