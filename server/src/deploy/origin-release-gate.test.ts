import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
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
 * LCA10 试用来源门禁回归：require_trial_source_compat 是纯静态语义断言。
 * 复核结论 P1 后的契约升级为正向证明——目标必须满足全部四层才算显式：
 *   1) workspaces.ts 命中 workspace-commercial-source-required 关闭契约；
 *   2) workspaces.ts 不发起任何 createWorkspace 供应调用（间接来源赋值同拒）；
 *   3) workspaces.ts 无 trial 来源键值字面量（含冒号前后空白/引号变体）；
 *   4) pro-trial.ts 为配置驱动实现（引用 pro_trial_configuration）且被
 *      app.ts 挂载（createProTrialRoutes）。
 * 发布主流上该门禁在任何主机状态变更（env 增改/停服/切换）之前执行，拒绝时
 * env/current/服务零接触；撤销门禁/env 键校验拒绝路径统一 restore_env 恢复
 * 备份（恢复失败显式中止）。
 */

const SCRIPT_PATH = join(import.meta.dir, "../../../scripts/deploy/origin-release.sh");
const scriptSrc = readFileSync(SCRIPT_PATH, "utf8");

const EXTRACTED = [
  "restore_env",
  "target_has_revocation_filter",
  "find_revocation_checker_dir",
  "grant_revocations_present",
  "require_revocation_compat",
  "target_has_explicit_trial_source",
  "require_trial_source_compat",
  "require_allowance_source_compat",
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

type TrialCompat =
  | "explicit"
  | "implicit"
  | "implicit-spacing"
  | "indirect-source"
  | "hybrid-literal"
  | "stub-entry"
  | "unmounted-entry"
  | "old-origin"
  | "no-entry"
  | "no-route"
  | "unreadable-route";

// 逐变体夹具：三份关键文件分别构造，正向契约每层都有独立命中的拒绝用例。
const ROUTE_CLOSED = 'return c.json({ error: { code: "workspace-commercial-source-required" } });\n';
const ROUTE_IMPLICIT =
  'const r = await workspaceCreator.createWorkspace({ resourceSource: { planKey: "trial", sourceKind: "trial" } });\n';
const ROUTE_IMPLICIT_SPACING =
  "const r = await workspaceCreator.createWorkspace({ resourceSource: { planKey : 'trial' } });\n";
// 间接来源赋值：trial 来源经变量传入，路由文件里没有 "trial" 字面量。
const ROUTE_INDIRECT =
  ROUTE_CLOSED + "const src = pickSource();\nconst r = await workspaceCreator.createWorkspace({ resourceSource: src });\n";
// 混合树：关闭契约在场但仍残留 trial 键值字面量。
const ROUTE_HYBRID_LITERAL = ROUTE_CLOSED + 'const fallback = { planKey : "trial" };\n';
const ENTRY_REAL = "// POST /api/pro-trial/start gated by pro_trial_configuration\nexport function createProTrialRoutes() {}\n";
const ENTRY_STUB = "export function createProTrialRoutes() {}\n";
const APP_MOUNTED = '.route("/", createProTrialRoutes(service));\n';
const APP_UNMOUNTED = '.route("/", createWorkspaceRoutes());\n';

function writeAllowanceTree(base: string, compatible = true) {
  for (const path of ["shared/src", "shared/sql/system", "shared/sql/workspace-template", "server/src/ai-allowance"]) mkdirSync(join(base, path), { recursive: true });
  writeFileSync(join(base, "shared/src/ai-allowance.ts"), "AI_ALLOWANCE_CONSUMABLE_SQL");
  writeFileSync(join(base, "shared/sql/system/027-ai-trial-conversion-source.surql"), "// structure");
  writeFileSync(join(base, "shared/sql/workspace-template/047-ai-source-termination.surql"), "// structure");
  writeFileSync(join(base, "server/src/ai-allowance/service.ts"), compatible ? "aiAllowancePlanPrefix\nWHERE AI_ALLOWANCE_CONSUMABLE_SQL\nWHERE AI_ALLOWANCE_CONSUMABLE_SQL\n" : "// old unrestricted consumption");
  writeFileSync(join(base, "server/src/ai-allowance/plan-cycle.ts"), "plan-cycle-rules-v4 conversion.sourceId");
}

function writeTrialTree(base: string, compat: TrialCompat) {
  writeAllowanceTree(base);
  const routes = join(base, "server", "src", "routes");
  mkdirSync(routes, { recursive: true });
  const routeByCompat: Partial<Record<TrialCompat, string>> = {
    explicit: ROUTE_CLOSED,
    implicit: ROUTE_IMPLICIT,
    "implicit-spacing": ROUTE_IMPLICIT_SPACING,
    "indirect-source": ROUTE_INDIRECT,
    "hybrid-literal": ROUTE_HYBRID_LITERAL,
    "stub-entry": ROUTE_CLOSED,
    "unmounted-entry": ROUTE_CLOSED,
    "old-origin": ROUTE_IMPLICIT,
    "no-entry": ROUTE_CLOSED,
    "unreadable-route": ROUTE_CLOSED,
  };
  const route = routeByCompat[compat];
  if (route !== undefined) {
    const path = join(routes, "workspaces.ts");
    writeFileSync(path, route);
    if (compat === "unreadable-route") chmodSync(path, 0o000);
  }
  const entryByCompat: Partial<Record<TrialCompat, string>> = {
    explicit: ENTRY_REAL,
    implicit: ENTRY_REAL,
    "implicit-spacing": ENTRY_REAL,
    "indirect-source": ENTRY_REAL,
    "hybrid-literal": ENTRY_REAL,
    "stub-entry": ENTRY_STUB,
    "unmounted-entry": ENTRY_REAL,
    "no-route": ENTRY_REAL,
    "unreadable-route": ENTRY_REAL,
  };
  const entry = entryByCompat[compat];
  if (entry !== undefined) writeFileSync(join(routes, "pro-trial.ts"), entry);
  const app = compat === "unmounted-entry" || compat === "old-origin" ? APP_UNMOUNTED : APP_MOUNTED;
  writeFileSync(join(base, "server", "src", "app.ts"), app);
}

type SimResult = { stdout: string; stderr: string; exitCode: number; calls: string[] };

function runSim(
  env: SimEnv,
  opts: { filteredTarget?: boolean; mode?: "gate" | "rollback" | "trial-gate" | "allowance-gate"; trialCompat?: TrialCompat; allowanceCompat?: boolean } = {},
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
  for (const base of [release, previous, target]) {
    writeTrialTree(base, trialCompat);
  }
  for (const base of [release, previous, target]) writeAllowanceTree(base, opts.allowanceCompat !== false);
  writeFileSync(join(envDir, "server.env"), "SURREAL_URL=memory://x\n");
  writeFileSync(join(envDir, "server.env.bak"), "SURREAL_URL=memory://bak\n");

  const driver =
    opts.mode === "rollback"
      ? // 与生产调用点一致：rollback 经 || 调用，函数体内 errexit 被抑制。
        `prelude_failed() { return 1; }\nprelude_failed || rollback "simulated health check failure"\necho "UNREACHABLE: rollback returned"`
      : opts.mode === "allowance-gate"
        ? `if require_allowance_source_compat "${target}"; then\n  echo "RESULT:pass"\nelse\n  echo "RESULT:refuse"\nfi`
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
    expect(r.stderr).toContain("lacks the explicit closure contract");
  });

  test("格式变体：planKey 冒号前空白 + 单引号（语义等价的隐式自授）→ 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "implicit-spacing" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("lacks the explicit closure contract");
  });

  test("间接来源赋值：闭约在场但公共入口仍发起 createWorkspace 供应调用 → 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "indirect-source" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("still issues workspace provisioning calls");
  });

  test("纵深防御：闭约在场 + trial 键值字面量变体（planKey : \"trial\"）→ 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "hybrid-literal" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("trial source literal");
  });

  test("显式入口为占位实现（无 pro_trial_configuration）→ 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "stub-entry" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("not configuration-driven");
  });

  test("显式入口文件在场但 app.ts 未挂载 → 拒绝", () => {
    const r = runSim({}, { mode: "trial-gate", trialCompat: "unmounted-entry" });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.stderr).toContain("does not mount it");
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

/**
 * 整段脚本仿真：直接执行未改动的 scripts/deploy/origin-release.sh，
 * 只经 BASH_ENV 桩替换 bunx/bun/sudo/systemctl/curl/sleep/journalctl/mv，
 * env 备份与增改、门禁、目录切换全部走真实脚本代码（P1-B 回归）。
 */
type FullSimResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: string[];
  envAfter: string;
  envBackupExists: boolean;
  currentTarget: string;
};

