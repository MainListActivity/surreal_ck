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
  if (subjects.length === 0) {
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

  console.info("[platform-operator-seed] bootstrapped operators", {
    subjects: subjects.length,
    capabilities: capabilities.length,
  });
  return { seededSubjects: subjects, capabilities };
}
