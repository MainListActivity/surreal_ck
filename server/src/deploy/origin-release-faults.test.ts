import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BEFORE,
  HOOK_BLOCK,
  HOOK_FAIL,
  HOOK_OK,
  SCRIPT_PATH,
  SECRET_MARKERS,
  SERVICE,
  SHA,
  TEST_TIMEOUT_MS,
  cleanupHarnesses,
  countPrefix,
  currentBasename,
  deadPid,
  gateCalls,
  launch,
  listFiles,
  makeHarness,
  pinSensitive,
  readText,
  run,
  sensitiveViolations,
  serviceState,
  snapshotTree,
  spawnLaunch,
  stageRelease,
  status,
  unitMutations,
  waitTerminal,
  waitUntil,
  writeLock,
  zeroTouchViolations,
  type Harness,
} from "./origin-release-harness";

/**
 * origin-release.sh 执行级故障门禁（真实脚本；外部命令为替身，见 origin-release-harness.ts）。
 * 覆盖：G1 前向路径各阶段失败；F1 回滚前提在停服/env 写入前核验与停服后拒绝的终态；
 * F2 撤销检查器输出严格解析与上层拒绝激活；F13 陈旧锁回收互斥与并发；G3 敏感对象零触碰（含 recover 路径与变异检测）；
 * AC04 主机入参 sha 校验。
 */

afterEach(() => {
  cleanupHarnesses();
});

const t = (name: string, fn: () => unknown | Promise<unknown>) => test(name, fn, TEST_TIMEOUT_MS);

// 仪器（仅测试桩）：每次 start/restart 时刻记录 server.env 中本激活被拒绝增改的出现次数；0 即激活前内容。
// 只记录计数，不记录值，保证测试日志不含 env 内容。
const ENV_AT_START_INSTRUMENT = `
eval "$(declare -f systemctl | sed '1s/^systemctl /orig_systemctl /')"
systemctl() {
  case "\${1:-}" in
    start|restart) echo "ENVSNAP:\${1}:additions_present=$(grep -cE 'after-value-7f3|new-value-9c1' "$ORIGIN_ENV_FILE" || true)" >>"$GATE_LOG" ;;
  esac
  orig_systemctl "$@"
}
`;

function expectNoSecrets(h: Harness, id: string, extra: string[] = []) {
  const texts = [run(h, ["--status", id]).stdout, run(h, ["--log", id]).stdout, readText(h.gateLog), ...extra];
  for (const text of texts) {
    for (const marker of SECRET_MARKERS) {
      expect(text).not.toContain(marker);
    }
  }
}

