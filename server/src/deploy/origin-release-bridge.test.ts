import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOOK_OK,
  SERVICE,
  TEST_TIMEOUT_MS,
  cleanupHarnesses,
  countPrefix,
  currentBasename,
  gateCalls,
  launch,
  makeHarness,
  serviceState,
  stageRelease,
  waitTerminal,
} from "./origin-release-harness";

/** 零停机桥接：重启正式 unit 前在旁路端口拉起新发布，正式进程健康后再停桥接。 */

const BRIDGE = { ORIGIN_BRIDGE: "1", ORIGIN_BRIDGE_SETTLE_SEC: "0" };
const CHECK_NOT_NEEDED = "#!/usr/bin/env bash\necho \"check:ran\" >>\"$GATE_LOG\"\necho \"pre-start: not-needed\"\n";
const CHECK_NEEDED = "#!/usr/bin/env bash\necho \"check:ran\" >>\"$GATE_LOG\"\necho \"pre-start: needed\"\n";
const t = (name: string, fn: () => Promise<void>) => test(name, fn, TEST_TIMEOUT_MS);

afterEach(cleanupHarnesses);

function indexOfPrefix(calls: string[], prefix: string): number {
  return calls.findIndex((c) => c.startsWith(prefix));
}

function lastIndexOfPrefix(calls: string[], prefix: string): number {
  return calls.findLastIndex((c) => c.startsWith(prefix));
}

describe("origin-release 零停机桥接", () => {
  t("无发布钩子：桥接健康 → 重启正式 unit（不先 stop）→ 正式健康后停桥接", async () => {
    const h = makeHarness();
    const id = "rel-bridge-ok";
    stageRelease(h, id, { target: "explicit", filtered: true });
    expect(launch(h, id, { extraEnv: BRIDGE }).exitCode).toBe(0);
    expect((await waitTerminal(h, id)).state).toBe("healthy");
    expect(currentBasename(h)).toBe(id);

    const calls = gateCalls(h);
    const run = indexOfPrefix(calls, "systemd-run:");
    expect(run).toBeGreaterThan(-1);
    const runCall = calls[run] ?? "";
    expect(runCall).toContain(`--unit=${SERVICE}-bridge`);
    expect(runCall).toContain("--setenv=PORT=8081");
    expect(runCall).toContain("--setenv=SERVER_BACKGROUND_WORKERS=off");
    expect(runCall).toContain(`releases/${id}/server/src/index.ts`);
    expect(indexOfPrefix(calls, "curl-bridge:")).toBeGreaterThan(run);
    const restart = indexOfPrefix(calls, `systemctl:restart ${SERVICE}`);
    expect(restart).toBeGreaterThan(indexOfPrefix(calls, "curl-bridge:"));
    expect(calls).not.toContain(`systemctl:stop ${SERVICE}`);
    expect(lastIndexOfPrefix(calls, `systemctl:stop ${SERVICE}-bridge`)).toBeGreaterThan(restart);
    expect(serviceState(h)).toBe("active");
    expect(existsSync(join(h.stateDir, "bridge.active"))).toBe(false);
  });

  t("预检确认内容迁移无需冻结 → 跳过停服与钩子，走桥接", async () => {
    const h = makeHarness();
    const id = "rel-bridge-check";
    stageRelease(h, id, { target: "explicit", filtered: true, hookBody: HOOK_OK, checkBody: CHECK_NOT_NEEDED });
    expect(launch(h, id, { extraEnv: BRIDGE }).exitCode).toBe(0);
    expect((await waitTerminal(h, id)).state).toBe("healthy");
    const calls = gateCalls(h);
    expect(calls).toContain("check:ran");
    expect(calls).not.toContain("hook:ran");
    expect(calls).not.toContain(`systemctl:stop ${SERVICE}`);
    expect(countPrefix(calls, "systemd-run:")).toBe(1);
  });

  t("钩子需要冻结写入（预检缺失或报告 needed）→ 不桥接，沿用停服执行钩子", async () => {
    for (const [id, checkBody] of [["rel-bridge-nocheck", undefined], ["rel-bridge-needed", CHECK_NEEDED]] as const) {
      const h = makeHarness();
      stageRelease(h, id, { target: "explicit", filtered: true, hookBody: HOOK_OK, ...(checkBody ? { checkBody } : {}) });
      expect(launch(h, id, { extraEnv: BRIDGE }).exitCode).toBe(0);
      expect((await waitTerminal(h, id)).state).toBe("healthy");
      const calls = gateCalls(h);
      expect(calls).toContain("hook:ran");
      expect(indexOfPrefix(calls, `systemctl:stop ${SERVICE}`)).toBeLessThan(calls.indexOf("hook:ran"));
      expect(countPrefix(calls, "systemd-run:")).toBe(0);
    }
  });

  t("桥接健康失败 → 中止前向发布：旧进程不被停/重启，current 不变，桥接被清理", async () => {
    const h = makeHarness();
    const id = "rel-bridge-bad";
    stageRelease(h, id, { target: "explicit", filtered: true });
    expect(launch(h, id, { extraEnv: { ...BRIDGE, T_HEALTH_BAD_BRIDGE: "1", ORIGIN_BRIDGE_HEALTH_TIMEOUT_SEC: "5" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).not.toBe("healthy");
    expect(currentBasename(h)).toBe("rel-old");
    const calls = gateCalls(h);
    expect(countPrefix(calls, `systemctl:restart ${SERVICE}`)).toBe(0);
    expect(calls).not.toContain(`systemctl:stop ${SERVICE}`);
    expect(calls).toContain(`systemctl:stop ${SERVICE}-bridge`);
    expect(serviceState(h)).toBe("active");
    expect(existsSync(join(h.stateDir, "bridge.active"))).toBe(false);
  });

  t("systemd-run 不可用 → 退回直接重启路径并正常完成", async () => {
    const h = makeHarness();
    const id = "rel-bridge-norun";
    stageRelease(h, id, { target: "explicit", filtered: true });
    expect(launch(h, id, { extraEnv: { ...BRIDGE, T_BRIDGE_RUN_FAIL: "1" } }).exitCode).toBe(0);
    expect((await waitTerminal(h, id)).state).toBe("healthy");
    const calls = gateCalls(h);
    expect(countPrefix(calls, "curl-bridge:")).toBe(0);
    expect(countPrefix(calls, `systemctl:restart ${SERVICE}`)).toBe(1);
  });
});
