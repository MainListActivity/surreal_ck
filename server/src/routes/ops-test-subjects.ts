import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { HttpError } from "../http-error";
import type { AppBindings } from "../hono-types";
import { requirePlatformOperator } from "../ops/operator-auth";
import { getRootDatabaseSession } from "../db/root-connection";
import {
  findTestSubject,
  isExpired,
  type Queryable,
} from "../test-subjects/store";
import { purgeTestSubject, purgeTestWorkspace, type TestSubjectReaperDeps } from "../test-subjects/reaper";
import { getRootConnection } from "../db/root-connection";

const CONTENT_CAPABILITIES = [
  "content.read",
  "content.submit",
  "content.publish",
  "content.source.manage",
] as const;

const putSchema = z.object({
  email: z.string().email().optional(),
  expiresAt: z.string().datetime(),
  origin: z.string().min(1).optional(),
  contentCapabilities: z.array(z.enum(CONTENT_CAPABILITIES)).optional(),
});

const MAX_TEST_TTL_MS = 31 * 24 * 60 * 60 * 1000;

function rows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0] as Record<string, unknown>[];
}

export function createOpsTestSubjectsRoutes(input: Readonly<{
  requireOperator?: () => MiddlewareHandler<AppBindings>;
  getSystemDb?: () => Promise<Queryable>;
  dropDatabase?: (dbName: string) => Promise<void>;
  now?: () => Date;
}> = {}) {
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("test.manage"));
  const getSystemDb = input.getSystemDb ?? (() => getRootDatabaseSession("_system"));
  const now = input.now ?? (() => new Date());

  const reaperDeps = async (): Promise<TestSubjectReaperDeps> => ({
    systemDb: await getSystemDb(),
    dropDatabase: input.dropDatabase ?? (async (dbName) => {
      const client = getRootConnection();
      await client.query(`REMOVE DATABASE IF EXISTS ${dbName};`);
    }),
    now,
  });

  const routes = new Hono<AppBindings>()
    .put("/api/ops/test-subjects/:subject", requireOperator(), async (c) => {
      const subject = c.req.param("subject").trim();
      if (!subject) throw new HttpError(400, "test-subject-subject-required", "subject is required");

      const parsed = putSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, "test-subject-invalid-body", "请求体无效");
      }
      const body = parsed.data;
      const expiresMs = Date.parse(body.expiresAt);
      const nowMs = now().getTime();
      if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs > nowMs + MAX_TEST_TTL_MS) {
        throw new HttpError(400, "test-subject-expires-out-of-range", "expiresAt 必须在当前时间后 31 天内");
      }

      const db = await getSystemDb();
      const existingTestSubject = await findTestSubject(db, subject);
      const operatorRows = rows(await db.query(
        `SELECT id FROM platform_operator WHERE subject = $subject LIMIT 1;`,
        { subject },
      ));
      // 已是正式运营主体且不在 test_subject：拒绝把它变成会被清理的测试主体。
      if (operatorRows.length > 0 && existingTestSubject === null) {
        throw new HttpError(409, "test-subject-conflict-operator", "该 subject 已是正式运营主体，不能登记为测试主体");
      }

      await db.query(
        `INSERT INTO test_subject { subject: $subject, email: $email, expires_at: $expiresAt, origin: $origin }
         ON DUPLICATE KEY UPDATE
           email = $email, expires_at = $expiresAt, origin = $origin, updated_at = time::now();`,
        {
          subject,
          email: body.email ?? null,
          expiresAt: new Date(expiresMs),
          origin: body.origin ?? null,
        },
      );

      if (body.contentCapabilities !== undefined && body.contentCapabilities.length > 0) {
        for (const capability of body.contentCapabilities) {
          if (!CONTENT_CAPABILITIES.includes(capability)) {
            throw new HttpError(400, "test-subject-capability-invalid", `不允许的能力 ${capability}`);
          }
        }
        await db.query(
          `INSERT INTO platform_operator { subject: $subject, display_name: $displayName, status: "active", kind: "agent" }
           ON DUPLICATE KEY UPDATE display_name = $displayName, updated_at = time::now();`,
          { subject, displayName: `测试主体 ${subject.slice(0, 12)}` },
        );
        const operator = rows(await db.query(
          `SELECT VALUE id FROM platform_operator WHERE subject = $subject LIMIT 1;`,
          { subject },
        ))[0]?.id;
        for (const capability of body.contentCapabilities) {
          await db.query(
            `INSERT INTO platform_operator_capability { operator: $operator, capability: $capability, status: "active", granted_by_subject: "test-subject-api" }
             ON DUPLICATE KEY UPDATE status = "active", updated_at = time::now();`,
            { operator, capability },
          );
        }
      }

      // 回填：唯一成员是该 subject 的既有 workspace 标记到期清理字段。
      const memberships = rows(await db.query(
        `SELECT VALUE workspace FROM user_workspace_index WHERE subject = $subject;`,
        { subject },
      ));
      for (const workspaceRef of memberships) {
        const memberCount = rows(await db.query(
          `SELECT count() AS n FROM user_workspace_index WHERE workspace = $wid GROUP ALL;`,
          { wid: workspaceRef },
        ))[0]?.n;
        if (Number(memberCount) === 1) {
          await db.query(
            `UPDATE $wid SET test_expires_at = $expiresAt, test_origin = $origin;`,
            { wid: workspaceRef, expiresAt: new Date(expiresMs), origin: body.origin ?? null },
          );
        }
      }

      const stored = await findTestSubject(db, subject);
      return c.json({
        subject: stored?.subject ?? subject,
        expiresAt: stored?.expires_at ?? body.expiresAt,
        origin: stored?.origin ?? null,
        email: stored?.email ?? null,
      });
    })
    .get("/api/ops/test-subjects", requireOperator(), async (c) => {
      const db = await getSystemDb();
      const subjects = rows(await db.query(
        `SELECT subject, email, expires_at, origin FROM test_subject ORDER BY expires_at;`,
      ));
      const list = [] as Record<string, unknown>[];
      for (const row of subjects) {
        const workspaces = rows(await db.query(
          `SELECT VALUE workspace.slug FROM user_workspace_index WHERE subject = $subject;`,
          { subject: row.subject },
        ));
        list.push({
          subject: row.subject,
          email: row.email ?? null,
          expiresAt: row.expires_at,
          origin: row.origin ?? null,
          expired: isExpired({ expires_at: String(row.expires_at) }, now()),
          workspaces,
        });
      }
      return c.json({ subjects: list });
    })
    .delete("/api/ops/test-subjects/:subject", requireOperator(), async (c) => {
      const subject = c.req.param("subject").trim();
      const db = await getSystemDb();
      const deps = await reaperDeps();

      const workspaces = rows(await db.query(
        `SELECT VALUE workspace FROM user_workspace_index WHERE subject = $subject;`,
        { subject },
      ));
      let workspacesPurged = 0;
      let workspacesSkipped = 0;
      for (const ref of workspaces) {
        const outcome = await purgeTestWorkspace(deps, String(ref));
        if (outcome === "purged") workspacesPurged += 1;
        else workspacesSkipped += 1;
      }
      await purgeTestSubject(deps, subject);
      return c.json({ subject, workspacesPurged, workspacesSkipped });
    });

  routes.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.code, message: error.message }, error.status as never);
    }
    return c.json({ error: "internal_error" }, 500);
  });
  return routes;
}