describe("G1 前向路径失败注入（执行级）", () => {
  t("依赖安装失败 → failed，零服务变更，env 与 current 不变，暂存件清理", async () => {
    const h = makeHarness();
    const id = "g1-install";
    const staged = stageRelease(h, id);
    expect(launch(h, id, { extraEnv: { T_BUNX_FAIL: "1" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("failed");
    expect(s.note).toContain("no service change");
    expect(countPrefix(gateCalls(h), "bunx:pnpm@10.32.1 install")).toBe(1);
    expect(unitMutations(h)).toEqual([]);
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(currentBasename(h)).toBe("rel-old");
    expect(existsSync(staged.archive)).toBe(false);
    expect(existsSync(staged.envPath)).toBe(false);
    expect(run(h, ["--log", id]).stdout).toContain("dependency install failed");
    expectNoSecrets(h, id);
  });

  t("解包失败 → failed，零服务变更，依赖安装未执行", async () => {
    const h = makeHarness();
    const id = "g1-unpack";
    const staged = stageRelease(h, id);
    expect(launch(h, id, { extraEnv: { T_UNPACK_FAIL: "1" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("failed");
    expect(s.note).toContain("no service change");
    expect(gateCalls(h)).toContain("tar:injected");
    expect(countPrefix(gateCalls(h), "bunx:")).toBe(0);
    expect(unitMutations(h)).toEqual([]);
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(currentBasename(h)).toBe("rel-old");
    expect(existsSync(staged.archive)).toBe(false);
    expect(existsSync(staged.envPath)).toBe(false);
    expect(run(h, ["--log", id]).stdout).toContain("archive unpack failed");
    expectNoSecrets(h, id);
  });

  t("pre-start 钩子失败 → rolled-back：stop 与 restart 各一次，current 与 env 恢复，服务回到 active", async () => {
    const h = makeHarness();
    const id = "g1-hook";
    stageRelease(h, id, { hookBody: HOOK_FAIL });
    expect(launch(h, id).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("rolled-back");
    const calls = gateCalls(h);
    expect(calls).toContain("hook:ran");
    expect(countPrefix(calls, `systemctl:stop ${SERVICE}`)).toBe(1);
    expect(countPrefix(calls, `systemctl:restart ${SERVICE}`)).toBe(1);
    expect(currentBasename(h)).toBe("rel-old");
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(serviceState(h)).toBe("active");
    expect(run(h, ["--log", id]).stdout).toContain("pre-start hook failed");
    expectNoSecrets(h, id);
  });

  t("钩子前 stop 失败（服务仍活跃）→ 钩子未执行，rolled-back：restart 一次，current 与 env 恢复", async () => {
    const h = makeHarness();
    const id = "g1-stopfail";
    stageRelease(h, id, { hookBody: HOOK_OK });
    expect(launch(h, id, { extraEnv: { T_STOP_FAIL: "1" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("rolled-back");
    const calls = gateCalls(h);
    expect(calls).not.toContain("hook:ran");
    expect(countPrefix(calls, `systemctl:stop ${SERVICE}`)).toBe(1);
    expect(countPrefix(calls, `systemctl:restart ${SERVICE}`)).toBe(1);
    expect(currentBasename(h)).toBe("rel-old");
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(run(h, ["--log", id]).stdout).toContain("stop before pre-start hook failed");
    expectNoSecrets(h, id);
  });

  t("切换 point_to 失败（首次 mv -T）→ rolled-back：restart 一次，current 与 env 恢复", async () => {
    const h = makeHarness();
    const id = "g1-pointto";
    stageRelease(h, id);
    expect(launch(h, id, { extraEnv: { T_MV_FAIL_FIRST: "1" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("rolled-back");
    const calls = gateCalls(h);
    expect(calls).toContain("mv:injected");
    expect(countPrefix(calls, `systemctl:restart ${SERVICE}`)).toBe(1);
    expect(currentBasename(h)).toBe("rel-old");
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(run(h, ["--log", id]).stdout).toContain("switching current to");
    expectNoSecrets(h, id);
  });

  t("前向 restart 失败（首次 restart 返回非零）→ rolled-back：restart 共两次，current 与 env 恢复", async () => {
    const h = makeHarness();
    const id = "g1-restartfail";
    stageRelease(h, id);
    expect(launch(h, id, { extraEnv: { T_RESTART_FAIL_FIRST: "1" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("rolled-back");
    expect(countPrefix(gateCalls(h), `systemctl:restart ${SERVICE}`)).toBe(2);
    expect(currentBasename(h)).toBe("rel-old");
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(run(h, ["--log", id]).stdout).toContain("restart fixture-svc failed");
    expectNoSecrets(h, id);
  });

  t("前向健康失败 → rolled-back：restart 两次，current 与 env 恢复", async () => {
    const h = makeHarness();
    const id = "g1-health";
    stageRelease(h, id);
    expect(launch(h, id, { extraEnv: { T_HEALTH_BAD_RELEASE: id } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("rolled-back");
    expect(countPrefix(gateCalls(h), `systemctl:restart ${SERVICE}`)).toBe(2);
    expect(currentBasename(h)).toBe("rel-old");
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(run(h, ["--log", id]).stdout).toContain("health check failed");
    expectNoSecrets(h, id);
  });

  t("钩子阶段（服务已停）工作进程被 SIGKILL → interrupted → 76 → --recover 有界回滚；二次恢复被拒（幂等）", async () => {
    const h = makeHarness();
    const id = "g1-hookkill";
    stageRelease(h, id, { hookBody: HOOK_BLOCK });
    const blockFile = join(h.dir, "hook-block");
    const mark = join(h.dir, "hook-mark");
    writeFileSync(blockFile, "");
    const extra = { HOOK_BLOCK_FILE: blockFile, HOOK_MARK: mark };
    try {
      expect(launch(h, id, { extraEnv: extra }).exitCode).toBe(0);
      await waitUntil(() => existsSync(mark), "hook marker");
      const mid = status(h, id);
      expect(mid.phase).toBe("hook");
      expect(mid.state).toBe("running");
      process.kill(Number(mid.worker_pid), "SIGKILL");
      await waitUntil(() => status(h, id).state === "interrupted", "interrupted state");
      const again = launch(h, id);
      expect(again.exitCode).toBe(76);
      expect(again.stdout).toContain(`interrupted=${id}`);
      expect(run(h, ["--recover", id]).exitCode).toBe(0);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("rolled-back");
      expect(currentBasename(h)).toBe("rel-old");
      expect(readText(h.envFile)).toBe(BEFORE);
      expect(countPrefix(gateCalls(h), `systemctl:stop ${SERVICE}`)).toBe(1);
      expect(countPrefix(gateCalls(h), `systemctl:restart ${SERVICE}`)).toBe(1);
      expect(serviceState(h)).toBe("active");
      expect(run(h, ["--recover", id]).exitCode).toBe(2);
      expectNoSecrets(h, id);
    } finally {
      rmSync(blockFile, { force: true });
    }
  });
});

describe("F1 回滚前提：转发激活在停服与 env 写入之前核验，停服后拒绝不拉起被拒版本", () => {
  t("previous 为旧隐式 origin（未过试用门禁）→ refused：零服务变更，env 与 current 不变，钩子未执行", async () => {
    const h = makeHarness("old-origin");
    const id = "f1-oldorigin";
    const staged = stageRelease(h, id, { hookBody: HOOK_FAIL });
    expect(launch(h, id).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("refused");
    expect(s.note).toContain("rollback preflight");
    expect(gateCalls(h)).not.toContain("hook:ran");
    expect(countPrefix(gateCalls(h), "bunx:")).toBe(0);
    expect(unitMutations(h)).toEqual([]);
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(currentBasename(h)).toBe("rel-old");
    expect(run(h, ["--log", id]).stdout).toContain("would restore implicit trial creation");
    expect(existsSync(staged.archive)).toBe(false);
    expectNoSecrets(h, id);
  });

  t("无 previous（current 缺失）→ refused：钩子未执行，零服务变更，env 不变", async () => {
    const h = makeHarness();
    rmSync(join(h.root, "current"), { force: true });
    const id = "f1-noprev";
    stageRelease(h, id, { hookBody: HOOK_FAIL });
    expect(launch(h, id).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("refused");
    expect(s.note).toContain("rollback preflight");
    expect(gateCalls(h)).not.toContain("hook:ran");
    expect(unitMutations(h)).toEqual([]);
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(run(h, ["--log", id]).stdout).toContain("no previous release recorded");
    expectNoSecrets(h, id);
  });

  t("previous 缺少撤销过滤且预检计数非零 → refused（检查器在依赖安装之后运行）：零服务变更，env 不变", async () => {
    const h = makeHarness("explicit", false);
    const id = "f1-prevrev";
    stageRelease(h, id, { hookBody: HOOK_FAIL });
    expect(launch(h, id, { extraEnv: { T_CHECKER_OUT: "grant_revocations=3\\n" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("refused");
    expect(s.note).toContain("rollback preflight");
    const calls = gateCalls(h);
    const install = calls.findIndex((c) => c.startsWith("bunx:pnpm@10.32.1 install"));
    const checker = calls.findIndex((c) => c.includes("grant-revocation-check-cli"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(checker).toBeGreaterThan(install);
    expect(calls).not.toContain("hook:ran");
    expect(unitMutations(h)).toEqual([]);
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(currentBasename(h)).toBe("rel-old");
    expect(run(h, ["--log", id]).stdout).toContain("lacks revocation filtering");
    expectNoSecrets(h, id);
  });

  t("previous 缺少撤销过滤且预检检查器失败（不可证明）→ refused：零服务变更，env 不变", async () => {
    const h = makeHarness("explicit", false);
    const id = "f1-prevunprov";
    stageRelease(h, id, { hookBody: HOOK_FAIL });
    expect(launch(h, id, { extraEnv: { T_CHECKER_RC: "2" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("refused");
    expect(s.note).toContain("rollback preflight");
    expect(gateCalls(h)).not.toContain("hook:ran");
    expect(unitMutations(h)).toEqual([]);
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(currentBasename(h)).toBe("rel-old");
    expectNoSecrets(h, id);
  });

  t("回滚时撤销门禁拒绝（预检 0、回滚时 3）→ rollback-failed：服务保持停止不被拉起并需人工决定，env 恢复，current 不变", async () => {
    const h = makeHarness("explicit", false);
    const id = "f1-rbrefuse";
    stageRelease(h, id, { hookBody: HOOK_FAIL });
    expect(launch(h, id, { extraEnv: { T_CHECKER_SEQ: "0,3" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("rollback-failed");
    expect(s.note).toContain("not restarted by rollback");
    expect(s.note).toContain("manual decision");
    const calls = gateCalls(h);
    expect(countPrefix(calls, `systemctl:stop ${SERVICE}`)).toBe(2);
    expect(countPrefix(calls, `systemctl:start ${SERVICE}`)).toBe(0);
    expect(countPrefix(calls, `systemctl:restart ${SERVICE}`)).toBe(0);
    expect(serviceState(h)).toBe("inactive");
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(currentBasename(h)).toBe("rel-old");
    expect(run(h, ["--log", id]).stdout).toContain("refusing to activate");
    expectNoSecrets(h, id);
  });

  t("转发目标缺少撤销过滤且计数为 3 → refused：按原 current 拉起（start 一次），env 恢复，未切换", async () => {
    const h = makeHarness();
    const id = "f1-fwdrefuse";
    stageRelease(h, id, { filtered: false, hookBody: HOOK_OK });
    expect(launch(h, id, { extraEnv: { T_CHECKER_OUT: "grant_revocations=3\\n" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("refused");
    const calls = gateCalls(h);
    expect(calls).not.toContain("hook:ran");
    expect(countPrefix(calls, `systemctl:stop ${SERVICE}`)).toBe(1);
    expect(countPrefix(calls, `systemctl:start ${SERVICE}`)).toBe(1);
    expect(countPrefix(calls, `systemctl:restart ${SERVICE}`)).toBe(0);
    expect(serviceState(h)).toBe("active");
    expect(readText(h.envFile)).toBe(BEFORE);
    expect(currentBasename(h)).toBe("rel-old");
    expectNoSecrets(h, id);
  });

  t("转发拒绝时每次 start/restart 观测到的 env 均为激活前内容（拒绝的增改不得在服务拉起时生效）", async () => {
    const h = makeHarness();
    const id = "f1-envorder";
    stageRelease(h, id, { filtered: false, hookBody: HOOK_OK });
    // 仪器：在桩 systemctl 之外记录 start/restart 时刻 server.env 中被拒绝增改的出现次数（0 = 激活前内容）。
    writeFileSync(h.prelude, readFileSync(h.prelude, "utf8") + ENV_AT_START_INSTRUMENT);
    expect(launch(h, id, { extraEnv: { T_CHECKER_OUT: "grant_revocations=3\\n" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("refused");
    const snaps = gateCalls(h).filter((c) => c.startsWith("ENVSNAP:"));
    expect(snaps).toEqual(["ENVSNAP:start:additions_present=0"]);
    expect(readText(h.envFile)).toBe(BEFORE);
    expectNoSecrets(h, id);
  });
});

describe("F2 撤销检查器输出严格解析（失败关闭，上层拒绝激活）", () => {
  const refusals: Array<[string, Record<string, string>]> = [
    ["计数非整数（abc）", { T_CHECKER_OUT: "grant_revocations=abc\\n" }],
    ["检查器非零退出", { T_CHECKER_RC: "2" }],
    ["同一输出含 0 与 3 两行", { T_CHECKER_OUT: "grant_revocations=0\\ngrant_revocations=3\\n" }],
    ["非规范整数 00（前导零）", { T_CHECKER_OUT: "grant_revocations=00\\n" }],
    ["输出无计数行", { T_CHECKER_OUT: "warning: nothing\\n" }],
  ];
  refusals.forEach(([name, env], i) => {
    t(`${name} → refused：服务按原 current 拉起，env 恢复，未切换`, async () => {
      const h = makeHarness();
      const id = `f2-refuse-${i}`;
      stageRelease(h, id, { filtered: false });
      expect(launch(h, id, { extraEnv: env }).exitCode).toBe(0);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("refused");
      expect(countPrefix(gateCalls(h), `systemctl:stop ${SERVICE}`)).toBe(1);
      expect(countPrefix(gateCalls(h), `systemctl:start ${SERVICE}`)).toBe(1);
      expect(serviceState(h)).toBe("active");
      expect(readText(h.envFile)).toBe(BEFORE);
      expect(currentBasename(h)).toBe("rel-old");
      expectNoSecrets(h, id);
    });
  });

  t("输出含无关行与唯一的 grant_revocations=0 → 允许激活：停服冻结后切换，healthy", async () => {
    const h = makeHarness();
    const id = "f2-noise";
    stageRelease(h, id, { filtered: false });
    expect(launch(h, id, { extraEnv: { T_CHECKER_OUT: "bun: note line\\ngrant_revocations=0\\n" } }).exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("healthy");
    expect(countPrefix(gateCalls(h), `systemctl:stop ${SERVICE}`)).toBe(1);
    expect(currentBasename(h)).toBe(id);
  });
});

describe("F13 陈旧锁回收：互斥与并发", () => {
  t("陈旧锁（持有者已死）且回收互斥被存活进程持有 → busy（75）：陈旧锁不被删除，不登记", async () => {
    const h = makeHarness();
    const id = "f13-busy";
    stageRelease(h, id);
    writeLock(h, await deadPid(), "rel-stale");
    mkdirSync(h.reclaimDir, { recursive: true });
    writeFileSync(join(h.reclaimDir, "pid"), `${process.pid}\n`);
    const r = launch(h, id);
    expect(r.exitCode).toBe(75);
    expect(readText(join(h.lockDir, "release")).trim()).toBe("rel-stale");
    expect(existsSync(join(h.reclaimDir, "pid"))).toBe(true);
    expect(existsSync(join(h.stateDir, `${id}.state`))).toBe(false);
    expect(unitMutations(h)).toEqual([]);
  });

  t("回收互斥的持有者已死（回收中途被终止）→ busy（75）并要求运维核查，互斥目录不被自动删除", async () => {
    const h = makeHarness();
    const id = "f13-deadmutex";
    stageRelease(h, id);
    writeLock(h, await deadPid(), "rel-stale");
    mkdirSync(h.reclaimDir, { recursive: true });
    writeFileSync(join(h.reclaimDir, "pid"), `${await deadPid()}\n`);
    const r = launch(h, id);
    expect(r.exitCode).toBe(75);
    expect(r.stderr).toContain("needs operator review");
    expect(existsSync(h.reclaimDir)).toBe(true);
    expect(existsSync(join(h.stateDir, `${id}.state`))).toBe(false);
  });

  t("两个登记同时争抢同一陈旧锁（5 轮）→ 每轮恰好一个成功（0）、另一个忙（75），且只登记一个激活", async () => {
    for (let round = 0; round < 5; round++) {
      const h = makeHarness();
      writeLock(h, await deadPid(), "rel-stale");
      stageRelease(h, "f13-a");
      stageRelease(h, "f13-b");
      const hold = join(h.dir, "hold");
      writeFileSync(hold, "");
      const extra = { T_HOLD_FILE: hold };
      const a = spawnLaunch(h, "f13-a", extra);
      const b = spawnLaunch(h, "f13-b", extra);
      const codes = [await a.exited, await b.exited];
      rmSync(hold, { force: true });
      expect([...codes].sort()).toEqual([0, 75]);
      const winner = codes[0] === 0 ? "f13-a" : "f13-b";
      expect(readText(join(h.lockDir, "release")).trim()).toBe(winner);
      expect(listFiles(h.stateDir).filter((f) => f.endsWith(".state"))).toEqual([`${winner}.state`]);
    }
  });
});

describe("G3 surrealdb 与数据目录零触碰（运行时：成功、回滚、中断恢复）", () => {
  const service = "surreal-ck-hono";
  const seedSensitive = (h: Harness) => {
    const dir = join(h.dir, ".sensitive");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "surrealdb.service"), "[Service]\nExecStart=/fake/surreal\n");
    writeFileSync(join(dir, "root.env"), "SURREAL_ROOT_PASS=fake-root-value\n");
    writeFileSync(join(dir, "data", "wal.bin"), "fake-data\n");
    return dir;
  };
  // 变异运行：在 run_release 入口前插入一行 shell（脚本其余部分不变），经真实 --launch 执行到终态，返回终态名。
  const runMutant = async (h: Harness, id: string, line: string) => {
    const original = readFileSync(SCRIPT_PATH, "utf8");
    const marker = "run_release() {\n";
    expect(original).toContain(marker);
    const mutatedPath = join(h.dir, `origin-release-${id}.sh`);
    writeFileSync(mutatedPath, original.replace(marker, `${marker}${line}\n`));
    stageRelease(h, id);
    expect(launch(h, id, { script: mutatedPath }).exitCode).toBe(0);
    return (await waitTerminal(h, id)).state;
  };

  t("访问检测自检：对假 root.env 的读取必须被 atime 观测到，且检测本身无误报", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const pin = await pinSensitive(dir);
    expect(sensitiveViolations(pin)).toEqual([]);
    readText(join(dir, "root.env"));
    expect(sensitiveViolations(pin)).toEqual(["read:root.env"]);
  });

  t("成功路径：systemctl 只作用于 surreal-ck-hono，假敏感对象无读取、写入或元数据变化", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const before = snapshotTree(dir);
    const pin = await pinSensitive(dir);
    stageRelease(h, "g3-ok");
    expect(launch(h, "g3-ok").exitCode).toBe(0);
    expect((await waitTerminal(h, "g3-ok")).state).toBe("healthy");
    expect(unitMutations(h).length).toBeGreaterThan(0);
    expect(zeroTouchViolations(gateCalls(h), service)).toEqual([]);
    expect(sensitiveViolations(pin)).toEqual([]);
    expect(snapshotTree(dir)).toEqual(before);
  });

  t("钩子失败回滚路径：systemctl 只作用于 surreal-ck-hono，假敏感对象无读取、写入或元数据变化", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const before = snapshotTree(dir);
    const pin = await pinSensitive(dir);
    stageRelease(h, "g3-rb", { hookBody: HOOK_FAIL });
    expect(launch(h, "g3-rb").exitCode).toBe(0);
    expect((await waitTerminal(h, "g3-rb")).state).toBe("rolled-back");
    expect(unitMutations(h).length).toBeGreaterThan(0);
    expect(zeroTouchViolations(gateCalls(h), service)).toEqual([]);
    expect(sensitiveViolations(pin)).toEqual([]);
    expect(snapshotTree(dir)).toEqual(before);
  });

  t("中断后 --recover 路径：systemctl 只作用于 surreal-ck-hono，假敏感对象无读取、写入或元数据变化", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const before = snapshotTree(dir);
    const pin = await pinSensitive(dir);
    stageRelease(h, "g3-rec", { hookBody: HOOK_BLOCK });
    const blockFile = join(h.dir, "hook-block");
    const mark = join(h.dir, "hook-mark");
    writeFileSync(blockFile, "");
    try {
      expect(launch(h, "g3-rec", { extraEnv: { HOOK_BLOCK_FILE: blockFile, HOOK_MARK: mark } }).exitCode).toBe(0);
      await waitUntil(() => existsSync(mark), "hook marker");
      process.kill(Number(status(h, "g3-rec").worker_pid), "SIGKILL");
      await waitUntil(() => status(h, "g3-rec").state === "interrupted", "interrupted state");
      expect(run(h, ["--recover", "g3-rec"]).exitCode).toBe(0);
      expect((await waitTerminal(h, "g3-rec")).state).toBe("rolled-back");
      expect(unitMutations(h).length).toBeGreaterThan(0);
      expect(zeroTouchViolations(gateCalls(h), service)).toEqual([]);
      expect(sensitiveViolations(pin)).toEqual([]);
      expect(snapshotTree(dir)).toEqual(before);
    } finally {
      rmSync(blockFile, { force: true });
    }
  });

  t("变异检测（只读）：run_release 只读取假 root.env、不改内容，快照不变但访问检测必须报告 read", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const before = snapshotTree(dir);
    const pin = await pinSensitive(dir);
    expect(await runMutant(h, "g3-mut-cat", `  command cat "${join(dir, "root.env")}" >/dev/null || true`)).toBe("healthy");
    expect(sensitiveViolations(pin)).toEqual(["read:root.env"]);
    expect(snapshotTree(dir)).toEqual(before);
  });

  t("变异检测（只读）：run_release 读取假 surrealdb.service 首字节，必须报告 read:surrealdb.service", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const pin = await pinSensitive(dir);
    expect(await runMutant(h, "g3-mut-head", `  head -c 1 "${join(dir, "surrealdb.service")}" >/dev/null || true`)).toBe("healthy");
    expect(sensitiveViolations(pin)).toEqual(["read:surrealdb.service"]);
  });

  t("变异检测（目录）：run_release 列出假数据目录，必须报告 read:data", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const pin = await pinSensitive(dir);
    expect(await runMutant(h, "g3-mut-ls", `  command ls "${join(dir, "data")}" >/dev/null || true`)).toBe("healthy");
    expect(sensitiveViolations(pin)).toEqual(["read:data"]);
  });

  t("变异检测（元数据）：run_release 修改假 root.env 权限，必须报告 meta:root.env", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const pin = await pinSensitive(dir);
    expect(await runMutant(h, "g3-mut-chmod", `  chmod 600 "${join(dir, "root.env")}" || true`)).toBe("healthy");
    expect(sensitiveViolations(pin)).toEqual(["meta:root.env"]);
  });

  t("变异检测（写入）：run_release 写入假数据文件，快照比对与访问检测都必须捕获该改动", async () => {
    const h = makeHarness("explicit", true, service);
    const dir = seedSensitive(h);
    const before = snapshotTree(dir);
    const pin = await pinSensitive(dir);
    expect(await runMutant(h, "g3-mut-data", `  echo tampered >> "${join(dir, "data", "wal.bin")}" || true`)).toBe("healthy");
    expect(sensitiveViolations(pin)).toEqual(["write:data/wal.bin"]);
    expect(snapshotTree(dir)).not.toEqual(before);
  });

  t("变异检测：在 run_release 中注入对 surrealdb 的重启，零触碰审计必须捕获", async () => {
    const h = makeHarness("explicit", true, service);
    await runMutant(h, "g3-mut", "  sudo -n systemctl restart surrealdb || true");
    expect(zeroTouchViolations(gateCalls(h), service)).toContain("systemctl:restart surrealdb");
  });

  t("静态：部署工具与工作流不引用 surrealdb 服务单元、journalctl 或数据目录，也不引用根凭证变量", () => {
    const files = [
      SCRIPT_PATH,
      join(import.meta.dir, "../../../scripts/deploy/origin-release-ci.sh"),
      join(import.meta.dir, "../../../scripts/deploy/origin-pre-start.sh"),
      join(import.meta.dir, "../../../.github/workflows/deploy-origin.yml"),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/surrealdb\.service/i);
      expect(text).not.toMatch(/systemctl[^\n]*surrealdb/i);
      expect(text).not.toMatch(/journalctl/);
      expect(text).not.toMatch(/\/var\/lib\/|\/srv\/|\/opt\//);
      expect(text).not.toMatch(/SURREAL_ROOT_/);
    }
  });
});

describe("AC04 主机入参校验先于登记、取锁与停服", () => {
  t("sha 为空字符串 → exit 2，未登记、未取锁、无服务变更", async () => {
    const h = makeHarness();
    const id = "ac04-empty";
    stageRelease(h, id);
    const r = launch(h, id, { sha: "" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("sha must be a full lowercase commit SHA");
    expect(existsSync(h.stateDir)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
    expect(gateCalls(h)).toEqual([]);
  });

  t("sha 省略（参数左移，仅 5 个参数）→ exit 2 usage，未登记", async () => {
    const h = makeHarness();
    const id = "ac04-omitted";
    const staged = stageRelease(h, id);
    const r = run(h, ["--launch", id, staged.archive, staged.envPath, "approval/ref-1", "deploy-1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage: --launch");
    expect(existsSync(h.stateDir)).toBe(false);
    expect(gateCalls(h)).toEqual([]);
  });

  t("sha 长度 39 → exit 2，未登记", async () => {
    const h = makeHarness();
    const id = "ac04-short";
    stageRelease(h, id);
    const r = launch(h, id, { sha: "0123456789abcdef0123456789abcdef0123456" });
    expect(r.exitCode).toBe(2);
    expect(existsSync(h.stateDir)).toBe(false);
    expect(gateCalls(h)).toEqual([]);
  });

  t("合法的 40 位小写 sha → 接受登记，状态记录该 sha 并收敛为 healthy", async () => {
    const h = makeHarness();
    const id = "ac04-valid";
    stageRelease(h, id);
    const r = launch(h, id);
    expect(r.exitCode).toBe(0);
    const s = await waitTerminal(h, id);
    expect(s.state).toBe("healthy");
    expect(s.sha).toBe(SHA);
  });

  t("sha 为大写 40 位 → exit 2，未登记、未取锁、无服务变更", async () => {
    const h = makeHarness();
    const id = "ac04-upper";
    stageRelease(h, id);
    const r = launch(h, id, { sha: SHA.toUpperCase() });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("sha must be a full lowercase commit SHA");
    expect(existsSync(h.stateDir)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
    expect(gateCalls(h)).toEqual([]);
  });

  t("sha 为 40 位但含非十六进制字符 → exit 2，未登记", async () => {
    const h = makeHarness();
    const id = "ac04-nonhex";
    stageRelease(h, id);
    const r = launch(h, id, { sha: "g".repeat(40) });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("sha must be a full lowercase commit SHA");
    expect(existsSync(h.stateDir)).toBe(false);
    expect(gateCalls(h)).toEqual([]);
  });
});
