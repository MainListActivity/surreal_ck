import { Mastra } from "@mastra/core";

let _mastra: Mastra | null = null;

export function initMastra(): Mastra {
  if (_mastra) return _mastra;

  _mastra = new Mastra({});
  console.log("[ai] Mastra initialized");
  return _mastra;
}

export function getMastra(): Mastra {
  if (!_mastra) throw new Error("Mastra not initialized — call initMastra() first");
  return _mastra;
}
