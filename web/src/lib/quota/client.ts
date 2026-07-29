import type {
  ControlPlaneObject,
  QuotaApiBillingView,
  QuotaApiOperatorView,
  QuotaApiWorkspaceView,
  QuotaInAppNotification,
  QuotaOperatorIntentKind,
  QuotaOperatorIntentStatusView,
  QuotaOpsContextView,
  QuotaOpsIntentPreflightView,
  QuotaOpsSearchView,
  QuotaOpsTimelineView,
} from "@surreal-ck/shared/native-quota";
import { api as defaultApi } from "../api";

type EndpointResponse = Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type QuotaOpsIntentDraft = Readonly<{
  kind: QuotaOperatorIntentKind;
  workspaceSlug: string;
  workspace: string;
  billingAccount?: string;
  requestId: string;
  customerReason: string;
  operatorReason: string;
  effectiveAt: string;
  input: ControlPlaneObject;
}>;

export type QuotaIntentAccepted = Readonly<{
  id: string;
  status: "accepted" | "duplicate";
  statusUrl: string;
}>;

export interface QuotaEndpointClient {
  workspace(slug: string, refresh: boolean): Promise<EndpointResponse>;
  billingAccount(
    accountKey: string,
    refresh: boolean,
  ): Promise<EndpointResponse>;
  notifications(limit: number): Promise<EndpointResponse>;
  markNotificationRead(id: string): Promise<EndpointResponse>;
  opsContext(): Promise<EndpointResponse>;
  opsSearch(query: string, limit: number): Promise<EndpointResponse>;
  opsWorkspace(slug: string, refresh: boolean): Promise<EndpointResponse>;
  opsTimeline(slug: string, limit: number): Promise<EndpointResponse>;
  opsPreflight(draft: QuotaOpsIntentDraft): Promise<EndpointResponse>;
  submitIntent(draft: QuotaOpsIntentDraft): Promise<EndpointResponse>;
  intentStatus(id: string): Promise<EndpointResponse>;
}

type HonoQuotaClient = {
  api: {
    workspaces: {
      ":slug": {
        quota: {
          $get(input: {
            param: { slug: string };
            query: { refresh?: string };
          }): Promise<EndpointResponse>;
        };
      };
    };
    "billing-accounts": {
      ":accountKey": {
        quota: {
          $get(input: {
            param: { accountKey: string };
            query: { refresh?: string };
          }): Promise<EndpointResponse>;
        };
      };
    };
    quota: {
      notifications: {
        $get(input: {
          query: { limit: string };
        }): Promise<EndpointResponse>;
        ":notificationId": {
          read: {
            $post(input: {
              param: { notificationId: string };
            }): Promise<EndpointResponse>;
          };
        };
      };
    };
    ops: {
      quota: {
        context: {
          $get(): Promise<EndpointResponse>;
        };
        search: {
          $get(input: {
            query: { q: string; limit: string };
          }): Promise<EndpointResponse>;
        };
        workspaces: {
          ":slug": {
            $get(input: {
              param: { slug: string };
              query: { refresh?: string };
            }): Promise<EndpointResponse>;
            timeline: {
              $get(input: {
                param: { slug: string };
                query: { limit: string };
              }): Promise<EndpointResponse>;
            };
          };
        };
        preflight: {
          $post(input: {
            json: Record<string, unknown>;
          }): Promise<EndpointResponse>;
        };
        intents: {
          $post(input: {
            json: Record<string, unknown>;
          }): Promise<EndpointResponse>;
          ":intentId": {
            $get(input: {
              param: { intentId: string };
            }): Promise<EndpointResponse>;
          };
        };
      };
    };
  };
};

export const honoQuotaEndpoint: QuotaEndpointClient = {
  workspace(slug, refresh) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.workspaces[":slug"].quota.$get({
      param: { slug },
      query: refresh ? { refresh: "true" } : {},
    });
  },
  billingAccount(accountKey, refresh) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api["billing-accounts"][":accountKey"].quota.$get({
      param: { accountKey },
      query: refresh ? { refresh: "true" } : {},
    });
  },
  notifications(limit) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.quota.notifications.$get({
      query: { limit: String(limit) },
    });
  },
  markNotificationRead(id) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.quota.notifications[":notificationId"].read.$post({
      param: { notificationId: id },
    });
  },
  opsContext() {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.ops.quota.context.$get();
  },
  opsSearch(query, limit) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.ops.quota.search.$get({
      query: { q: query, limit: String(limit) },
    });
  },
  opsWorkspace(slug, refresh) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.ops.quota.workspaces[":slug"].$get({
      param: { slug },
      query: refresh ? { refresh: "true" } : {},
    });
  },
  opsTimeline(slug, limit) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.ops.quota.workspaces[":slug"].timeline.$get({
      param: { slug },
      query: { limit: String(limit) },
    });
  },
  opsPreflight(draft) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.ops.quota.preflight.$post({
      json: intentBody(draft, false),
    });
  },
  submitIntent(draft) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.ops.quota.intents.$post({
      json: intentBody(draft, true),
    });
  },
  intentStatus(id) {
    const client = defaultApi as unknown as HonoQuotaClient;
    return client.api.ops.quota.intents[":intentId"].$get({
      param: { intentId: id },
    });
  },
};

