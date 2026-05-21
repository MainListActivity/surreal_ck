import { describe, expect, test } from "bun:test";
import {
  buildComposerSendOptions,
  composerModeView,
  selectComposerMode,
  type AiComposerMode,
  type ComposerDraftState,
} from "./global-ai-composer";

describe("global AI composer mode", () => {
  test("切换资源搜索模式保留当前输入内容", () => {
    const state: ComposerDraftState = {
      prompt: "查找合同解除相关资料",
      mode: "chat",
    };

    expect(selectComposerMode(state, "resource-search")).toEqual({
      prompt: "查找合同解除相关资料",
      mode: "resource-search",
    });
  });

  test("按钮视图直接暴露当前模式的图标和文案", () => {
    const modes: AiComposerMode[] = ["chat", "resource-search"];
    expect(modes.map((mode) => composerModeView(mode))).toEqual([
      { icon: "send", label: "发送" },
      { icon: "search", label: "搜索资源" },
    ]);
  });

  test("资源搜索模式会写入 sendAiMessage 请求选项，普通发送不写入", () => {
    expect(buildComposerSendOptions("chat")).toEqual({});
    expect(buildComposerSendOptions("resource-search")).toEqual({ composerMode: "resource-search" });
  });

  test("AI 抽屉头部只保留关闭入口，不再放资源搜索入口", async () => {
    const source = await Bun.file(new URL("./GlobalAiLauncher.svelte", import.meta.url)).text();
    const header = source.match(/<header>[\s\S]*?<\/header>/)?.[0] ?? "";

    expect(header).toContain('aria-label="关闭 AI 助手"');
    expect(header).not.toContain('name="search"');
    expect(header).not.toContain("主动补库");
    expect(header).not.toContain("openResearchWindow");
    expect(header).not.toContain("proactive");
  });
});
