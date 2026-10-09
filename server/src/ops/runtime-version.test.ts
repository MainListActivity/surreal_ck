import { expect, test } from "bun:test";
import { parseRuntimeRelease, readRuntimeVersion } from "./runtime-version";
const release = { sha: "a".repeat(40), deploymentId: "123-1" };
test("release metadata requires exact SHA and deployment identity; missing never becomes false/current", () => {
  expect(parseRuntimeRelease(release)).toEqual({ state: "known", ...release });
  for (const missing of [null, {}, { sha: "abc", deploymentId: "123-1" }, { sha: release.sha }]) {
    expect(parseRuntimeRelease(missing)).toEqual({ state: "unknown", sha: null, deploymentId: null });
  }
});
test("runtime observation fetches only company Pages without credentials; different web SHA remains distinct", async () => {
  const result = await readRuntimeVersion(async (url, init) => {
    expect(String(url)).toStartWith("https://l.maplayer.top/runtime-version.json?t=");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.headers).toBeUndefined();
    return Response.json({ ...release, sha: "b".repeat(40), ignored: "never-returned" });
  });
  expect(result.origin).toEqual({ state: "unknown", sha: null, deploymentId: null });
  expect(result.web).toEqual({ state: "known", ...release, sha: "b".repeat(40) });
});
test("missing web, SPA fallback, malformed metadata and failed fetch all report unknown", async () => {
  for (const response of [new Response("missing", { status: 404 }), new Response("<html>SPA</html>"), Response.json({ sha: release.sha }), new Response("broken", { headers: { "content-type": "application/json" } })]) {
    expect((await readRuntimeVersion(async () => response)).web.state).toBe("unknown");
  }
  expect((await readRuntimeVersion(async () => { throw new Error("offline"); })).web.state).toBe("unknown");
});
test("origin and web are independent deployment observations, including split releases", async () => {
  const origin = parseRuntimeRelease(release);
  const same = await readRuntimeVersion(async () => Response.json(release), origin);
  expect(same.origin.sha).toBe(same.web.sha);
  const split = await readRuntimeVersion(async () => Response.json({ ...release, sha: "c".repeat(40), deploymentId: "124-2" }), origin);
  expect(split.origin).toEqual(origin);
  expect(split.web.sha).not.toBe(split.origin.sha);
  expect(split.web.deploymentId).toBe("124-2");
});
