import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { StringRecordId } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString } from "../db/surreal-values";

type Queryable = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

type Row = Record<string, unknown>;

const rows = (v: unknown): Row[] => {
  if (!Array.isArray(v)) return [];
  const first = v[0];
  if (Array.isArray(first)) return first as Row[];
  return first !== null && typeof first === "object" ? [first as Row] : [];
};

export class PlatformSecretError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlatformSecretError";
  }
}

export type PlatformSecretValue = Readonly<{
  name: string;
  value: string;
  updatedAt: string | null;
  updatedBy: string;
}>;

export type PlatformSecretMeta = Readonly<{
  name: string;
  purpose: string | null;
  updatedAt: string | null;
  updatedBy: string;
}>;

/**
 * 平台密封密钥仓：运行时密文存 _system.platform_secret（PERMISSIONS NONE，仅 root
 * 维护会话可写），明文在库内任何地方都不落盘。AES-256-GCM 封套与
 * ChatDeliveryStore 同一约定（v/iv/tag/data），AAD 绑定 secret name，防止
 * 跨槽位替换密文。解封密钥只存在于 server 进程环境 PLATFORM_SECRET_KEY，
 * 不进入库、日志或响应。
 *
 * 写入路径 UPSERT 既有行并写 platform_secret_event 审计锚点；审计只记
 * actor 与元数据，不记明文与密文差异。
 */
export class PlatformSecretStore {
  private readonly key: Buffer;

  constructor(
    hexKey: string,
    private readonly session: (database: string, namespace?: string) => Promise<Queryable> = getRootDatabaseSession,
    private readonly database = "_system",
  ) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey)) {
      throw new Error("PLATFORM_SECRET_KEY must be a 32-byte hex key");
    }
    this.key = Buffer.from(hexKey, "hex");
  }

  private seal(name: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`platform-secret:${name}`));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return JSON.stringify({
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }

  private open(name: string, envelope: string): string {
    try {
      const parsed = JSON.parse(envelope) as { v?: number; alg?: string; iv?: string; tag?: string; data?: string };
      if (parsed.v !== 1 || parsed.alg !== "aes-256-gcm"
        || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.data !== "string") {
        throw new Error("malformed envelope");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parsed.iv, "base64"));
      decipher.setAAD(Buffer.from(`platform-secret:${name}`));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
    } catch (error) {
      if (error instanceof PlatformSecretError) throw error;
      throw new PlatformSecretError(
        "secret-unseal-failed",
        `密封密钥 ${name} 解封失败：密钥不匹配或密文损坏`,
      );
    }
  }

  /** 读取并解封；行不存在返回 null，解封失败抛 PlatformSecretError（fail closed）。 */
  async get(name: string): Promise<PlatformSecretValue | null> {
    const db = await this.session(this.database);
    const found = rows(await db.query(
      "SELECT envelope, updated_by, updated_at FROM ONLY $id;",
      { id: new StringRecordId(`platform_secret:${name}`) },
    ))[0];
    if (!found || typeof found.envelope !== "string") return null;
    return {
      name,
      value: this.open(name, found.envelope),
      updatedAt: toIsoDateTimeString(found.updated_at),
      updatedBy: typeof found.updated_by === "string" ? found.updated_by : "unknown",
    };
  }

  /** 只读元数据（status 端点用）：不解封、不接触明文。 */
  async describe(name: string): Promise<PlatformSecretMeta | null> {
    const db = await this.session(this.database);
    const found = rows(await db.query(
      "SELECT name, purpose, updated_by, updated_at FROM ONLY $id;",
      { id: new StringRecordId(`platform_secret:${name}`) },
    ))[0];
    if (!found || typeof found.name !== "string") return null;
    return {
      name: found.name,
      purpose: typeof found.purpose === "string" ? found.purpose : null,
      updatedAt: toIsoDateTimeString(found.updated_at),
      updatedBy: typeof found.updated_by === "string" ? found.updated_by : "unknown",
    };
  }

  /**
   * 写入/轮换：UPSERT 密文行并追加审计事件（同一 query，原子落盘）。
   * 写后立刻回读解封自检，确保持久化的密文可被当前密钥打开。
   */
  async put(name: string, plaintext: string, input: {
    actor: string;
    purpose?: string;
    action?: "rotate" | "seed";
    source?: string;
    detail?: Record<string, unknown>;
  }): Promise<PlatformSecretMeta> {
    const db = await this.session(this.database);
    const envelope = this.seal(name, plaintext);
    try {
      await db.query(
        `UPSERT ONLY $id SET
          name = $name, envelope = $envelope, purpose = $purpose ?? NONE,
          updated_by = $actor, updated_at = time::now();
        CREATE platform_secret_event CONTENT {
          secret_name: $name, action: $action, actor_subject: $actor,
          source: $source, detail: $detail ?? NONE, occurred_at: time::now()
        };`,
        {
          id: new StringRecordId(`platform_secret:${name}`),
          name,
          envelope,
          purpose: input.purpose ?? null,
          actor: input.actor,
          action: input.action ?? "rotate",
          source: input.source ?? "ops_api",
          detail: input.detail ?? null,
        },
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new PlatformSecretError(
        "secret-write-failed",
        `密封密钥 ${name} 写入失败：${cause}`,
        { cause: error },
      );
    }
    const persisted = await this.get(name);
    if (!persisted || persisted.value !== plaintext) {
      throw new PlatformSecretError("secret-write-verify-failed", `密封密钥 ${name} 写后校验失败`);
    }
    return {
      name,
      purpose: input.purpose ?? null,
      updatedAt: persisted.updatedAt,
      updatedBy: input.actor,
    };
  }
}

/** 由环境装配；缺少 PLATFORM_SECRET_KEY 时返回 null，调用方据此降级/拒绝轮换。 */
export function createPlatformSecretStore(hexKey: string | undefined): PlatformSecretStore | null {
  return hexKey ? new PlatformSecretStore(hexKey) : null;
}
