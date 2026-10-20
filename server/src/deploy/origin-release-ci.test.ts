import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CI 收敛脚本契约测试（scripts/deploy/origin-release-ci.sh）。
 *
 * 全部使用桩：PATH 前置假 ssh（执行本地 bash -c，不发起真实网络请求），
 * 远端工具 origin-release-<id>.sh 为桩脚本，由 ctl 目录中的序列文件驱动
 * --status / --launch / --recover 的退出码与输出。轮询间隔为 0。
 */

const CI_SCRIPT = join(import.meta.dir, "../../../scripts/deploy/origin-release-ci.sh");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ID = `${SHA.slice(0, 7)}-ci42`;
const APPROVAL = "deploy-production-7";
const DEPLOY_ID = "42-1";

// 假 ssh：跳过 -o <值> 与 host，把剩余参数拼成远端命令；按需断开（退出 255，无输出）。
const FAKE_SSH = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
cmd="$*"
echo "$cmd" >> "$SSH_LOG"
if [ -n "$SSH_FAIL_PATTERN" ] && [[ "$cmd" == *"$SSH_FAIL_PATTERN"* ]]; then
  exit 255
fi
exec bash -c "$cmd"
`;

// 桩远端工具：每次调用的 argv 逐行记入 CALLS_LOG；序列文件逐次取值，最后一行重复。
const STUB_REMOTE = `#!/usr/bin/env bash
for a in "$@"; do echo "$a" >> "$CALLS_LOG"; done
pick() {
  local name=$1 def=$2 f="$CTL/$1.seq" idx=0 total line
  if [ ! -s "$f" ]; then echo "$def"; return; fi
  if [ -f "$CTL/$name.idx" ]; then idx=$(cat "$CTL/$name.idx"); fi
  idx=$((idx + 1))
  echo "$idx" > "$CTL/$name.idx"
  total=$(wc -l < "$f" | tr -d ' ')
  line=$idx
  if [ "$line" -gt "$total" ]; then line=$total; fi
  sed -n "$line"p "$f"
}
case "$1" in
  --status) pick status "state=absent" ;;
  --launch)
    rc=$(pick launch 0)
    if [ -f "$CTL/launch.out" ]; then cat "$CTL/launch.out"; fi
    exit "$rc" ;;
  --recover) rc=$(pick recover 0); exit "$rc" ;;
  --log) echo "stub log line for $2" ;;
  *) exit 64 ;;
esac
`;

type Harness = {
  staging: string;
  bin: string;
  ctl: string;
  callsLog: string;
  sshLog: string;
  archive: string;
  envFile: string;
  remoteScript: string;
};

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function writeSeq(path: string, lines: (string | number)[]) {
  writeFileSync(path, lines.map(String).join("\n") + "\n");
}

function makeHarness(opts: {
  status?: string[];
  launch?: number[];
  recover?: number[];
  launchOut?: string;
}): Harness {
  const staging = mkdtempSync(join(tmpdir(), "origin-ci-"));
  roots.push(staging);
  const bin = join(staging, "bin");
  const ctl = join(staging, "ctl");
  mkdirSync(bin);
  mkdirSync(ctl);
  writeFileSync(join(bin, "ssh"), FAKE_SSH);
  chmodSync(join(bin, "ssh"), 0o755);
  const remoteScript = join(staging, `origin-release-${ID}.sh`);
  writeFileSync(remoteScript, STUB_REMOTE);
  chmodSync(remoteScript, 0o755);
  if (opts.status) writeSeq(join(ctl, "status.seq"), opts.status);
  if (opts.launch) writeSeq(join(ctl, "launch.seq"), opts.launch);
  if (opts.recover) writeSeq(join(ctl, "recover.seq"), opts.recover);
  if (opts.launchOut !== undefined) writeFileSync(join(ctl, "launch.out"), opts.launchOut);
  const archive = join(staging, `surreal_ck-${ID}.tar.gz`);
  const envFile = join(staging, `surreal_ck-env-${ID}`);
  writeFileSync(archive, "placeholder-archive");
  writeFileSync(envFile, "PLACEHOLDER=1\n");
  return {
    staging,
    bin,
    ctl,
    callsLog: join(staging, "calls.log"),
    sshLog: join(staging, "ssh.log"),
    archive,
    envFile,
    remoteScript,
  };
}

function validArgs(h: Harness): string[] {
  return [ID, h.archive, h.envFile, SHA, APPROVAL, DEPLOY_ID];
}

async function runCi(
  h: Harness,
  args: string[],
  opts: { deadline?: number; sshFailPattern?: string } = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bash", CI_SCRIPT, ...args], {
    env: {
      PATH: `${h.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: h.staging,
      LANG: "C",
      ORIGIN_STAGING_DIR: h.staging,
      ORIGIN_WATCH_INTERVAL_SEC: "0",
      ORIGIN_WATCH_DEADLINE_SEC: String(opts.deadline ?? 5),
      CTL: h.ctl,
      CALLS_LOG: h.callsLog,
      SSH_LOG: h.sshLog,
      SSH_FAIL_PATTERN: opts.sshFailPattern ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: stdout + stderr };
}

