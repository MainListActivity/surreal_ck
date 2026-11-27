import { randomUUID } from "node:crypto";
import { DateTime, RecordId, SurrealError } from "surrealdb";
import { getRootDatabaseSession } from "../db/root-connection";
import { toIsoDateTimeString } from "../db/surreal-values";
import { env } from "../env";
import { HttpError } from "../http-error";
import { signPayload, verifySignature } from "../secure-token";
import { privateEvidenceDirectory } from "./evidence-filesystem";
import { EvidenceJobs, type EvidenceJob } from "./evidence-jobs";
import { MeetingEvidenceLedger, type EvidenceArtifact, type EvidenceEvent } from "./evidence-ledger";
import { deriveEvidenceWorkspaceKey, evidenceHash, evidenceJson, EvidenceVault, type EvidenceJson } from "./evidence-vault";
import { rows, type RosterQuery } from "./roster-votes";

const day = 86_400_000;
const ticketTtl = 60_000;
const deny = () => new HttpError(403, "meeting-evidence-denied", "无权下载会议存证包");
const conflict = () => new HttpError(409, "meeting-evidence-conflict", "会议存证尚未封存或工作区投影与可信根不一致");
const digest = (value: string) => evidenceHash(Buffer.from(value)).toString("hex");
const scoped = (workspace: string, meeting: string) => ({ workspace, meeting: digest(meeting) });
const projectionId = (meeting: string) => new RecordId("meeting_evidence_archive", digest(meeting));
type Projection = { meeting: string; root_sha256: Uint8Array | ArrayBuffer; sealed_at: DateTime; retain_until: DateTime };

export class MeetingEvidenceArchive {
  private readonly ledger: MeetingEvidenceLedger;

  constructor(
    private readonly vault: EvidenceVault,
    private readonly signingKey: string,
    private readonly retentionDays: number,
    private readonly dbFor: (workspace: string) => Promise<RosterQuery> = getRootDatabaseSession,
    private readonly now = Date.now,
  ) { this.ledger = new MeetingEvidenceLedger(vault); }

  append(workspace: string, meeting: string, event: EvidenceEvent) {
    return this.ledger.append(scoped(workspace, meeting), event);
  }

  events(workspace: string, meeting: string) {
    return this.ledger.events(scoped(workspace, meeting));
  }

  finalization(finalize: (job: EvidenceJob) => Promise<void>) {
    return new EvidenceJobs(this.vault, finalize);
  }

  async seal(workspace: string, meeting: string, at: string, metadata: EvidenceJson, artifacts: ReadonlyMap<string, EvidenceArtifact>) {
    const scope = scoped(workspace, meeting);
    const retainUntil = new Date(Date.parse(at) + this.retentionDays * day).toISOString();
    await this.ledger.seal(scope, at, { meeting, sealedAt: at, retainUntil, meetingMetadata: metadata }, artifacts);
    return this.publish(workspace, meeting);
  }

  async publish(workspace: string, meeting: string) {
    const scope = scoped(workspace, meeting);
    const root = await this.vault.read(scope, "root.sha256");
    if (!root) throw conflict();
    const manifest = await this.ledger.verifiedManifest(scope, root.toString("hex"));
    const { sealedAt: at, retainUntil } = manifest.metadata as { sealedAt: string; retainUntil: string };
    const db = await this.dbFor(workspace);
    const id = projectionId(meeting);
    const previous = await this.projection(db, meeting);
    if (!previous) {
      try {
        await db.query("CREATE $id CONTENT $projection;", { id, projection: {
          meeting, root_sha256: new Uint8Array(root), sealed_at: new DateTime(new Date(at)),
          retain_until: new DateTime(new Date(retainUntil)),
        } });
      } catch (error) {
        if (!(error instanceof SurrealError) || !await this.projection(db, meeting)) throw error;
      }
    }
    return this.status(workspace, meeting);
  }

  private async projection(db: RosterQuery, meeting: string) {
    return rows<Projection>(await db.query("SELECT * FROM $id;", { id: projectionId(meeting) }))[0];
  }

  async status(workspace: string, meeting: string) {
    const scope = scoped(workspace, meeting);
    const trusted = await this.vault.read(scope, "root.sha256");
    if (!trusted) throw conflict();
    const projection = await this.projection(await this.dbFor(workspace), meeting);
    const projected = projection?.root_sha256 instanceof ArrayBuffer ? new Uint8Array(projection.root_sha256) : projection?.root_sha256;
    if (!projection || projection.meeting !== meeting || !(projected instanceof Uint8Array) || !trusted.equals(projected)) throw conflict();
    const root = trusted.toString("hex");
    const manifest = await this.ledger.verifiedManifest(scope, root);
    const metadata = manifest.metadata as { retainUntil?: string; sealedAt?: string };
    const retainUntil = metadata.retainUntil;
    const sealedAt = metadata.sealedAt;
    if (!retainUntil || !sealedAt || retainUntil !== toIsoDateTimeString(projection.retain_until)
      || sealedAt !== toIsoDateTimeString(projection.sealed_at)) throw conflict();
    return { root, retainUntil, sealedAt,
      backupReminder: Date.parse(retainUntil) - this.now() <= 30 * day };
  }

  async hasRoot(workspace: string, meeting: string) {
    return !!await this.vault.read(scoped(workspace, meeting), "root.sha256");
  }

  private async audit(workspace: string, meeting: string, nonce: string, subject: string, operation: "grant" | "download") {
    return this.vault.create(scoped(workspace, meeting), `audit/${nonce}-${operation}.json`, evidenceJson({
      operation, subject, at: new Date(this.now()).toISOString(),
    }));
  }

  async grant(workspace: string, meeting: string, subject: string) {
    const status = await this.status(workspace, meeting);
    const nonce = randomUUID();
    const expiresAt = this.now() + ticketTtl;
    const binding = `${expiresAt}.${nonce}`;
    const signature = signPayload(JSON.stringify([workspace, meeting, subject, binding]), this.signingKey);
    await this.audit(workspace, meeting, nonce, subject, "grant");
    return { ...status, expiresAt, token: `${binding}.${signature}` };
  }

  async download(workspace: string, meeting: string, subject: string, token: string) {
    const [, expires, nonce, signature] = /^(\d{13})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(token) ?? [];
    if (!expires || !nonce || !signature) throw deny();
    if (Number(expires) <= this.now() || !verifySignature(JSON.stringify([workspace, meeting, subject, `${expires}.${nonce}`]),
      signature, this.signingKey)) throw deny();
    const status = await this.status(workspace, meeting);
    const blob = await this.ledger.exportPackage(scoped(workspace, meeting), status.root);
    if (!await this.audit(workspace, meeting, nonce, subject, "download")) throw deny();
    return blob;
  }
}

export function configuredMeetingEvidence(): MeetingEvidenceArchive | undefined {
  const { MEETING_EVIDENCE_DIR: directory, MEETING_EVIDENCE_MASTER_KEY: key, MEETING_EVIDENCE_RETENTION_DAYS: retention } = env;
  if (!directory && !key) return;
  if (!directory || !key) {
    throw new Error("会议存证目录、密钥或保留期配置无效");
  }
  const master = Buffer.from(key, "hex");
  return new MeetingEvidenceArchive(new EvidenceVault(privateEvidenceDirectory(directory), deriveEvidenceWorkspaceKey(master)),
    signPayload("meeting-evidence-download-v1", key), retention);
}
