import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 前端恢复准入门禁契约测试（scripts/deploy/frontend-recovery-gate.sh）。
 *
 * 在临时 git 仓库中验证：目标必须等于运营核定的 origin SHA、核定时间新鲜、目标已合入 main、
 * Quality gate 成功、运营批准可核查（评论存在、作者授权、正文绑定 sha 与核定时间、创建不早于核定时间）、
 * origin 健康探测通过。gh / curl / ssh / scp 全部为桩；ssh 与 scp 在任何用例中都不得被调用。
 */

const GATE = join(import.meta.dir, "../../../scripts/deploy/frontend-recovery-gate.sh");
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
const HEALTHY_BODY = '{"status":"ok","surrealdb":"up"}';

// gh 桩：issues/comments 端点输出 FAKE_COMMENT（或失败）；其它调用（check-runs）输出 FAKE_QG。
const FAKE_GH = `#!/usr/bin/env bash
case "$*" in
  *issues/comments*)
    if [ "$FAKE_COMMENT_FAIL" = "1" ]; then
      echo "gh: simulated comment failure" >&2
      exit 1
    fi
    printf '%s' "$FAKE_COMMENT"
    exit 0 ;;
esac
if [ "$FAKE_GH_FAIL" = "1" ]; then
  echo "gh: simulated failure" >&2
  exit 1
fi
echo "$FAKE_QG"
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

  for (const name of ["gh", "curl"]) {
    const path = join(bin, name);
    writeFileSync(path, name === "gh" ? FAKE_GH : FAKE_CURL);
    chmodSync(path, 0o755);
  }
  for (const name of ["ssh", "scp"]) {
    const path = join(bin, name);
    writeFileSync(path, FAKE_REMOTE_TOOL);
    chmodSync(path, 0o755);
  }
  return { root, repo, bin, callsLog: join(root, "calls.log"), A, B };
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function approvalComment(opts: {
  sha: string;
  verifiedAt: string;
  createdAt: string;
  login: string;
  body?: string;
}): string {
  const body = opts.body ?? `批准前端恢复 ${opts.sha}，origin 核定于 ${opts.verifiedAt}`;
  return JSON.stringify({ user: { login: opts.login }, body, created_at: opts.createdAt });
}

function baseEnv(ctx: Ctx, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${ctx.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: ctx.root,
    LANG: "C",
    CALLS_LOG: ctx.callsLog,
    RELEASE_SHA: ctx.A,
    ORIGIN_SHA: ctx.A,
    ORIGIN_VERIFIED_AT: iso(NOW - 60),
    APPROVAL_REF: "4500000001",
    RELEASE_APPROVER_LOGINS: "approver-a,approver-b",
    FAKE_COMMENT: approvalComment({
      sha: ctx.A,
      verifiedAt: iso(NOW - 60),
      createdAt: iso(NOW - 30),
      login: "approver-a",
    }),
    FAKE_COMMENT_FAIL: "0",
    GITHUB_REPOSITORY: "owner/repo",
    GH_TOKEN: "test-token-placeholder",
    MAIN_REF: "main",
    NOW_EPOCH: String(NOW),
    ORIGIN_HEALTH_URL: "https://health.invalid/health",
    FAKE_QG: "true",
    FAKE_GH_FAIL: "0",
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

function remoteCalls(ctx: Ctx): string[] {
  return existsSync(ctx.callsLog) ? readFileSync(ctx.callsLog, "utf8").split("\n").filter(Boolean) : [];
}

describe("frontend-recovery-gate.sh 准入门禁", () => {
  test("全部满足时通过，且 ssh/scp 无调用", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx);
    expect(r.code).toBe(0);
    expect(r.out).toContain("frontend recovery gate passed");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("RELEASE_SHA 与 ORIGIN_SHA 不一致时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { ORIGIN_SHA: ctx.B });
    expect(r.code).toBe(1);
    expect(r.out).toContain("differs from the operator-verified origin");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("核定时间过期（超过 MAX_ORIGIN_AGE_SEC）时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { ORIGIN_VERIFIED_AT: iso(NOW - 1801) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("stale or in the future");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("核定时间在未来超过 60 秒时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { ORIGIN_VERIFIED_AT: iso(NOW + 61) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("stale or in the future");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("核定时间在未来 60 秒以内允许通过（边界，批准创建时间与核定时间相同）", async () => {
    const ctx = makeContext();
    const verifiedAt = iso(NOW + 60);
    const r = await runGate(ctx, {
      ORIGIN_VERIFIED_AT: verifiedAt,
      FAKE_COMMENT: approvalComment({ sha: ctx.A, verifiedAt, createdAt: verifiedAt, login: "approver-a" }),
    });
    expect(r.code).toBe(0);
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("ORIGIN_VERIFIED_AT 缺少 Z 时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { ORIGIN_VERIFIED_AT: iso(NOW - 60).replace("Z", "") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("must be UTC");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("ORIGIN_VERIFIED_AT 使用 +08:00 时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { ORIGIN_VERIFIED_AT: "2026-01-01T08:00:00+08:00" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("must be UTC");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("目标提交未合入 main 时拒绝并输出 not merged", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_SHA: ctx.B, ORIGIN_SHA: ctx.B });
    expect(r.code).toBe(1);
    expect(r.out).toContain("not merged");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("Quality gate 为 false 时拒绝", async () => {
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
    expect(remoteCalls(ctx)).toEqual([]);
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

  for (const [name, ref] of [
    ["含空格", "bad ref"],
    ["过短", "abc"],
    ["旧式字符串（须为评论数字 ID）", "approval-123"],
  ] as const) {
    test(`APPROVAL_REF ${name} 时拒绝`, async () => {
      const ctx = makeContext();
      const r = await runGate(ctx, { APPROVAL_REF: ref });
      expect(r.code).toBe(1);
      expect(r.out).toContain("approval_ref is missing or malformed");
      expect(remoteCalls(ctx)).toEqual([]);
    });
  }

  test("RELEASE_SHA 非 40 位小写 hex（大写）时拒绝", async () => {
    const ctx = makeContext();
    const upper = ctx.A.toUpperCase();
    const r = await runGate(ctx, { RELEASE_SHA: upper, ORIGIN_SHA: upper });
    expect(r.code).toBe(1);
    expect(r.out).toContain("release_sha must be a full lowercase commit SHA");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("RELEASE_SHA 长度不足 40 位时拒绝", async () => {
    const ctx = makeContext();
    const short = ctx.A.slice(0, 39);
    const r = await runGate(ctx, { RELEASE_SHA: short, ORIGIN_SHA: short });
    expect(r.code).toBe(1);
    expect(r.out).toContain("release_sha must be a full lowercase commit SHA");
    expect(remoteCalls(ctx)).toEqual([]);
  });
});

describe("运营批准可核查（评论绑定 sha 与核定时间）", () => {
  test("RELEASE_APPROVER_LOGINS 未配置时拒绝（fail closed）", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_APPROVER_LOGINS: undefined });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RELEASE_APPROVER_LOGINS is not configured");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("RELEASE_APPROVER_LOGINS 只含空白与逗号时同样拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { RELEASE_APPROVER_LOGINS: " , " });
    expect(r.code).toBe(1);
    expect(r.out).toContain("RELEASE_APPROVER_LOGINS is not configured");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("评论作者不在白名单时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, {
      FAKE_COMMENT: approvalComment({ sha: ctx.A, verifiedAt: iso(NOW - 60), createdAt: iso(NOW - 30), login: "mallory" }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not by an authorized approver");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("作者按大小写不敏感匹配白名单时通过", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, {
      FAKE_COMMENT: approvalComment({ sha: ctx.A, verifiedAt: iso(NOW - 60), createdAt: iso(NOW - 30), login: "Approver-B" }),
    });
    expect(r.code).toBe(0);
  });

  test("评论不可读（gh 失败）时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, { FAKE_COMMENT_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not readable in this repository");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("正文缺少目标 sha 时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, {
      FAKE_COMMENT: approvalComment({
        sha: ctx.A,
        verifiedAt: iso(NOW - 60),
        createdAt: iso(NOW - 30),
        login: "approver-a",
        body: `批准，核定于 ${iso(NOW - 60)}`,
      }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("does not name the release sha");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("正文缺少核定时间时拒绝", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, {
      FAKE_COMMENT: approvalComment({
        sha: ctx.A,
        verifiedAt: iso(NOW - 60),
        createdAt: iso(NOW - 30),
        login: "approver-a",
        body: `批准 ${ctx.A}`,
      }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("does not name the origin verification time");
    expect(remoteCalls(ctx)).toEqual([]);
  });

  test("评论创建早于核定时间时拒绝（不能复用更早的批准）", async () => {
    const ctx = makeContext();
    const r = await runGate(ctx, {
      FAKE_COMMENT: approvalComment({ sha: ctx.A, verifiedAt: iso(NOW - 60), createdAt: iso(NOW - 120), login: "approver-a" }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("predates the origin verification");
    expect(remoteCalls(ctx)).toEqual([]);
  });
});
