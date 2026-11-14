import {
  PLATFORM_OPERATOR_CAPABILITIES,
  type PlatformOperatorCapability,
} from "@surreal-ck/shared/native-quota";
import { StringRecordId } from "surrealdb";
import { env } from "../env";
import { getRootConnection } from "./root-connection";
import { toStringRecordId } from "./surreal-values";

export type PlatformOperatorSeedClient = {
  use(scope: { namespace: string; database: string }): Promise<unknown>;
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type SeedPlatformOperatorsOptions = {
  /** 逗号分隔的 OIDC subject 列表；默认取 env.PLATFORM_OPERATOR_SUBJECTS。 */
  subjectsCsv?: string;
  /** 逗号分隔的能力列表；默认取 env.PLATFORM_OPERATOR_CAPABILITIES。 */
  capabilitiesCsv?: string;
  /** 逗号分隔的测试主体管理 subject 列表；默认取 env.PLATFORM_OPERATOR_TEST_MANAGERS。 */
  testManagersCsv?: string;
  /** 逗号分隔的测试物料 agent subject 列表；默认取 env.PLATFORM_OPERATOR_TEST_AGENTS。 */
  testAgentsCsv?: string;
  displayName?: string;
  grantedBySubject?: string;
  namespace?: string;
};

export type SeedPlatformOperatorsResult = {
  seededSubjects: string[];
  capabilities: PlatformOperatorCapability[];
};

const SYSTEM_DATABASE = "_system";
const DEFAULT_GRANTOR = "system:env-bootstrap";

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (item !== "") seen.add(item);
  }
  return [...seen];
}

function parseCapabilities(value: string | undefined): PlatformOperatorCapability[] {
  const allowed = new Set<string>(PLATFORM_OPERATOR_CAPABILITIES);
  const values = parseCsv(value);
  const invalid = values.filter((item) => !allowed.has(item));
  if (invalid.length > 0) {
    throw new Error(
      `PLATFORM_OPERATOR_CAPABILITIES contains unsupported values: ${invalid.join(", ")}`,
    );
  }
  // test.provision 只授给 PLATFORM_OPERATOR_TEST_AGENTS 列出的 agent，不经全体主体 CSV 下发。
  if (values.includes("test.provision")) {
    throw new Error(
      "PLATFORM_OPERATOR_CAPABILITIES must not include test.provision; list agent subjects in PLATFORM_OPERATOR_TEST_AGENTS",
    );
  }
  // 探针临时授权走独立表；禁止经 CSV seed 写成全体主体的永久能力。
  if (values.includes("internal-ai.endpoint-probe")) {
    throw new Error(
      "PLATFORM_OPERATOR_CAPABILITIES must not include internal-ai.endpoint-probe; use the temporary-grant control plane",
    );
  }
  return values as PlatformOperatorCapability[];
}

function firstRecordId(result: unknown): StringRecordId | null {
  if (!Array.isArray(result)) return null;
  const statement = result[0];
  const value = Array.isArray(statement) ? statement[0] : statement;
  return toStringRecordId(value);
}

/**
 * 用显式环境变量完成首次平台运营主体 bootstrap。
 *
 * 该操作是“补缺失”而非权限同步：已禁用主体与已撤销能力保持原状态，避免
 * 重启服务意外恢复权限。未配置主体时完全 no-op；配置主体却未配置能力时
 * 直接失败，防止部署者误以为主体已经具备运营权限。
 */
