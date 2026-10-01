import { api } from "./api";
import type {
  OfficeEmployeeStatus,
  OfficeLifecycleAction,
  OfficeLifecycleClient,
  OfficeActionResult,
} from "./office-runtime";

/**
 * 虚拟员工生命周期动作（VER02 既有 endpoint 的浏览器客户端）：
 * `POST /api/workspaces/:slug/employees/:key/pause|resume|retire`。
 *
 * 生命周期规则（状态机、幂等重放、凭证旋转、SIGNIN 门控）全部由后端权威执行；
 * 这不是 office CRUD 代理，而是已有的窄生命周期接口，浏览器只透传动作。
 * participant token 会被 endpoint 以 403 拒绝，UI 只是隐藏不可用按钮。
 */

type LifecycleResponse = {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
};

type LifecycleRouteClient = {
  workspaces: {
    ":slug": {
      employees: {
        ":employeeKey": {
          [action in OfficeLifecycleAction]: {
            $post(input: { param: { slug: string; employeeKey: string } }): Promise<LifecycleResponse>;
          };
        };
      };
    };
  };
};

const STATUSES: readonly OfficeEmployeeStatus[] = ["active", "paused", "retired", "provisioning"];

async function parseOutcome(response: LifecycleResponse): Promise<OfficeActionResult> {
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { employee?: { status?: unknown } }
      | null;
    const status = body?.employee?.status;
    return {
      ok: true,
      ...(typeof status === "string" && (STATUSES as readonly string[]).includes(status)
        ? { status: status as OfficeEmployeeStatus }
        : {}),
    };
  }
  const body = await response.json().catch(() => null);
  const message =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : `请求失败${response.status ? ` (${response.status})` : ""}`;
  return { ok: false, message };
}

export function createOfficeLifecycleClient(): OfficeLifecycleClient {
  const client = api as unknown as LifecycleRouteClient;
  return async ({ slug, employeeKey, action }) => {
    try {
      const response = await client.workspaces[":slug"].employees[":employeeKey"][action].$post({
        param: { slug, employeeKey },
      });
      return await parseOutcome(response);
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  };
}
