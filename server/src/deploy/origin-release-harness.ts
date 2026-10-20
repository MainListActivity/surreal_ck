import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, type Stats, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type TrialCompat, writeTrialTree } from "./origin-release-fixtures";

/**
 * origin-release.sh 脚本级测试的共享夹具（真实脚本、真实 --launch / --status / --recover 与分离工作进程）。
 * 外部命令（bunx / bun / sudo / systemctl / curl / sleep / mv / tar）通过 BASH_ENV 桩替换，
 * 每次调用记入 GATE_LOG；systemctl 桩维护一个服务状态文件（默认 active）。故障开关由测试经环境变量注入，默认全部关闭。
 * 从不发出真实 SSH、网络请求或 systemctl 调用，夹具目录位于系统临时目录。
 */

export const SCRIPT_PATH = join(import.meta.dir, "../../../scripts/deploy/origin-release.sh");
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const APPROVAL = "approval/ref-1";
export const DEPLOY = "deploy-1";
export const BEFORE = "REVIEW_FIXTURE=before\nBASE_KEY=keep\n";
export const ADDITIONS = "REVIEW_FIXTURE=after-value-7f3\nNEW_K=new-value-9c1\n";
export const SECRET_MARKERS = ["after-value-7f3", "new-value-9c1"];
export const TERMINAL = ["healthy", "refused", "failed", "rolled-back", "rollback-refused", "rollback-failed"];
export const SERVICE = "fixture-svc";
export const TEST_TIMEOUT_MS = 40_000;

export const HOOK_OK = "#!/usr/bin/env bash\necho \"hook:ran\" >>\"$GATE_LOG\"\nexit 0\n";
export const HOOK_FAIL = "#!/usr/bin/env bash\necho \"hook:ran\" >>\"$GATE_LOG\"\necho \"hook: injected failure\" >&2\nexit 1\n";
// 钩子阻塞直到测试删除 HOOK_BLOCK_FILE；用于在钩子阶段（服务已停）杀死工作进程。
export const HOOK_BLOCK = [
  "#!/usr/bin/env bash",
  ": >\"$HOOK_MARK\"",
  "while [ -f \"$HOOK_BLOCK_FILE\" ]; do command sleep 1; done",
  "echo \"hook:ran\" >>\"$GATE_LOG\"",
  "exit 0",
  "",
].join("\n");

// 注意：模板字符串内的 shell 插值需转义为 \${...}；printf 格式中的 \\n 在脚本里是 \n。
export const FAULT_PRELUDE = `bunx() {
  echo "bunx:$*" >>"$GATE_LOG"
  if [ -n "\${T_HOLD_FILE:-}" ]; then while [ -f "$T_HOLD_FILE" ]; do command sleep 0.05; done; fi
  if [ -n "\${T_BUNX_FAIL:-}" ]; then return 1; fi
  return 0
}
bun() {
  echo "bun:$*" >>"$GATE_LOG"
  if [ -n "\${T_CHECKER_RC:-}" ]; then return "$T_CHECKER_RC"; fi
  if [ -n "\${T_CHECKER_SEQ:-}" ]; then
    local n
    local -a seq
    IFS=, read -ra seq <<<"$T_CHECKER_SEQ"
    n=$(grep -c 'grant-revocation-check-cli' "$GATE_LOG")
    if [ "$n" -gt "\${#seq[@]}" ]; then n=\${#seq[@]}; fi
    printf 'grant_revocations=%s\\n' "\${seq[$((n - 1))]}"
    return 0
  fi
  printf '%b' "\${T_CHECKER_OUT-grant_revocations=0\\n}"
}
sudo() { echo "sudo:$*" >>"$GATE_LOG"; if [ "\${1:-}" = "-n" ]; then shift; fi; "$@"; }
systemctl() {
  echo "systemctl:$*" >>"$GATE_LOG"
  local svc_state="\${T_ACTIVE:-active}"
  if [ -f "$GATE_LOG.unit" ]; then svc_state=$(cat "$GATE_LOG.unit"); fi
  case "\${1:-}" in
    is-active) echo "$svc_state"; [ "$svc_state" = active ] ;;
    stop)
      if [ -n "\${T_STOP_FAIL:-}" ]; then return 1; fi
      echo inactive >"$GATE_LOG.unit"; return 0 ;;
    start|restart)
      if [ "\${1:-}" = restart ] && [ -n "\${T_RESTART_FAIL_FIRST:-}" ] && [ "$(grep -c '^systemctl:restart' "$GATE_LOG")" -eq 1 ]; then
        echo inactive >"$GATE_LOG.unit"; return 1
      fi
      echo active >"$GATE_LOG.unit"; return 0 ;;
    *) return 0 ;;
  esac
}
curl() {
  local target
  target=$(readlink "\${ORIGIN_ROOT}/current" 2>/dev/null || true)
  target=\${target##*/}
  if [ -n "\${T_HEALTH_BAD_ALL:-}" ]; then return 22; fi
  if [ -n "\${T_HEALTH_BAD_RELEASE:-}" ] && [ "$target" = "$T_HEALTH_BAD_RELEASE" ]; then return 22; fi
  printf '%s' '{"status":"ok","surrealdb":"up"}'
}
sleep() { :; }
mv() {
  if [ "\${1:-}" = "-T" ]; then
    echo "mv:-T" >>"$GATE_LOG"
    if [ -n "\${T_MV_FAIL:-}" ]; then echo "mv:injected" >>"$GATE_LOG"; return 1; fi
    if [ -n "\${T_MV_FAIL_FIRST:-}" ] && [ "$(grep -c '^mv:-T' "$GATE_LOG")" -eq 1 ]; then echo "mv:injected" >>"$GATE_LOG"; return 1; fi
    shift
    if [ -L "$2" ]; then command rm -f "$2"; fi
  fi
  command mv -f "$@"
}
tar() {
  if [ "\${1:-}" = "-xzf" ] && [ -n "\${T_UNPACK_FAIL:-}" ]; then echo "tar:injected" >>"$GATE_LOG"; return 2; fi
  command tar "$@"
}
`;

