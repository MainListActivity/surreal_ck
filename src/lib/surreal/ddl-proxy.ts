/**
 * DDL proxy client（已废弃）
 *
 * local-first 架构下，Bun 主进程持有 root 权限，可直接执行 DEFINE 语句。
 * 此模块不再使用，保留以避免破坏可能仍有导入的旧代码。
 *
 * @deprecated 使用 IPC dbQuery 替代
 */

export class DdlProxyError extends Error {
  constructor(
    public readonly templateId: string,
    public readonly status: number,
    message: string,
  ) {
    super(`DDL proxy error [${templateId}] HTTP ${status}: ${message}`);
    this.name = 'DdlProxyError';
  }
}

/** @deprecated no-op in local-first mode */
export async function execDdlTemplate(
  _accessToken: string,
  _templateId: string,
  _params: Record<string, unknown>,
): Promise<void> {
  // local-first：主进程直接执行 DDL，此函数为空操作
}
