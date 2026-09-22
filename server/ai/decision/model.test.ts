import { describe, expect, test } from "bun:test";
import {
  createTypeSafeDecisionModel,
  DecisionModelError,
} from "./model";

const VALID_BODY = {
  model: "jev-1.13.0",
  answers: {
    multi_intent: { type: "noul", noul: 0.1 },
    category: {
      type: "choice",
      choice: "navigation",
      probabilities: { navigation: 0.9, dashboard: 0.1 },
      confidence: 0.9,
    },
    severity: {
      type: "score",
      score: 1.4,
      probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 },
      confidence: 0.8,
      legend: { "0": "低", "1": "中", "2": "高" },
    },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
};

function fakeFetch(status: number, body: unknown, delayMs = 0): typeof fetch {
  return (async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("decision-model client", () => {
  test("成功响应：解析 model/answers/usage 并按题型返回", async () => {
    let sentBody = "";
    let sentAuth = "";
    const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      sentAuth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify(VALID_BODY), { status: 200 });
    }) as typeof fetch;

    const decide = createTypeSafeDecisionModel({ apiKey: "sk-test", fetchImpl });
    const result = await decide({
      state: { message: "打开工作簿" },
      questions: {
        multi_intent: { type: "noul", instructions: "是否多意图" },
        category: {
          type: "choice",
          instructions: "哪个类别",
          criteria: { navigation: "导航", dashboard: "仪表盘" },
        },
        severity: { type: "score", criteria: ["低", "中", "高"] },
      },
    });

    expect(sentAuth).toBe("Bearer sk-test");
    const parsed = JSON.parse(sentBody);
    expect(parsed.model).toBe("jev-latest");
    expect(parsed.questions.category.type).toBe("choice");

    expect(result.model).toBe("jev-1.13.0");
    const noul = result.answers.multi_intent;
    const choice = result.answers.category;
    const score = result.answers.severity;
    expect(noul.type).toBe("noul");
    expect(choice.type).toBe("choice");
    expect(score.type).toBe("score");
    if (noul.type === "noul") expect(noul.noul).toBeCloseTo(0.1);
    if (choice.type === "choice") {
      expect(choice.choice).toBe("navigation");
      expect(choice.confidence).toBeCloseTo(0.9);
    }
    if (score.type === "score") expect(score.score).toBeCloseTo(1.4);
    expect(result.usage.inputTokens).toBe(100);
  });

  test("HTTP 非 2xx → DecisionModelError(kind=http)", async () => {
    const decide = createTypeSafeDecisionModel({
      apiKey: "sk-test",
      fetchImpl: fakeFetch(429, "rate limited"),
    });
    try {
      await decide({ state: "x", questions: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DecisionModelError);
      expect((e as DecisionModelError).kind).toBe("http");
      expect((e as DecisionModelError).status).toBe(429);
    }
  });

  test("非 JSON 响应体 → kind=invalid_response", async () => {
    const decide = createTypeSafeDecisionModel({
      apiKey: "sk-test",
      fetchImpl: fakeFetch(200, "not json{{{"),
    });
    try {
      await decide({ state: "x", questions: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionModelError).kind).toBe("invalid_response");
    }
  });

  test("响应形状缺字段 → kind=invalid_response", async () => {
    const decide = createTypeSafeDecisionModel({
      apiKey: "sk-test",
      fetchImpl: fakeFetch(200, { model: "jev-1.13.0" }),
    });
    try {
      await decide({ state: "x", questions: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionModelError).kind).toBe("invalid_response");
    }
  });

  test("fetch 抛 AbortError/TimeoutError → kind=timeout", async () => {
    const fetchImpl = (async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as typeof fetch;
    const decide = createTypeSafeDecisionModel({ apiKey: "sk-test", fetchImpl });
    try {
      await decide({ state: "x", questions: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionModelError).kind).toBe("timeout");
    }
  });

  test("fetch 抛普通网络错误 → kind=network", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const decide = createTypeSafeDecisionModel({ apiKey: "sk-test", fetchImpl });
    try {
      await decide({ state: "x", questions: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionModelError).kind).toBe("network");
    }
  });

  test("超时中断：AbortSignal.timeout 到期中断慢响应", async () => {
    const fetchImpl: typeof fetch = ((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out", "TimeoutError")),
        );
      });
    }) as typeof fetch;
    const decide = createTypeSafeDecisionModel({ apiKey: "sk-test", fetchImpl, timeoutMs: 50 });
    const started = Date.now();
    try {
      await decide({ state: "x", questions: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as DecisionModelError).kind).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});
