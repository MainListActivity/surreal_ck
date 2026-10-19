import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 前端恢复准入门禁契约测试（scripts/deploy/frontend-recovery-gate.sh）。
 *
 * 门禁只做只读检查：输入格式、审批人已配置、目标已合入 main、证据 PR 存在、Quality gate、origin 健康。
 * 它不读取 origin 运行 SHA，也不读取 PR 评论（评论由发布作业内的 origin-verification.py 校验）。
 * gh / curl / ssh / scp 全部为桩：gh 记录每次调用，未知调用失败；ssh 与 scp 在任何用例中都不得被调用。
 */

const GATE = join(import.meta.dir, "../../../scripts/deploy/frontend-recovery-gate.sh");
const HEALTHY_BODY = '{"status":"ok","surrealdb":"up"}';

const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$CALLS_LOG"
case "$*" in
  *pulls/*)
    if [ "$FAKE_PR_FAIL" = "1" ]; then echo "gh: simulated 404" >&2; exit 1; fi
    echo "$FAKE_PR_NUMBER"
    exit 0 ;;
  *check-runs*)
    if [ "$FAKE_GH_FAIL" = "1" ]; then echo "gh: simulated failure" >&2; exit 1; fi
    echo "$FAKE_QG"
    exit 0 ;;
esac
echo "gh: unexpected call $*" >&2
exit 1
`;

const FAKE_CURL = `#!/usr/bin/env bash
if [ -n "$FAKE_HEALTH_RC" ] && [ "$FAKE_HEALTH_RC" != "0" ]; then
  exit "$FAKE_HEALTH_RC"
fi
printf '%s' "$FAKE_HEALTH_BODY"
`;

const FAKE_REMOTE_TOOL = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$CALLS_LOG"
exit 0
`;

type Ctx = {
  root: string;
  repo: string;
  bin: string;
  callsLog: string;
  A: string;
  B: string;
};

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

function makeContext(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "frontend-gate-"));
  roots.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);

  git(repo, ["init", "-q", "-b", "main"]);
  // 仅作用于本临时仓库，避免依赖宿主机的全局身份或签名配置。
  git(repo, ["config", "user.name", "frontend-gate-test"]);
  git(repo, ["config", "user.email", "frontend-gate-test@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "file.txt"), "A\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-q", "-m", "A"]);
  const A = git(repo, ["rev-parse", "HEAD"]);

  git(repo, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repo, "file.txt"), "B\n");
  git(repo, ["commit", "-q", "-am", "B"]);
  const B = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-q", "main"]);

  for (const [name, body] of [
    ["gh", FAKE_GH],
    ["curl", FAKE_CURL],
    ["ssh", FAKE_REMOTE_TOOL],
    ["scp", FAKE_REMOTE_TOOL],
  ] as const) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return { root, repo, bin, callsLog: join(root, "calls.log"), A, B };
}

function baseEnv(ctx: Ctx, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${ctx.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: ctx.root,
    LANG: "C",
    CALLS_LOG: ctx.callsLog,
    RELEASE_SHA: ctx.A,
    EVIDENCE_PR: "199",
    APPROVAL_REF: "fa-audit-20261019-01",
    RELEASE_APPROVER_LOGINS: "MainListActivity,approver-b",
    GITHUB_REPOSITORY: "MainListActivity/surreal_ck",
    GH_TOKEN: "test-token-placeholder",
    MAIN_REF: "main",
    ORIGIN_HEALTH_URL: "https://health.invalid/health",
    FAKE_QG: "true",
    FAKE_GH_FAIL: "0",
    FAKE_PR_FAIL: "0",
    FAKE_PR_NUMBER: "199",
    FAKE_HEALTH_BODY: HEALTHY_BODY,
    FAKE_HEALTH_RC: "0",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function runGate(ctx: Ctx, overrides: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(["bash", GATE], {
    cwd: ctx.repo,
    env: baseEnv(ctx, overrides),
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

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

const remoteCalls = (ctx: Ctx) => lines(ctx.callsLog).filter((line) => /^(ssh|scp) /.test(line));
const ghCalls = (ctx: Ctx) => lines(ctx.callsLog).filter((line) => line.startsWith("gh "));

describe("frontend-recovery-gate.sh 准入门禁（只读）", () => {
  test("全部满足时通过；只读 check runs 与 PR 元数据，不读取评论；ssh/scp 无调用", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx);
    expect(r.code).toBe(0);
    expect(r.out).toContain("frontend recovery gate passed");
    expect(remoteCalls(ctx)).toEqual([]);
    expect(ghCalls(ctx).some((line) => line.includes("pulls/199"))).toBe(true);
    expect(ghCalls(ctx).some((line) => line.includes("check-runs"))).toBe(true);
    expect(ghCalls(ctx).some((line) => line.includes("comments"))).toBe(false);
  });

  test("门禁不读取 origin 运行 SHA：旧的 origin 输入即使不同也不影响结果", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { ORIGIN_SHA: ctx.B, ORIGIN_VERIFIED_AT: "2020-01-01T00:00:00Z" });
    expect(r.code).toBe(0);
  });

  test("门禁脚本本身不含 origin 运行 SHA 或核定时间输入", () => {
    const text = readFileSync(GATE, "utf8");
    expect(text).not.toContain("ORIGIN_SHA");
    expect(text).not.toContain("ORIGIN_VERIFIED_AT");
    expect(text).not.toContain("issues/");
  });

  test("RELEASE_SHA 大写时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_SHA: ctx.A.toUpperCase() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("release_sha must be a full lowercase commit SHA");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("RELEASE_SHA 长度不足 40 位时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_SHA: ctx.A.slice(0, 39) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("release_sha must be a full lowercase commit SHA");
  });

  for (const [name, value] of [
    ["为空", ""],
    ["为 0", "0"],
    ["含字母", "199x"],
    ["非数字", "abc"],
  ] as const) {
    test(`EVIDENCE_PR ${name} 时拒绝`, async () => {
      const ctx = makeContext();
      const r = await runGate(ctx, { EVIDENCE_PR: value });
      expect(r.code).toBe(1);
      expect(r.out).toContain("evidence_pr must be the PR number that carries the operator evidence");
      expect(ghCalls(ctx)).toEqual([]);
    });
  }

  for (const [name, ref] of [
    ["含空格", "bad ref"],
    ["过短", "abc"],
    ["缺失", ""],
  ] as const) {
    test(`APPROVAL_REF ${name} 时拒绝`, async () => {
      const ctx = makeContext();
      const r = await runGate(ctx, { APPROVAL_REF: ref });
      expect(r.code).toBe(1);
      expect(r.out).toContain("approval_ref is missing or malformed");
      expect(remoteCalls(ctx)).toEqual([]);
    });
  }

  test("RELEASE_APPROVER_LOGINS 未配置时拒绝（fail closed）", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_APPROVER_LOGINS: undefined });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RELEASE_APPROVER_LOGINS is not configured");
    expect(ghCalls(ctx)).toEqual([]);
  });

  test("RELEASE_APPROVER_LOGINS 只含空白与逗号时同样拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_APPROVER_LOGINS: " , " });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RELEASE_APPROVER_LOGINS is not configured");
  });

  test("目标提交未合入 main 时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_SHA: ctx.B });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not merged into main");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("证据 PR 不可读（gh 失败）时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { FAKE_PR_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("evidence PR #199 is not readable in this repository");
  });

  test("证据 PR 编号与请求不符（PR 不存在）时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { FAKE_PR_NUMBER: "200" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("evidence PR #199 does not exist");
  });

  test("Quality gate 不是成功时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { FAKE_QG: "false" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Quality gate has not succeeded");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("读取 check runs 失败（gh 非零退出）时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { FAKE_GH_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not read check runs");
  });

  test("origin 健康 body 非 ok（degraded）时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { FAKE_HEALTH_BODY: '{"status":"degraded","surrealdb":"down"}' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("origin health probe is not ok");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("origin 健康探测 curl 失败时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { FAKE_HEALTH_RC: "22", FAKE_HEALTH_BODY: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("origin health probe is not ok");
    expect(remoteCalls(ctx)).toEqual([]);
  });
});
