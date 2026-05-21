import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { Observability, DefaultExporter, SensitiveDataFilter } from "@mastra/observability";
import { SurrealMastraStore } from "./mastra/storage/surreal-store";
import { createRouterWorkflow, ROUTER_WORKFLOW_ID } from "./mastra/workflows/router-workflow";
export { createNavigationAgent, NAVIGATION_AGENT_ID } from "./mastra/agents/navigation-agent";
export { createResourceAgent, RESOURCE_AGENT_ID } from "./mastra/agents/resource-agent";
export { ROUTER_WORKFLOW_ID } from "./mastra/workflows/router-workflow";
export {
  listDashboardGenerationTargets,
  previewGeneratedDashboardView,
  saveGeneratedDashboardView,
} from "../services/dashboard-mastra";

let _mastra: Mastra | null = null;

export function initMastraForCurrentUser(): Mastra {
  if (_mastra) return _mastra;

  _mastra = new Mastra({
    storage: new SurrealMastraStore(),
    workflows: {
      [ROUTER_WORKFLOW_ID]: createRouterWorkflow(),
    },
    logger: new PinoLogger({
      name: "Mastra",
      level: "info",
    }),
    observability: new Observability({
      configs: {
        default: {
          serviceName: "surreal-ck",
          exporters: [new DefaultExporter()],
          spanOutputProcessors: [new SensitiveDataFilter()],
        },
      },
    }),
  });
  console.log("[ai] Mastra initialized");
  return _mastra;
}

export function resetMastra(): void {
  _mastra = null;
}

export function getMastra(): Mastra {
  if (!_mastra) throw new Error("Mastra not initialized - authenticate before using AI features");
  return _mastra;
}
