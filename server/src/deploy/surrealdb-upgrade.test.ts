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
      GITHUB_WORKSPACE: join(import.meta.dir, "../../.."),
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

test("runner 预检硬限制内存，退出确认与 OOM 检查先于 SSH", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../.github/workflows/surrealdb-upgrade.yml")).text();
  const workflow = Bun.YAML.parse(text) as { jobs: { maintenance: { steps: Array<{ name: string; run?: string }> } } };
  const preflight = workflow.jobs.maintenance.steps.find((step) => step.name === "Fail-closed target engine and production contract preflight")!.run!;
  const directory = await mkdtemp(join(tmpdir(), "surreal-preflight-limits-"));
  try {
    for (const scenario of ["healthy", "oom", "still-running", "stop-failed", "invalid-cap"]) {
      const log = join(directory, `${scenario}.log`);
      const result = Bun.spawnSync(["bash", "-c", `
        set -e
        docker() {
          printf 'docker %s\\n' "$*" >> "$CALL_LOG"
          if [ "$1" = inspect ]; then printf '%s' "$CONTAINER_STATE"; fi
          if [ "$1" = stop ] && [ "$SCENARIO" = stop-failed ]; then return 1; fi
          return 0
        }
        curl() { if [[ "$*" == *capabilities* ]]; then printf '%s' "$CAPABILITY_FIXTURE"; fi; }
        (
          ${preflight}
        )
        printf 'SSH_REACHED\\n' >> "$CALL_LOG"
      `], { cwd: directory, env: { ...process.env, MODE: "upgrade", STORAGE_ENGINE: "rocksdb",
        GITHUB_WORKSPACE: join(import.meta.dir, "../../.."), TARGET_IMAGE: "fixture@sha256:fixture",
        GITHUB_RUN_ID: "sandbox", SCENARIO: scenario, CALL_LOG: log,
        SURREAL_UPGRADE_MEMORY_MAX_MIB: scenario === "invalid-cap" ? "0" : "64",
        CONTAINER_STATE: JSON.stringify({ Running: scenario === "still-running", Pid: scenario === "still-running" ? 123 : 0,
          OOMKilled: scenario === "oom" }),
        CAPABILITY_FIXTURE: JSON.stringify({ manifest_revision: "native-quota-v2.0", fork: { release: "4.0.1-native-quota.1" },
          storage: { backend: "rocksdb", ready: true, storage_version: 32772,
            marker: { upstream_storage_major: 4, migration_state: "clean" } },
          backend: { production: true, hard_quota_certified: true, persistent_restart_certified: true,
            certification_revision: "native-quota-contract-v1" } }) },
      });
      expect(result.exitCode, `${scenario}: ${result.stderr}`).toBe(scenario === "healthy" ? 0 : 1);
      const calls = await Bun.file(log).exists() ? await Bun.file(log).text() : "";
      if (scenario === "invalid-cap") {
        expect(calls).toBe("");
        continue;
      }
      const launch = calls.split("\n").find((line) => line.startsWith("docker run "))!;
      expect(launch).toContain("--memory 67108864 --memory-swap 67108864");
      expect(launch).not.toContain("--rm");
      expect(calls).toContain("docker stop --time 30 surreal-target-sandbox");
      if (scenario === "healthy") {
        expect(calls).toContain("docker inspect --format {{json .State}} surreal-target-sandbox");
        expect(calls.trim().endsWith("docker rm surreal-target-sandbox\nSSH_REACHED")).toBe(true);
      } else {
        expect(calls).not.toContain("SSH_REACHED");
      }
      if (scenario === "oom") expect(result.stderr.toString()).toContain("OOMKilled");
    }
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
