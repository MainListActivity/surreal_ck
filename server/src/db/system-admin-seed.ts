import { env } from "../env";
import { getRootConnection } from "./root-connection";

export type SystemAdminSeedClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type SeedSystemAdminsOptions = {
  /** 逗号分隔的 subject 列表；默认取 env.SYSTEM_ADMIN_SUBJECTS。 */
  subjectsCsv?: string;
  namespace?: string;
};

export type SeedSystemAdminsResult = {
  seededSubjects: string[];
};

const SYSTEM_DATABASE = "_system";

function parseSubjects(csv: string | undefined): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  for (const raw of csv.split(",")) {
    const subject = raw.trim();
    if (subject !== "") seen.add(subject);
  }
  return [...seen];
}

/**
 * 启动期把 env 里的 subject upsert 进 `_system.system_admin`（按 subject 唯一）。
 * 当前 MVP 中该表非空即开启创建 workspace 能力；env 为空时直接跳过（不报错）。
 * 幂等：重复启动只刷新已有行，不产生重复。
 */
export async function seedSystemAdmins(
  db: SystemAdminSeedClient = getRootConnection(),
  options: SeedSystemAdminsOptions = {},
): Promise<SeedSystemAdminsResult> {
  const subjects = parseSubjects(options.subjectsCsv ?? env.SYSTEM_ADMIN_SUBJECTS);
  if (subjects.length === 0) {
    return { seededSubjects: [] };
  }

  const namespace = options.namespace ?? env.SURREAL_NS;
  await db.use({ namespace, database: SYSTEM_DATABASE });

  for (const subject of subjects) {
    // 唯一索引在 subject 上；冲突即刷新（保留 added_at 的 VALUE time::now() 语义由 schema 决定）。
    await db.query(
      `INSERT INTO system_admin { subject: $subject, note: "seeded from SYSTEM_ADMIN_SUBJECTS" }
       ON DUPLICATE KEY UPDATE note = "seeded from SYSTEM_ADMIN_SUBJECTS";`,
      { subject },
    );
  }

  console.info("[system-admin-seed] upserted admins", { count: subjects.length });
  return { seededSubjects: subjects };
}