export async function seedPlatformOperators(
  db: PlatformOperatorSeedClient = getRootConnection(),
  options: SeedPlatformOperatorsOptions = {},
): Promise<SeedPlatformOperatorsResult> {
  const subjects = parseCsv(options.subjectsCsv ?? env.PLATFORM_OPERATOR_SUBJECTS);
  const testManagers = parseCsv(options.testManagersCsv ?? env.PLATFORM_OPERATOR_TEST_MANAGERS);
  const testAgents = parseCsv(options.testAgentsCsv ?? env.PLATFORM_OPERATOR_TEST_AGENTS);
  if (subjects.length === 0) {
    if (testAgents.length > 0) {
      await seedTestAgents(db, testAgents, options.namespace ?? env.SURREAL_NS,
        options.grantedBySubject ?? env.PLATFORM_OPERATOR_GRANTOR_SUBJECT ?? DEFAULT_GRANTOR);
    }
    return { seededSubjects: [], capabilities: [] };
  }

  const capabilities = parseCapabilities(
    options.capabilitiesCsv ?? env.PLATFORM_OPERATOR_CAPABILITIES,
  );
  if (capabilities.length === 0) {
    throw new Error(
      "PLATFORM_OPERATOR_SUBJECTS requires PLATFORM_OPERATOR_CAPABILITIES",
    );
  }

  const namespace = options.namespace ?? env.SURREAL_NS;
  const displayName = options.displayName ?? env.PLATFORM_OPERATOR_DISPLAY_NAME;
  const grantedBySubject =
    options.grantedBySubject
    ?? env.PLATFORM_OPERATOR_GRANTOR_SUBJECT
    ?? DEFAULT_GRANTOR;

  await db.use({ namespace, database: SYSTEM_DATABASE });

  for (const subject of subjects) {
    if (displayName) {
      await db.query(
        `
          INSERT INTO platform_operator {
            subject: $subject,
            display_name: $displayName,
            status: "active"
          }
          ON DUPLICATE KEY UPDATE
            display_name = $displayName,
            updated_at = time::now();
        `,
        { subject, displayName },
      );
    } else {
      await db.query(
        `
          INSERT INTO platform_operator {
            subject: $subject,
            status: "active"
          }
          ON DUPLICATE KEY UPDATE updated_at = time::now();
        `,
        { subject },
      );
    }

    const operatorResult = await db.query(
      "SELECT VALUE id FROM platform_operator WHERE subject = $subject LIMIT 1;",
      { subject },
    );
    const operator = firstRecordId(operatorResult);
    if (!operator) {
      throw new Error(`platform operator bootstrap did not resolve subject ${subject}`);
    }

    for (const capability of capabilities) {
      await db.query(
        `
          INSERT INTO platform_operator_capability {
            operator: $operator,
            capability: $capability,
            status: "active",
            granted_by_subject: $grantedBySubject
          }
          ON DUPLICATE KEY UPDATE updated_at = time::now();
        `,
        {
          operator,
          capability,
          grantedBySubject,
        },
      );
    }
  }

  // 测试主体管理通道：PLATFORM_OPERATOR_TEST_MANAGERS 列出的 subject 仅获得
  // test.manage；与 SUBJECTS/CAPABILITIES 同样「补缺失、不回滚」语义。
  for (const subject of testManagers) {
    await db.query(
      `INSERT INTO platform_operator { subject: $subject, status: "active" }
       ON DUPLICATE KEY UPDATE updated_at = time::now();`,
      { subject },
    );
    const opRow = await db.query(
      "SELECT VALUE id FROM platform_operator WHERE subject = $subject LIMIT 1;",
      { subject },
    );
    const operator = firstRecordId(opRow);
    if (!operator) {
      throw new Error(`platform operator bootstrap did not resolve subject ${subject}`);
    }
    await db.query(
      `INSERT INTO platform_operator_capability { operator: $operator, capability: "test.manage", status: "active", granted_by_subject: $grantedBySubject }
       ON DUPLICATE KEY UPDATE updated_at = time::now();`,
      { operator, grantedBySubject },
    );
  }

  await seedTestAgents(db, testAgents, namespace, grantedBySubject);

  console.info("[platform-operator-seed] bootstrapped operators", {
    subjects: subjects.length,
    capabilities: capabilities.length,
  });
  return { seededSubjects: subjects, capabilities };
}

/**
 * 测试物料 agent：kind=agent 的运营主体，只授 test.provision。与其它通道同为「补缺失、不回滚」：
 * 已禁用的主体或已撤销的能力保持原状；若该 subject 已被登记为 human 运营主体则拒绝改 kind。
 */
async function seedTestAgents(
  db: PlatformOperatorSeedClient,
  subjects: readonly string[],
  namespace: string,
  grantedBySubject: string,
): Promise<void> {
  if (subjects.length === 0) return;
  await db.use({ namespace, database: SYSTEM_DATABASE });
  for (const subject of subjects) {
    const existing = await db.query(
      "SELECT VALUE kind FROM platform_operator WHERE subject = $subject LIMIT 1;",
      { subject },
    );
    const kind = Array.isArray(existing) && Array.isArray(existing[0]) ? existing[0][0] : undefined;
    if (kind === "human") {
      throw new Error(`PLATFORM_OPERATOR_TEST_AGENTS subject ${subject} is already a human operator`);
    }
    await db.query(
      `INSERT INTO platform_operator { subject: $subject, display_name: "测试物料 agent", status: "active", kind: "agent" }
       ON DUPLICATE KEY UPDATE updated_at = time::now();`,
      { subject },
    );
    const operator = firstRecordId(await db.query(
      "SELECT VALUE id FROM platform_operator WHERE subject = $subject LIMIT 1;",
      { subject },
    ));
    if (!operator) throw new Error(`platform operator bootstrap did not resolve subject ${subject}`);
    await db.query(
      `INSERT INTO platform_operator_capability { operator: $operator, capability: "test.provision", status: "active", granted_by_subject: $grantedBySubject }
       ON DUPLICATE KEY UPDATE updated_at = time::now();`,
      { operator, grantedBySubject },
    );
  }
}
