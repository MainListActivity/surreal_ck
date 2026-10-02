import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { StringRecordId, type Surreal } from "surrealdb";
import type { AiDeliveryProof, ChatStreamEvent } from "@surreal-ck/shared";
import type { OpenContentResearchSession } from "../../ai/mastra/workflows/router-workflow";
import { isRetryableTxnError } from "../ai-allowance/service";
import { HttpError } from "../http-error";

export type DoneEvent = Extract<ChatStreamEvent, { kind: "done" }>;
export type DeliveryRow = { run_id: string; nonce: string; request_hash: string; status: "running" | "suspended" | "complete" | "failed"; envelope?: string };
export type DeliveryPayload = { event: DoneEvent; proofs: AiDeliveryProof[] };
type Session = Pick<Surreal, "query">;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const requestDigest = digest;

function first<T>(value: unknown): T | undefined {
  return Array.isArray(value) && Array.isArray(value[0]) ? value[0][0] as T | undefined : undefined;
}
function denied(): never { throw new HttpError(409, "authorization_changed", "当前材料或授权已变化，不能补取旧答案，请重新研究。"); }

/** Caller session persists an authenticated ciphertext; no root business access or plaintext snapshot. */
export class ChatDeliveryStore {
  private readonly key: Buffer;
  constructor(hexKey: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey)) throw new Error("AI_DELIVERY_KEY must be a 32-byte hex key");
    this.key = Buffer.from(hexKey, "hex");
  }
  async claim(session: Session, input: { requestKey: string; requestHash: string; runId: string }): Promise<{ row: DeliveryRow; fresh: boolean }> {
    const nonce = crypto.randomUUID();
    let row: DeliveryRow | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        row = first<DeliveryRow>(await session.query(`INSERT INTO chat_delivery $content
      ON DUPLICATE KEY UPDATE request_key = $content.request_key RETURN AFTER;`, {
      content: { request_key: input.requestKey, request_hash: input.requestHash, run_id: input.runId, nonce, status: "running" },
    }));
        break;
      } catch (error) {
        if (!isRetryableTxnError(error) || attempt === 4) throw error;
      }
    }
    if (!row) throw new HttpError(403, "chat-run-forbidden", "当前身份不能启动研究");
    if (row.request_hash !== input.requestHash) throw new HttpError(409, "chat-idempotency-conflict", "重试必须使用原始问题与上下文");
    return { row, fresh: row.nonce === nonce };
  }
  async find(session: Session, runId: string): Promise<DeliveryRow | undefined> {
    const row = first<DeliveryRow>(await session.query(`SELECT * FROM chat_delivery WHERE run_id = $runId
      AND owner_user = fn::current_user() AND (SELECT VALUE disabled_at FROM ONLY fn::current_user()) = NONE LIMIT 1;`, { runId }));
    return row;
  }
  async read(session: Session, runId: string): Promise<DeliveryRow> {
    const row = await this.find(session, runId);
    if (!row) throw new HttpError(403, "chat-run-forbidden", "当前身份不能读取该研究");
    return row;
  }
  private aad(db: string, subject: string, runId: string): Buffer { return Buffer.from(JSON.stringify([db, subject, runId])); }
  async save(session: Session, db: string, subject: string, payload: DeliveryPayload): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(db, subject, payload.event.runId));
    const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    const envelope = JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    const row = first<DeliveryRow>(await session.query(`UPDATE chat_delivery SET status = "complete", envelope = $envelope
      WHERE run_id = $runId AND owner_user = fn::current_user() AND status INSIDE ["running", "suspended"] RETURN AFTER;`, { runId: payload.event.runId, envelope }));
    if (!row || row.envelope !== envelope) throw new Error("chat delivery persistence failed");
    // Read-back is required before billing succeeds.
    this.decrypt(await this.read(session, payload.event.runId), db, subject);
  }
  decrypt(row: DeliveryRow, db: string, subject: string): DeliveryPayload {
    try {
      const envelope = JSON.parse(row.envelope ?? "") as { v: number; iv: string; tag: string; data: string };
      if (envelope.v !== 1) return denied();
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(this.aad(db, subject, row.run_id));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString()) as DeliveryPayload;
      if (payload.event.kind !== "done" || payload.event.runId !== row.run_id || !Array.isArray(payload.proofs)) return denied();
      return payload;
    } catch { return denied(); }
  }
  async status(session: Session, runId: string, status: "failed" | "suspended"): Promise<void> {
    await session.query(`UPDATE chat_delivery SET status = $status WHERE run_id = $runId
      AND owner_user = fn::current_user() AND status INSIDE ["running", "suspended"];`, { runId, status });
  }
}

/** Re-open current RECORD authorization and verify all prompt evidence, including uncited material. */
export async function authorizeDelivery(session: Session, proofs: readonly AiDeliveryProof[], openContentSession?: OpenContentResearchSession): Promise<void> {
  const current = await session.query(`RETURN fn::current_user() != NONE AND (SELECT VALUE disabled_at FROM ONLY fn::current_user()) = NONE;`);
  if (!Array.isArray(current) || current[0] !== true) return denied();
  for (const proof of proofs) {
    if (proof.platform.length || proof.authorization.kind === "ready") {
      const window = await openContentSession?.();
      if (!window || window.kind !== "ready") return denied();
      try {
        if (window.entitlementRevision !== proof.authorization.revision || window.digest !== proof.authorization.digest
          || window.leaseEndSeconds <= Date.now() / 1000) return denied();
        for (const item of proof.platform) {
          const row = first<{ body_sha256?: string; ai?: boolean; read?: boolean; cite?: boolean }>(await window.session.query(`SELECT body_sha256,
            fn::content_reader_action(id, 'ai_use') AS ai, fn::content_reader_action(id, 'read') AS read,
            fn::content_reader_action(id, 'cite') AS cite FROM $version;`, { version: new StringRecordId(item.versionId) }));
          if (!row || row.body_sha256 !== item.bodySha256 || row.ai !== true || row.read !== true || (item.cite && row.cite !== true)) return denied();
        }
      } finally { await window.close(); }
    }
    for (const item of proof.private) {
      const row = first<{ evidence?: Array<{ text?: string }> }>(await session.query("SELECT evidence FROM $resource;", { resource: new StringRecordId(item.resourceId) }));
      if (!row?.evidence?.some(e => typeof e.text === "string" && digest(e.text.trim()) === item.quoteSha256)) return denied();
    }
  }
}
