import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AC04：派发运行回执（origin-verification.py receipt）的纯判定与有界轮询测试。
 *
 * 全部经 fake gh 执行：只服务 GET repos/.../actions/runs/<id>/attempts/<n>[/jobs]，记录每次调用，
 * 任何写入形态的参数或其它端点都会失败。从不访问 GitHub，也不派发工作流。
 */

const SCRIPT = join(import.meta.dir, "../../../scripts/deploy/origin-verification.py");
const REPO = "MainListActivity/surreal_ck";
const RUN_ID = "987654321";
const ATTEMPT = "1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REF = "main";
const WORKFLOW = ".github/workflows/deploy-origin.yml";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_GH_DIR/gh.log"
if [ "\${1:-}" != "api" ]; then exit 64; fi
endpoint="$2"
for a in "$@"; do
  case "$a" in
    -X|--method|-f|-F|--field|--input|--raw-field) echo "write-like flag: $a" >> "$FAKE_GH_DIR/gh.log"; exit 64 ;;
  esac
done
case "$endpoint" in
  repos/*/actions/runs/*/attempts/*/jobs*) kind=jobs ;;
  repos/*/actions/runs/*/attempts/*) kind=run ;;
  *) echo "unexpected endpoint: $endpoint" >> "$FAKE_GH_DIR/gh.log"; exit 64 ;;
esac
n=$(cat "$FAKE_GH_DIR/$kind.count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_GH_DIR/$kind.count"
if [ -f "$FAKE_GH_DIR/$kind.seq" ]; then
  total=$(wc -l < "$FAKE_GH_DIR/$kind.seq" | tr -d ' ')
  line=$n
  if [ "$line" -gt "$total" ]; then line=$total; fi
  file=$(sed -n "\${line}p" "$FAKE_GH_DIR/$kind.seq")
else
  file="$kind.json"
fi
if [ "$file" = "__fail__" ]; then echo "HTTP 502" >&2; exit 1; fi
cat "$FAKE_GH_DIR/$file"
`;

type Seq = Array<unknown | "__fail__">;

function makeFixture(opts: { run?: unknown; jobs?: unknown; runSeq?: Seq; jobsSeq?: Seq }) {
  const dir = mkdtempSync(join(tmpdir(), "origin-receipt-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  if (opts.run !== undefined) writeFileSync(join(dir, "run.json"), JSON.stringify(opts.run));
  if (opts.jobs !== undefined) writeFileSync(join(dir, "jobs.json"), JSON.stringify(opts.jobs));
  const writeSeq = (kind: "run" | "jobs", seq: Seq | undefined) => {
    if (!seq) return;
    const names = seq.map((entry, i) => {
      if (entry === "__fail__") return "__fail__";
      const name = `${kind}-${i}.json`;
      writeFileSync(join(dir, name), typeof entry === "string" ? entry : JSON.stringify(entry));
      return name;
    });
    writeFileSync(join(dir, `${kind}.seq`), names.join("\n") + "\n");
  };
  writeSeq("run", opts.runSeq);
  writeSeq("jobs", opts.jobsSeq);
  return { dir, bin };
}

function goodRun(over: Record<string, unknown> = {}) {
  return {
    id: Number(RUN_ID),
    run_attempt: 1,
    head_sha: SHA,
    head_branch: REF,
    event: "workflow_dispatch",
    path: WORKFLOW,
    status: "completed",
    conclusion: "success",
    ...over,
  };
}

function goodJobs(over: Record<string, unknown> = {}) {
  return {
    total_count: 1,
    jobs: [{ name: "deploy", status: "completed", conclusion: "success" }],
    ...over,
  };
}

function baseArgs(extra: string[] = [], over: Partial<Record<"run-id" | "attempt" | "sha" | "ref" | "workflow-path", string>> = {}) {
  const v = {
    "run-id": RUN_ID,
    attempt: ATTEMPT,
    sha: SHA,
    ref: REF,
    "workflow-path": WORKFLOW,
    ...over,
  };
  return [
    "receipt",
    "--repo", REPO,
    "--run-id", v["run-id"],
    "--attempt", v.attempt,
    "--sha", v.sha,
    "--ref", v.ref,
    "--workflow-path", v["workflow-path"],
    ...extra,
  ];
}

function runReceipt(fx: { dir: string; bin: string }, args: string[]) {
  const proc = Bun.spawnSync(["python3", SCRIPT, ...args], {
    env: { PATH: `${fx.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_GH_DIR: fx.dir },
    timeout: 60_000,
  });
  const stdout = proc.stdout.toString();
  const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let payload: { status?: string; reason?: string } = {};
  try {
    payload = JSON.parse(last);
  } catch {
    payload = {};
  }
  return { code: proc.exitCode ?? -1, stdout, stderr: proc.stderr.toString(), payload };
}

function ghLog(fx: { dir: string }): string[] {
  const path = join(fx.dir, "gh.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

describe("receipt：派发运行回执的判定（经 fake gh，只读）", () => {
  test("通过：运行 completed、结论 success、作业完整且全部 success → 退出 0", () => {
    const fx = makeFixture({ run: goodRun(), jobs: goodJobs() });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(0);
    expect(r.payload.status).toBe("ok");
    const calls = ghLog(fx);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith(`gh api repos/${REPO}/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`))).toBe(true);
  });

  test("action_required 且无作业 → 退出 2（未启动，按失败处理）", () => {
    const fx = makeFixture({
      run: goodRun({ status: "completed", conclusion: "action_required" }),
      jobs: { total_count: 0, jobs: [] },
    });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(2);
    expect(r.payload.status).toBe("refused");
    expect(r.payload.reason).toContain("action_required");
  });

  test("历史样本：运行 39153839203（workflow_dispatch、deploy-origin.yml、main、50663e3a、action_required、0 作业）→ 退出 2", () => {
    // 字段取自 GitHub 只读核对的同一运行尝试 1（2026-10-20）；不发起派发，只作为真实负例的形状。
    const sha = "50663e3a6c89ee9a61a25eddf334a682c445bee1";
    const fx = makeFixture({
      run: {
        id: 39153839203,
        run_attempt: 1,
        head_sha: sha,
        head_branch: "main",
        event: "workflow_dispatch",
        path: ".github/workflows/deploy-origin.yml",
        status: "completed",
        conclusion: "action_required",
      },
      jobs: { total_count: 0, jobs: [] },
    });
    const r = runReceipt(fx, baseArgs([], { "run-id": "39153839203", sha, "workflow-path": ".github/workflows/deploy-origin.yml" }));
    expect(r.code).toBe(2);
    expect(r.payload.status).toBe("refused");
    expect(r.payload.reason).toContain("action_required");
  });

  test("action_required 即使带作业也不是通过 → 退出 2", () => {
    const fx = makeFixture({
      run: goodRun({ conclusion: "action_required" }),
      jobs: goodJobs(),
    });
    expect(runReceipt(fx, baseArgs()).code).toBe(2);
  });

  test("排队中（queued、无结论）且只查一次 → 退出 3 pending：既不是失败也不是通过", () => {
    const fx = makeFixture({ run: goodRun({ status: "queued", conclusion: null }), jobs: { total_count: 0, jobs: [] } });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("pending");
  });

  test("进行中后转为成功：有界轮询内判定通过 → 退出 0（进行中不被误判）", () => {
    const fx = makeFixture({
      runSeq: [goodRun({ status: "in_progress", conclusion: null }), goodRun()],
      jobsSeq: [{ total_count: 1, jobs: [{ name: "deploy", status: "in_progress", conclusion: null }] }, goodJobs()],
    });
    const r = runReceipt(fx, baseArgs(["--timeout", "5", "--interval", "1"]));
    expect(r.code).toBe(0);
    expect(r.payload.status).toBe("ok");
    expect(ghLog(fx).length).toBeGreaterThanOrEqual(4);
  });

  test("结论 failure → 退出 2", () => {
    const fx = makeFixture({ run: goodRun({ conclusion: "failure" }), jobs: goodJobs() });
    expect(runReceipt(fx, baseArgs()).code).toBe(2);
  });

  test("结论 cancelled → 退出 2", () => {
    const fx = makeFixture({ run: goodRun({ conclusion: "cancelled" }), jobs: goodJobs() });
    expect(runReceipt(fx, baseArgs()).code).toBe(2);
  });

  test("绑定逐项精确：运行号、尝试号、提交、分支、事件、工作流路径任一不符 → 退出 2", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["运行号不符", { id: 111 }],
      ["尝试号不符（重跑后的尝试）", { run_attempt: 2 }],
      ["提交不符", { head_sha: "fedcba9876543210fedcba9876543210fedcba98" }],
      ["分支不符", { head_branch: "release" }],
      ["事件不是 workflow_dispatch", { event: "push" }],
      ["工作流路径不符", { path: ".github/workflows/other.yml" }],
    ];
    for (const [name, over] of cases) {
      const fx = makeFixture({ run: goodRun(over), jobs: goodJobs() });
      const r = runReceipt(fx, baseArgs());
      expect(r.code, name).toBe(2);
      expect(r.payload.status, name).toBe("refused");
    }
  });

  test("请求的尝试号与运行给出的尝试号不符 → 退出 2（不得借用其它尝试的结论）", () => {
    const fx = makeFixture({ run: goodRun({ run_attempt: 3 }), jobs: goodJobs() });
    expect(runReceipt(fx, baseArgs([], { attempt: "2" })).code).toBe(2);
  });

  test("接口返回 502 且只查一次 → 退出 3 unknown：API 失败不是通过", () => {
    const fx = makeFixture({ runSeq: ["__fail__"], jobs: goodJobs() });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("unknown");
    expect(r.payload.reason).toContain("transient GitHub API error");
  });

  test("接口持续失败且预算耗尽 → 退出 3 unknown，不通过", () => {
    const fx = makeFixture({ runSeq: ["__fail__"], jobs: goodJobs() });
    const r = runReceipt(fx, baseArgs(["--timeout", "2", "--interval", "1"]));
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("unknown");
    expect(r.payload.reason).toContain("no pass within 2s");
    expect(ghLog(fx).length).toBeLessThanOrEqual(12);
  });

  test("进行中永不结束 → 预算耗尽退出 3 pending，调用次数有界（超时不算通过）", () => {
    const fx = makeFixture({
      run: goodRun({ status: "in_progress", conclusion: null }),
      jobs: { total_count: 1, jobs: [{ name: "deploy", status: "in_progress", conclusion: null }] },
    });
    const r = runReceipt(fx, baseArgs(["--timeout", "2", "--interval", "1"]));
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("pending");
    expect(r.payload.reason).toContain("no pass within 2s");
    const calls = ghLog(fx);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  test("接口临时失败后恢复：预算内重试并判定通过 → 退出 0", () => {
    const fx = makeFixture({
      runSeq: ["__fail__", goodRun()],
      jobsSeq: [goodJobs()],
    });
    const r = runReceipt(fx, baseArgs(["--timeout", "5", "--interval", "1"]));
    expect(r.code).toBe(0);
  });

  test("接口返回非 JSON → 退出 3 unknown，不通过", () => {
    const fx = makeFixture({ runSeq: ["<html>not json</html>"], jobs: goodJobs() });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("unknown");
  });

  test("未知运行状态 → 退出 3 unknown，不通过", () => {
    const fx = makeFixture({ run: goodRun({ status: "frozen" }), jobs: goodJobs() });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("unknown");
  });

  test("运行 completed 且 success 但作业列表不完整 → 退出 3 unknown，不通过", () => {
    const fx = makeFixture({ run: goodRun(), jobs: { total_count: 3, jobs: [{ name: "deploy", status: "completed", conclusion: "success" }] } });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(3);
    expect(r.payload.reason).toContain("incomplete");
  });

  test("运行 success 但无作业 → 退出 3 unknown：无法证明确实执行过", () => {
    const fx = makeFixture({ run: goodRun(), jobs: { total_count: 0, jobs: [] } });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("unknown");
  });

  test("作业仍在进行中 → 退出 3 pending，不通过", () => {
    const fx = makeFixture({ run: goodRun(), jobs: { total_count: 1, jobs: [{ name: "deploy", status: "in_progress", conclusion: null }] } });
    const r = runReceipt(fx, baseArgs());
    expect(r.code).toBe(3);
    expect(r.payload.status).toBe("pending");
  });

  test("作业失败的运行（结论被篡改为 success 时）仍被逐作业拒绝 → 退出 2", () => {
    const fx = makeFixture({ run: goodRun(), jobs: { total_count: 1, jobs: [{ name: "deploy", status: "completed", conclusion: "failure" }] } });
    expect(runReceipt(fx, baseArgs()).code).toBe(2);
  });

  test("指定的作业名缺失 → 退出 2", () => {
    const fx = makeFixture({ run: goodRun(), jobs: goodJobs() });
    const r = runReceipt(fx, baseArgs(["--job-name", "deploy-origin"]));
    expect(r.code).toBe(2);
    expect(r.payload.reason).toContain("deploy-origin");
  });

  test("指定的作业名存在且成功 → 退出 0", () => {
    const fx = makeFixture({ run: goodRun(), jobs: goodJobs() });
    expect(runReceipt(fx, baseArgs(["--job-name", "deploy"])).code).toBe(0);
  });
});

describe("receipt：参数校验先于任何接口调用", () => {
  const cases: Array<[string, string[]]> = [
    ["sha 大写", baseArgs([], { sha: SHA.toUpperCase() })],
    ["sha 长度 39", baseArgs([], { sha: SHA.slice(0, 39) })],
    ["attempt 为 0", baseArgs([], { attempt: "0" })],
    ["attempt 带前导零", baseArgs([], { attempt: "01" })],
    ["run-id 非数字", baseArgs([], { "run-id": "12a" })],
    ["工作流路径非法", baseArgs([], { "workflow-path": "../deploy.yml" })],
    ["interval 为 0", baseArgs(["--interval", "0"])],
    ["timeout 为负", baseArgs(["--timeout", "-1"])],
  ];
  for (const [name, args] of cases) {
    test(`${name} → 退出 1，且未调用 gh`, () => {
      const fx = makeFixture({ run: goodRun(), jobs: goodJobs() });
      const r = runReceipt(fx, args);
      expect(r.code).toBe(1);
      expect(ghLog(fx)).toEqual([]);
    });
  }
});

describe("receipt：不得发起派发或写入请求", () => {
  test("所有 gh 调用都是 attempts 下的 GET 读取，无写入参数或其它端点", () => {
    const fx = makeFixture({ run: goodRun(), jobs: goodJobs() });
    runReceipt(fx, baseArgs(["--timeout", "0"]));
    const calls = ghLog(fx);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/^gh api repos\/[^ ]+\/actions\/runs\/\d+\/attempts\/\d+(\/jobs\?per_page=\d+)?$/);
      expect(call).not.toMatch(/write-like|workflow|dispatch|POST|PUT|PATCH|DELETE/);
    }
  });
});
