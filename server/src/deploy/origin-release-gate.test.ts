import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * LCA13 撤销兼容门禁回归测试（Finding A 修复验证）。
 *
 * 方法：从 scripts/deploy/origin-release.sh 逐字提取门禁/回滚函数，在受控
 * bash harness 中以 stub 替换 sudo/systemctl/sleep/point_to/healthy/bun，
 * 并在与生产一致的调用上下文（if 条件 / || 右侧——errexit 被抑制）中跑矩阵。
 *
 * 核心回归：require_revocation_compat 的「冻结」前置必须被证明——
 * systemctl stop 失败时，仅当 is-active 证明进程已死（inactive/failed）
 * 才采信冻结；服务仍活跃或状态不可证时拒绝激活无过滤目标。
 *
 * LCA10 试用来源门禁回归：require_trial_source_compat 是纯静态语义断言
 * （公共创建入口不自授 trial + 显式受控试用入口在场），先于撤销门禁执行，
 * 无任何副作用；回滚/恢复目标为旧隐式 trial 代码时必须拒绝，且 env/current/
 * 服务状态零接触（fail-closed：目标树缺失/不可读/检查命令出错同样拒绝）。
 */

const SCRIPT_PATH = join(import.meta.dir, "../../../scripts/deploy/origin-release.sh");
const scriptSrc = readFileSync(SCRIPT_PATH, "utf8");

const EXTRACTED = [
  "target_has_revocation_filter",
  "find_revocation_checker_dir",
  "grant_revocations_present",
  "require_revocation_compat",
  "target_has_explicit_trial_source",
  "require_trial_source_compat",
  "rollback",
]
  .map((name) => {
    const match = scriptSrc.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
    if (!match) throw new Error(`cannot extract ${name}() from origin-release.sh`);
    return match[0];
  })
  .join("\n\n");

type SimEnv = {
  stopRc?: number;
  isActive?: string;
  startRc?: number;
  restartRc?: number;
  count?: number;
  queryRc?: number;
  queryOut?: string;
  pointRc?: number;
  healthyRc?: number;
  checkerPresent?: boolean;
  envBackupMissing?: boolean;
};

type TrialCompat = "explicit" | "implicit" | "old-origin" | "no-entry" | "no-route" | "unreadable-route";

type SimResult = { stdout: string; stderr: string; exitCode: number; calls: string[] };

