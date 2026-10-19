// 发布门禁测试共享夹具：从 origin-release-gate.test.ts 原样搬移（行为不变）。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TrialCompat =
  | "explicit"
  | "implicit"
  | "implicit-spacing"
  | "indirect-source"
  | "hybrid-literal"
  | "stub-entry"
  | "unmounted-entry"
  | "old-origin"
  | "no-entry"
  | "no-route"
  | "unreadable-route";

// 逐变体夹具：三份关键文件分别构造，正向契约每层都有独立命中的拒绝用例。
export const ROUTE_CLOSED = 'return c.json({ error: { code: "workspace-commercial-source-required" } });\n';
export const ROUTE_IMPLICIT =
  'const r = await workspaceCreator.createWorkspace({ resourceSource: { planKey: "trial", sourceKind: "trial" } });\n';
export const ROUTE_IMPLICIT_SPACING =
  "const r = await workspaceCreator.createWorkspace({ resourceSource: { planKey : 'trial' } });\n";
// 间接来源赋值：trial 来源经变量传入，路由文件里没有 "trial" 字面量。
export const ROUTE_INDIRECT =
  ROUTE_CLOSED + "const src = pickSource();\nconst r = await workspaceCreator.createWorkspace({ resourceSource: src });\n";
// 混合树：关闭契约在场但仍残留 trial 键值字面量。
export const ROUTE_HYBRID_LITERAL = ROUTE_CLOSED + 'const fallback = { planKey : "trial" };\n';
export const ENTRY_REAL = "// POST /api/pro-trial/start gated by pro_trial_configuration\nexport function createProTrialRoutes() {}\n";
export const ENTRY_STUB = "export function createProTrialRoutes() {}\n";
export const APP_MOUNTED = '.route("/", createProTrialRoutes(service));\n';
export const APP_UNMOUNTED = '.route("/", createWorkspaceRoutes());\n';

export function writeAllowanceTree(base: string, compatible = true) {
  for (const path of ["shared/src", "shared/sql/system", "shared/sql/workspace-template", "server/src/ai-allowance"]) mkdirSync(join(base, path), { recursive: true });
  writeFileSync(join(base, "shared/src/ai-allowance.ts"), "AI_ALLOWANCE_CONSUMABLE_SQL");
  writeFileSync(join(base, "shared/sql/system/027-ai-trial-conversion-source.surql"), "// structure");
  writeFileSync(join(base, "shared/sql/workspace-template/047-ai-source-termination.surql"), "// structure");
  writeFileSync(join(base, "server/src/ai-allowance/service.ts"), compatible ? "aiAllowancePlanPrefix\nWHERE AI_ALLOWANCE_CONSUMABLE_SQL\nWHERE AI_ALLOWANCE_CONSUMABLE_SQL\n" : "// old unrestricted consumption");
  writeFileSync(join(base, "server/src/ai-allowance/plan-cycle.ts"), "plan-cycle-rules-v4 conversion.sourceId");
}

export function writeTrialTree(base: string, compat: TrialCompat) {
  writeAllowanceTree(base);
  const routes = join(base, "server", "src", "routes");
  mkdirSync(routes, { recursive: true });
  const routeByCompat: Partial<Record<TrialCompat, string>> = {
    explicit: ROUTE_CLOSED,
    implicit: ROUTE_IMPLICIT,
    "implicit-spacing": ROUTE_IMPLICIT_SPACING,
    "indirect-source": ROUTE_INDIRECT,
    "hybrid-literal": ROUTE_HYBRID_LITERAL,
    "stub-entry": ROUTE_CLOSED,
    "unmounted-entry": ROUTE_CLOSED,
    "old-origin": ROUTE_IMPLICIT,
    "no-entry": ROUTE_CLOSED,
    "unreadable-route": ROUTE_CLOSED,
  };
  const route = routeByCompat[compat];
  if (route !== undefined) {
    const path = join(routes, "workspaces.ts");
    writeFileSync(path, route);
    if (compat === "unreadable-route") chmodSync(path, 0o000);
  }
  const entryByCompat: Partial<Record<TrialCompat, string>> = {
    explicit: ENTRY_REAL,
    implicit: ENTRY_REAL,
    "implicit-spacing": ENTRY_REAL,
    "indirect-source": ENTRY_REAL,
    "hybrid-literal": ENTRY_REAL,
    "stub-entry": ENTRY_STUB,
    "unmounted-entry": ENTRY_REAL,
    "no-route": ENTRY_REAL,
    "unreadable-route": ENTRY_REAL,
  };
  const entry = entryByCompat[compat];
  if (entry !== undefined) writeFileSync(join(routes, "pro-trial.ts"), entry);
  const app = compat === "unmounted-entry" || compat === "old-origin" ? APP_UNMOUNTED : APP_MOUNTED;
  writeFileSync(join(base, "server", "src", "app.ts"), app);
}
