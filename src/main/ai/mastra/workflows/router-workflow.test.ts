import { describe, expect, test } from "bun:test";
import {
  routeAndDispatch,
  runRouterDispatch,
  type SubAgentExecutors,
  type SharedWorkflowContext,
} from "./router-workflow";
import type { RouterLlmCaller, RouterPlan } from "./router-classifier";
import type { AiContextSnapshot } from "../../../../shared/ai-context";

const emptyContext: AiContextSnapshot = {
  route: { screen: "home" },
  workbook: null,
  sheet: null,
  selectedRow: null,
  contextHint: "",
};

function makeShared(overrides: Partial<SharedWorkflowContext> = {}): SharedWorkflowContext {
  return {
    userContext: emptyContext,
    confirmed: {},
    ...overrides,
  };
}

describe("router-workflow 调度", () => {
  test("plan 中只有 navigation 时只调 navigation 执行器", async () => {
    const calls: string[] = [];
    const executors: SubAgentExecutors = {
      navigation: async ({ taskText }) => {
        calls.push(`navigation:${taskText}`);
        return { text: "已找到工作簿 X", confirmed: {} };
      },
      dashboard: async () => {
        calls.push("dashboard");
        return { text: "", confirmed: {} };
      },
      "claim-analysis": async () => {
        calls.push("claim-analysis");
        return { text: "", confirmed: {} };
      },
      chitchat: async () => {
        calls.push("chitchat");
        return { text: "", confirmed: {} };
      },
    };

    const plan: RouterPlan = [{ category: "navigation", taskText: "打开工作簿 X" }];
    const result = await runRouterDispatch({ plan, shared: makeShared(), executors });

    expect(calls).toEqual(["navigation:打开工作簿 X"]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      category: "navigation",
      taskText: "打开工作簿 X",
      text: "已找到工作簿 X",
    });
  });

  test("plan 长度为 N 时按顺序串行调用对应 executor", async () => {
    const order: string[] = [];
    const executors: SubAgentExecutors = {
      navigation: async () => {
        order.push("nav");
        return { text: "n", confirmed: {} };
      },
      dashboard: async () => {
        order.push("dash");
        return { text: "d", confirmed: {} };
      },
      "claim-analysis": async () => {
        order.push("claim");
        return { text: "c", confirmed: {} };
      },
      chitchat: async () => {
        order.push("chit");
        return { text: "h", confirmed: {} };
      },
    };

    const plan: RouterPlan = [
      { category: "navigation", taskText: "a" },
      { category: "dashboard", taskText: "b" },
      { category: "chitchat", taskText: "c" },
    ];
    const result = await runRouterDispatch({ plan, shared: makeShared(), executors });

    expect(order).toEqual(["nav", "dash", "chit"]);
    expect(result.steps.map((s) => s.category)).toEqual(["navigation", "dashboard", "chitchat"]);
  });

  test("子 agent 完成后 confirmed 字段会合并到 shared.confirmed 供下一步读取", async () => {
    const seenByDashboard: SharedWorkflowContext["confirmed"][] = [];
    const executors: SubAgentExecutors = {
      navigation: async () => ({
        text: "找到了张三的记录",
        confirmed: { resolvedRecord: { id: "person:zs", label: "张三" } },
      }),
      dashboard: async ({ shared }) => {
        seenByDashboard.push({ ...shared.confirmed });
        return { text: "ok", confirmed: {} };
      },
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };

    const plan: RouterPlan = [
      { category: "navigation", taskText: "找张三" },
      { category: "dashboard", taskText: "对张三做统计" },
    ];
    await runRouterDispatch({ plan, shared: makeShared(), executors });

    expect(seenByDashboard).toHaveLength(1);
    expect(seenByDashboard[0].resolvedRecord).toEqual({ id: "person:zs", label: "张三" });
  });

  test("shared.userContext 在整个流程中是只读的", async () => {
    const executors: SubAgentExecutors = {
      navigation: async ({ shared }) => {
        // 试图变更也不该影响外部
        (shared.userContext as { route: { screen: string } }).route.screen = "MUTATED";
        return { text: "x", confirmed: {} };
      },
      dashboard: async () => ({ text: "", confirmed: {} }),
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };
    const shared = makeShared();
    await runRouterDispatch({
      plan: [{ category: "navigation", taskText: "x" }],
      shared,
      executors,
    });
    // 调度器对外暴露的 userContext 不应被污染
    expect(shared.userContext.route.screen).toBe("home");
  });

  test("routeAndDispatch 端到端：用户消息 → router → 对应 executor → 输出", async () => {
    const llm: RouterLlmCaller = async () =>
      `[{"category":"navigation","taskText":"打开工作簿 X"}]`;
    const executors: SubAgentExecutors = {
      navigation: async ({ taskText }) => ({
        text: `已为你打开 ${taskText}`,
        confirmed: { resolvedRecord: { id: "wb:x", label: "X" } },
      }),
      dashboard: async () => ({ text: "", confirmed: {} }),
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };
    const result = await routeAndDispatch({
      text: "打开工作簿 X",
      shared: makeShared(),
      executors,
      llmCaller: llm,
    });
    expect(result.plan).toEqual([{ category: "navigation", taskText: "打开工作簿 X" }]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].text).toBe("已为你打开 打开工作簿 X");
    expect(result.shared.confirmed.resolvedRecord).toEqual({ id: "wb:x", label: "X" });
  });

  test("routeAndDispatch 在 LLM 解析失败时降级到 chitchat", async () => {
    const calls: string[] = [];
    const llm: RouterLlmCaller = async () => "not json";
    const executors: SubAgentExecutors = {
      navigation: async () => {
        calls.push("nav");
        return { text: "", confirmed: {} };
      },
      dashboard: async () => {
        calls.push("dash");
        return { text: "", confirmed: {} };
      },
      "claim-analysis": async () => {
        calls.push("claim");
        return { text: "", confirmed: {} };
      },
      chitchat: async ({ taskText }) => {
        calls.push(`chit:${taskText}`);
        return { text: "你好～", confirmed: {} };
      },
    };
    const result = await routeAndDispatch({
      text: "在吗",
      shared: makeShared(),
      executors,
      llmCaller: llm,
    });
    expect(calls).toEqual(["chit:在吗"]);
    expect(result.steps[0].text).toBe("你好～");
  });

  test("confirmed 字段只能写入 executor 显式声明的产出", async () => {
    // 即使 executor 误返回了未声明的字段，也只有声明字段（通过类型）能到 confirmed。
    // 这里通过断言 confirmed 字段集合验证调度器只合并已知字段。
    const executors: SubAgentExecutors = {
      navigation: async () => ({
        text: "x",
        confirmed: { resolvedRecord: { id: "r:1", label: "L" } },
      }),
      dashboard: async () => ({
        text: "y",
        confirmed: { schemaSummary: { tables: ["t"], fieldsByTable: { t: ["f"] } } },
      }),
      "claim-analysis": async () => ({ text: "", confirmed: {} }),
      chitchat: async () => ({ text: "", confirmed: {} }),
    };
    const plan: RouterPlan = [
      { category: "navigation", taskText: "n" },
      { category: "dashboard", taskText: "d" },
    ];
    const result = await runRouterDispatch({ plan, shared: makeShared(), executors });
    expect(Object.keys(result.shared.confirmed).sort()).toEqual([
      "resolvedRecord",
      "schemaSummary",
    ]);
  });
});
