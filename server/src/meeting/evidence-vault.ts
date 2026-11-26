import {
  createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes,
} from "node:crypto";
import type { S3Client } from "bun";

export type EvidenceScope = Readonly<{ workspace: string; meeting: string }>;
export type EvidenceJson = null | boolean | number | string | readonly EvidenceJson[]
  | { readonly [key: string]: EvidenceJson };

export interface EvidenceObjects {
  read(key: string): Promise<Uint8Array | null>;
  create(key: string, content: Uint8Array): Promise<boolean>;
  list?(key: string): Promise<string[]>;
}

export function privateEvidenceBucket(bucket: S3Client, request: typeof fetch = fetch): EvidenceObjects {
  return {
    async read(key) {
      const result = await request(bucket.presign(key, { method: "GET", expiresIn: 30 }), { redirect: "error" });
      if (result.status === 404) return null;
      if (!result.ok) throw new Error("无法读取私有会议存证对象");
      return new Uint8Array(await result.arrayBuffer());
    },
    async create(key, content) {
      const result = await request(bucket.presign(key, { method: "PUT", expiresIn: 30 }), {
        method: "PUT", headers: { "If-None-Match": "*" }, body: Buffer.from(content), redirect: "error",
      });
      if (result.status === 412) return false;
      if (!result.ok) throw new Error("无法写入私有会议存证对象");
      return true;
    },
  };
}

const safePart = /^[a-zA-Z0-9_-]{1,128}$/u;
const tagSize = 16;
const nonceSize = 12;
const digestSize = 32;
export const evidenceHash = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
function serialize(value: EvidenceJson): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("会议存证数值无效");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const object = value as { readonly [key: string]: EvidenceJson };
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${serialize(object[key]!)}`).join(",")}}`;
}

export const evidenceJson = (value: EvidenceJson): Buffer => Buffer.from(serialize(value), "utf8");

function objectKey(scope: EvidenceScope, name: string): string {
  if (!safePart.test(scope.workspace) || !safePart.test(scope.meeting)
    || !name.split("/").every((part) => /^[a-zA-Z0-9_.-]{1,128}$/u.test(part) && part !== "." && part !== "..")) {
    throw new Error("会议存证对象路径无效");
  }
  return `v1/${scope.workspace}/${scope.meeting}/${name}`;
}

function encrypt(key: Uint8Array, clear: Uint8Array, context: string): Buffer {
  const nonce = randomBytes(nonceSize);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const output = Buffer.concat([cipher.update(clear), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), output]);
}

function decrypt(key: Uint8Array, sealed: Uint8Array, context: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, nonceSize));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(sealed.subarray(nonceSize, nonceSize + tagSize));
  return Buffer.concat([decipher.update(sealed.subarray(nonceSize + tagSize)), decipher.final()]);
}

export class EvidenceVault {
  constructor(
    private readonly objects: EvidenceObjects,
    private readonly workspaceKey: (workspace: string) => Promise<Uint8Array>,
  ) {}

  list(scope: EvidenceScope, directory: string) {
    if (!this.objects.list) throw new Error("会议存证后端不支持任务枚举");
    return this.objects.list(objectKey(scope, directory));
  }

  private async wrappingKey(workspace: string): Promise<Uint8Array> {
    const key = await this.workspaceKey(workspace);
    if (key.byteLength !== digestSize) throw new Error("工作区存证密钥长度无效");
    return key;
  }

  async create(scope: EvidenceScope, name: string, plaintext: Uint8Array): Promise<boolean> {
    const path = objectKey(scope, name);
    const dataKey = randomBytes(digestSize);
    try {
      const wrapped = encrypt(await this.wrappingKey(scope.workspace), dataKey, `key:${path}`);
      return await this.objects.create(path, Buffer.concat([wrapped, encrypt(dataKey, plaintext, `data:${path}`)]));
    } finally { dataKey.fill(0); }
  }

  async read(scope: EvidenceScope, name: string): Promise<Buffer | null> {
    const path = objectKey(scope, name);
    const ciphertext = await this.objects.read(path);
    if (ciphertext === null) return null;
    const wrappedSize = nonceSize + tagSize + digestSize;
    const key = decrypt(await this.wrappingKey(scope.workspace), ciphertext.subarray(0, wrappedSize), `key:${path}`);
    try {
      return decrypt(key, ciphertext.subarray(wrappedSize), `data:${path}`);
    } finally { key.fill(0); }
  }
}

export function deriveEvidenceWorkspaceKey(master: Uint8Array): (workspace: string) => Promise<Uint8Array> {
  if (master.byteLength !== digestSize) throw new Error("存证主密钥长度无效");
  return async (workspace) => Buffer.from(hkdfSync("sha256", master, "ck-meeting-evidence-v1", workspace, digestSize));
}
