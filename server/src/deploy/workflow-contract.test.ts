import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 发布工作流契约测试：解析 .github/workflows 下的 YAML，断言 origin 发布、
 * 手动入口、Production 编排与前端定向恢复的结构性约束。
 */

type Doc = Record<string, any>;
type Step = Record<string, any>;

const WORKFLOWS = join(import.meta.dir, "../../../.github/workflows");

function load(file: string): Doc {
  return Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Doc;
}

function onKeys(doc: Doc): string[] {
  return Object.keys(doc.on ?? {});
}

function jobsOf(doc: Doc): Array<[string, Doc]> {
  return Object.entries(doc.jobs ?? {}) as Array<[string, Doc]>;
}

function stepsOf(doc: Doc): Array<[string, Doc, Step]> {
  const out: Array<[string, Doc, Step]> = [];
  for (const [jobName, job] of jobsOf(doc)) {
    for (const step of job.steps ?? []) out.push([jobName, job, step]);
  }
  return out;
}

function runsOf(doc: Doc): string[] {
  return stepsOf(doc)
    .map(([, , step]) => step.run)
    .filter((run): run is string => typeof run === "string");
}

function usesOf(doc: Doc): string[] {
  const uses: string[] = [];
  for (const [, job] of jobsOf(doc)) {
    if (typeof job.uses === "string") uses.push(job.uses);
  }
  for (const [, , step] of stepsOf(doc)) {
    if (typeof step.uses === "string") uses.push(step.uses);
  }
  return uses;
}

function needsOf(job: Doc): string[] {
  return [job.needs ?? []].flat().filter((n): n is string => typeof n === "string");
}

/** 以 workflow 中 probe 作业的 run 原文执行 hold_seconds 校验；返回退出码。 */
function runHoldCheck(run: string, holdSeconds: string): number | null {
  const proc = Bun.spawnSync(["bash", "-c", run], {
    env: { ...process.env, PROBE_SHA: "a".repeat(40), HOLD_SECONDS: holdSeconds },
  });
  return proc.exitCode;
}

/** 在指定目录以 set -euo pipefail 执行一段 run 原文；返回退出码。 */
function runIn(cwd: string, script: string): number | null {
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${script}`], { cwd });
  return proc.exitCode;
}

/** 在指定目录以 set -euo pipefail 执行一段 run 原文，注入环境变量；返回退出码与标准输出。 */
function runCapture(cwd: string, script: string, env: Record<string, string>): { code: number | null; stdout: string } {
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${script}`], { cwd, env: { ...process.env, ...env } });
  return { code: proc.exitCode, stdout: proc.stdout.toString() };
}

const FILES = [
  "deploy-origin.yml",
  "deploy-origin-manual.yml",
  "deploy-production.yml",
  "release-frontend-recovery.yml",
] as const;

