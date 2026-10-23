import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 发布目标准入门禁契约测试（scripts/deploy/release-target-gate.sh）。
 *
 * origin 部署的自动路径与手动路径（含回滚）都经过本门禁，且发生在任何上传之前。
 * gh 为桩：compare 端点输出 FAKE_COMPARE，check-runs 端点输出 FAKE_QG；
 * 目标必须是 origin/main 的祖先（compare 状态为 behind 或 identical），且 Quality gate 成功。
 */

const GATE = join(import.meta.dir, "../../../scripts/deploy/release-target-gate.sh");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const FAKE_GH = `#!/usr/bin/env bash
case "$*" in
  *compare/*)
    if [ "$FAKE_COMPARE_FAIL" = "1" ]; then
      echo "gh: simulated compare failure" >&2
      exit 1
    fi
    printf '%s' "$FAKE_COMPARE" ;;
  *check-runs*)
    if [ "$FAKE_CHECK_FAIL" = "1" ]; then
      echo "gh: simulated check-runs failure" >&2
      exit 1
    fi
    printf '%s' "$FAKE_QG" ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 2 ;;
esac
`;

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function makeBin(): string {
  const root = mkdtempSync(join(tmpdir(), "release-target-gate-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const path = join(bin, "gh");
  writeFileSync(path, FAKE_GH);
  chmodSync(path, 0o755);
  return bin;
}

async function runGate(overrides: Record<string, string> = {}) {
  const bin = makeBin();
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: bin,
    LANG: "C",
    GITHUB_REPOSITORY: "owner/repo",
    GH_TOKEN: "test-token-placeholder",
    RELEASE_SHA: SHA,
    FAKE_COMPARE: "behind",
    FAKE_COMPARE_FAIL: "0",
    FAKE_CHECK_FAIL: "0",
    FAKE_QG: "true",
    ...overrides,
  };
  const proc = Bun.spawn(["bash", GATE], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: stdout + stderr };
}

describe("release-target-gate.sh 发布目标门禁", () => {
  test("sha 是 main 的祖先（behind）且 Quality gate 成功时通过", async () => {
    const r = await runGate();
    expect(r.code).toBe(0);
    expect(r.out).toContain("release target gate passed");
    expect(r.out).toContain("main_relation=behind");
  });

  test("sha 即 main 头（identical）时通过", async () => {
    const r = await runGate({ FAKE_COMPARE: "identical" });
    expect(r.code).toBe(0);
  });

  test("sha 不在 main 上（ahead）时拒绝：未合入的提交不能经 main 派发上生产", async () => {
    const r = await runGate({ FAKE_COMPARE: "ahead" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not an ancestor of main");
    expect(r.out).toContain("compare status: ahead");
  });

  test("sha 与 main 分叉（diverged）时拒绝", async () => {
    const r = await runGate({ FAKE_COMPARE: "diverged" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not an ancestor of main");
  });

  test("compare 返回空状态（无法判定）时拒绝", async () => {
    const r = await runGate({ FAKE_COMPARE: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("compare status: unknown");
  });

  test("compare 调用失败（gh 非零退出）时拒绝（fail closed）", async () => {
    const r = await runGate({ FAKE_COMPARE_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not compare");
  });

  test("Quality gate 未成功时拒绝", async () => {
    const r = await runGate({ FAKE_QG: "false" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Quality gate has not succeeded");
  });

  test("读取 check runs 失败时拒绝", async () => {
    const r = await runGate({ FAKE_CHECK_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not read check runs");
  });

  test("sha 大写或长度不足时拒绝，且不调用 gh", async () => {
    const upper = await runGate({ RELEASE_SHA: SHA.toUpperCase() });
    expect(upper.code).toBe(1);
    expect(upper.out).toContain("sha must be a full lowercase commit SHA");
    const short = await runGate({ RELEASE_SHA: SHA.slice(0, 39) });
    expect(short.code).toBe(1);
    expect(short.out).toContain("sha must be a full lowercase commit SHA");
  });
});
