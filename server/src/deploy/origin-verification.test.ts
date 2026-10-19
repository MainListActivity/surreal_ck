import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 前端恢复的 origin 运行版本核定证据契约测试（scripts/deploy/origin-verification.py）。
 *
 * 时间由 NOW_EPOCH 固定；GitHub 评论由 --comments-json 提供；post 的 gh 为桩（记录调用，不联网）。
 * 退出码：0 通过；1 用法、运行绑定或接口错误；2 找到绑定评论但不合格；3 尚无绑定评论或超时。
 */

const SCRIPT = join(import.meta.dir, "../../../scripts/deploy/origin-verification.py");
const REPO = "MainListActivity/surreal_ck";
const TARGET = "a".repeat(40);
const OTHER = "b".repeat(40);
const TOOLING = "c".repeat(40);
const RUN_ID = "1234567890";
const WORKFLOW_REF = `${REPO}/.github/workflows/release-frontend-recovery.yml@refs/heads/main`;
const PR = "199";
const APPROVER = "MainListActivity";
const FA_REF = "fa-audit-20261019-01";

// 固定时间线（UTC）：barrier 00:50:00Z，采样 00:55:00Z，评论 00:56:00Z，默认校验时刻 01:00:00Z。
const NOW = Date.UTC(2026, 9, 19, 1, 0, 0) / 1000;
const BARRIER_AT = NOW - 600;
const SAMPLE_AT = NOW - 300;
const POSTED_AT = NOW - 240;

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "origin-verification-"));
  dirs.push(dir);
  return dir;
}