function runSim(
  env: SimEnv,
  opts: { filteredTarget?: boolean; mode?: "gate" | "rollback" | "trial-gate"; trialCompat?: TrialCompat } = {},
): SimResult {
  const dir = mkdtempSync(join(tmpdir(), "gate-sim-"));
  const root = join(dir, "root");
  const release = join(root, "releases", "rel-new");
  const previous = join(root, "releases", "rel-old");
  const target = join(dir, "target");
  const envDir = join(root, "env");
  const log = join(dir, "calls.log");

  for (const d of [
    join(release, "server", "src", "db"),
    join(previous, "server", "src", "db"),
    join(release, "server", "src", "routes"),
    join(previous, "server", "src", "routes"),
    join(target, "server", "src", "routes"),
    join(target, "server", "src", "product-entitlement"),
    envDir,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  // 有过滤目标在 product-entitlement 下含撤销过滤标记；无过滤目标不含。
  writeFileSync(
    join(target, "server", "src", "product-entitlement", "store.ts"),
    opts.filteredTarget ? "content_grant_revocation\n" : "content_grant\n",
  );
  // checker 存在性由真实 find_revocation_checker_dir 按文件探测决定。
  if (env.checkerPresent !== false) {
    writeFileSync(join(release, "server", "src", "db", "grant-revocation-check-cli.ts"), "// checker\n");
  }
  // LCA10 试用来源语义夹具：默认 explicit（显式创建来源语义在场），
  // 让既有的撤销门禁/回滚用例继续打它们各自的目标门禁。
  const trialCompat = opts.trialCompat ?? "explicit";
  const implicitIssuance = 'resourceSource: { planKey: "trial", sourceKind: "trial" },\n';
  for (const base of [release, previous, target]) {
    if (trialCompat !== "no-route") {
      const route = join(base, "server", "src", "routes", "workspaces.ts");
      writeFileSync(route, trialCompat === "implicit" || trialCompat === "old-origin" ? implicitIssuance : "// explicit creation source; issuance closed\n");
      if (trialCompat === "unreadable-route") chmodSync(route, 0o000);
    }
    if (trialCompat !== "no-entry" && trialCompat !== "old-origin") {
      writeFileSync(join(base, "server", "src", "routes", "pro-trial.ts"), "// explicit trial entry\n");
    }
  }
  writeFileSync(join(envDir, "server.env"), "SURREAL_URL=memory://x\n");
  writeFileSync(join(envDir, "server.env.bak"), "SURREAL_URL=memory://bak\n");

  const driver =
    opts.mode === "rollback"
      ? // 与生产调用点一致：rollback 经 || 调用，函数体内 errexit 被抑制。
        `prelude_failed() { return 1; }\nprelude_failed || rollback "simulated health check failure"\necho "UNREACHABLE: rollback returned"`
      : opts.mode === "trial-gate"
        ? // 与生产调用点一致：门禁经 if 条件调用，函数体内 errexit 被抑制。
          `if require_trial_source_compat "${target}"; then\n  echo "RESULT:pass"\nelse\n  echo "RESULT:refuse"\nfi`
        : `if require_revocation_compat "${target}"; then\n  echo "RESULT:pass"\nelse\n  echo "RESULT:refuse"\nfi`;

  const harness = `#!/usr/bin/env bash
set -euo pipefail
service=svc
root=${root}
release=${release}
previous=${previous}
env_file=${envDir}/server.env
env_backup=${envDir}/server.env.bak
env_additions=
release_id=rel-new
REVOCATION_GATE_DRAIN_SEC=0
LOG=${log}
: > "$LOG"

T_STOP_RC=${env.stopRc ?? 0}
T_IS_ACTIVE='${env.isActive ?? "inactive"}'
T_START_RC=${env.startRc ?? 0}
T_RESTART_RC=${env.restartRc ?? 0}
T_COUNT=${env.count ?? 0}
T_QUERY_RC=${env.queryRc ?? 0}
T_QUERY_OUT='${env.queryOut ?? ""}'
T_POINT_RC=${env.pointRc ?? 0}
T_HEALTHY_RC=${env.healthyRc ?? 0}
T_MISSING_ENV_BACKUP='${env.envBackupMissing ? "1" : ""}'

systemctl() {
  echo "systemctl:$*" >>"$LOG"
  case "$1" in
    is-active)
      echo "$T_IS_ACTIVE"
      if [ "$T_IS_ACTIVE" = "active" ]; then return 0; fi
      return 3 ;;
    stop) return "$T_STOP_RC" ;;
    start) return "$T_START_RC" ;;
    restart) return "$T_RESTART_RC" ;;
    *) return 0 ;;
  esac
}
sudo() {
  echo "sudo:$*" >>"$LOG"
  if [ "\${1:-}" = "-n" ]; then shift; fi
  if [ "\${1:-}" = "systemctl" ]; then
    shift
    systemctl "$@"
    return
  fi
  return 0
}
sleep() { :; }
point_to() { echo "point_to:$*" >>"$LOG"; return "$T_POINT_RC"; }
healthy() { echo "healthy" >>"$LOG"; return "$T_HEALTHY_RC"; }
bun() {
  echo "bun:$*" >>"$LOG"
  if [ "$T_QUERY_RC" != "0" ]; then
    echo "checker exploded" >&2
    return "$T_QUERY_RC"
  fi
  if [ -n "$T_QUERY_OUT" ]; then
    echo "$T_QUERY_OUT"
    return 0
  fi
  echo "grant_revocations=$T_COUNT"
}
journalctl() { :; }
cat() {
  if [ -n "$T_MISSING_ENV_BACKUP" ]; then
    echo "cat: no such file" >&2
    return 1
  fi
  command cat "$@"
}

${EXTRACTED}

${driver}
`;

  const harnessPath = join(dir, "harness.sh");
  writeFileSync(harnessPath, harness);
  const proc = Bun.spawnSync(["bash", harnessPath]);
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode, calls };
}

const has = (r: SimResult, prefix: string) => r.calls.some((c) => c.startsWith(prefix));
const countOf = (r: SimResult, prefix: string) => r.calls.filter((c) => c.startsWith(prefix)).length;

describe("origin-release revocation gate", () => {
  test("目标含撤销过滤：跳过门禁，不停服不检查", () => {
    const r = runSim({}, { filteredTarget: true });
    expect(r.stdout).toContain("RESULT:pass");
    expect(has(r, "sudo:-n systemctl stop")).toBe(false);
    expect(has(r, "bun:")).toBe(false);
  });

  test("基线：无过滤目标 + 停服成功 + count=0 → 放行", () => {
    const r = runSim({ count: 0 });
    expect(r.stdout).toContain("RESULT:pass");
    expect(has(r, "sudo:-n systemctl stop svc")).toBe(true);
    expect(has(r, "bun:")).toBe(true);
  });

  test("Finding A 回归：stop 失败 + 服务仍活跃 + count=0 → 必须拒绝", () => {
    const r = runSim({ stopRc: 1, isActive: "active", count: 0 });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stdout).not.toContain("RESULT:pass");
    // 冻结未成立即拒绝：不得继续执行撤销计数检查，并尝试恢复原服务。
    expect(has(r, "bun:")).toBe(false);
    expect(has(r, "sudo:-n systemctl start svc")).toBe(true);
  });

  test("stop 失败 + is-active 查询不可证（空状态）→ 拒绝", () => {
    const r = runSim({ stopRc: 1, isActive: "", count: 0 });
    expect(r.stdout).toContain("RESULT:refuse");
  });

  test("stop 失败 + 状态为 deactivating（未确认停止）→ 拒绝", () => {
    const r = runSim({ stopRc: 1, isActive: "deactivating", count: 0 });
    expect(r.stdout).toContain("RESULT:refuse");
  });

  test("stop 报错但服务已 inactive（进程已死=冻结成立）→ 继续排空检查并放行", () => {
    const r = runSim({ stopRc: 1, isActive: "inactive", count: 0 });
    expect(r.stdout).toContain("RESULT:pass");
    expect(has(r, "bun:")).toBe(true);
  });

  test("stop 报错但服务已 failed（进程已死=冻结成立）→ 放行", () => {
    const r = runSim({ stopRc: 1, isActive: "failed", count: 0 });
    expect(r.stdout).toContain("RESULT:pass");
  });

  test("已有撤销记录（count>0）→ 拒绝并恢复原服务", () => {
    const r = runSim({ count: 3 });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(has(r, "sudo:-n systemctl start svc")).toBe(true);
  });

  test("checker 缺失 → 拒绝（无法证明安全）", () => {
    const r = runSim({ checkerPresent: false });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(has(r, "bun:")).toBe(false);
    expect(has(r, "sudo:-n systemctl start svc")).toBe(true);
  });

  test("checker 查询失败 → 拒绝", () => {
    const r = runSim({ queryRc: 2 });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(has(r, "sudo:-n systemctl start svc")).toBe(true);
  });

  test("checker 输出无法解析（引擎契约漂移）→ 拒绝", () => {
    const r = runSim({ queryRc: 0, queryOut: "unexpected-output-shape" });
    expect(r.stdout).toContain("RESULT:refuse");
  });
});