export type Harness = {
  dir: string;
  root: string;
  service: string;
  stateDir: string;
  lockDir: string;
  reclaimDir: string;
  envFile: string;
  stagingDir: string;
  gateLog: string;
  prelude: string;
  previous: string;
  procs: { kill(): void }[];
};

const harnesses: Harness[] = [];

export function writeChecker(base: string) {
  mkdirSync(join(base, "server", "src", "db"), { recursive: true });
  writeFileSync(join(base, "server", "src", "db", "grant-revocation-check-cli.ts"), "// checker\n");
}

export function writeStore(base: string, filtered: boolean) {
  mkdirSync(join(base, "server", "src", "product-entitlement"), { recursive: true });
  writeFileSync(join(base, "server", "src", "product-entitlement", "store.ts"), filtered ? "content_grant_revocation\n" : "content_grant\n");
}

// 夹具 previous（rel-old）：current 指向它；previousFiltered 控制是否含撤销过滤。
export function makeHarness(previousCompat: TrialCompat = "explicit", previousFiltered = true, service: string = SERVICE): Harness {
  const dir = mkdtempSync(join(tmpdir(), "origin-release-fx-"));
  const root = join(dir, "root");
  const previous = join(root, "releases", "rel-old");
  writeTrialTree(previous, previousCompat);
  writeStore(previous, previousFiltered);
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
  writeFileSync(prelude, FAULT_PRELUDE);
  const h: Harness = {
    dir,
    root,
    service,
    stateDir: join(root, "deploy-state"),
    lockDir: join(root, "deploy-state", "lock"),
    reclaimDir: join(root, "deploy-state", "lock.reclaim"),
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

export function cleanupHarnesses() {
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
}

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export type StageOpts = {
  target?: TrialCompat;
  filtered?: boolean;
  envBody?: string;
  archiveBody?: string;
  hookBody?: string;
};

// 生成发布包与 env 增改文件，放入暂存目录（与 CI 上传位置一致）。hookBody 存在时包含 scripts/deploy/origin-pre-start.sh。
export function stageRelease(h: Harness, id: string, opts: StageOpts = {}) {
  const archive = join(h.stagingDir, `surreal_ck-${id}.tar.gz`);
  const envPath = join(h.stagingDir, `surreal_ck-env-${id}`);
  if (opts.archiveBody !== undefined) {
    writeFileSync(archive, opts.archiveBody);
  } else {
    const payload = mkdtempSync(join(h.dir, "payload-"));
    writeTrialTree(payload, opts.target ?? "explicit");
    writeStore(payload, opts.filtered !== false);
    writeChecker(payload);
    const parts = ["server", "shared"];
    if (opts.hookBody !== undefined) {
      mkdirSync(join(payload, "scripts", "deploy"), { recursive: true });
      writeFileSync(join(payload, "scripts", "deploy", "origin-pre-start.sh"), opts.hookBody);
      parts.push("scripts");
    }
    const proc = Bun.spawnSync(["tar", "-czf", archive, "-C", payload, ...parts]);
    if (proc.exitCode !== 0) throw new Error("fixture tar failed");
  }
  writeFileSync(envPath, opts.envBody ?? ADDITIONS);
  return { archive, envPath };
}

export type Run = { exitCode: number; stdout: string; stderr: string };

export function runEnv(h: Harness, extraEnv: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    BASH_ENV: h.prelude,
    GATE_LOG: h.gateLog,
    ORIGIN_ROOT: h.root,
    ORIGIN_ENV_FILE: h.envFile,
    ORIGIN_STAGING_DIR: h.stagingDir,
    ORIGIN_SERVICE: h.service,
    ORIGIN_KEEP_RELEASES: "8",
    REVOCATION_GATE_DRAIN_SEC: "0",
    T_ACTIVE: "",
    T_HEALTH_BAD_RELEASE: "",
    ...extraEnv,
  };
}

export function run(h: Harness, args: string[], extraEnv: Record<string, string> = {}, script: string = SCRIPT_PATH): Run {
  const proc = Bun.spawnSync(["bash", script, ...args], { env: runEnv(h, extraEnv), timeout: 30_000 });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

export function launch(
  h: Harness,
  id: string,
  opts: { sha?: string; approval?: string; deploy?: string; archive?: string; env?: string; extraEnv?: Record<string, string>; script?: string } = {},
): Run {
  const archive = opts.archive ?? join(h.stagingDir, `surreal_ck-${id}.tar.gz`);
  const env = opts.env ?? join(h.stagingDir, `surreal_ck-env-${id}`);
  return run(h, ["--launch", id, archive, env, opts.sha ?? SHA, opts.approval ?? APPROVAL, opts.deploy ?? DEPLOY], opts.extraEnv, opts.script);
}

// 异步登记（用于并发竞争测试）：返回子进程，调用方等待 exited。
export function spawnLaunch(h: Harness, id: string, extraEnv: Record<string, string> = {}) {
  const archive = join(h.stagingDir, `surreal_ck-${id}.tar.gz`);
  const env = join(h.stagingDir, `surreal_ck-env-${id}`);
  return Bun.spawn(["bash", SCRIPT_PATH, "--launch", id, archive, env, SHA, APPROVAL, DEPLOY], {
    env: runEnv(h, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function status(h: Harness, id: string): Record<string, string> {
  return parseKv(run(h, ["--status", id]).stdout);
}

export async function waitUntil<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(50);
  }
}

export async function waitTerminal(h: Harness, id: string): Promise<Record<string, string>> {
  return waitUntil(() => {
    const s = status(h, id);
    return TERMINAL.includes(s.state ?? "") ? s : null;
  }, `terminal state of ${id}`);
}

export function gateCalls(h: Harness): string[] {
  return readText(h.gateLog)
    .split("\n")
    .filter((l) => l.length > 0);
}

export function countPrefix(calls: string[], prefix: string): number {
  return calls.filter((c) => c.startsWith(prefix)).length;
}

// 主机侧调用：排除 --status 发出的只读 unit 查询（show / is-active）。
export function hostCalls(h: Harness): string[] {
  return gateCalls(h).filter((c) => !c.startsWith("systemctl:show") && !c.startsWith("systemctl:is-active"));
}

// 对服务单元的变更调用（stop/start/restart）；不含只读查询。
export function unitMutations(h: Harness): string[] {
  return gateCalls(h).filter((c) => c.startsWith("systemctl:") && !c.startsWith("systemctl:show") && !c.startsWith("systemctl:is-active"));
}

export function currentBasename(h: Harness): string {
  return basename(readlinkSync(join(h.root, "current")));
}

export function serviceState(h: Harness): string {
  return readText(`${h.gateLog}.unit`).trim() || "active";
}

export function writeLock(h: Harness, owner: number, release: string) {
  mkdirSync(h.lockDir, { recursive: true });
  writeFileSync(join(h.lockDir, "pid"), `${owner}\n`);
  writeFileSync(join(h.lockDir, "release"), `${release}\n`);
}

export async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

export function writeStateFile(h: Harness, id: string, fields: Record<string, string> = {}) {
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

// 敏感对象快照：文件路径与内容哈希。用于断言执行前后未被改动。
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else {
        out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// 敏感对象访问检测（仅用于假敏感对象）。pinSensitive 把各对象的 atime、mtime 固定到过去时刻并记录基线；
// sensitiveViolations 只用 lstat 比对、不读取内容，因此检测本身不会制造读取记录。
// - atime 变化 = 有读取（cat、head、ls 列目录与 readFileSync 已在本平台验证；Linux relatime 下 atime 早于 mtime 时首次读取同样更新）；
// - mtime 或 size 变化 = 写入（内容相同的覆写也会更新 mtime）；
// - mode、nlink、uid、gid 变化，或仅 ctime 变化 = 元数据修改（chmod、chown、硬链接、xattr）；
// - ino 或 dev 变化 = 替换；条目消失 = 删除或改名。
// 局限：只查询元数据的调用（stat、test -r）与只 open 不 read 的调用不更新 atime，超出本检测范围。
const PIN_ATIME = new Date("2000-01-01T00:00:00Z");
const PIN_MTIME = new Date("2001-01-01T00:00:00Z");

export type SensitiveBaseline = { root: string; entries: Map<string, Stats> };

// 相对 root 的全部条目（根记为 "."）。夹具不得含符号链接：固定时间戳会穿透链接改动外部对象。
function sensitiveEntries(root: string): string[] {
  const out = ["."];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const child = rel === "." ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, child));
      if (st.isSymbolicLink()) throw new Error(`sensitive fixture must not contain symlinks: ${child}`);
      out.push(child);
      if (st.isDirectory()) walk(child);
    }
  };
  walk(".");
  return out;
}

export async function pinSensitive(root: string): Promise<SensitiveBaseline> {
  const rels = sensitiveEntries(root);
  for (const rel of rels) utimesSync(join(root, rel), PIN_ATIME, PIN_MTIME);
  // 固定后等待一个时钟粒度：此后 inode 变化记入的 ctime 必晚于基线中的固定时刻。
  await Bun.sleep(20);
  const entries = new Map<string, Stats>();
  for (const rel of rels) entries.set(rel, lstatSync(join(root, rel)));
  return { root, entries };
}

// 返回违规标签列表（如 read:root.env），空数组表示无读取、写入、替换或元数据变化。
export function sensitiveViolations(baseline: SensitiveBaseline): string[] {
  const bad: string[] = [];
  for (const [rel, before] of baseline.entries) {
    let now: Stats;
    try {
      now = lstatSync(join(baseline.root, rel));
    } catch {
      bad.push(`missing:${rel}`);
      continue;
    }
    if (now.dev !== before.dev || now.ino !== before.ino) bad.push(`replaced:${rel}`);
    if (now.atimeMs !== before.atimeMs) bad.push(`read:${rel}`);
    const wrote = now.mtimeMs !== before.mtimeMs || now.size !== before.size;
    if (wrote) bad.push(`write:${rel}`);
    const attr = now.mode !== before.mode || now.nlink !== before.nlink || now.uid !== before.uid || now.gid !== before.gid;
    if (attr || (!wrote && now.ctimeMs !== before.ctimeMs)) bad.push(`meta:${rel}`);
  }
  return bad;
}

// 零触碰审计：systemctl 调用只能作用于目标服务，且不得出现 surrealdb 相关 unit 或 journalctl。
// 返回违规列表（空数组表示通过）。
export function zeroTouchViolations(calls: string[], service: string = SERVICE): string[] {
  const bad: string[] = [];
  for (const c of calls) {
    if (/surrealdb/i.test(c)) bad.push(c);
    if (c.startsWith("journalctl")) bad.push(c);
    if (c.startsWith("systemctl:") && !c.endsWith(` ${service}`)) bad.push(c);
  }
  return bad;
}
