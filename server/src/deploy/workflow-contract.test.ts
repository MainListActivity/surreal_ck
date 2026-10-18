import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

const GATE = join(import.meta.dir, "../../../scripts/deploy/frontend-recovery-gate.sh");
const FRESHNESS_STEP = "Check origin verification is still fresh";

function freshnessRun(doc: Doc): string {
  const step = (doc.jobs.deploy.steps as Step[]).find((item) => item.name === FRESHNESS_STEP);
  expect(step).toBeDefined();
  return String(step?.run ?? "");
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

describe("release-frontend-recovery.yml（前端定向恢复，不触碰 origin）", () => {
  const doc = load("release-frontend-recovery.yml");

  test("on 仅包含 workflow_dispatch", () => {
    expect(onKeys(doc)).toEqual(["workflow_dispatch"]);
  });

  test("不存在任何 uses 指向 deploy-origin.yml", () => {
    expect(usesOf(doc).some((use) => use.includes("deploy-origin.yml"))).toBe(false);
  });

  test("任何 job 的 needs 都不包含 origin", () => {
    for (const [, job] of jobsOf(doc)) {
      expect(needsOf(job)).not.toContain("origin");
    }
  });

  test("任何 run 或 uses 中都不出现 ssh、scp、origin-release、systemctl", () => {
    const text = [...runsOf(doc), ...usesOf(doc)];
    for (const item of text) {
      for (const forbidden of ["ssh", "scp", "origin-release", "systemctl"]) {
        expect(item).not.toContain(forbidden);
      }
    }
  });

  test("deploy job 的 environment.name 为 production", () => {
    expect(doc.jobs.deploy.environment?.name).toBe("production");
  });

  test("validate 与 deploy 两个 job 都有 if 且包含 refs/heads/main", () => {
    for (const name of ["validate", "deploy"]) {
      const job = doc.jobs[name];
      expect(job).toBeDefined();
      expect(String(job.if ?? "")).toContain("refs/heads/main");
    }
  });

  test("validate 的 run 调用 frontend-recovery-gate.sh", () => {
    const validate = doc.jobs.validate;
    const runs = (validate.steps ?? []).map((step: Step) => String(step.run ?? ""));
    expect(runs.some((run: string) => run.includes("frontend-recovery-gate.sh"))).toBe(true);
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

  test("deploy job 的 env 含 ORIGIN_VERIFIED_AT，取自 workflow 输入", () => {
    expect(doc.jobs.deploy.env?.ORIGIN_VERIFIED_AT).toBe("${{ inputs.origin_verified_at }}");
  });

  test("deploy job 的核定时效步骤位于 CI 检查与任何 checkout 之前", () => {
    const steps: Step[] = doc.jobs.deploy.steps ?? [];
    const fresh = steps.findIndex((step) => step.name === FRESHNESS_STEP);
    const ci = steps.findIndex((step) => step.name === "Verify the release commit passed CI");
    const firstCheckout = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(fresh).toBeGreaterThanOrEqual(0);
    expect(fresh).toBeLessThan(ci);
    expect(fresh).toBeLessThan(firstCheckout);
  });

  test("时效步骤与 gate 同一窗口（-60 至 1800 秒），超时错误要求整条工作流重新派发", () => {
    const run = freshnessRun(doc);
    expect(run).toContain("ORIGIN_VERIFIED_AT");
    expect(run).toContain('"$age" -lt -60');
    expect(run).toContain('"$age" -gt 1800');
    expect(run).toContain("re-dispatch the whole Frontend recovery workflow");
    const gate = readFileSync(GATE, "utf8");
    expect(gate).toContain('"$age" -lt -60');
    expect(gate).toContain("MAX_ORIGIN_AGE_SEC:-1800");
  });

  test("时效步骤按 run 原文执行：窗口内放行；过期、未来或格式错误均失败并提示重新派发", () => {
    const run = freshnessRun(doc);
    const check = (verifiedAt: string) => {
      const proc = Bun.spawnSync(["bash", "-c", run], {
        env: { ...process.env, ORIGIN_VERIFIED_AT: verifiedAt },
      });
      return { code: proc.exitCode, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
    };
    const at = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

    expect(check(at(-30)).code).toBe(0);
    const stale = check(at(-1920));
    expect(stale.code).not.toBe(0);
    expect(stale.out).toContain("re-dispatch the whole Frontend recovery workflow");
    expect(check(at(300)).code).not.toBe(0);
    expect(check("2026-10-18 22:00:00").code).not.toBe(0);
  });

  test("顶层 permissions 为空对象", () => {
    expect(doc.permissions).toEqual({});
  });

  test("所有非本地 uses 均为 owner/repo@<40 位小写 hex>", () => {
    for (const use of usesOf(doc)) {
      if (use.startsWith("./")) continue;
      expect(use).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/);
    }
  });
});

describe("工作流文件集合", () => {
  test("所有契约文件都可被解析且为对象", () => {
    for (const file of FILES) {
      expect(typeof load(file)).toBe("object");
    }
  });
});
