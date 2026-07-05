import { api as defaultApi } from "./api";
import type { SurrealConn } from "./surreal";

export type WorkspaceMember = {
  id: string;
  displayName: string | null;
  email: string;
  isAdmin: boolean;
  pending: boolean;
};

export type AddMemberInput = {
  email: string;
  displayName?: string;
  isAdmin: boolean;
};

export type MemberWriteResult = { ok: true } | { ok: false; message: string };

export type MemberEndpointResponse = {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
};

export type MemberEndpointClient = {
  create(slug: string, input: AddMemberInput): Promise<MemberEndpointResponse>;
  updateRole(slug: string, userId: string, isAdmin: boolean): Promise<MemberEndpointResponse>;
  remove(slug: string, userId: string): Promise<MemberEndpointResponse>;
};

type HonoMemberRouteClient = {
  api: {
    workspaces: {
      ":slug": {
        members: {
          $post(input: { param: { slug: string }; json: AddMemberInput }): Promise<MemberEndpointResponse>;
          ":userId": {
            $patch(input: {
              param: { slug: string; userId: string };
              json: { isAdmin: boolean };
            }): Promise<MemberEndpointResponse>;
            $delete(input: { param: { slug: string; userId: string } }): Promise<MemberEndpointResponse>;
          };
        };
      };
    };
  };
};

type MemberRow = {
  id: { toString(): string };
  display_name?: string | null;
  email: string;
  is_admin?: boolean | null;
  subject?: string | null;
};

export async function loadMembers(conn: SurrealConn): Promise<WorkspaceMember[]> {
  const rows = await conn.query<MemberRow>(
    "SELECT id, display_name, email, is_admin, subject FROM user WHERE kind = 'human' AND disabled_at = NONE",
  );
  return rows.map((row) => ({
    id: row.id.toString(),
    displayName: row.display_name ?? null,
    email: row.email,
    isAdmin: row.is_admin === true,
    pending: row.subject === null || row.subject === undefined,
  }));
}

export const honoMemberEndpoint: MemberEndpointClient = {
  async create(slug, input) {
    const client = defaultApi as unknown as HonoMemberRouteClient;
    return client.api.workspaces[":slug"].members.$post({ param: { slug }, json: input });
  },
  async updateRole(slug, userId, isAdmin) {
    const client = defaultApi as unknown as HonoMemberRouteClient;
    return client.api.workspaces[":slug"].members[":userId"].$patch({
      param: { slug, userId },
      json: { isAdmin },
    });
  },
  async remove(slug, userId) {
    const client = defaultApi as unknown as HonoMemberRouteClient;
    return client.api.workspaces[":slug"].members[":userId"].$delete({
      param: { slug, userId },
    });
  },
};

function cleanAddInput(input: AddMemberInput): AddMemberInput {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName?.trim();
  return {
    email,
    ...(displayName ? { displayName } : {}),
    isAdmin: input.isAdmin,
  };
}

function responseMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

async function normalizeWrite(run: () => Promise<MemberEndpointResponse>): Promise<MemberWriteResult> {
  try {
    const response = await run();
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => null);
    return {
      ok: false,
      message: responseMessage(body, `请求失败${response.status ? ` (${response.status})` : ""}`),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function recordIdToPathId(recordId: string): string {
  const prefix = "user:";
  return recordId.startsWith(prefix) ? recordId.slice(prefix.length) : recordId;
}

export async function addMember(
  slug: string,
  input: AddMemberInput,
  endpoint: MemberEndpointClient = honoMemberEndpoint,
): Promise<MemberWriteResult> {
  const cleaned = cleanAddInput(input);
  return normalizeWrite(() => endpoint.create(slug, cleaned));
}

export async function updateMemberRole(
  slug: string,
  memberId: string,
  isAdmin: boolean,
  endpoint: MemberEndpointClient = honoMemberEndpoint,
): Promise<MemberWriteResult> {
  return normalizeWrite(() => endpoint.updateRole(slug, recordIdToPathId(memberId), isAdmin));
}

export async function removeMember(
  slug: string,
  memberId: string,
  endpoint: MemberEndpointClient = honoMemberEndpoint,
): Promise<MemberWriteResult> {
  return normalizeWrite(() => endpoint.remove(slug, recordIdToPathId(memberId)));
}
