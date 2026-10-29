import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { expect, spyOn, test } from "bun:test";
import type { RecordId } from "surrealdb";
import { InternalBudgetModel } from "./model";
import { inInternalScope, type InternalScope } from "./context";
import type { AttemptTicket, InternalAiGate } from "./gate";
import type { Tariff } from "./pricing";

type Options = Parameters<ModelRouterLanguageModel["doStream"]>[0];
const scope: InternalScope = { activity: "synthetic-activity", runHash: "run", keyHash: "key", logicalHash: "logical" };
const settings = { provider: "openai", model: "sensenova-6.8-flash-lite", baseUrl: "https://token.sensenova.cn/v1", apiKey: "synthetic-only" };
const tariff = { maxOutput: 65536 } as Tariff;
const emptyStream = () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) });
const passthroughGate = () => ({ begin: async () => undefined, finish: async () => {} }) as unknown as InternalAiGate;

// 生产 03d839b6 行分析失败形态：reasoning 模型首步后，Mastra 把含 reasoning part 的
// assistant 消息回传进下一步 prompt；此前在 internal scope 被门卫 deterministic 拒绝。
const multiStepPrompt: Options["prompt"] = [
  { role: "system", content: "synthetic-system" },
  { role: "user", content: [{ type: "text", text: "synthetic-user" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "synthetic-CoT-must-not-reach-transport" },
      { type: "tool-call", toolCallId: "c1", toolName: "analyzeRow", input: {} },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c1", toolName: "analyzeRow", output: { type: "json", value: { ok: true } } }],
  },
];

test("internal scope：多步回传 reasoning 的 prompt 不再被门卫拒绝，reasoning 在发送前剥离", async () => {
  const sent: Options[] = [];
  const mock = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async options => { sent.push(options); return emptyStream(); });
  try {
    const model = new InternalBudgetModel(settings, "row-analysis-agent", passthroughGate());
    await inInternalScope(scope, () => model.doStream({ prompt: multiStepPrompt }));
    expect(sent).toHaveLength(1);
    const assistant = sent[0]!.prompt.find(m => m.role === "assistant")!;
    expect(assistant.role === "assistant" && assistant.content).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "analyzeRow", input: {} },
    ]);
    expect(JSON.stringify(sent[0]!.prompt)).not.toContain("synthetic-CoT");
  } finally { mock.mockRestore(); }
});

test("internal scope 计量路径：reasoning 剥离走 capped 请求，usage 照常 finish", async () => {
  const sent: Options[] = [];
  let finishes = 0;
  const gate = {
    begin: async (): Promise<AttemptTicket> => ({ id: "attempt:synthetic" as unknown as RecordId, tariff }),
    finish: async () => { finishes++; },
  } as unknown as InternalAiGate;
  const mock = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async options => {
    sent.push(options);
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } });
      c.close();
    } }) };
  });
  try {
    const model = new InternalBudgetModel(settings, "row-analysis-agent", gate);
    const result = await inInternalScope(scope, () => model.doStream({ prompt: multiStepPrompt }));
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) { /* consume */ }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.maxOutputTokens).toBe(tariff.maxOutput);
    const assistant = sent[0]!.prompt.find(m => m.role === "assistant")!;
    expect(assistant.role === "assistant" && assistant.content.every(p => p.type !== "reasoning")).toBe(true);
    expect(finishes).toBe(1);
  } finally { mock.mockRestore(); }
});

test("internal scope：真正不支持的输入仍 fail-closed 拒绝且不消耗 provider attempt", async () => {
  const sent: Options[] = [];
  let begins = 0;
  const gate = { begin: async () => { begins++; return undefined; }, finish: async () => {} } as unknown as InternalAiGate;
  const mock = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async options => { sent.push(options); return emptyStream(); });
  const userText: Options["prompt"] = [{ role: "user", content: [{ type: "text", text: "synthetic" }] }];
  const cases: Options[] = [
    // file part：当前证书仅覆盖文本，维持拒绝。
    { prompt: [{ role: "user", content: [{ type: "file", data: "AAAA", mediaType: "image/png" }] }] },
    // tool-result 的 content/media 输出形状不在许可集。
    { prompt: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "t", output: { type: "content", value: [{ type: "text", text: "x" }] } }] }] },
    // 非 function 工具。
    { prompt: userText, tools: [{ type: "provider-defined", id: "openai.web_search", name: "web_search", args: {} }] },
    // 非 openai 命名空间与 openai 内非 stream 键的 providerOptions。
    { prompt: userText, providerOptions: { anthropic: { thinking: true } } as Options["providerOptions"] },
    { prompt: userText, providerOptions: { openai: { reasoningEffort: "low" } } as Options["providerOptions"] },
    // user 位置的 reasoning part 属 spec 外形状，不放行。
    { prompt: [{ role: "user", content: [{ type: "reasoning", text: "x" } as never] }] },
  ];
  try {
    const model = new InternalBudgetModel(settings, "row-analysis-agent", gate);
    for (const options of cases) {
      await expect(inInternalScope(scope, () => model.doStream(options))).rejects.toThrow("internal-ai-input-format-unavailable");
      await expect(inInternalScope(scope, () => model.doGenerate(options))).rejects.toThrow("internal-ai-input-format-unavailable");
    }
    expect(begins).toBe(0);
    expect(sent).toHaveLength(0);
  } finally { mock.mockRestore(); }
});