describe("deploy-origin.yml（workflow_call 发布核心）", () => {
  const doc = load("deploy-origin.yml");

  test("只能被调用：on 仅包含 workflow_call，不含 workflow_dispatch", () => {
    expect(onKeys(doc)).toEqual(["workflow_call"]);
  });

  test("workflow_call 的 sha 与 approval_ref 均为必填", () => {
    const inputs = doc.on.workflow_call.inputs;
    expect(inputs.sha?.required).toBe(true);
    expect(inputs.approval_ref?.required).toBe(true);
  });

  test("顶层 permissions 为空对象", () => {
    expect(doc.permissions).toEqual({});
  });

  test("job origin 的 environment.name 为 production", () => {
    const origin = doc.jobs.origin;
    expect(origin.environment?.name).toBe("production");
  });

  test("job origin 的 concurrency：group 为 production-origin 且 cancel-in-progress 为 false", () => {
    const concurrency = doc.jobs.origin.concurrency;
    expect(concurrency?.group).toBe("production-origin");
    expect(concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("任何 run 脚本都不得以 ssh origin 单会话激活", () => {
    for (const run of runsOf(doc)) {
      expect(run).not.toMatch(/\bssh\s+origin\b/);
    }
  });

  test("存在调用 origin-release-ci.sh 的步骤", () => {
    const calls = runsOf(doc).filter((run) => run.includes("origin-release-ci.sh"));
    expect(calls.length).toBeGreaterThan(0);
  });

  test("ALL_SECRETS（toJSON(secrets)）只出现在 Build release bundle and env additions 步骤中", () => {
    const withSecrets = stepsOf(doc).filter(([, , step]) => JSON.stringify(step).includes("toJSON(secrets)"));
    expect(withSecrets.length).toBe(1);
    expect(withSecrets[0]?.[2].name).toBe("Build release bundle and env additions");
  });

  test("上传步骤与激活步骤存在，且其 run 不含 systemctl、--launch 或 --recover", () => {
    const upload = stepsOf(doc).find(([, , step]) => String(step.name).startsWith("Upload release bundle"));
    const activate = stepsOf(doc).find(([, , step]) => String(step.name).startsWith("Activate release on origin"));
    expect(upload).toBeDefined();
    expect(activate).toBeDefined();
    for (const step of [upload![2], activate![2]]) {
      const run = String(step.run ?? "");
      expect(run).not.toContain("systemctl");
      expect(run).not.toContain("--launch");
      expect(run).not.toContain("--recover");
    }
  });

  test("上传步骤注册失败清理（trap 先于第一次 scp），且清理的是暂存件路径", () => {
    const upload = stepsOf(doc).find(([, , step]) => String(step.name).startsWith("Upload release bundle"));
    const run = String(upload![2].run ?? "");
    expect(run).toContain("trap cleanup_staged EXIT");
    expect(run.indexOf("trap cleanup_staged EXIT")).toBeLessThan(run.indexOf("scp -q env.additions"));
    expect(run).toContain("rm -f /tmp/surreal_ck-env-");
  });

  test("所有非本地 uses 均为 owner/repo@<40 位小写 hex>", () => {
    for (const use of usesOf(doc)) {
      if (use.startsWith("./")) continue;
      expect(use).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/);
    }
  });

  test("顶层不设 concurrency：被 Deploy production 与手动入口调用时，不得在被调用工作流上叠加顶层发布锁（嵌套死锁）", () => {
    expect(doc.concurrency).toBeUndefined();
  });
});

describe("deploy-origin-manual.yml（手动入口）", () => {
  const doc = load("deploy-origin-manual.yml");

  test("on 仅包含 workflow_dispatch", () => {
    expect(onKeys(doc)).toEqual(["workflow_dispatch"]);
  });

  test("inputs 含 sha 与 approval_ref", () => {
    const inputs = doc.on.workflow_dispatch.inputs ?? {};
    expect(inputs).toHaveProperty("sha");
    expect(inputs).toHaveProperty("approval_ref");
  });

  test("顶层 concurrency 为 production-release 且 cancel-in-progress 为 false", () => {
    expect(doc.concurrency?.group).toBe("production-release");
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("inputs 含 dry_run（boolean，默认 false）与 hold_seconds（string，默认 \"0\"）", () => {
    const inputs = doc.on.workflow_dispatch.inputs ?? {};
    expect(inputs.dry_run?.type).toBe("boolean");
    expect(inputs.dry_run?.default).toBe(false);
    expect(inputs.hold_seconds?.type).toBe("string");
    expect(inputs.hold_seconds?.default).toBe("0");
  });

  test("probe 只在 dry_run 时运行，不使用 environment 也不引用 secrets；origin 排除 dry_run", () => {
    const probe = doc.jobs.probe;
    expect(String(probe.if ?? "")).toContain("inputs.dry_run");
    expect(probe.environment).toBeUndefined();
    expect(JSON.stringify(probe)).not.toContain("secrets.");
    expect(String(doc.jobs.origin.if)).toContain("!inputs.dry_run");
  });

  test("hold_seconds 在 sleep 之前校验：0 放行，负数、非整数与超过 900 均拒绝", () => {
    const run = String(doc.jobs.probe.steps[0].run ?? "");
    expect(run.indexOf("-le 900")).toBeGreaterThan(-1);
    expect(run.indexOf("-le 900")).toBeLessThan(run.indexOf("sleep "));
    expect(runHoldCheck(run, "0")).toBe(0);
    expect(runHoldCheck(run, "901")).not.toBe(0);
    expect(runHoldCheck(run, "-1")).not.toBe(0);
    expect(runHoldCheck(run, "abc")).not.toBe(0);
  });

  test("job origin 的 if 限定 refs/heads/main", () => {
    expect(String(doc.jobs.origin.if)).toContain("refs/heads/main");
  });

  test("job origin 复用 ./.github/workflows/deploy-origin.yml", () => {
    expect(doc.jobs.origin.uses).toBe("./.github/workflows/deploy-origin.yml");
  });

  test("job origin 的 with 含 sha 与 approval_ref", () => {
    const withBlock = doc.jobs.origin.with ?? {};
    expect(withBlock).toHaveProperty("sha");
    expect(withBlock).toHaveProperty("approval_ref");
  });

  test("所有非本地 uses 均为 owner/repo@<40 位小写 hex>", () => {
    for (const use of usesOf(doc)) {
      if (use.startsWith("./")) continue;
      expect(use).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/);
    }
  });
});

describe("deploy-production.yml（自动发布编排）", () => {
  const doc = load("deploy-production.yml");

  test("job origin 调用 ./.github/workflows/deploy-origin.yml 且 with 含 approval_ref", () => {
    expect(doc.jobs.origin.uses).toBe("./.github/workflows/deploy-origin.yml");
    expect(doc.jobs.origin.with).toHaveProperty("approval_ref");
  });

  test("job deploy 的 needs 包含 origin（保持原有行为）", () => {
    expect(needsOf(doc.jobs.deploy)).toContain("origin");
  });

  test("job precheck 仍然存在", () => {
    expect(doc.jobs.precheck).toBeDefined();
  });

  test("所有非本地 uses 均为 owner/repo@<40 位小写 hex>", () => {
    for (const use of usesOf(doc)) {
      if (use.startsWith("./")) continue;
      expect(use).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/);
    }
  });
});

describe("release-frontend-recovery.yml（前端定向恢复：锁内 barrier、绑定证据、生产写入前复核）", () => {
  const doc = load("release-frontend-recovery.yml");
  const deploySteps: Step[] = doc.jobs.deploy.steps ?? [];
  const deployNames = deploySteps.map((step) => String(step.name ?? ""));
  const indexOfStep = (prefix: string) => deployNames.findIndex((name) => name.startsWith(prefix));
  const stepNamed = (prefix: string): Step => {
    const index = indexOfStep(prefix);
    expect(index).toBeGreaterThanOrEqual(0);
    return deploySteps[index] as Step;
  };
  // 读取 GitHub 的步骤（唯一允许携带 GH_TOKEN 的步骤）。
  const GH_TOKEN_STEPS = [
    "Run frontend recovery gate",
    "Verify the release commit passed CI",
    "Wait for operator origin evidence",
    "Re-verify origin evidence and origin health",
  ];
  // 允许接触 secrets 的步骤：配置校验与三个 Cloudflare 写入步骤。
  const SECRET_STEPS = [
    "Validate production configuration",
    "Deploy Hono edge proxy",
    "Deploy application",
    "Deploy marketing site",
  ];

  test("on 仅包含 workflow_dispatch", () => {
    expect(onKeys(doc)).toEqual(["workflow_dispatch"]);
  });

  test("inputs 恰为 sha、evidence_pr、approval_ref、dry_run、hold_seconds；不再接受 origin_sha 或 origin_verified_at", () => {
    const inputs = doc.on.workflow_dispatch.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(["approval_ref", "dry_run", "evidence_pr", "hold_seconds", "sha"]);
    for (const name of ["sha", "evidence_pr", "approval_ref"]) {
      expect(inputs[name]?.required).toBe(true);
    }
    expect(JSON.stringify(doc)).not.toMatch(/origin_sha|origin_verified_at|ORIGIN_SHA|ORIGIN_VERIFIED_AT/);
  });

  test("inputs 含 dry_run（boolean，默认 false）与 hold_seconds（string，默认 \"0\"）", () => {
    const inputs = doc.on.workflow_dispatch.inputs ?? {};
    expect(inputs.dry_run?.type).toBe("boolean");
    expect(inputs.dry_run?.default).toBe(false);
    expect(inputs.hold_seconds?.type).toBe("string");
    expect(inputs.hold_seconds?.default).toBe("0");
  });

  test("顶层 permissions 为空对象；每个作业的权限只取 read", () => {
    expect(doc.permissions).toEqual({});
    for (const [, job] of jobsOf(doc)) {
      for (const value of Object.values(job.permissions ?? {})) {
        expect(value).toBe("read");
      }
    }
  });

  test("顶层 concurrency 为 production-release 且 cancel-in-progress 为 false", () => {
    expect(doc.concurrency?.group).toBe("production-release");
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("probe 只在 dry_run 时运行，不使用 environment 也不引用 secrets", () => {
    const probe = doc.jobs.probe;
    expect(probe).toBeDefined();
    expect(String(probe.if ?? "")).toContain("inputs.dry_run");
    expect(probe.environment).toBeUndefined();
    expect(JSON.stringify(probe)).not.toContain("secrets.");
  });

  test("hold_seconds 在 sleep 之前校验：0 放行，负数、非整数与超过 900 均拒绝", () => {
    const run = String(doc.jobs.probe.steps[0].run ?? "");
    expect(run.indexOf("-le 900")).toBeGreaterThan(-1);
    expect(run.indexOf("-le 900")).toBeLessThan(run.indexOf("sleep "));
    expect(runHoldCheck(run, "0")).toBe(0);
    expect(runHoldCheck(run, "901")).not.toBe(0);
    expect(runHoldCheck(run, "-1")).not.toBe(0);
    expect(runHoldCheck(run, "abc")).not.toBe(0);
  });

  test("validate 与 deploy 两个 job 都有 if 且包含 refs/heads/main，并排除 dry_run", () => {
    for (const name of ["validate", "deploy"]) {
      const job = doc.jobs[name];
      expect(job).toBeDefined();
      expect(String(job.if ?? "")).toContain("refs/heads/main");
      expect(String(job.if ?? "")).toContain("!inputs.dry_run");
    }
  });

  test("validate 不使用 environment、不引用 secrets；只运行只读准入门禁", () => {
    const validate = doc.jobs.validate;
    expect(validate.environment).toBeUndefined();
    expect(JSON.stringify(validate)).not.toContain("secrets.");
    const gate = validate.steps.find((step: Step) => step.name === "Run frontend recovery gate");
    expect(String(gate?.run ?? "")).toBe("bash scripts/deploy/frontend-recovery-gate.sh");
  });

  test("deploy 依赖 validate，使用 production environment，超时不少于 45 分钟（20 分钟等待 + 构建 + 写入）", () => {
    expect(needsOf(doc.jobs.deploy)).toContain("validate");
    expect(doc.jobs.deploy.environment?.name).toBe("production");
    expect(doc.jobs.deploy["timeout-minutes"]).toBeGreaterThanOrEqual(45);
  });

  test("deploy 的权限包含 issues 与 pull-requests 读取（证据评论与 PR 读取），不含写权限", () => {
    expect(doc.jobs.deploy.permissions).toEqual({
      checks: "read",
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
  });

  test("作业级 env 不含 GH_TOKEN 或 secrets：令牌与凭证只放在需要它们的步骤", () => {
    for (const name of ["validate", "deploy"]) {
      const env = JSON.stringify(doc.jobs[name].env ?? {});
      expect(env).not.toContain("GH_TOKEN");
      expect(env).not.toContain("secrets.");
    }
  });

  test("GH_TOKEN 只出现在读取 GitHub 的四个步骤中，且四个步骤都携带它", () => {
    const carriers = stepsOf(doc)
      .filter(([, , step]) => step.env?.GH_TOKEN !== undefined)
      .map(([, , step]) => String(step.name));
    for (const name of carriers) {
      expect(GH_TOKEN_STEPS.some((prefix) => name.startsWith(prefix))).toBe(true);
    }
    expect(carriers.length).toBe(GH_TOKEN_STEPS.length);
  });

  test("secrets 只出现在配置校验与三个 Cloudflare 写入步骤；barrier、wait、verify 不接触 secrets", () => {
    const withSecrets = stepsOf(doc)
      .filter(([, , step]) => JSON.stringify(step).includes("secrets."))
      .map(([, , step]) => String(step.name));
    expect(withSecrets.length).toBeGreaterThan(0);
    for (const name of withSecrets) {
      expect(SECRET_STEPS.some((prefix) => name.startsWith(prefix))).toBe(true);
    }
    for (const prefix of ["Generate the in-lock origin barrier", "Wait for operator origin evidence", "Re-verify origin evidence"]) {
      expect(JSON.stringify(stepNamed(prefix))).not.toContain("secrets.");
    }
  });

  test("重跑被拒绝：deploy 在构建之前检查 GITHUB_RUN_ATTEMPT 必须为 1", () => {
    const refuse = stepNamed("Refuse reruns");
    expect(String(refuse.run ?? "")).toContain('"$GITHUB_RUN_ATTEMPT" != "1"');
    expect(indexOfStep("Refuse reruns")).toBeLessThan(indexOfStep("Build production sites"));
  });

  test("发布顺序：重跑检查 → Quality gate → 配置 → 根目录发布检出 → 构建 → tooling 检出 → barrier → wait → 复核 → 写入（edge、app、marketing）→ 验证", () => {
    const order = [
      "Refuse reruns",
      "Verify the release commit passed CI",
      "Validate production configuration",
      "Checkout the CI-approved commit",
      "Build production sites",
      "Checkout deploy tooling",
      "Generate the in-lock origin barrier",
      "Publish the origin barrier as a run artifact",
      "Wait for operator origin evidence",
      "Re-verify origin evidence",
      "Deploy Hono edge proxy",
      "Deploy application",
      "Deploy marketing site",
      "Verify production",
    ];
    const indices = order.map(indexOfStep);
    for (const index of indices) expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });

  test("构建与写入步骤在仓库根目录执行（与 deploy-production 相同布局）；barrier、wait、verify 只从 tooling 检出的 scripts/deploy 执行", () => {
    for (const prefix of ["Build production sites", "Install exact pnpm", "Deploy Hono edge proxy", "Deploy application", "Deploy marketing site"]) {
      expect(stepNamed(prefix)["working-directory"]).toBeUndefined();
    }
    for (const prefix of ["Generate the in-lock origin barrier", "Wait for operator origin evidence", "Re-verify origin evidence"]) {
      const step = stepNamed(prefix);
      expect(step["working-directory"]).toBeUndefined();
      expect(String(step.run ?? "")).toContain("tooling/scripts/deploy/origin-verification.py");
      expect(String(step.run ?? "")).not.toContain("release/");
    }
  });

  test("tooling 检出固定为 github.sha、只取 scripts/deploy 并放入 tooling 目录；release 检出固定为 RELEASE_SHA、位于根目录", () => {
    const tooling = stepNamed("Checkout deploy tooling");
    expect(tooling.with?.ref).toBe("${{ github.sha }}");
    expect(tooling.with?.["sparse-checkout"]).toBe("scripts/deploy");
    expect(tooling.with?.path).toBe("tooling");
    const release = stepNamed("Checkout the CI-approved commit");
    expect(release.with?.ref).toBe("${{ env.RELEASE_SHA }}");
    expect(release.with?.path).toBeUndefined();
    expect(release.with?.clean).toBe(false);
  });

  test("deploy 作业只有一次根目录检出（发布提交）；它先于 tooling 检出，tooling 在构建之后、barrier 之前检出", () => {
    // actions/checkout 在目标目录没有 .git 时会清空整个目录（clean 不影响这一点），之后的根目录检出会删除 tooling/。
    const rootCheckouts = deploySteps.filter(
      (step) => String(step.uses ?? "").startsWith("actions/checkout") && step.with?.path === undefined,
    );
    expect(rootCheckouts.map((step) => String(step.name))).toEqual(["Checkout the CI-approved commit"]);
    const toolingIndex = indexOfStep("Checkout deploy tooling");
    expect(indexOfStep("Checkout the CI-approved commit")).toBeLessThan(toolingIndex);
    expect(indexOfStep("Build production sites")).toBeLessThan(toolingIndex);
    expect(toolingIndex).toBeLessThan(indexOfStep("Generate the in-lock origin barrier"));
  });

  test("barrier 在构建之后生成，写入作业摘要并保存到 RUNNER_TEMP", () => {
    const run = String(stepNamed("Generate the in-lock origin barrier").run ?? "");
    expect(run).toContain("origin-verification.py barrier");
    expect(run).toContain("$RUNNER_TEMP/origin-barrier.json");
    expect(run).toContain("$GITHUB_STEP_SUMMARY");
    expect(indexOfStep("Build production sites")).toBeLessThan(indexOfStep("Generate the in-lock origin barrier"));
  });

  test("barrier 前校验 tooling 脚本：缺失时失败，存在时通过", () => {
    const run = String(stepNamed("Generate the in-lock origin barrier").run ?? "");
    const guard = run.slice(run.indexOf("test -f"), run.indexOf("python3 tooling/scripts/deploy/origin-verification.py barrier"));
    expect(guard).toContain("tooling/scripts/deploy/origin-verification.py");
    const dir = mkdtempSync(join(tmpdir(), "tooling-guard-"));
    try {
      expect(runIn(dir, guard)).not.toBe(0);
      mkdirSync(join(dir, "tooling/scripts/deploy"), { recursive: true });
      writeFileSync(join(dir, "tooling/scripts/deploy/origin-verification.py"), "");
      expect(runIn(dir, guard)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("barrier 写好后发出单行 notice（仅作业结束后可读，运行中的通道是 artifact）：位于 barrier 步骤内、wait 步骤之前", () => {
    const run = String(stepNamed("Generate the in-lock origin barrier").run ?? "");
    expect(run.split("\n").filter((line) => line.includes("::notice"))).toHaveLength(1);
    expect(run.indexOf("origin-verification.py barrier")).toBeLessThan(run.indexOf("::notice"));
    expect(indexOfStep("Generate the in-lock origin barrier")).toBeLessThan(indexOfStep("Wait for operator origin evidence"));
  });

  test("barrier notice 实际执行：文件存在时输出单行 workflow command，消息即 barrier JSON；文件缺失时失败", () => {
    const run = String(stepNamed("Generate the in-lock origin barrier").run ?? "");
    const lines = run.split("\n");
    const start = lines.findIndex((line) => line.includes("barrier_compact="));
    const end = lines.findIndex((line) => line.includes("::notice"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const notice = lines.slice(start, end + 1).join("\n");
    const barrier = {
      generated_at: "2026-10-19T06:14:52Z",
      nonce: "0123456789abcdef0123456789abcdef",
      repo: "MainListActivity/surreal_ck",
      run_attempt: "1",
      run_id: "39208693272",
      target_sha: "50663e3a6c89ee9a61a25eddf334a682c445bee1",
      tooling_sha: "0f26fbf919db18b68e98e66bab47ff60395ce7c1",
      workflow_ref: "MainListActivity/surreal_ck/.github/workflows/release-frontend-recovery.yml@refs/heads/main",
    };
    const dir = mkdtempSync(join(tmpdir(), "barrier-notice-"));
    try {
      expect(runCapture(dir, notice, { RUNNER_TEMP: dir }).code).not.toBe(0);
      writeFileSync(join(dir, "origin-barrier.json"), `${JSON.stringify(barrier, null, 2)}\n`);
      const result = runCapture(dir, notice, { RUNNER_TEMP: dir });
      expect(result.code).toBe(0);
      const prefix = "::notice title=origin-verification-barrier::";
      expect(result.stdout.startsWith(prefix)).toBe(true);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout.slice(prefix.length))).toEqual(barrier);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("barrier artifact 上传：位于 barrier 之后、wait 之前；名称含 run id 与 attempt；路径为 barrier 文件；缺失即失败；同名不覆盖；保留 1 天", () => {
    const upload = stepNamed("Publish the origin barrier as a run artifact");
    expect(indexOfStep("Publish the origin barrier as a run artifact")).toBeGreaterThan(indexOfStep("Generate the in-lock origin barrier"));
    expect(indexOfStep("Publish the origin barrier as a run artifact")).toBeLessThan(indexOfStep("Wait for operator origin evidence"));
    expect(upload.uses).toBe("actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f");
    expect(upload.with?.name).toBe("origin-barrier-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(upload.with?.path).toBe("${{ runner.temp }}/origin-barrier.json");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.overwrite).toBe(false);
    expect(upload.with?.["retention-days"]).toBe(1);
  });

  test("barrier artifact 上传步骤不携带 GH_TOKEN、secrets 或额外环境变量", () => {
    const upload = stepNamed("Publish the origin barrier as a run artifact");
    expect(JSON.stringify(upload)).not.toContain("GH_TOKEN");
    expect(JSON.stringify(upload)).not.toContain("secrets.");
    expect(upload.env).toBeUndefined();
  });

  test("barrier artifact 名称与 origin-verification.py 的 artifact_name 格式一致（origin-barrier-<run>-<attempt>）", () => {
    const script = readFileSync(join(import.meta.dir, "../../../scripts/deploy/origin-verification.py"), "utf8");
    expect(script).toContain('"origin-barrier-%s-%s"');
    expect(stepNamed("Publish the origin barrier as a run artifact").with?.name).toBe(
      "origin-barrier-${{ github.run_id }}-${{ github.run_attempt }}",
    );
  });

  test("CI 不读取 artifact：wait 与写入前的 verify 仍只以本作业生成的 barrier 文件为准", () => {
    for (const prefix of ["Wait for operator origin evidence", "Re-verify origin evidence"]) {
      expect(String(stepNamed(prefix).run ?? "")).not.toContain("artifact");
    }
  });

  test("wait 有界（--timeout 1200）且只读真实评论：不接受 --comments-json", () => {
    const run = String(stepNamed("Wait for operator origin evidence").run ?? "");
    expect(run).toContain("origin-verification.py wait");
    expect(run).toContain("--timeout 1200");
    expect(run).toContain('--approvers "$RELEASE_APPROVER_LOGINS"');
    expect(run).toContain('--approval-ref "$APPROVAL_REF"');
    expect(run).not.toContain("--comments-json");
  });

  test("写入前复核：先 verify 再检查 origin 健康，且只读真实评论", () => {
    const run = String(stepNamed("Re-verify origin evidence").run ?? "");
    expect(run).toContain("origin-verification.py verify");
    expect(run.indexOf("origin-verification.py verify")).toBeLessThan(run.indexOf("https://l.maplayer.top/health"));
    expect(run).not.toContain("--comments-json");
  });

  test("重跑检查与 wait/verify 使用的审批人与证据 PR 均来自输入，审批人列表取自仓库变量", () => {
    for (const name of ["validate", "deploy"]) {
      expect(doc.jobs[name].env?.RELEASE_APPROVER_LOGINS).toBe("${{ vars.RELEASE_APPROVER_LOGINS }}");
      expect(doc.jobs[name].env?.EVIDENCE_PR).toBe("${{ inputs.evidence_pr }}");
      expect(doc.jobs[name].env?.APPROVAL_REF).toBe("${{ inputs.approval_ref }}");
    }
  });

  test("固定版本：bun-version 1.3.11、pnpm@10.32.1、wrangler@4.135.0", () => {
    const steps = stepsOf(doc).map(([, , step]) => step);
    expect(steps.some((step) => step.with?.["bun-version"] === "1.3.11")).toBe(true);
    const runs = runsOf(doc).join("\n");
    expect(runs).toContain("pnpm@10.32.1");
    expect(runs).toContain("wrangler@4.135.0");
  });

  test("run 中校验 runtime-version.json 的 deploymentId 与 sha", () => {
    const runs = runsOf(doc).filter((run) => run.includes("runtime-version.json"));
    expect(runs.length).toBeGreaterThan(0);
    const joined = runs.join("\n");
    expect(joined).toMatch(/\.sha\s*==\s*\$sha/);
    expect(joined).toMatch(/\.deploymentId\s*==\s*\$dep/);
  });

  test("任何 run 或 uses 中都不出现 ssh、scp、origin-release、systemctl", () => {
    const text = [...runsOf(doc), ...usesOf(doc)];
    for (const item of text) {
      for (const forbidden of ["ssh", "scp", "origin-release", "systemctl"]) {
        expect(item).not.toContain(forbidden);
      }
    }
  });

  test("所有非本地 uses 均为 owner/repo@<40 位小写 hex>", () => {
    for (const use of usesOf(doc)) {
      if (use.startsWith("./")) continue;
      expect(use).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/);
    }
  });
});

describe("发布入口共用顶层发布锁（跨入口互斥的唯一机制）", () => {
  const ENTRIES = ["deploy-production.yml", "deploy-origin-manual.yml", "release-frontend-recovery.yml"] as const;

  test("Deploy production、Deploy origin (manual)、Frontend recovery 的顶层 concurrency 组名相同，均为 production-release 且不取消进行中的运行", () => {
    for (const file of ENTRIES) {
      const concurrency = load(file).concurrency;
      expect(concurrency?.group).toBe("production-release");
      expect(concurrency?.["cancel-in-progress"]).toBe(false);
    }
  });

  test("被调用的 deploy-origin.yml 不设顶层 concurrency，origin 作业保持 job 级 production-origin", () => {
    const doc = load("deploy-origin.yml");
    expect(doc.concurrency).toBeUndefined();
    expect(doc.jobs.origin.concurrency?.group).toBe("production-origin");
  });

  test("没有任何入口仍使用旧的顶层组名 production", () => {
    for (const file of FILES) {
      expect(load(file).concurrency?.group).not.toBe("production");
    }
  });
});

describe("frontend-barrier-artifact-probe.yml（无生产环境的只读探针：合成 barrier 的 artifact 通道）", () => {
  const PROBE_FILE = "frontend-barrier-artifact-probe.yml";
  const doc = load(PROBE_FILE);
  const text = readFileSync(join(WORKFLOWS, PROBE_FILE), "utf8");
  const steps: Step[] = doc.jobs.publish.steps ?? [];
  const find = (prefix: string): Step => {
    const step = steps.find((candidate) => String(candidate.name ?? "").startsWith(prefix));
    expect(step).toBeDefined();
    return step as Step;
  };

  test("on 为本线分支推送（路径受限）与 workflow_dispatch；hold_seconds 为字符串且默认 \"600\"", () => {
    expect(onKeys(doc).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(doc.on.push.branches).toEqual(["lane/c11970f4-frontend-barrier-artifact"]);
    expect(doc.on.push.paths).toEqual([
      ".github/workflows/frontend-barrier-artifact-probe.yml",
      "scripts/deploy/origin-verification.py",
    ]);
    const inputs = doc.on.workflow_dispatch.inputs ?? {};
    expect(inputs.hold_seconds?.type).toBe("string");
    expect(inputs.hold_seconds?.default).toBe("600");
  });

  test("顶层 permissions 为空对象；作业只取 contents 读取", () => {
    expect(doc.permissions).toEqual({});
    expect(doc.jobs.publish.permissions).toEqual({ contents: "read" });
  });

  test("不使用 environment，不引用 secrets，不加入 production-release 发布锁", () => {
    for (const [, job] of jobsOf(doc)) expect(job.environment).toBeUndefined();
    expect(text).not.toContain("secrets.");
    expect(doc.concurrency).toBeUndefined();
    expect(text).not.toContain("production-release");
  });

  test("不含任何生产写入或 origin 相关命令", () => {
    const surface = [...runsOf(doc), ...usesOf(doc)].join("\n");
    for (const forbidden of ["wrangler", "ssh", "scp", "systemctl", "origin-release", "deploy-origin", "CLOUDFLARE", "pages deploy"]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  test("所有非本地 uses 均为 owner/repo@<40 位小写 hex>", () => {
    for (const use of usesOf(doc)) {
      if (use.startsWith("./")) continue;
      expect(use).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/);
    }
  });

  test("hold 窗口在 sleep 之前校验：60 与 900 放行，0、59、901、1000、负数、非整数均拒绝", () => {
    const validate = find("Validate the hold window");
    const hold = find("Hold the job open");
    expect(steps.indexOf(validate)).toBeLessThan(steps.indexOf(hold));
    const run = String(validate.run ?? "");
    expect(runHoldCheck(run, "60")).toBe(0);
    expect(runHoldCheck(run, "900")).toBe(0);
    for (const bad of ["0", "59", "901", "1000", "-1", "abc"]) {
      expect(runHoldCheck(run, bad)).not.toBe(0);
    }
  });

  test("合成 barrier 与正式发布使用同一生成入口（origin-verification.py barrier）", () => {
    expect(String(find("Generate the synthetic barrier").run ?? "")).toContain("scripts/deploy/origin-verification.py barrier");
  });

  test("发布、回读、比较与保持运行的顺序：上传 → 回读 → cmp 逐字节比较 → sleep", () => {
    const upload = steps.indexOf(find("Publish the synthetic barrier as a run artifact"));
    const readback = steps.indexOf(find("Read the artifact back"));
    const compare = steps.indexOf(find("Compare the read-back bytes"));
    const hold = steps.indexOf(find("Hold the job open"));
    expect(upload).toBeLessThan(readback);
    expect(readback).toBeLessThan(compare);
    expect(compare).toBeLessThan(hold);
    expect(String(find("Compare the read-back bytes").run ?? "")).toContain("cmp ");
  });

  test("制品名称、保留与覆盖设置与正式发布完全一致（fetch 按同一名称取回）", () => {
    const releaseSteps = load("release-frontend-recovery.yml").jobs.deploy.steps as Step[];
    const releaseUpload = releaseSteps.find((step) =>
      String(step.name ?? "").startsWith("Publish the origin barrier as a run artifact"),
    );
    const probeUpload = find("Publish the synthetic barrier as a run artifact");
    expect(probeUpload.with?.name).toBe(releaseUpload?.with?.name);
    for (const key of ["if-no-files-found", "retention-days", "overwrite", "include-hidden-files"]) {
      expect(probeUpload.with?.[key]).toBe(releaseUpload?.with?.[key]);
    }
  });

  test("固定版本：upload-artifact 与正式发布相同（v7.0.0），download-artifact 为仓库已用的 v8.0.1", () => {
    expect(find("Publish the synthetic barrier as a run artifact").uses).toBe(
      "actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f",
    );
    expect(find("Read the artifact back").uses).toBe("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
  });
});

describe("工作流文件集合", () => {
  test("所有契约文件都可被解析且为对象", () => {
    for (const file of FILES) {
      expect(typeof load(file)).toBe("object");
    }
  });
});