function baseEnv(extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tmpdir(),
    LANG: "C",
    NOW_EPOCH: String(NOW),
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_SHA: TOOLING,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

type Run = { code: number; stdout: string; stderr: string };
type Outcome = Record<string, any> & { code: number; stderr: string };
type Env = Record<string, string | undefined>;

function runPy(args: string[], env: Env = {}): Run {
  const proc = Bun.spawnSync(["python3", SCRIPT, ...args], {
    env: baseEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function outcome(run: Run): Outcome {
  const last = run.stdout.trim().split("\n").pop() ?? "";
  const json = last.startsWith("{") ? JSON.parse(last) : {};
  return { ...json, code: run.code, stderr: run.stderr };
}

type Barrier = {
  repo: string;
  run_id: string;
  run_attempt: string;
  workflow_ref: string;
  tooling_sha: string;
  target_sha: string;
  generated_at: string;
  nonce: string;
};

function makeBarrier(): { file: string; barrier: Barrier } {
  const file = join(newDir(), "barrier.json");
  const run = runPy(["barrier", "--target", TARGET, "--out", file], { NOW_EPOCH: String(BARRIER_AT) });
  if (run.code !== 0) throw new Error(`barrier failed: ${run.stderr}`);
  return { file, barrier: JSON.parse(readFileSync(file, "utf8")) };
}

type Evidence = { origin?: string; verifiedAt?: number; fa?: string };

/** 用脚本自己的 render 生成评论正文，保证测试使用的格式与发布校验一致。 */
function renderBody(file: string, evidence: Evidence = {}): string {
  const run = runPy([
    "render",
    "--barrier",
    file,
    "--origin-sha",
    evidence.origin ?? TARGET,
    "--origin-verified-at",
    iso(evidence.verifiedAt ?? SAMPLE_AT),
    "--ops-task-id",
    "ops-task-42",
    "--fa-audit-ref",
    evidence.fa ?? FA_REF,
  ]);
  if (run.code !== 0) throw new Error(`render failed: ${run.stderr}`);
  return run.stdout;
}

function tamper(body: string, from: string, to: string): string {
  if (!body.includes(from)) throw new Error(`tamper target missing: ${from}`);
  return body.replace(from, to);
}

function dropLine(body: string, prefix: string): string {
  const lines = body.split("\n");
  const kept = lines.filter((line) => !line.startsWith(prefix));
  if (kept.length === lines.length) throw new Error(`no line starts with ${prefix}`);
  return kept.join("\n");
}

type Cmt = { body: string; id?: number; login?: string; pr?: string; created?: number; updated?: number };

function comment(c: Cmt): Record<string, unknown> {
  const id = c.id ?? 1;
  const pr = c.pr ?? PR;
  const created = iso(c.created ?? POSTED_AT);
  return {
    id,
    html_url: `https://github.com/${REPO}/pull/${pr}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${pr}`,
    user: { login: c.login ?? APPROVER },
    body: c.body,
    created_at: created,
    updated_at: c.updated === undefined ? created : iso(c.updated),
  };
}

type CheckOpts = { target?: string; approvers?: string; approvalRef?: string; env?: Env };

function check(command: "verify" | "wait", file: string, comments: unknown[], opts: CheckOpts = {}, extra: string[] = []): Outcome {
  const commentsFile = join(newDir(), "comments.json");
  writeFileSync(commentsFile, JSON.stringify(comments));
  const args = [
    command,
    "--barrier",
    file,
    "--target",
    opts.target ?? TARGET,
    "--pr",
    PR,
    "--approvers",
    opts.approvers ?? APPROVER,
    "--approval-ref",
    opts.approvalRef ?? FA_REF,
    "--comments-json",
    commentsFile,
    ...extra,
  ];
  return outcome(runPy(args, opts.env ?? {}));
}

function expectRefused(r: Outcome, fragment: string) {
  expect(r.code).toBe(2);
  expect(r.status).toBe("refused");
  expect(String(r.reason)).toContain(fragment);
}

function expectNoEvidence(r: Outcome) {
  expect(r.code).toBe(3);
  expect(r.status).toBe("no_evidence");
}

// gh 桩：记录调用；POST 把 --input 文件复制出来并返回评论 id 42；GET 输出 FAKE_COMMENTS_FILE 的内容。
const GH_STUB = `#!/usr/bin/env bash
echo "gh $*" >> "$GH_CALLS"
case "$*" in
  *"--method POST"*)
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--input" ]; then cp "$arg" "$POSTED_FILE"; fi
      prev="$arg"
    done
    echo '{"id":42}'
    exit 0 ;;
esac
cat "$FAKE_COMMENTS_FILE"
`;

function ghStub(comments: unknown[]) {
  const dir = newDir();
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "gh"), GH_STUB);
  chmodSync(join(binDir, "gh"), 0o755);
  const commentsFile = join(dir, "fake-comments.json");
  writeFileSync(commentsFile, JSON.stringify(comments));
  const calls = join(dir, "gh-calls.log");
  const posted = join(dir, "posted.json");
  return {
    env: {
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      GH_CALLS: calls,
      POSTED_FILE: posted,
      FAKE_COMMENTS_FILE: commentsFile,
    } as Env,
    calls,
    posted,
  };
}

describe("barrier：发布作业在构建之后、生产写入之前生成", () => {
  test("八个字段齐全，nonce 为 32 位小写 hex，生成时间为 UTC Z 格式", () => {
    const { barrier } = makeBarrier();
    expect(Object.keys(barrier).sort()).toEqual([
      "generated_at",
      "nonce",
      "repo",
      "run_attempt",
      "run_id",
      "target_sha",
      "tooling_sha",
      "workflow_ref",
    ]);
    expect(barrier.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(barrier.generated_at).toBe(iso(BARRIER_AT));
    expect(barrier.target_sha).toBe(TARGET);
    expect(barrier.tooling_sha).toBe(TOOLING);
  });

  test("同一运行的重跑（run attempt 为 2）拒绝生成 barrier", () => {
    const file = join(newDir(), "barrier.json");
    const run = runPy(["barrier", "--target", TARGET, "--out", file], { GITHUB_RUN_ATTEMPT: "2" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("reruns are not allowed");
    expect(existsSync(file)).toBe(false);
  });

  test("目标不是完整小写 SHA 时拒绝", () => {
    const file = join(newDir(), "barrier.json");
    const run = runPy(["barrier", "--target", "ABC", "--out", file]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--target must be a full lowercase commit SHA");
  });

  test("缺少运行环境变量时拒绝，且不写出半成品文件", () => {
    const file = join(newDir(), "barrier.json");
    const run = runPy(["barrier", "--target", TARGET, "--out", file], { GITHUB_RUN_ID: undefined });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("GITHUB_RUN_ID is required");
    expect(existsSync(file)).toBe(false);
  });
});

describe("render：运营本地预检，不合格时不生成正文", () => {
  test("origin 与 barrier 目标不同时拒绝（不得发表）", () => {
    const { file } = makeBarrier();
    const run = runPy([
      "render",
      "--barrier",
      file,
      "--origin-sha",
      OTHER,
      "--origin-verified-at",
      iso(SAMPLE_AT),
      "--ops-task-id",
      "ops-task-42",
      "--fa-audit-ref",
      FA_REF,
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("do not post");
  });

  test("采样时间早于 barrier 时拒绝", () => {
    const { file } = makeBarrier();
    const run = runPy([
      "render",
      "--barrier",
      file,
      "--origin-sha",
      TARGET,
      "--origin-verified-at",
      iso(BARRIER_AT - 300),
      "--ops-task-id",
      "ops-task-42",
      "--fa-audit-ref",
      FA_REF,
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("predates the barrier");
  });
});

describe("verify / wait：绑定评论逐项校验", () => {
  test("绑定评论满足全部条件时通过", () => {
    const { file } = makeBarrier();
    const r = check("verify", file, [comment({ id: 7, body: renderBody(file) })]);
    expect(r.code).toBe(0);
    expect(r.status).toBe("ok");
    expect(r.origin_sha).toBe(TARGET);
    expect(r.comment_id).toBe(7);
    expect(r.age_seconds).toBe(300);
  });

  test("审批人白名单按大小写不敏感匹配", () => {
    const { file } = makeBarrier();
    const r = check("verify", file, [comment({ body: renderBody(file), login: "mainlistactivity" })]);
    expect(r.code).toBe(0);
  });

  test("采样早于 barrier（不在锁内采样）时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `origin_verified_at: ${iso(SAMPLE_AT)}`, `origin_verified_at: ${iso(BARRIER_AT - 300)}`);
    expectRefused(check("verify", file, [comment({ body })]), "sampled before the barrier");
  });

  test("核定的 origin 跑 B、请求的目标是 A 时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `origin_sha: ${TARGET}`, `origin_sha: ${OTHER}`);
    expectRefused(check("verify", file, [comment({ body })]), "origin runs");
  });

  test("核定超过 30 分钟（以更晚的校验时刻模拟）时拒绝", () => {
    const { file } = makeBarrier();
    const r = check("verify", file, [comment({ body: renderBody(file) })], { env: { NOW_EPOCH: String(NOW + 2000) } });
    expectRefused(r, "expired");
  });

  test("核定时间在未来超过 60 秒时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `origin_verified_at: ${iso(SAMPLE_AT)}`, `origin_verified_at: ${iso(NOW + 300)}`);
    expectRefused(check("verify", file, [comment({ body })]), "in the future");
  });

  test("评论早于它所报告的采样时（时间被夸大）时拒绝", () => {
    const { file } = makeBarrier();
    expectRefused(check("verify", file, [comment({ body: renderBody(file), created: SAMPLE_AT - 60 })]), "predates the sampling it reports");
  });

  test("评论创建后被编辑（updated_at 不同于 created_at）时拒绝", () => {
    const { file } = makeBarrier();
    expectRefused(check("verify", file, [comment({ body: renderBody(file), updated: POSTED_AT + 30 })]), "edited after it was created");
  });

  test("评论位于其它 PR 时拒绝", () => {
    const { file } = makeBarrier();
    expectRefused(check("verify", file, [comment({ body: renderBody(file), pr: "200" })]), "is not on PR #199");
  });

  test("barrier 字段与评论不一致（run attempt）时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), "barrier_run_attempt: 1", "barrier_run_attempt: 2");
    expectRefused(check("verify", file, [comment({ body })]), "run attempt does not match");
  });

  test("barrier 字段与评论不一致（tooling sha）时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `barrier_tooling_sha: ${TOOLING}`, `barrier_tooling_sha: ${OTHER}`);
    expectRefused(check("verify", file, [comment({ body })]), "tooling sha does not match");
  });

  test("barrier 字段与评论不一致（workflow ref）时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `barrier_workflow_ref: ${WORKFLOW_REF}`, "barrier_workflow_ref: other.yml@refs/heads/main");
    expectRefused(check("verify", file, [comment({ body })]), "workflow ref does not match");
  });

  test("证据块缺少键时拒绝", () => {
    const { file } = makeBarrier();
    const body = dropLine(renderBody(file), "fa_audit_ref: ");
    expectRefused(check("verify", file, [comment({ body })]), "keys differ");
  });

  test("证据块出现重复键时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `origin_sha: ${TARGET}\n`, `origin_sha: ${TARGET}\norigin_sha: ${TARGET}\n`);
    expectRefused(check("verify", file, [comment({ body })]), "duplicate key origin_sha");
  });

  test("证据块出现多余键时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `fa_audit_ref: ${FA_REF}\n`, `fa_audit_ref: ${FA_REF}\nnote: x\n`);
    expectRefused(check("verify", file, [comment({ body })]), "unexpected: ['note']");
  });

  test("origin_sha 不是完整小写 SHA 时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `origin_sha: ${TARGET}`, `origin_sha: ${TARGET.toUpperCase()}`);
    expectRefused(check("verify", file, [comment({ body })]), "not a full lowercase commit SHA");
  });

  test("核定时间不是 UTC（+08:00）时拒绝", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `origin_verified_at: ${iso(SAMPLE_AT)}`, "origin_verified_at: 2026-10-19T09:55:00+08:00");
    expectRefused(check("verify", file, [comment({ body })]), "timestamp is malformed");
  });

  test("fa_audit_ref 与 approval_ref 不一致时拒绝", () => {
    const { file } = makeBarrier();
    expectRefused(
      check("verify", file, [comment({ body: renderBody(file) })], { approvalRef: "fa-audit-other-99" }),
      "fa_audit_ref does not match approval_ref",
    );
  });

  test("同一 barrier 有两条审批人绑定评论时拒绝（歧义）", () => {
    const { file } = makeBarrier();
    const body = renderBody(file);
    expectRefused(check("verify", file, [comment({ id: 7, body }), comment({ id: 8, body })]), "refusing ambiguous evidence");
  });

  test("非审批人发布的、带 nonce 的评论被忽略（退出码 3）", () => {
    const { file } = makeBarrier();
    expectNoEvidence(check("verify", file, [comment({ body: renderBody(file), login: "mallory" })]));
  });

  test("没有任何评论时退出码 3", () => {
    const { file } = makeBarrier();
    expectNoEvidence(check("verify", file, []));
  });

  test("不含 barrier nonce 的审批人评论不构成绑定（退出码 3）", () => {
    const { file } = makeBarrier();
    expectNoEvidence(check("verify", file, [comment({ body: "批准" })]));
  });

  test("另一 barrier 的评论（nonce 不同）不构成绑定（退出码 3）", () => {
    const first = makeBarrier();
    const second = makeBarrier();
    expectNoEvidence(check("verify", first.file, [comment({ body: renderBody(second.file) })]));
  });

  test("barrier 不属于本运行（run id 不同）时退出码 1", () => {
    const { file } = makeBarrier();
    const r = check("verify", file, [], { env: { GITHUB_RUN_ID: "999" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not belong to this run");
  });

  test("请求目标与 barrier 目标不同时退出码 1", () => {
    const { file } = makeBarrier();
    const r = check("verify", file, [], { target: OTHER });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is not the requested target");
  });

  test("审批人列表为空时 fail closed（退出码 1）", () => {
    const { file } = makeBarrier();
    const r = check("verify", file, [comment({ body: renderBody(file) })], { approvers: " , " });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("approver list is empty");
  });

  test("wait：证据已存在时立即通过", () => {
    const { file } = makeBarrier();
    const r = check("wait", file, [comment({ body: renderBody(file) })], {}, ["--timeout", "5", "--interval", "1"]);
    expect(r.code).toBe(0);
    expect(r.status).toBe("ok");
  });

  test("wait：超时仍无证据时退出码 3", () => {
    const { file } = makeBarrier();
    const r = check("wait", file, [], {}, ["--timeout", "0", "--interval", "1"]);
    expectNoEvidence(r);
    expect(String(r.reason)).toContain("timed out after 0s");
  });

  test("wait：绑定评论不合格时立即停止（退出码 2，不等待超时）", () => {
    const { file } = makeBarrier();
    const body = tamper(renderBody(file), `origin_sha: ${TARGET}`, `origin_sha: ${OTHER}`);
    expectRefused(check("wait", file, [comment({ body })], {}, ["--timeout", "1200", "--interval", "30"]), "origin runs");
  });
});

describe("post：运营发表证据并回读校验", () => {
  test("origin 与 barrier 目标不同时发表前即拒绝（不调用 POST）", () => {
    const { file } = makeBarrier();
    const stub = ghStub([]);
    const run = runPy(
      [
        "post",
        "--barrier",
        file,
        "--origin-sha",
        OTHER,
        "--origin-verified-at",
        iso(SAMPLE_AT),
        "--ops-task-id",
        "ops-task-42",
        "--fa-audit-ref",
        FA_REF,
        "--pr",
        PR,
        "--approvers",
        APPROVER,
        "--approval-ref",
        FA_REF,
      ],
      stub.env,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("do not post");
    const calls = existsSync(stub.calls) ? readFileSync(stub.calls, "utf8") : "";
    expect(calls).not.toContain("POST");
  });

  test("发表后回读通过：返回评论 id，且发表的正文与 render 一致", () => {
    const { file } = makeBarrier();
    const body = renderBody(file);
    const stub = ghStub([comment({ id: 42, body })]);
    const run = runPy(
      [
        "post",
        "--barrier",
        file,
        "--origin-sha",
        TARGET,
        "--origin-verified-at",
        iso(SAMPLE_AT),
        "--ops-task-id",
        "ops-task-42",
        "--fa-audit-ref",
        FA_REF,
        "--pr",
        PR,
        "--approvers",
        APPROVER,
        "--approval-ref",
        FA_REF,
      ],
      stub.env,
    );
    const r = outcome(run);
    expect(r.code).toBe(0);
    expect(r.status).toBe("ok");
    expect(r.comment_id).toBe(42);
    expect(JSON.parse(readFileSync(stub.posted, "utf8")).body).toBe(body);
  });

  test("发表后回读不到绑定评论时退出码 3，并给出评论 id", () => {
    const { file } = makeBarrier();
    const stub = ghStub([]);
    const r = outcome(
      runPy(
        [
          "post",
          "--barrier",
          file,
          "--origin-sha",
          TARGET,
          "--origin-verified-at",
          iso(SAMPLE_AT),
          "--ops-task-id",
          "ops-task-42",
          "--fa-audit-ref",
          FA_REF,
          "--pr",
          PR,
          "--approvers",
          APPROVER,
          "--approval-ref",
          FA_REF,
        ],
        stub.env,
      ),
    );
    expectNoEvidence(r);
    expect(r.comment_id).toBe(42);
  });
});