describe("origin-release rollback hardening", () => {
  test("回滚路径同样经门禁：previous 无过滤 + 有撤销 → 拒绝回滚，不动 env/pointer", () => {
    const r = runSim({ count: 2 }, { mode: "rollback" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("UNREACHABLE");
    expect(has(r, "point_to:")).toBe(false);
  });

  test("回滚：previous 无过滤 + 空表 + env 备份缺失 → cat 失败即中止，不碰 point_to", () => {
    const r = runSim({ count: 0, envBackupMissing: true }, { mode: "rollback" });
    expect(r.exitCode).not.toBe(0);
    expect(has(r, "point_to:")).toBe(false);
  });

  test("回滚：env/point 成功但 restart 失败 → 中止在 healthy 之前", () => {
    const r = runSim({ count: 0, restartRc: 1 }, { mode: "rollback" });
    expect(r.exitCode).not.toBe(0);
    expect(has(r, "point_to:")).toBe(true);
    expect(has(r, "sudo:-n systemctl restart svc")).toBe(true);
    expect(countOf(r, "healthy")).toBe(0);
  });

  test("回滚成功路径：门禁通过 → env 恢复 → point_to → restart → healthy", () => {
    const r = runSim({ count: 0 }, { mode: "rollback" });
    expect(r.exitCode).not.toBe(0); // rollback 终态恒 exit 1（把发布标记为失败）
    expect(has(r, "point_to:")).toBe(true);
    expect(has(r, "sudo:-n systemctl restart svc")).toBe(true);
    expect(countOf(r, "healthy")).toBe(1);
  });

  test("回滚 stop 失败 + previous 服务仍活跃 → 拒绝回滚", () => {
    const r = runSim({ stopRc: 1, isActive: "active", count: 0 }, { mode: "rollback" });
    expect(r.exitCode).not.toBe(0);
    expect(has(r, "bun:")).toBe(false);
    expect(has(r, "point_to:")).toBe(false);
  });
});

describe("origin-release trial source gate (LCA10)", () => {
  test("显式语义目标 → 放行，且纯静态无副作用（不停服、不查库）", () => {
    const r = runSim({}, { mode: "trial-gate" });
    expect(r.stdout).toContain("RESULT:pass");
    expect(has(r, "sudo:-n systemctl stop")).toBe(false);
    expect(has(r, "bun:")).toBe(false);
  });

  test("恢复目标=旧隐式 trial origin（路由自授 + 无显式入口）→ 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "old-origin" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("no explicit trial entry");
  });

  test("仅有显式模块但公共入口重开隐式自授（部分回退/变异）→ 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "implicit" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("self-issues an implicit trial source");
  });

  test("显式入口缺失（无法证明目标带显式语义）→ fail-closed 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "no-entry" });
    expect(r.stdout).toContain("RESULT:refuse");
  });

  test("公共路由文件缺失（检查器无法读取）→ fail-closed 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "no-route" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("cannot prove creation semantics");
  });

  test("路由文件不可读（检查命令出错 rc=2）→ fail-closed 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "unreadable-route" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("grep failed");
  });

  test("回滚链：previous=旧隐式 origin → 自动回滚被拒且 env/current/服务零接触", () => {
    const r = runSim({}, { mode: "rollback", trialCompat: "old-origin" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("would restore implicit trial creation");
    expect(r.stdout).not.toContain("UNREACHABLE");
    // 试用门禁先于撤销门禁：拒绝发生时没有任何状态变更可恢复。
    expect(has(r, "sudo:-n systemctl stop")).toBe(false);
    expect(has(r, "point_to:")).toBe(false);
  });

  test("共存：previous 显式语义 + 无撤销过滤 + 空撤销表 → 两道门禁依次放行，回滚链完整", () => {
    const r = runSim({ count: 0 }, { mode: "rollback", trialCompat: "explicit" });
    expect(r.exitCode).not.toBe(0); // rollback 终态恒 exit 1
    expect(has(r, "point_to:")).toBe(true);
    expect(has(r, "sudo:-n systemctl restart svc")).toBe(true);
    expect(countOf(r, "healthy")).toBe(1);
  });

  test("共存：previous 显式语义但有撤销记录 → 撤销门禁拒绝并恢复服务", () => {
    const r = runSim({ count: 2 }, { mode: "rollback", trialCompat: "explicit" });
    expect(r.exitCode).not.toBe(0);
    expect(has(r, "sudo:-n systemctl start svc")).toBe(true);
    expect(has(r, "point_to:")).toBe(false);
  });
});