const step1Stream = () => ({ stream: new ReadableStream({ start(c) {
  c.enqueue({ type: "stream-start", warnings: [] });
  c.enqueue({ type: "reasoning-start", id: "r1" });
  c.enqueue({ type: "reasoning-delta", id: "r1", delta: "synthetic-CoT" });
  c.enqueue({ type: "reasoning-end", id: "r1" });
  c.enqueue({ type: "tool-call", toolCallId: "call-1", toolName: "echoTool", input: "{}" });
  c.enqueue({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5 } });
  c.close();
} }) });
const step2Stream = () => ({ stream: new ReadableStream({ start(c) {
  c.enqueue({ type: "stream-start", warnings: [] });
  c.enqueue({ type: "text-start", id: "t1" });
  c.enqueue({ type: "text-delta", id: "t1", delta: "完成" });
  c.enqueue({ type: "text-end", id: "t1" });
  c.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 3 } });
  c.close();
} }) });
const echoTool = createTool({ id: "echoTool", description: "synthetic echo", inputSchema: z.object({}), execute: async () => ({ ok: true }) });
const reasoningParts = (prompt: Options["prompt"]) =>
  prompt.flatMap(m => m.role === "system" ? [] : m.content.filter(c => c.type === "reasoning"));

test("端到端：真实 Agent 多步循环在 internal scope 走完两步，reasoning 回传被剥离", async () => {
  const sent: Options[] = [];
  const mock = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async options => {
    sent.push(options);
    return sent.length === 1 ? step1Stream() : step2Stream();
  });
  try {
    const agent = new Agent({ name: "multi-step-probe", instructions: "synthetic", model: new InternalBudgetModel(settings, "row-analysis-agent", passthroughGate()), tools: { echoTool } });
    const stream = await inInternalScope(scope, () => agent.stream("分析", { maxSteps: 4, providerOptions: { openai: { stream: true } } }));
    expect(await stream.text).toBe("完成");
    expect(sent).toHaveLength(2);
    expect(reasoningParts(sent[1]!.prompt)).toHaveLength(0);
    expect(JSON.stringify(sent[1]!.prompt)).toContain("call-1");
  } finally { mock.mockRestore(); }
});

test("触发条件佐证：同一多步流在非 internal scope 下第二步 prompt 确实含 reasoning part", async () => {
  const sent: Options[] = [];
  const mock = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async options => {
    sent.push(options);
    return sent.length === 1 ? step1Stream() : step2Stream();
  });
  try {
    const agent = new Agent({ name: "multi-step-probe", instructions: "synthetic", model: new InternalBudgetModel(settings, "row-analysis-agent", passthroughGate()), tools: { echoTool } });
    const stream = await agent.stream("分析", { maxSteps: 4 });
    await stream.text;
    expect(sent).toHaveLength(2);
    expect(reasoningParts(sent[1]!.prompt).length).toBeGreaterThan(0);
  } finally { mock.mockRestore(); }
});

test("单步路径不误伤：internal scope 纯文本请求照常发送；非 internal scope 原样透传不剥离", async () => {
  const sent: Options[] = [];
  const mock = spyOn(ModelRouterLanguageModel.prototype, "doStream").mockImplementation(async options => { sent.push(options); return emptyStream(); });
  try {
    const model = new InternalBudgetModel(settings, "chitchat", passthroughGate());
    await inInternalScope(scope, () => model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }] }));
    expect(sent).toHaveLength(1);
    const reasoningBack: Options["prompt"] = [{ role: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "text", text: "t" }] }];
    await model.doStream({ prompt: reasoningBack });
    expect(sent).toHaveLength(2);
    const assistant = sent[1]!.prompt[0]!;
    expect(assistant.role === "assistant" && assistant.content).toHaveLength(2);
  } finally { mock.mockRestore(); }
});

test('model capability 384000 does not override the approved 65536 output ceiling', async () => {
  const sent: Options[] = [];
  const gate = { begin: async () => ({ id: 'attempt:synthetic', tariff: { maxOutput: 65536 } }), finish: async () => {} } as unknown as InternalAiGate;
  const mock = spyOn(ModelRouterLanguageModel.prototype, 'doStream').mockImplementation(async options => { sent.push(options); return emptyStream(); });
  try {
    const model = new InternalBudgetModel({ ...settings, model: 'group/work' }, 'synthetic-stage', gate);
    await inInternalScope(scope, () => model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }], maxOutputTokens: 384000 }));
    expect(sent[0]!.maxOutputTokens).toBe(65536);
    expect(sent[0]!.maxOutputTokens).toBeLessThan(384000);
  } finally { mock.mockRestore(); }
});
