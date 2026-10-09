import { readFileSync } from "node:fs";
import { z } from "zod";

const releaseSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/), deploymentId: z.string().regex(/^[0-9]+-[0-9]+$/),
});
export function parseRuntimeRelease(value: unknown) {
  const parsed = releaseSchema.safeParse(value);
  return parsed.success ? { state: "known" as const, ...parsed.data } : { state: "unknown" as const, sha: null, deploymentId: null };
}

function readOriginRelease() {
  try {
    return parseRuntimeRelease(JSON.parse(readFileSync(new URL("../../runtime-release.json", import.meta.url), "utf8")));
  } catch {
    return parseRuntimeRelease(null);
  }
}
// Capture the artifact at process startup, not from a mutable environment or current symlink.
const originRelease = readOriginRelease();

export async function readRuntimeVersion(fetchWeb: typeof fetch = fetch, origin = originRelease) {
  let web = parseRuntimeRelease(null);
  try {
    // Fixed company Pages origin, no caller URL or credentials; bypass cached old artifacts.
    const response = await fetchWeb(`https://l.maplayer.top/runtime-version.json?t=${Date.now()}`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      web = parseRuntimeRelease(await response.json());
    }
  } catch { /* Missing artifact, SPA fallback and network failure remain unknown. */ }
  return { serverTime: new Date().toISOString(), origin, web };
}
