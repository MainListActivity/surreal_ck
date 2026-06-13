import { describe, expect, test } from "bun:test";
import {
  createSwitchWorkspacePanelController,
  initialSwitchWorkspacePanelState,
} from "./switch-workspace-panel";
import type { WorkspaceListItem } from "./switch-workspace";

const workspaces: WorkspaceListItem[] = [
  { slug: "alpha", name: "Alpha", dbName: "ws_alpha", role: "admin", lastSelectedAt: null },
  { slug: "beta", name: "Beta", dbName: "ws_beta", role: "participant", lastSelectedAt: null },
];

describe("switch workspace inline panel", () => {
  test("choose() 切换非当前 workspace：调用 switchWorkspace、关闭 panel、刷新当前 workspace", async () => {
    const calls = { switch: [] as string[], load: 0 };
    let currentDbName = "ws_alpha";
    const controller = createSwitchWorkspacePanelController({
      loadWorkspaces: async () => {
        calls.load += 1;
        return { workspaces, currentDbName, canCreate: true };
      },
      switchWorkspace: async (slug) => {
        calls.switch.push(slug);
        currentDbName = "ws_beta";
        return { ok: true };
      },
    });

    const initial = {
      ...initialSwitchWorkspacePanelState(),
      open: true,
      workspaces,
      currentDbName,
      canCreate: true,
    };

    const next = await controller.choose(initial, "beta");

    expect(calls.switch).toEqual(["beta"]);
    expect(calls.load).toBe(1);
    expect(next.open).toBe(false);
    expect(next.currentDbName).toBe("ws_beta");
    expect(next.switching).toBeNull();
    expect(next.error).toBeNull();
  });

  test("choose() 点击当前 workspace：直接关闭 panel，不调用 switchWorkspace", async () => {
    const calls = { switch: [] as string[], load: 0 };
    const controller = createSwitchWorkspacePanelController({
      loadWorkspaces: async () => {
        calls.load += 1;
        return { workspaces, currentDbName: "ws_alpha", canCreate: true };
      },
      switchWorkspace: async (slug) => {
        calls.switch.push(slug);
        return { ok: true };
      },
    });

    const initial = {
      ...initialSwitchWorkspacePanelState(),
      open: true,
      workspaces,
      currentDbName: "ws_alpha",
      canCreate: true,
    };

    const next = await controller.choose(initial, "alpha");

    expect(calls.switch).toHaveLength(0);
    expect(calls.load).toBe(0);
    expect(next.open).toBe(false);
    expect(next.currentDbName).toBe("ws_alpha");
    expect(next.switching).toBeNull();
    expect(next.error).toBeNull();
  });
});
