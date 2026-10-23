import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * G2：deploy-origin.yml「Upload release bundle」步骤的执行级测试。
 *
 * 真实运行工作流中该步骤的脚本体（从 YAML 提取），scp 与 ssh 为替身，从不发出真实网络或 SSH 请求。
 * 上传只写暂存件与工具副本，失败必须在停服之前结束：不得调用 systemctl、--launch 或 --recover，
 * 且失败时远端暂存件（含 env 增改）被清理。
 */

const WORKFLOW_PATH = join(import.meta.dir, "../../../.github/workflows/deploy-origin.yml");
const SCRIPT_SOURCE = join(import.meta.dir, "../../../scripts/deploy/origin-release.sh");
const RELEASE_ID = "abc1234-ci999";
const FIXTURE_ENV = "FIXTURE_KEY=fixture-value\n";
const REMOTE_CLEANUP = `rm -f /tmp/surreal_ck-env-${RELEASE_ID} /tmp/surreal_ck-${RELEASE_ID}.tar.gz /tmp/origin-release-${RELEASE_ID}.sh`;

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function readCalls(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0) : [];
}

// 提取 "- name: Upload release bundle ..." 步骤的 run 块：去掉 YAML 缩进后的 bash 脚本体。
export function uploadStepBody(workflowPath: string = WORKFLOW_PATH): string {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes("- name: Upload release bundle"));
  if (start < 0) throw new Error("upload step not found");
  const runIdx = lines.findIndex((line, i) => i > start && line === "        run: |");
  if (runIdx < 0) throw new Error("upload run block not found");
  const body: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return `${body.join("\n")}\n`;
}

// 运行上传步骤脚本体。failAt 为第几次 scp 失败（0 表示全部成功）。
export function runUpload(failAt: number, workflowPath: string = WORKFLOW_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "origin-g2-upload-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const work = join(dir, "work");
  mkdirSync(join(work, "scripts", "deploy"), { recursive: true });
  const callLog = join(dir, "calls.log");
  const countFile = join(dir, "scp.count");
  writeFileSync(join(work, "env.additions"), FIXTURE_ENV);
  writeFileSync(join(work, "release.tar.gz"), "tarball-bytes");
  writeFileSync(join(work, "scripts", "deploy", "origin-release.sh"), readFileSync(SCRIPT_SOURCE));
  writeFileSync(
    join(bin, "scp"),
    `#!/usr/bin/env bash\nn=$(cat "${countFile}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${countFile}"\necho "scp #$n $*" >> "${callLog}"\nif [ "$n" = "${failAt}" ]; then exit 1; fi\nexit 0\n`,
  );
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env bash\necho "ssh $*" >> "${callLog}"\nexit 0\n`);
  chmodSync(join(bin, "scp"), 0o755);
  chmodSync(join(bin, "ssh"), 0o755);
  const stepBody = uploadStepBody(workflowPath);
  const stepPath = join(dir, "step.sh");
  writeFileSync(stepPath, stepBody);
  const proc = Bun.spawnSync(["bash", stepPath], {
    cwd: work,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RELEASE_ID },
    timeout: 20_000,
  });
  return {
    exitCode: proc.exitCode ?? -1,
    calls: readCalls(callLog),
    workDir: work,
    stepBody,
  };
}

type UploadRun = ReturnType<typeof runUpload>;

// 失败上传的清理断言：恰好一次远端清理，且清理的是本次三类暂存件。
function assertFailedUploadCleaned(r: UploadRun) {
  const ssh = r.calls.filter((c) => c.startsWith("ssh "));
  expect(ssh).toHaveLength(1);
  expect(ssh[0]).toContain(REMOTE_CLEANUP);
}

describe("G2 上传步骤 scp 失败（执行级，真实上传步骤脚本体）", () => {
  test("提取到的步骤体包含三次上传与失败清理，且不含激活命令", () => {
    const body = uploadStepBody();
    expect(body).toContain("scp -q env.additions");
    expect(body).toContain("scp -q release.tar.gz");
    expect(body).toContain("scp -q scripts/deploy/origin-release.sh");
    expect(body).toContain("trap cleanup_staged EXIT");
    expect(body).not.toMatch(/systemctl|--launch|--recover/);
  });

  test("上传成功：三个 scp 依次执行，不调用 ssh（上传步骤不改动远端服务），本地 env 增改件被删除", () => {
    const r = runUpload(0);
    expect(r.exitCode).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("scp #"))).toHaveLength(3);
    expect(r.calls.some((c) => c.startsWith("ssh "))).toBe(false);
    expect(existsSync(join(r.workDir, "env.additions"))).toBe(false);
  });

  test("env 上传失败（第一次 scp）→ 非零退出，清理三类远端暂存件，不执行任何远端激活", () => {
    const r = runUpload(1);
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("scp #"))).toHaveLength(1);
    assertFailedUploadCleaned(r);
    expect(r.calls.join("\n")).not.toMatch(/systemctl|--launch|--recover/);
    expect(existsSync(join(r.workDir, "env.additions"))).toBe(false);
  });

  test("tar 上传失败（第二次 scp）→ 非零退出，清理远端暂存件，工具副本未上传", () => {
    const r = runUpload(2);
    expect(r.exitCode).not.toBe(0);
    const scps = r.calls.filter((c) => c.startsWith("scp #"));
    expect(scps).toHaveLength(2);
    expect(scps.some((c) => c.includes("origin-release-"))).toBe(false);
    assertFailedUploadCleaned(r);
    expect(r.calls.join("\n")).not.toMatch(/systemctl|--launch|--recover/);
  });

  test("工具副本上传失败（第三次 scp）→ 非零退出，清理远端暂存件", () => {
    const r = runUpload(3);
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("scp #"))).toHaveLength(3);
    assertFailedUploadCleaned(r);
    expect(r.calls.join("\n")).not.toMatch(/systemctl|--launch|--recover/);
  });

  test("变异检测：去掉失败清理（trap 中的远端 rm）后，清理断言必须捕获该回归", () => {
    const dir = mkdtempSync(join(tmpdir(), "origin-g2-mutant-"));
    dirs.push(dir);
    const original = readFileSync(WORKFLOW_PATH, "utf8");
    const cleanupLine = `                "rm -f /tmp/surreal_ck-env-\${RELEASE_ID} /tmp/surreal_ck-\${RELEASE_ID}.tar.gz /tmp/origin-release-\${RELEASE_ID}.sh" \\`;
    expect(original).toContain(cleanupLine);
    const mutantPath = join(dir, "deploy-origin.yml");
    writeFileSync(mutantPath, original.replace(cleanupLine, `                "true" \\`));
    const r = runUpload(1, mutantPath);
    expect(r.exitCode).not.toBe(0);
    expect(() => assertFailedUploadCleaned(r)).toThrow();
  });
});
