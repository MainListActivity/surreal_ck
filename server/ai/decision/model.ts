/**
 * 决策模型薄封装：与 llmCaller 平行的结构化决策层。
 *
 * 当前实现为 TypeSafe Jev（System One 模型）：一次请求携带 state + 一组类型化
 * 问题（noul / choice / score），返回每题的校准概率答案与决策置信度，不生成文本。
 *
 * 约定（与 docs/adr/jev-decision-model.md 对齐）：
 *   - client 只做调用与形状校验；置信门控与回退策略在调用方。
 *   - 网络错误 / 超时 / HTTP 非 2xx / 响应形状不符统一抛 DecisionModelError，
 *     调用方据此进入 LLM 回退。
 */

import { z } from "zod";

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 1500;

// ─── 请求形状 ────────────────────────────────────────────────────────────────

export type NoulQuestion = {
  type: "noul";
  instructions?: string;
};

export type ChoiceQuestion = {
  type: "choice";
  instructions?: string;
  /** 选项 → 说明；值可为 null 表示"无需说明"（如 other 兜底项）。 */
  criteria: Record<string, string | null>;
};

export type ScoreQuestion = {
  type: "score";
  instructions?: string;
  /** 从低到高的有序等级描述，2 到 10 级。 */
  criteria: string[];
};

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type DecisionRequest = {
  /** 决策输入：文本或可 JSON 化的对象；同一请求内所有问题共享。 */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  /** 覆盖默认模型别名（如 pin 到某个版本号）。 */
  model?: string;
};

// ─── 响应形状 ────────────────────────────────────────────────────────────────

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
  legend?: Record<string, string>;
};
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type DecisionUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type DecisionResult = {
  /** 实际回答的版本化模型 id（响应原样上报，供阈值调参与日志）。 */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
};

const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
    legend: z.record(z.string(), z.string()).optional(),
  }),
]);

const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

// ─── 错误 ────────────────────────────────────────────────────────────────────

export type DecisionModelErrorKind = "network" | "timeout" | "http" | "invalid_response";

export class DecisionModelError extends Error {
  readonly kind: DecisionModelErrorKind;
  readonly status?: number;

  constructor(kind: DecisionModelErrorKind, message: string, status?: number) {
    super(message);
    this.name = "DecisionModelError";
    this.kind = kind;
    this.status = status;
  }
}

// ─── client ─────────────────────────────────────────────────────────────────

export type DecisionCaller = (input: DecisionRequest) => Promise<DecisionResult>;

export type TypeSafeDecisionModelOptions = {
  apiKey: string;
  /** 默认 jev-latest（稳定别名）。调参后如需钉版本可传具体版本 id。 */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 测试注入；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
};

export function createTypeSafeDecisionModel(options: TypeSafeDecisionModelOptions): DecisionCaller {
  const {
    apiKey,
    model = DEFAULT_JEV_MODEL,
    baseUrl = TYPESAFE_SYSTEMONE_URL,
    timeoutMs = DEFAULT_JEV_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  return async (input: DecisionRequest): Promise<DecisionResult> => {
    const body = JSON.stringify({
      model: input.model ?? model,
      state: input.state,
      questions: input.questions,
    });

    let response: Response;
    try {
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new DecisionModelError("timeout", `decision model request timed out after ${timeoutMs}ms`);
      }
      throw new DecisionModelError("network", `decision model request failed: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new DecisionModelError("http", `decision model HTTP ${response.status}: ${detail.slice(0, 300)}`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DecisionModelError("invalid_response", "decision model returned non-JSON body");
    }

    const parsed = ResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DecisionModelError("invalid_response", `decision model response failed schema: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }

    return {
      model: parsed.data.model,
      answers: parsed.data.answers,
      usage: {
        inputTokens: parsed.data.usage?.input_tokens,
        outputTokens: parsed.data.usage?.output_tokens,
      },
    };
  };
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  ) || (error instanceof Error && error.name === "TimeoutError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