export class QuotaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "QuotaApiError";
  }
}

function intentBody(
  draft: QuotaOpsIntentDraft,
  includeReasons: boolean,
): Record<string, unknown> {
  return {
    kind: draft.kind,
    workspaceSlug: draft.workspaceSlug,
    workspace: draft.workspace,
    ...(draft.billingAccount
      ? { billingAccount: draft.billingAccount }
      : {}),
    effectiveAt: draft.effectiveAt,
    input: draft.input,
    ...(includeReasons
      ? {
          requestId: draft.requestId,
          customerReason: draft.customerReason,
          operatorReason: draft.operatorReason,
        }
      : {}),
  };
}

async function bodyOrThrow<T>(
  response: EndpointResponse,
  fallback: string,
): Promise<T> {
  const body = await response.json().catch(() => null) as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | null;
  if (!response.ok) {
    throw new QuotaApiError(
      response.status,
      body?.error?.code ?? "quota-api-error",
      body?.error?.message ?? fallback,
      body?.error?.details,
    );
  }
  return body as T;
}

export async function loadWorkspaceQuota(
  slug: string,
  refresh = false,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaApiWorkspaceView> {
  return bodyOrThrow(
    await endpoint.workspace(slug, refresh),
    "无法读取工作区配额。",
  );
}

export async function loadBillingQuota(
  accountKey: string,
  refresh = false,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaApiBillingView> {
  return bodyOrThrow(
    await endpoint.billingAccount(accountKey, refresh),
    "无法读取计费账户配额。",
  );
}

export async function loadQuotaNotifications(
  limit = 50,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<readonly QuotaInAppNotification[]> {
  const result = await bodyOrThrow<{ notifications: QuotaInAppNotification[] }>(
    await endpoint.notifications(limit),
    "无法读取配额通知。",
  );
  return result.notifications;
}

export async function markQuotaNotificationRead(
  id: string,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<void> {
  await bodyOrThrow(
    await endpoint.markNotificationRead(id),
    "无法更新通知状态。",
  );
}

export async function loadOpsContext(
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaOpsContextView> {
  return bodyOrThrow(await endpoint.opsContext(), "无法进入配额运营台。");
}

export async function searchQuotaOps(
  query: string,
  limit = 25,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaOpsSearchView> {
  return bodyOrThrow(
    await endpoint.opsSearch(query, limit),
    "无法搜索配额对象。",
  );
}

export async function loadOperatorWorkspace(
  slug: string,
  refresh = false,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaApiOperatorView> {
  return bodyOrThrow(
    await endpoint.opsWorkspace(slug, refresh),
    "无法读取运营配额详情。",
  );
}

export async function loadOpsTimeline(
  slug: string,
  limit = 50,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaOpsTimelineView> {
  return bodyOrThrow(
    await endpoint.opsTimeline(slug, limit),
    "无法读取配额操作时间线。",
  );
}

export async function preflightQuotaIntent(
  draft: QuotaOpsIntentDraft,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaOpsIntentPreflightView> {
  return bodyOrThrow(
    await endpoint.opsPreflight(draft),
    "无法完成配额变更预检。",
  );
}

export async function submitQuotaIntent(
  draft: QuotaOpsIntentDraft,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaIntentAccepted> {
  return bodyOrThrow(
    await endpoint.submitIntent(draft),
    "无法提交配额运营意图。",
  );
}

export async function loadQuotaIntentStatus(
  id: string,
  endpoint: QuotaEndpointClient = honoQuotaEndpoint,
): Promise<QuotaOperatorIntentStatusView> {
  return bodyOrThrow(
    await endpoint.intentStatus(id),
    "无法读取运营意图状态。",
  );
}
