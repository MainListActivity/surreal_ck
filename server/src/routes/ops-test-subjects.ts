import { Hono } from "hono";
import { DateTime, StringRecordId } from "surrealdb";
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
import type { WorkspaceCreator } from "../workspaces/create-workspace";
import { env } from "../env";
import { getRootConnection } from "../db/root-connection";
import { toSurrealNone, dateTimeTimestamp } from "../db/surreal-values";

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

const WORKSPACE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;

export function createOpsTestSubjectsRoutes(input: Readonly<{
  requireOperator?: () => MiddlewareHandler<AppBindings>;
  getSystemDb?: () => Promise<Queryable>;
  dropDatabase?: (dbName: string) => Promise<void>;
  now?: () => Date;
  /** 代办开通 createWorkspace（app.ts 注入真实 creator；测试注入替身）。 */
  workspaceCreator?: WorkspaceCreator;
  /** 测试 workspace 的容量修订；缺省 env.TEST_SUBJECT_QUOTA_PLAN_REVISION ?? trial_v2。 */
  quotaPlanRevisionId?: string;
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
          email: toSurrealNone(body.email ?? null),
          expiresAt: new DateTime(new Date(expiresMs)),
          origin: toSurrealNone(body.origin ?? null),
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
        // SELECT VALUE id 直接把 record id 作为行返回（不是 {id} 对象）。
        const operator = rows(await db.query(
          `SELECT VALUE id FROM platform_operator WHERE subject = $subject LIMIT 1;`,
          { subject },
        ))[0];
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
            { wid: new StringRecordId(String(workspaceRef)), expiresAt: new DateTime(new Date(expiresMs)), origin: toSurrealNone(body.origin ?? null) },
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
    })
    .post("/api/ops/test-subjects/:subject/workspaces", requireOperator(), async (c) => {
      const subject = c.req.param("subject").trim();
      const db = await getSystemDb();
      const stored = await findTestSubject(db, subject);
      if (stored === null) {
        throw new HttpError(404, "test-subject-not-found", "该 subject 不是测试主体");
      }
      if (isExpired(stored, now())) {
        throw new HttpError(409, "test-subject-expired", "测试主体已到期，不能新建 workspace");
      }

      const parsed = z.object({
        slug: z.string().regex(WORKSPACE_SLUG_RE, "slug must be lowercase kebab-case"),
        name: z.string().trim().min(1).max(80),
      }).safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, "test-subject-workspace-invalid-body", "请求体无效");
      }
      const { slug, name } = parsed.data;

      // 幂等：同 subject 已有同 slug → 返回已有；slug 被其他人占 → 409。
      const existing = rows(await db.query(
        `SELECT id, slug, db_name, owner_subject, test_expires_at FROM workspace WHERE slug = $slug LIMIT 1;`,
        { slug },
      ))[0];
      if (existing !== undefined) {
        if (String(existing.owner_subject) !== subject) {
          throw new HttpError(409, "test-subject-workspace-slug-taken", "该 slug 已被其他主体占用");
        }
        return c.json({
          slug: String(existing.slug),
          dbName: String(existing.db_name),
          testExpiresAt: dateTimeTimestamp(existing.test_expires_at) > 0
            ? new Date(dateTimeTimestamp(existing.test_expires_at)).toISOString()
            : null,
          created: false,
        });
      }

      if (input.workspaceCreator === undefined) {
        throw new HttpError(500, "test-subject-workspace-creator-missing", "workspace creator 未注入");
      }
      const revisionId = input.quotaPlanRevisionId
        ?? env.TEST_SUBJECT_QUOTA_PLAN_REVISION
        ?? "quota_plan_revision:trial_v2";
      const created = await input.workspaceCreator.createWorkspace({
        subject,
        email: stored.email ?? "",
        name,
        slug,
        resourceSource: {
          planKey: "trial",
          sourceKind: "manual",
          revisionId,
        },
      });

      if (created.kind === "slug-conflict") {
        // 并发/既有占用：重读以判定归属。
        const raced = rows(await db.query(
          `SELECT id, slug, db_name, owner_subject, test_expires_at FROM workspace WHERE slug = $slug LIMIT 1;`,
          { slug },
        ))[0];
        if (raced !== undefined && String(raced.owner_subject) === subject) {
          return c.json({
            slug: String(raced.slug),
            dbName: String(raced.db_name),
            testExpiresAt: dateTimeTimestamp(raced.test_expires_at) > 0
              ? new Date(dateTimeTimestamp(raced.test_expires_at)).toISOString()
              : null,
            created: false,
          });
        }
        throw new HttpError(409, "test-subject-workspace-slug-taken", "该 slug 已被其他主体占用");
      }
      if (created.kind !== "created" && created.kind !== "scope-update-failed") {
        throw new HttpError(502, `test-subject-workspace-${created.code ?? "provisioning-failed"}`,
          created.message ?? "workspace 供应失败");
      }

      const ws = rows(await db.query(
        `SELECT db_name, test_expires_at FROM workspace WHERE slug = $slug LIMIT 1;`,
        { slug },
      ))[0];
      const testExpiresAt = ws?.test_expires_at;
      return c.json({
        slug,
        dbName: created.kind === "created" ? created.dbName : String(ws?.db_name ?? ""),
        testExpiresAt: dateTimeTimestamp(testExpiresAt) > 0
          ? new Date(dateTimeTimestamp(testExpiresAt)).toISOString()
          : null,
        created: true,
      }, 201);
    })
;

  routes.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.code, message: error.message }, error.status as never);
    }
    console.error("[ops-test-subjects] unexpected error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "internal_error" }, 500);
  });
  return routes;
}