function remoteCalls(h: Harness): string[] {
  return existsSync(h.callsLog) ? readFileSync(h.callsLog, "utf8").split("\n").filter(Boolean) : [];
}

function sshCalls(h: Harness): string[] {
  return existsSync(h.sshLog) ? readFileSync(h.sshLog, "utf8").split("\n").filter(Boolean) : [];
}

function count(h: Harness, arg: string): number {
  return remoteCalls(h).filter((line) => line === arg).length;
}

const STATUS_TIMEOUT = 20_000;

describe("origin-release-ci.sh 收敛", () => {
  test("成功：launch 一次后 absent→running→healthy，exit 0，且不恢复", async () => {
    const h = makeHarness({
      status: ["state=absent", "state=running", "state=healthy"],
      launch: [0],
    });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`release ${ID} is healthy on origin`);
    expect(count(h, "--launch")).toBe(1);
    expect(count(h, "--recover")).toBe(0);
  });

  test("SSH 断开后收敛：launch 退出 255，之后 absent→running→healthy，exit 0，且不恢复", async () => {
    const h = makeHarness({
      status: ["state=absent", "state=running", "state=healthy"],
      launch: [255],
    });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(0);
    expect(r.out).toContain("launch outcome unknown (rc=255)");
    expect(count(h, "--launch")).toBe(1);
    expect(count(h, "--recover")).toBe(0);
  });

  test("中断自动恢复：interrupted→running→healthy，recover 成功，exit 0，且不 launch", async () => {
    const h = makeHarness({
      status: ["state=interrupted", "state=running", "state=healthy"],
      recover: [0],
    });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(0);
    expect(count(h, "--recover")).toBe(1);
    expect(count(h, "--launch")).toBe(0);
  });

  for (const rc of [76, 2]) {
    test(`中断且恢复被拒（recover 退出 ${rc}）：退出前回读主机状态与日志，exit 1，输出说明恢复被拒`, async () => {
      const h = makeHarness({ status: ["state=interrupted"], recover: [rc] });
      const r = await runCi(h, validArgs(h));
      expect(r.code).toBe(1);
      expect(r.out).toContain("origin refused recovery");
      expect(count(h, "--recover")).toBe(1);
      expect(count(h, "--launch")).toBe(0);
      // F8：拒绝前的回读（状态与日志）必须先于 exit 1 的错误输出，且不因此改变退出码。
      expect(count(h, "--log")).toBe(1);
      expect(r.out.indexOf("state=interrupted")).toBeGreaterThanOrEqual(0);
      expect(r.out.indexOf("state=interrupted")).toBeLessThan(r.out.indexOf("origin refused recovery"));
      expect(r.out.indexOf("stub log line")).toBeLessThan(r.out.indexOf("origin refused recovery"));
    });
  }

  test("终态失败：rolled-back 时 exit 1，之后不 launch 也不 recover", async () => {
    const h = makeHarness({ status: ["state=rolled-back"] });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(1);
    expect(r.out).toContain("ended in state 'rolled-back'");
    expect(count(h, "--launch")).toBe(0);
    expect(count(h, "--recover")).toBe(0);
  });

  test("请求被拒：launch 退出 2 时 exit 1，并清理远端工具副本与暂存件", async () => {
    const h = makeHarness({ status: ["state=absent"], launch: [2], launchOut: "rejected: bad request\n" });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(1);
    expect(r.out).toContain("rejected");
    const cleanup = sshCalls(h).filter((line) => line.startsWith("rm -f "));
    expect(cleanup.length).toBeGreaterThan(0);
    expect(cleanup.some((line) => line.includes(`surreal_ck-${ID}.tar.gz`))).toBe(true);
    expect(cleanup.some((line) => line.includes(`surreal_ck-env-${ID}`))).toBe(true);
    expect(existsSync(h.remoteScript)).toBe(false);
    expect(existsSync(h.archive)).toBe(false);
    expect(existsSync(h.envFile)).toBe(false);
  });

  test("其他激活中断：launch 退出 76 且 interrupted=other-release 时 exit 1", async () => {
    const h = makeHarness({
      status: ["state=absent"],
      launch: [76],
      launchOut: "interrupted=other-release\n",
    });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(1);
    expect(r.out).toContain("interrupted activation other-release");
    expect(count(h, "--recover")).toBe(0);
  });

  test("忙后收敛：launch 先退出 75 再 0，状态序列 absent→absent→running→healthy，exit 0", async () => {
    const h = makeHarness({
      status: ["state=absent", "state=absent", "state=running", "state=healthy"],
      launch: [75, 0],
    });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(0);
    expect(count(h, "--launch")).toBe(2);
    expect(count(h, "--recover")).toBe(0);
  });

  test(
    "截止未知：状态始终 running 时 exit 1，不视为成功或回滚，且不删除暂存件",
    async () => {
      const h = makeHarness({ status: ["state=running"] });
      const r = await runCi(h, validArgs(h), { deadline: 1 });
      expect(r.code).toBe(1);
      expect(r.out).toContain("result unknown after 1s");
      expect(r.out).toContain("not treated as success or rollback");
      expect(count(h, "--recover")).toBe(0);
      expect(count(h, "--launch")).toBe(0);
      expect(existsSync(h.archive)).toBe(true);
      expect(existsSync(h.envFile)).toBe(true);
      expect(existsSync(h.remoteScript)).toBe(true);
    },
    STATUS_TIMEOUT,
  );

  test(
    "状态不可读：status 一直断开时 exit 1，绝不成功，且不恢复",
    async () => {
      const h = makeHarness({ status: ["state=healthy"] });
      const r = await runCi(h, validArgs(h), { deadline: 1, sshFailPattern: "--status" });
      expect(r.code).toBe(1);
      expect(r.out).toContain("result unknown after 1s");
      expect(r.out).not.toContain("is healthy on origin");
      expect(count(h, "--recover")).toBe(0);
    },
    STATUS_TIMEOUT,
  );

  test("恢复已被接受后，同一运行再次出现 interrupted 不重复请求 recover", async () => {
    const h = makeHarness({
      status: ["state=interrupted", "state=interrupted", "state=healthy"],
      recover: [0],
    });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(0);
    expect(r.out).toContain("already accepted");
    expect(count(h, "--recover")).toBe(1);
  });

  test("恢复请求忙（退出 75）时未被接受，下一轮继续请求直到被接受", async () => {
    const h = makeHarness({
      status: ["state=interrupted", "state=interrupted", "state=healthy"],
      recover: [75, 0],
    });
    const r = await runCi(h, validArgs(h));
    expect(r.code).toBe(0);
    expect(count(h, "--recover")).toBe(2);
  });

  describe("参数校验先于任何 ssh 调用", () => {
    const cases: Array<[string, (h: Harness) => string[], string]> = [
      ["sha 非 40 位小写 hex（大写）", (h) => [ID, h.archive, h.envFile, SHA.toUpperCase(), APPROVAL, DEPLOY_ID], "sha must be"],
      ["sha 长度 39", (h) => [ID, h.archive, h.envFile, SHA.slice(0, 39), APPROVAL, DEPLOY_ID], "sha must be"],
      ["sha 为空字符串", (h) => [ID, h.archive, h.envFile, "", APPROVAL, DEPLOY_ID], "sha must be"],
      ["sha 省略（参数左移，approval 落入 sha 位）", (h) => [ID, h.archive, h.envFile, APPROVAL, DEPLOY_ID], "sha must be"],
      ["release-id 与 sha 不匹配", (h) => ["fffffff-ci42", h.archive, h.envFile, SHA, APPROVAL, DEPLOY_ID], "release id does not match"],
      ["approval 含空格", (h) => [ID, h.archive, h.envFile, SHA, "bad ref", DEPLOY_ID], "approval ref is missing"],
      ["approval 过短", (h) => [ID, h.archive, h.envFile, SHA, "abc", DEPLOY_ID], "approval ref is missing"],
      ["archive 路径不符", (h) => [ID, join(h.staging, "other.tar.gz"), h.envFile, SHA, APPROVAL, DEPLOY_ID], "archive is not the staged path"],
      ["env 路径不符", (h) => [ID, h.archive, join(h.staging, "other-env"), SHA, APPROVAL, DEPLOY_ID], "env additions is not the staged path"],
    ];
    for (const [name, mkArgs, msg] of cases) {
      test(`${name}：exit 1 且 ssh 无调用`, async () => {
        const h = makeHarness({ status: ["state=absent"], launch: [0] });
        const r = await runCi(h, mkArgs(h));
        expect(r.code).toBe(1);
        expect(r.out).toContain(msg);
        expect(sshCalls(h)).toEqual([]);
        expect(remoteCalls(h)).toEqual([]);
      });
    }
  });

  test("参数转义：approval 含 # 时远端 argv 完整保留", async () => {
    const h = makeHarness({ status: ["state=absent", "state=healthy"], launch: [0] });
    const args = [ID, h.archive, h.envFile, SHA, "deploy-production-7#1", DEPLOY_ID];
    const r = await runCi(h, args);
    expect(r.code).toBe(0);
    const calls = remoteCalls(h);
    const idx = calls.indexOf("--launch");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(calls.slice(idx + 1, idx + 7)).toEqual([ID, h.archive, h.envFile, SHA, "deploy-production-7#1", DEPLOY_ID]);
  });
});
