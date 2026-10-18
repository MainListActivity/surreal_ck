import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type TrialCompat, writeTrialTree } from "./origin-release-fixtures";

/**
 * origin-release.sh 脚本级生命周期测试（真实 --launch / --status / --log / --recover
 * 与分离工作进程路径）。外部命令（bunx/bun/sudo/systemctl/curl/sleep/mv）通过
 * BASH_ENV 桩替换；桩把每次调用记入 GATE_LOG，从不发出真实 SSH 或网络请求。
 */

const SCRIPT_PATH = join(import.meta.dir, "../../../scripts/deploy/origin-release.sh");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const APPROVAL = "approval/ref-1";
const DEPLOY = "deploy-1";
const BEFORE = "REVIEW_FIXTURE=before\nBASE_KEY=keep\n";
const ADDITIONS = "REVIEW_FIXTURE=after-value-7f3\nNEW_K=new-value-9c1\n";
const TERMINAL = ["healthy", "refused", "failed", "rolled-back", "rollback-refused", "rollback-failed"];
const POLL_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 40_000;

// 外部命令桩。注意：模板字符串内的 shell 插值需转义为 \${...}。
const PRELUDE = `bunx() { echo "bunx:$*" >>"$GATE_LOG"; return 0; }
bun() { echo "bun:$*" >>"$GATE_LOG"; echo "grant_revocations=0"; }
sudo() { echo "sudo:$*" >>"$GATE_LOG"; if [ "\${1:-}" = "-n" ]; then shift; fi; "$@"; }
systemctl() {
  echo "systemctl:$*" >>"$GATE_LOG"
  case "\${1:-}" in
    is-active) echo "\${T_ACTIVE:-inactive}"; [ "\${T_ACTIVE:-inactive}" = active ] ;;
    restart)
      if [ -n "\${T_BLOCK_FILE:-}" ] && [ -f "\${T_BLOCK_FILE}" ]; then
        rm -f "\${T_BLOCK_FILE}"
        : >"\${T_MARK_FILE}"
        command sleep 5
      fi
      return 0 ;;
    *) return 0 ;;
  esac
}
curl() {
  local target
  target=$(readlink "\${ORIGIN_ROOT}/current" 2>/dev/null || true)
  target=\${target##*/}
  if [ -n "\${T_HEALTH_BAD_RELEASE:-}" ] && [ "$target" = "$T_HEALTH_BAD_RELEASE" ]; then return 22; fi
  printf '%s' '{"status":"ok","surrealdb":"up"}'
}
sleep() { :; }
mv() {
  if [ "\${1:-}" = "-T" ]; then
    shift
    if [ -L "$2" ]; then command rm -f "$2"; fi
  fi
  command mv -f "$@"
}
`;

type Harness = {
  dir: string;
  root: string;
  stateDir: string;
  lockDir: string;
  envFile: string;
  stagingDir: string;
  gateLog: string;
  prelude: string;
  previous: string;
  procs: { kill(): void }[];
};

const harnesses: Harness[] = [];

function writeChecker(base: string) {
  mkdirSync(join(base, "server", "src", "db"), { recursive: true });
  writeFileSync(join(base, "server", "src", "db", "grant-revocation-check-cli.ts"), "// checker\n");
}

function writeStore(base: string, filtered: boolean) {
  mkdirSync(join(base, "server", "src", "product-entitlement"), { recursive: true });
  writeFileSync(join(base, "server", "src", "product-entitlement", "store.ts"), filtered ? "content_grant_revocation\n" : "content_grant\n");
}

function makeHarness(previousCompat: TrialCompat = "explicit"): Harness {
  const dir = mkdtempSync(join(tmpdir(), "origin-lifecycle-"));
  const root = join(dir, "root");
  const previous = join(root, "releases", "rel-old");
  writeTrialTree(previous, previousCompat);
  writeStore(previous, true);
  writeChecker(previous);
  mkdirSync(join(root, "releases"), { recursive: true });
  symlinkSync(previous, join(root, "current"));
  const envFile = join(dir, "server.env");
  writeFileSync(envFile, BEFORE);
  const stagingDir = join(dir, "staging");
  mkdirSync(stagingDir, { recursive: true });
  const gateLog = join(dir, "gate.log");
  writeFileSync(gateLog, "");
  const prelude = join(dir, "prelude.sh");
  writeFileSync(prelude, PRELUDE);
  const h: Harness = {
    dir,
    root,
    stateDir: join(root, "deploy-state"),
    lockDir: join(root, "deploy-state", "lock"),
    envFile,
    stagingDir,
    gateLog,
    prelude,
    previous,
    procs: [],
  };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    for (const p of h.procs) {
      try {
        p.kill();
      } catch {
        // 进程已结束
      }
    }
    const pids: number[] = [];
    const lockOwner = Number(readText(join(h.lockDir, "pid")).trim());
    if (Number.isInteger(lockOwner) && lockOwner > 0) pids.push(lockOwner);
    for (const f of listFiles(h.stateDir)) {
      if (!f.endsWith(".state")) continue;
      const wp = Number(parseKv(readText(join(h.stateDir, f))).worker_pid);
      if (Number.isInteger(wp) && wp > 0) pids.push(wp);
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已不存在
      }
    }
    rmSync(h.dir, { recursive: true, force: true });
  }
});

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

