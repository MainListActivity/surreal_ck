import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { Observability, DefaultExporter, SensitiveDataFilter } from "@mastra/observability";
import { SurrealMastraStore } from "./mastra/storage/surreal-store";
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