function runFullRelease(opts: {
  target: TrialCompat;
  allowanceCompat?: boolean;
  filteredTarget?: boolean;
  additions?: string;
  healthyBody?: string;
  catFailBackup?: boolean;
}): FullSimResult {
  const dir = mkdtempSync(join(tmpdir(), "full-release-sim-"));
  const root = join(dir, "root");
  // release id 含 -ci 以命中脚本结尾 *-ci* 清理通配（否则 ls 无匹配、管道非零退出——预存行为）。
  const releaseId = "lca10-ci7";
  const previous = join(root, "releases", "rel-old");
  const envFile = join(dir, "server.env");
  const additionsPath = join(dir, "env.additions");
  const log = join(dir, "calls.log");

  writeTrialTree(previous, "explicit");
  mkdirSync(join(previous, "server", "src", "product-entitlement"), { recursive: true });
  writeFileSync(join(previous, "server", "src", "product-entitlement", "store.ts"), "content_grant_revocation\n");
  symlinkSync(previous, join(root, "current"));
  writeFileSync(envFile, "REVIEW_FIXTURE=before\nBASE_KEY=keep\n");
  if (opts.additions !== undefined) writeFileSync(additionsPath, opts.additions);
  writeFileSync(log, "");

  // 发布负载：git archive 风格的全树 server/ 目录。
  const payload = join(dir, "payload");
  writeTrialTree(payload, opts.target);
  writeAllowanceTree(payload, opts.allowanceCompat !== false);
  mkdirSync(join(payload, "server", "src", "product-entitlement"), { recursive: true });
  writeFileSync(join(payload, "server", "src", "product-entitlement", "store.ts"), opts.filteredTarget ? "content_grant_revocation\n" : "content_grant\n");
  const archive = join(dir, "payload.tar.gz");
  Bun.spawnSync(["tar", "-czf", archive, "-C", payload, "server", "shared"]);

  // 外部命令桩：只替换特权/网络/包管理行为，脚本主体逻辑原样执行。
  const prelude = join(dir, "prelude.sh");
  writeFileSync(
    prelude,
    `bunx() { echo "bunx:$*" >>"$GATE_LOG"; return 0; }
bun() { echo "bun:$*" >>"$GATE_LOG"; echo "grant_revocations=0"; }
sudo() { echo "sudo:$*" >>"$GATE_LOG"; [ "\${1:-}" = "-n" ] && shift; "$@"; }
systemctl() { echo "systemctl:$*" >>"$GATE_LOG"; case "\${1:-}" in is-active) echo "inactive"; return 3 ;; *) return 0 ;; esac; }
curl() { printf '%s' "\${T_HEALTH_BODY:-}"; }
sleep() { :; }
journalctl() { :; }
mv() { if [ "\${1:-}" = "-T" ]; then shift; [ -L "\$2" ] && command rm -f "\$2"; fi; command mv -f "$@"; }
cat() {
  case "\${T_CAT_FAIL_BACKUP:-}" in
    1) case "\${1##*/}" in server.env.*-ci*) echo "cat: injected failure" >&2; return 1 ;; esac ;;
  esac
  command cat "$@"
}
`,
  );

  const proc = Bun.spawnSync(["bash", SCRIPT_PATH, releaseId, archive, opts.additions !== undefined ? additionsPath : ""], {
    env: {
      ...process.env,
      BASH_ENV: prelude,
      GATE_LOG: log,
      ORIGIN_ROOT: root,
      ORIGIN_ENV_FILE: envFile,
      ORIGIN_SERVICE: "fixture-svc",
      ORIGIN_KEEP_RELEASES: "8",
      REVOCATION_GATE_DRAIN_SEC: "0",
      T_HEALTH_BODY: opts.healthyBody ?? "",
      T_CAT_FAIL_BACKUP: opts.catFailBackup ? "1" : "",
    },
  });

  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    calls: readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0),
    envAfter: readFileSync(envFile, "utf8"),
    envBackupExists: existsSync(join(root, "backups", "env", `server.env.${releaseId}`)),
    currentTarget: readlinkSync(join(root, "current")),
  };
}

