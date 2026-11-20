import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("生产数据库维护脚本的隔离沙箱与失败恢复", () => {
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "../../../scripts/deploy/surrealdb-upgrade.test.py")], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("当前制品的未认证 SurrealKV 在任何生产 SSH 前拒绝 upgrade", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../.github/workflows/surrealdb-upgrade.yml")).text();
  const workflow = Bun.YAML.parse(text) as { jobs: { maintenance: { steps: Array<{ name: string; run?: string }> } } };
  const steps = workflow.jobs.maintenance.steps;
  const index = steps.findIndex((step) => step.name === "Fail-closed target engine and production contract preflight");
  expect(index).toBeGreaterThan(-1);
  expect(index).toBeLessThan(steps.findIndex((step) => step.name === "Configure SSH"));
  const directory = await mkdtemp(join(tmpdir(), "surreal-preflight-"));
  try {
    const result = Bun.spawnSync(["bash", "-c", `
      docker() { return 0; }
      curl() { if [[ "$*" == *capabilities* ]]; then printf '%s' "$CAPABILITY_FIXTURE"; fi; }
      ssh() { printf 'SSH_REACHED'; }
      ${steps[index]!.run!}
      ssh must-not-run
    `], { cwd: directory, env: { ...process.env, MODE: "upgrade", STORAGE_ENGINE: "surrealkv",
      TARGET_IMAGE: "", TARGET_BINARY: "/fixture/surreal", GITHUB_RUN_ID: "sandbox",
      CAPABILITY_FIXTURE: JSON.stringify({ manifest_revision: "native-quota-v2.0", fork: { release: "4.0.1-native-quota.1" },
        storage: { backend: "surrealkv", ready: true, storage_version: 32772,
          marker: { upstream_storage_major: 4, migration_state: "clean" } },
        backend: { name: "surrealkv", production: false, hard_quota_certified: false } }) },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("目标引擎未通过 native-quota 生产认证");
    expect(result.stdout.toString()).not.toContain("SSH_REACHED");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("数据库维护仅手动、main、production 审批与全局发布锁", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../.github/workflows/surrealdb-upgrade.yml")).text();
  const workflow = Bun.YAML.parse(text) as {
    on: Record<string, { inputs: Record<string, { default?: string | boolean; required?: boolean }> }>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, { if: string; environment: string }>;
  };
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.on.workflow_dispatch?.inputs.mode?.default).toBe("check");
  expect(workflow.on.workflow_dispatch?.inputs.approval_ref?.required).toBe(true);
  expect(workflow.on.workflow_dispatch?.inputs.defer_origin_start?.default).toBe(false);
  expect(workflow.concurrency).toEqual({ group: "production-release", "cancel-in-progress": false });
  expect(workflow.jobs.maintenance?.if).toBe("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.maintenance?.environment).toBe("production");
  expect(text).toContain("ORIGIN_SSH_KEY || secrets.SSH_KEY");
  expect(text).toContain("StrictHostKeyChecking yes");
  expect(text).toContain("STORAGE_ENGINE");
  expect(text).toContain("ubuntu-24.04-arm");
  expect(text).toContain("promotion-production.json");
  expect(text).toContain("linux-arm64.tgz");
  expect(text).toContain("systemd-run");
  expect(text).toContain('--defer-origin-start');
  expect(text).toContain('"$DEFER_ORIGIN_START" = true');
});
