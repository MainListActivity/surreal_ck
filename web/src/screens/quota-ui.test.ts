import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

describe("SCK-NQ-08 quota UI wiring", () => {
  test("workspace settings renders the role-shaped native quota summary", () => {
    const settings = source("./WorkspaceSettingsScreen.svelte");
    const quota = source("../components/quota/QuotaOverview.svelte");
    expect(settings).toContain(
      'import QuotaOverview from "../components/quota/QuotaOverview.svelte";',
    );
    expect(settings).toContain("<QuotaOverview slug={workspaceSlug} />");
    expect(quota).toContain('view?.view === "workspace_admin"');
    expect(quota).toContain('view?.view === "operator"');
    expect(quota).toContain('view?.view === "participant"');
    expect(quota).toContain("未知值不会显示为 0");
    expect(quota).toContain("pendingChange");
    expect(quota).toContain("matched_tables");
  });

  test("operations console is independent and gates actions by capabilities", () => {
    const app = source("../App.svelte");
    const operations = source("./QuotaOperationsScreen.svelte");
    expect(app).toContain('route.kind === "ops"');
    expect(app).toContain("<QuotaOperationsScreen");
    expect(operations).toContain("availableQuotaOpsActions");
    expect(operations).toContain("Fresh preflight 与影响预览");
    expect(operations).toContain("预计超额项");
    expect(operations).toContain("我确认已核对 current/target");
    expect(operations).toContain("HTTP 202 只表示意图已持久化");
    expect(operations).not.toContain("root token");
  });

  test("billing aggregate and in-app notifications have dedicated entry points", () => {
    const app = source("../App.svelte");
    const billing = source("./BillingQuotaScreen.svelte");
    const navigation = source("../components/SideNav.svelte");
    expect(app).toContain('route.kind === "billing-quota"');
    expect(billing).toContain("不会泄露物理表名或逐表记录数");
    expect(billing).toContain("grace_until");
    expect(billing).toContain("cancel_at");
    expect(navigation).toContain("<QuotaNotificationMenu");
  });
});