describe("origin-release.sh 整段发布流：env 顺序与门禁拒绝恢复原状", () => {
  const BEFORE = "REVIEW_FIXTURE=before\nBASE_KEY=keep\n";

  test("旧隐式目标 + 非空 env-additions → 试用门禁先于 env 写入拒绝：env/current/服务零变更", () => {
    const r = runFullRelease({ target: "old-origin", additions: "REVIEW_FIXTURE=after\nNEW_K=v\n" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("would restore implicit trial creation");
    expect(r.envAfter).toBe(BEFORE);
    expect(r.envBackupExists).toBe(false); // 拒绝发生在 env 备份之前，无任何 env 侧副作用
    expect(r.calls.some((c) => c.startsWith("systemctl:"))).toBe(false);
    expect(r.calls.some((c) => c.startsWith("sudo:"))).toBe(false);
    expect(r.currentTarget).toContain("rel-old");
  });

  test("显式目标 + 非空 env-additions + 撤销门禁拒绝 → env 恢复备份、服务拉回、current 不动", () => {
    const r = runFullRelease({ target: "explicit", filteredTarget: false, additions: "REVIEW_FIXTURE=after\n" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("revocation gate");
    expect(r.envAfter).toBe(BEFORE);
    expect(r.envBackupExists).toBe(true);
    expect(r.calls.some((c) => c === "systemctl:stop fixture-svc")).toBe(true);
    expect(r.calls.some((c) => c === "systemctl:start fixture-svc")).toBe(true);
    expect(r.calls.some((c) => c.includes("restart"))).toBe(false);
    expect(r.currentTarget).toContain("rel-old");
  });

  test("env 恢复命令本身失败 → 显式中止且不静默（stderr 点名恢复失败与备份位置）", () => {
    const r = runFullRelease({ target: "explicit", filteredTarget: false, additions: "REVIEW_FIXTURE=after\n", catFailBackup: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("env restore failed");
    // 恢复失败是真实故障注入：env 保持增改后内容（键序按脚本重排），
    // 脚本以非零退出暴露不一致，不伪装恢复成功
    expect(r.envAfter).toBe("BASE_KEY=keep\nREVIEW_FIXTURE=after\n");
    expect(r.currentTarget).toContain("rel-old");
  });

  test("非法 env 键拒绝 → 已应用的先行增改被恢复", () => {
    const r = runFullRelease({ target: "explicit", filteredTarget: true, additions: "NEW_K=v\n1BAD=x\n", healthyBody: '{"status":"ok","surrealdb":"up"}' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("invalid env key");
    expect(r.envAfter).toBe(BEFORE);
    expect(r.currentTarget).toContain("rel-old");
    expect(r.calls.some((c) => c.includes("restart"))).toBe(false);
  });

  test("正向路径：显式 + 过滤目标完整发布 → env 增改生效、current 切换、健康通过", () => {
    const r = runFullRelease({ target: "explicit", filteredTarget: true, additions: "REVIEW_FIXTURE=after\n", healthyBody: '{"status":"ok","surrealdb":"up"}' });
    expect(r.exitCode).toBe(0);
    expect(r.envAfter).toBe("BASE_KEY=keep\nREVIEW_FIXTURE=after\n");
    expect(r.currentTarget).toContain("lca10-ci7");
    expect(r.calls.some((c) => c === "systemctl:restart fixture-svc")).toBe(true);
  });
});


describe("LCA14 allowance source compatibility", () => {
  test("current repository satisfies the compatibility floor", () => {
    const harness = `${EXTRACTED}\nrequire_allowance_source_compat "$1"`;
    const result = Bun.spawnSync(["bash", "-c", harness, "gate", join(import.meta.dir, "../../..")]);
    expect(result.exitCode).toBe(0);
  });
  test("old consumption target is refused without host mutations", () => {
    const r = runSim({}, { mode: "allowance-gate", allowanceCompat: false });
    expect(r.stdout).toContain("RESULT:refuse");
    expect(r.calls).toEqual([]);
  });
  test("automatic rollback refuses the old allowance implementation", () => {
    const r = runSim({}, { mode: "rollback", allowanceCompat: false });
    expect(r.stderr).toContain("not allowance-source-compatible");
    expect(has(r, "point_to:")).toBe(false);
    expect(has(r, "systemctl:")).toBe(false);
  });
  test("forward release refusal precedes env writes and service changes", () => {
    const r = runFullRelease({ target: "explicit", allowanceCompat: false, additions: "REVIEW_FIXTURE=after\n" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("allowance source gate");
    expect(r.envAfter).toBe("REVIEW_FIXTURE=before\nBASE_KEY=keep\n");
    expect(r.envBackupExists).toBe(false);
    expect(r.currentTarget).toContain("rel-old");
    expect(r.calls.some(c => c.startsWith("systemctl:"))).toBe(false);
  });
});
