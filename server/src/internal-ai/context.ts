import { AsyncLocalStorage } from "node:async_hooks";
export type InternalScope = Readonly<{ activity: string; runHash: string; keyHash: string; logicalHash: string; stage?: string }>;
const context = new AsyncLocalStorage<InternalScope>();
export const internalScope = () => context.getStore();
export function inInternalScope<T>(scope: InternalScope, work: () => T): T { return context.run(scope, work); }
export function forbidUnmeteredPath(): void { if (internalScope()) throw new Error("internal-ai-path-unavailable"); }
export function inInternalStage<T>(stage: string, work: () => T): T {
  const scope = internalScope(); return scope ? inInternalScope({ ...scope, stage }, work) : work();
}
