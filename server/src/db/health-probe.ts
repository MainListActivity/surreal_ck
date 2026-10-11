import {
  createRootConnectionManager,
  type ExerciseDisconnectResult,
  type RootConnectionManager,
  type RootConnectionManagerOptions,
  type RootConnectionSnapshot,
} from "./root-connection";

/**
 * /health 专用探测连接：与业务 root 连接物理隔离的第二条长连接
 * （同一 SURREAL_URL、同一 root 认证、同 _system 库，复用同一套
 * 探测→单飞重连→退避状态机）。
 *
 * 为什么独立：受控 down→up 演练端点必须断开「/health 实际评估的连接」。
 * 若探针直接评估业务 root 连接，演练 close 会同时掐断 root session
 * pool 与 quotaWorker 的业务流量；专用探测连接让演练只牺牲探针自己——
 * /health 如实 down→up，业务路径完全不受影响。
 */
export function createHealthProbeManager(
  options: RootConnectionManagerOptions = {},
): RootConnectionManager {
  return createRootConnectionManager({ label: "health-probe", ...options });
}

const manager = createHealthProbeManager();

/** 生产启动接线（startup.ts）；test 环境跳过，探针保持断开即 /health 如实 down。 */
export function initHealthProbe(): Promise<void> {
  return manager.init();
}

export function checkHealthProbe(timeoutMs = 5000): Promise<boolean> {
  return manager.checkConnection(timeoutMs);
}

export function healthProbeSnapshot(): RootConnectionSnapshot {
  return manager.snapshot();
}

/** 受控演练断连：关当前探测连接并在 holdMs 内抑制重连，窗口后自动恢复。 */
export function exerciseHealthProbeDisconnect(
  holdMs: number,
): Promise<ExerciseDisconnectResult> {
  return manager.exerciseDisconnect(holdMs);
}

export function closeHealthProbe(): Promise<void> {
  return manager.close();
}