type StageOpts = { target?: TrialCompat; filtered?: boolean; envBody?: string; archiveBody?: string };

// 生成发布包（tar.gz）与 env 增改文件，放入暂存目录（与 CI 上传位置一致）。
function stageRelease(h: Harness, id: string, opts: StageOpts = {}) {
  const archive = join(h.stagingDir, `surreal_ck-${id}.tar.gz`);
  const envPath = join(h.stagingDir, `surreal_ck-env-${id}`);
  if (opts.archiveBody !== undefined) {
    writeFileSync(archive, opts.archiveBody);
  } else {
    const payload = mkdtempSync(join(h.dir, "payload-"));
    writeTrialTree(payload, opts.target ?? "explicit");
    writeStore(payload, opts.filtered !== false);
    writeChecker(payload);
    const proc = Bun.spawnSync(["tar", "-czf", archive, "-C", payload, "server", "shared"]);
    if (proc.exitCode !== 0) throw new Error("fixture tar failed");
  }
  writeFileSync(envPath, opts.envBody ?? ADDITIONS);
  return { archive, envPath };
}

type Run = { exitCode: number; stdout: string; stderr: string };

function run(h: Harness, args: string[], extraEnv: Record<string, string> = {}): Run {
  const proc = Bun.spawnSync(["bash", SCRIPT_PATH, ...args], {
    env: {
      ...process.env,
      BASH_ENV: h.prelude,
      GATE_LOG: h.gateLog,
      ORIGIN_ROOT: h.root,
      ORIGIN_ENV_FILE: h.envFile,
      ORIGIN_STAGING_DIR: h.stagingDir,
      ORIGIN_SERVICE: "fixture-svc",
      ORIGIN_KEEP_RELEASES: "8",
      REVOCATION_GATE_DRAIN_SEC: "0",
      T_HEALTH_BAD_RELEASE: "",
      T_BLOCK_FILE: "",
      T_MARK_FILE: "",
      T_ACTIVE: "",
      ...extraEnv,
    },
    timeout: 30_000,
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function launch(
  h: Harness,
  id: string,
  opts: { sha?: string; approval?: string; deploy?: string; archive?: string; env?: string; extraEnv?: Record<string, string> } = {},
): Run {
  const archive = opts.archive ?? join(h.stagingDir, `surreal_ck-${id}.tar.gz`);
  const env = opts.env ?? join(h.stagingDir, `surreal_ck-env-${id}`);
  return run(h, ["--launch", id, archive, env, opts.sha ?? SHA, opts.approval ?? APPROVAL, opts.deploy ?? DEPLOY], opts.extraEnv);
}

function status(h: Harness, id: string): Record<string, string> {
  return parseKv(run(h, ["--status", id]).stdout);
}

async function waitUntil<T>(probe: () => T | null | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(50);
  }
}

async function waitTerminal(h: Harness, id: string): Promise<Record<string, string>> {
  return waitUntil(() => {
    const s = status(h, id);
    return TERMINAL.includes(s.state ?? "") ? s : null;
  }, `terminal state of ${id}`);
}

function gateCalls(h: Harness): string[] {
  return readText(h.gateLog)
    .split("\n")
    .filter((l) => l.length > 0);
}

function countPrefix(calls: string[], prefix: string): number {
  return calls.filter((c) => c.startsWith(prefix)).length;
}

// 主机侧调用：排除 --status 发出的只读 unit 查询（show / is-active），其余一律计入。
function hostCalls(h: Harness): string[] {
  return gateCalls(h).filter((c) => !c.startsWith("systemctl:show") && !c.startsWith("systemctl:is-active"));
}

// 仅上传 env 增改文件（不生成发布包），用于上传件缺失用例。
function stageEnvOnly(h: Harness, id: string): string {
  const envPath = join(h.stagingDir, `surreal_ck-env-${id}`);
  writeFileSync(envPath, ADDITIONS);
  return envPath;
}

function currentBasename(h: Harness): string {
  return basename(readlinkSync(join(h.root, "current")));
}

function writeLock(h: Harness, owner: number, release: string) {
  mkdirSync(h.lockDir, { recursive: true });
  writeFileSync(join(h.lockDir, "pid"), `${owner}\n`);
  writeFileSync(join(h.lockDir, "release"), `${release}\n`);
}

async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

function writeStateFile(h: Harness, id: string, fields: Record<string, string> = {}) {
  const base: Record<string, string> = {
    state: "running",
    release_id: id,
    sha: SHA,
    phase: "unpack",
    previous: h.previous,
    archive: join(h.stagingDir, `surreal_ck-${id}.tar.gz`),
    env_additions: join(h.stagingDir, `surreal_ck-env-${id}`),
    approval_ref: APPROVAL,
    deployment_id: DEPLOY,
    worker_pid: "0",
    env_dirty: "0",
    svc_touched: "0",
    switched: "0",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    log: join(h.stateDir, `${id}.log`),
    note: "fixture",
    ...fields,
  };
  mkdirSync(h.stateDir, { recursive: true });
  writeFileSync(join(h.stateDir, `${id}.state`), Object.entries(base).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function expectRejected(h: Harness, r: Run) {
  expect(r.exitCode).toBe(2);
  expect(existsSync(join(h.stateDir, "lock"))).toBe(false);
  expect(hostCalls(h)).toEqual([]);
  expect(readText(h.envFile)).toBe(BEFORE);
}

const t = (name: string, fn: () => unknown | Promise<unknown>) => test(name, fn, TEST_TIMEOUT_MS);

describe("origin-release 生命周期（脚本级）", () => {
  describe("入口拒绝零接触", () => {
    t("sha 非法（大写）→ exit 2，零接触", () => {
      const h = makeHarness();
      const { archive, envPath } = stageRelease(h, "rel-ci-sha");
      const r = launch(h, "rel-ci-sha", { sha: SHA.toUpperCase(), archive, env: envPath });
      expectRejected(h, r);
      expect(run(h, ["--status", "rel-ci-sha"]).stdout).toContain("state=absent");
    });

    t("sha 非法（长度不足）→ exit 2，零接触", () => {
      const h = makeHarness();
      const { archive, envPath } = stageRelease(h, "rel-ci-sha2");
      const r = launch(h, "rel-ci-sha2", { sha: "abc123", archive, env: envPath });
      expectRejected(h, r);
      expect(status(h, "rel-ci-sha2").state).toBe("absent");
    });

    t("approval 非法（含空格）→ exit 2，零接触", () => {
      const h = makeHarness();
      const { archive, envPath } = stageRelease(h, "rel-ci-appr");
      const r = launch(h, "rel-ci-appr", { approval: "bad ref", archive, env: envPath });
      expectRejected(h, r);
      expect(status(h, "rel-ci-appr").state).toBe("absent");
    });

    t("deployment-id 非法（含空格）→ exit 2，零接触", () => {
      const h = makeHarness();
      const { archive, envPath } = stageRelease(h, "rel-ci-dep");
      const r = launch(h, "rel-ci-dep", { deploy: "bad id", archive, env: envPath });
      expectRejected(h, r);
      expect(status(h, "rel-ci-dep").state).toBe("absent");
    });

    t("archive 路径不符（非暂存目录）→ exit 2，零接触", () => {
      const h = makeHarness();
      const { archive, envPath } = stageRelease(h, "rel-ci-path");
      const elsewhere = join(h.dir, "elsewhere.tar.gz");
      copyFileSync(archive, elsewhere);
      const r = launch(h, "rel-ci-path", { archive: elsewhere, env: envPath });
      expectRejected(h, r);
      expect(status(h, "rel-ci-path").state).toBe("absent");
    });

    t("上传件缺失（archive 不存在）→ exit 2，零接触", () => {
      const h = makeHarness();
      const envPath = stageEnvOnly(h, "rel-ci-missing");
      const archive = join(h.stagingDir, "surreal_ck-rel-ci-missing.tar.gz");
      const r = launch(h, "rel-ci-missing", { archive, env: envPath });
      expectRejected(h, r);
      expect(status(h, "rel-ci-missing").state).toBe("absent");
    });

    t("tar 损坏 → exit 2，零接触", () => {
      const h = makeHarness();
      const { archive, envPath } = stageRelease(h, "rel-ci-tar", { archiveBody: "this is not a tar.gz archive" });
      const r = launch(h, "rel-ci-tar", { archive, env: envPath });
      expectRejected(h, r);
      expect(status(h, "rel-ci-tar").state).toBe("absent");
    });

    t("env 行非法（小写键）→ exit 2，零接触，输出不含 env 值", () => {
      const h = makeHarness();
      const { archive, envPath } = stageRelease(h, "rel-ci-env", { envBody: "lowercase=SECRET-VALUE-123\n" });
      const r = launch(h, "rel-ci-env", { archive, env: envPath });
      expectRejected(h, r);
      expect(r.stdout + r.stderr).not.toContain("SECRET-VALUE-123");
      expect(status(h, "rel-ci-env").state).toBe("absent");
    });

    t("上传件缺失时不停服：GATE_LOG 不含 systemctl stop", () => {
      const h = makeHarness();
      const envPath = stageEnvOnly(h, "rel-ci-nostop");
      const archive = join(h.stagingDir, "surreal_ck-rel-ci-nostop.tar.gz");
      const r = launch(h, "rel-ci-nostop", { archive, env: envPath });
      expect(r.exitCode).toBe(2);
      expect(gateCalls(h).some((c) => c.startsWith("systemctl:stop"))).toBe(false);
      expect(gateCalls(h).some((c) => c.startsWith("systemctl:restart"))).toBe(false);
      expect(hostCalls(h)).toEqual([]);
      expect(readText(h.envFile)).toBe(BEFORE);
    });
  });

  describe("正向发布与幂等", () => {
    t("正向发布（显式 + 过滤目标）：登记运行、健康收敛、切换与 env 增改生效、暂存件清理", async () => {
      const h = makeHarness();
      const id = "rel-ci-ok";
      const staged = stageRelease(h, id, { target: "explicit", filtered: true });
      const r = launch(h, id);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`registered=${id} state=running`);

      const s = await waitTerminal(h, id);
      expect(s.state).toBe("healthy");
      expect(currentBasename(h)).toBe(id);

      const env = readText(h.envFile);
      expect(env).toContain("REVIEW_FIXTURE=after-value-7f3\n");
      expect(env).toContain("NEW_K=new-value-9c1\n");
      expect(env).toContain("BASE_KEY=keep\n");

      expect(existsSync(staged.archive)).toBe(false);
      expect(existsSync(staged.envPath)).toBe(false);

      const calls = gateCalls(h);
      expect(countPrefix(calls, "systemctl:restart")).toBe(1);
      expect(countPrefix(calls, "systemctl:stop")).toBe(0);

      const log = run(h, ["--log", id]).stdout;
      expect(log).toContain("env: set REVIEW_FIXTURE");
      expect(log).toContain("env: set NEW_K");
      expect(log).not.toContain("after-value-7f3");
      expect(log).not.toContain("new-value-9c1");
    });

    t("幂等：healthy 后同参数重新登记 → 报告 healthy、删除暂存件、不新增 systemctl；sha 不同 → exit 2", async () => {
      const h = makeHarness();
      const id = "rel-ci-idem";
      stageRelease(h, id, { target: "explicit", filtered: true });
      expect(launch(h, id).exitCode).toBe(0);
      await waitTerminal(h, id);
      const before = gateCalls(h).length;

      const restaged = stageRelease(h, id, { target: "explicit", filtered: true });
      const again = launch(h, id);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain(`registered=${id} state=healthy`);
      expect(existsSync(restaged.archive)).toBe(false);
      expect(existsSync(restaged.envPath)).toBe(false);
      expect(gateCalls(h).length).toBe(before);

      stageRelease(h, id, { target: "explicit", filtered: true });
      const different = launch(h, id, { sha: "f".repeat(40) });
      expect(different.exitCode).toBe(2);
      expect(different.stdout + different.stderr).toContain("already registered");
      expect(gateCalls(h).length).toBe(before);
    });
  });

  describe("忙与陈旧锁", () => {
    t("锁被存活进程持有 → exit 75，不生成新状态、无 systemctl", () => {
      const h = makeHarness();
      const holder = Bun.spawn(["sleep", "30"]);
      h.procs.push(holder);
      writeLock(h, holder.pid, "other-running");
      const id = "rel-ci-busy";
      stageRelease(h, id);
      const r = launch(h, id);
      expect(r.exitCode).toBe(75);
      expect(r.stderr).toContain("busy");
      expect(existsSync(join(h.stateDir, `${id}.state`))).toBe(false);
      expect(countPrefix(gateCalls(h), "systemctl:")).toBe(0);
    });

    t("陈旧锁（持有者已死且无状态文件）→ 回收并登记，exit 0", async () => {
      const h = makeHarness();
      writeLock(h, await deadPid(), "stale-old");
      const id = "rel-ci-stale";
      stageRelease(h, id, { target: "explicit", filtered: true });
      const r = launch(h, id);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`registered=${id} state=running`);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("healthy");
    });
  });

  describe("中断检测与恢复", () => {
    t("中断检测：state=running 且无锁 → --status 为 interrupted；同参数 launch → exit 76，无 systemctl", () => {
      const h = makeHarness();
      const id = "rel-ci-intr";
      writeStateFile(h, id, { phase: "switch", switched: "1", svc_touched: "1", env_dirty: "1" });
      expect(status(h, id).state).toBe("interrupted");
      const r = launch(h, id);
      expect(r.exitCode).toBe(76);
      expect(r.stdout).toContain(`interrupted=${id}`);
      expect(hostCalls(h)).toEqual([]);
    });

    t("其他激活中断：锁指向另一个已中断 id → 新 id launch → exit 76 输出 interrupted=<other>", async () => {
      const h = makeHarness();
      const other = "rel-ci-other";
      writeStateFile(h, other, { phase: "switch", switched: "1", svc_touched: "1" });
      writeLock(h, await deadPid(), other);
      const id = "rel-ci-next";
      stageRelease(h, id);
      const r = launch(h, id);
      expect(r.exitCode).toBe(76);
      expect(r.stdout).toContain(`interrupted=${other}`);
      expect(existsSync(join(h.stateDir, `${id}.state`))).toBe(false);
      expect(countPrefix(gateCalls(h), "systemctl:")).toBe(0);
    });

    t("恢复（主机未改动）：--recover → failed，备注 nothing rolled back，无 stop/restart，暂存件清理", async () => {
      const h = makeHarness();
      const id = "rel-ci-recov0";
      const staged = stageRelease(h, id);
      writeStateFile(h, id, {
        phase: "unpack",
        svc_touched: "0",
        env_dirty: "0",
        switched: "0",
        worker_pid: String(await deadPid()),
      });
      expect(status(h, id).state).toBe("interrupted");
      const r = run(h, ["--recover", id]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`recovery-started=${id}`);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("failed");
      expect(s.note).toContain("nothing rolled back");
      expect(hostCalls(h)).toEqual([]);
      expect(existsSync(staged.archive)).toBe(false);
      expect(existsSync(staged.envPath)).toBe(false);
      expect(readText(h.envFile)).toBe(BEFORE);
    });

    t("恢复（仅 env 已写入）：--recover 恢复 env 备份 → failed，不停服、不重启、不切换", async () => {
      const h = makeHarness();
      const id = "rel-ci-envrec";
      const staged = stageRelease(h, id);
      // 模拟 env-write 阶段被中断：备份已落盘、live env 已写入增改值，服务与 current 均未动。
      mkdirSync(join(h.root, "backups", "env"), { recursive: true });
      writeFileSync(join(h.root, "backups", "env", `server.env.${id}`), BEFORE);
      writeFileSync(h.envFile, ADDITIONS);
      writeStateFile(h, id, {
        phase: "env-write",
        svc_touched: "0",
        switched: "0",
        env_dirty: "1",
        worker_pid: String(await deadPid()),
      });
      expect(status(h, id).state).toBe("interrupted");
      const r = run(h, ["--recover", id]);
      expect(r.exitCode).toBe(0);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("failed");
      expect(s.note).toContain("no service change, env restored");
      expect(hostCalls(h)).toEqual([]);
      expect(currentBasename(h)).toBe("rel-old");
      expect(readText(h.envFile)).toBe(BEFORE);
      expect(existsSync(staged.archive)).toBe(false);
      expect(existsSync(staged.envPath)).toBe(false);
    });
  });

  describe("中途断线与信号", () => {
    t("中途断线：restart 阻塞时 SIGKILL 工作进程 → interrupted → 76 → --recover 回滚到 rel-old", async () => {
      const h = makeHarness();
      const id = "rel-ci-kill";
      stageRelease(h, id, { target: "explicit", filtered: true });
      const blockFile = join(h.dir, "block");
      const markFile = join(h.dir, "mark");
      writeFileSync(blockFile, "");
      const extra = { T_BLOCK_FILE: blockFile, T_MARK_FILE: markFile };
      expect(launch(h, id, { extraEnv: extra }).exitCode).toBe(0);
      await waitUntil(() => existsSync(markFile), "restart block marker");

      const mid = status(h, id);
      expect(mid.state).toBe("running");
      process.kill(Number(mid.worker_pid), "SIGKILL");

      await waitUntil(() => status(h, id).state === "interrupted", "interrupted state");

      const again = launch(h, id);
      expect(again.exitCode).toBe(76);
      expect(again.stdout).toContain(`interrupted=${id}`);

      const rec = run(h, ["--recover", id]);
      expect(rec.exitCode).toBe(0);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("rolled-back");
      expect(currentBasename(h)).toBe("rel-old");
      expect(readText(h.envFile)).toBe(BEFORE);
      expect(countPrefix(gateCalls(h), "systemctl:restart")).toBe(2);
    });

    t("TERM 信号：restart 阻塞时发送 TERM → 阻塞结束后 trap 回滚 → rolled-back", async () => {
      const h = makeHarness();
      const id = "rel-ci-term";
      stageRelease(h, id, { target: "explicit", filtered: true });
      const blockFile = join(h.dir, "block");
      const markFile = join(h.dir, "mark");
      writeFileSync(blockFile, "");
      expect(launch(h, id, { extraEnv: { T_BLOCK_FILE: blockFile, T_MARK_FILE: markFile } }).exitCode).toBe(0);
      await waitUntil(() => existsSync(markFile), "restart block marker");

      process.kill(Number(status(h, id).worker_pid), "SIGTERM");

      const s = await waitTerminal(h, id);
      expect(s.state).toBe("rolled-back");
      expect(currentBasename(h)).toBe("rel-old");
      expect(readText(h.envFile)).toBe(BEFORE);
      expect(countPrefix(gateCalls(h), "systemctl:restart")).toBe(2);
    });
  });

  describe("健康失败与回滚", () => {
    t("健康探测失败 → 回滚到 rel-old，env 恢复，日志不含增改值", async () => {
      const h = makeHarness();
      const id = "rel-ci-hbad";
      stageRelease(h, id, { target: "explicit", filtered: true });
      expect(launch(h, id, { extraEnv: { T_HEALTH_BAD_RELEASE: id } }).exitCode).toBe(0);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("rolled-back");
      expect(currentBasename(h)).toBe("rel-old");
      expect(readText(h.envFile)).toBe(BEFORE);
      expect(countPrefix(gateCalls(h), "systemctl:restart")).toBe(2);
      const log = run(h, ["--log", id]).stdout;
      expect(log).toContain("env: set REVIEW_FIXTURE");
      expect(log).not.toContain("after-value-7f3");
      expect(log).not.toContain("new-value-9c1");
    });

    t("回滚被拒（previous 为旧隐式 origin）→ rollback-refused，current 仍指向新 release，无 stop", async () => {
      const h = makeHarness("old-origin");
      const id = "rel-ci-refuse";
      stageRelease(h, id, { target: "explicit", filtered: true });
      expect(launch(h, id, { extraEnv: { T_HEALTH_BAD_RELEASE: id } }).exitCode).toBe(0);
      const s = await waitTerminal(h, id);
      expect(s.state).toBe("rollback-refused");
      expect(currentBasename(h)).toBe(id);
      expect(countPrefix(gateCalls(h), "systemctl:restart")).toBe(1);
      expect(countPrefix(gateCalls(h), "systemctl:stop")).toBe(0);
      const log = run(h, ["--log", id]).stdout;
      expect(log).toContain("would restore implicit trial creation");
    });
  });

  describe("状态与日志权限", () => {
    t("状态目录权限 700，日志文件权限 600", async () => {
      const h = makeHarness();
      const id = "rel-ci-perm";
      stageRelease(h, id, { target: "explicit", filtered: true });
      expect(launch(h, id).exitCode).toBe(0);
      await waitTerminal(h, id);
      expect(statSync(h.stateDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(h.stateDir, `${id}.log`)).mode & 0o777).toBe(0o600);
    });
  });
});
