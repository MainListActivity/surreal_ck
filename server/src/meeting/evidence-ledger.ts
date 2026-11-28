import { createHash } from "node:crypto";
import { streamEvidenceTar } from "./evidence-tar";
import { evidenceHash, evidenceJson, type EvidenceJson, type EvidenceScope, type EvidenceVault } from "./evidence-vault";

const hashPattern = /^[a-f0-9]{64}$/u;
const pathPattern = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/u;
const genesis = "0".repeat(64);
const rootObject = "root.sha256";
const manifestObject = "manifest.json";
const partSize = 4 * 1024 * 1024;

export type EvidenceEvent = Readonly<{ id: string; kind: string; at: string; payload: EvidenceJson }>;
export type EvidenceArtifact = Uint8Array | Bun.BunFile;
type LedgerEntry = Readonly<{ sequence: number; previous: string; event: EvidenceEvent }>;
type LedgerTail = Readonly<{ sequence: number; digest: string; sealed: boolean }>;
export type EvidenceItem = Readonly<{ path: string; bytes: number; sha256: string; parts?: number }>;
export type EvidenceManifest = Readonly<{
  version: 1;
  workspace: string;
  meeting: string;
  ledger: { sequence: number; sha256: string };
  metadata: EvidenceJson;
  files: readonly EvidenceItem[];
}>;

export interface EvidenceTimestampAuthority {
  timestamp(digest: Uint8Array): Promise<Uint8Array>;
}

function ledgerPath(sequence: number): string {
  return `ledger/${sequence.toString().padStart(16, "0")}.json`;
}

function artifactPath(path: string): string {
  if (!pathPattern.test(path) || [rootObject, manifestObject, "ledger.json", "tsa-response.bin", "VERIFICATION.txt"].includes(path)) {
    throw new Error("会议存证产物名称无效");
  }
  return `files/${path}`;
}

const fileKey = (path: string) => path === "ledger.json" ? "files/ledger.json" : artifactPath(path);
const partKey = (path: string, index: number) => `chunks/${path}/${index}`;

export function verifyEvidenceManifest(manifest: Uint8Array, trustedRoot: Uint8Array): EvidenceManifest {
  if (trustedRoot.byteLength !== 32 || !evidenceHash(manifest).equals(trustedRoot)) {
    throw new Error("会议存证清单 SHA-256 不匹配");
  }
  return JSON.parse(Buffer.from(manifest).toString("utf8")) as EvidenceManifest;
}

export function verifyEvidenceArtifact(item: EvidenceItem, bytes: Uint8Array): void {
  if (item.bytes !== bytes.byteLength || item.sha256 !== evidenceHash(bytes).toString("hex")) {
    throw new Error(`会议存证产物 SHA-256 或长度不匹配: ${item.path}`);
  }
}

export class MeetingEvidenceLedger {
  constructor(private readonly vault: EvidenceVault, private readonly tsa?: EvidenceTimestampAuthority) {}

  private async entries(scope: EvidenceScope): Promise<{ records: LedgerEntry[]; tail: LedgerTail }> {
    const records: LedgerEntry[] = [];
    let digest = genesis;
    let sealed = false;
    for (let sequence = 1; ; sequence++) {
      const bytes = await this.vault.read(scope, ledgerPath(sequence));
      if (bytes === null) return { records, tail: { sequence: sequence - 1, digest, sealed } };
      const entry = JSON.parse(bytes.toString("utf8")) as LedgerEntry;
      if (entry.sequence !== sequence || entry.previous !== digest || sealed) {
        throw new Error("会议存证账本校验失败");
      }
      digest = evidenceHash(bytes).toString("hex");
      sealed = entry.event.kind === "seal";
      records.push(entry);
    }
  }

  private async appendEntry(scope: EvidenceScope, event: EvidenceEvent, whileOpen = false): Promise<void> {
    for (;;) {
      const { records, tail } = await this.entries(scope);
      const existing = records.find((item) => item.event.id === event.id);
      if (existing) {
        if (evidenceJson(existing.event).equals(evidenceJson(event))) return;
        throw new Error("会议存证事件标识冲突");
      }
      if (tail.sealed) {
        if (whileOpen) return;
        throw new Error("会议存证账本已封存");
      }
      const entry = { sequence: tail.sequence + 1, previous: tail.digest, event };
      if (await this.vault.create(scope, ledgerPath(entry.sequence), evidenceJson(entry))) return;
    }
  }

  append(scope: EvidenceScope, event: EvidenceEvent, { whileOpen = false } = {}): Promise<void> {
    if (!event.id || event.id === "seal" || !event.kind || event.kind === "seal" || !Number.isFinite(Date.parse(event.at))) {
      throw new Error("会议存证事件无效");
    }
    return this.appendEntry(scope, event, whileOpen);
  }

  async events(scope: EvidenceScope): Promise<EvidenceEvent[]> {
    const { records } = await this.entries(scope);
    return records.filter(({ event }) => event.kind !== "seal").map(({ event }) => event);
  }

  private async immutable(scope: EvidenceScope, key: string, bytes: Buffer): Promise<void> {
    if (!(await this.vault.create(scope, key, bytes)) && !(await this.vault.read(scope, key))?.equals(bytes)) {
      throw new Error(`会议存证对象与已冻结版本不同: ${key}`);
    }
  }

  private async storeArtifact(scope: EvidenceScope, path: string, artifact: EvidenceArtifact): Promise<EvidenceItem> {
    const key = fileKey(path);
    const bytes = artifact instanceof Uint8Array ? artifact.byteLength : artifact.size;
    if (artifact instanceof Uint8Array && bytes <= partSize) {
      await this.immutable(scope, key, Buffer.from(artifact));
      return { path, bytes, sha256: evidenceHash(artifact).toString("hex") };
    }
    const hash = createHash("sha256");
    let parts = 0;
    for (let offset = 0; offset < bytes; offset += partSize) {
      const chunk = artifact instanceof Uint8Array ? Buffer.from(artifact.subarray(offset, offset + partSize))
        : Buffer.from(await artifact.slice(offset, offset + partSize).arrayBuffer());
      if (chunk.byteLength !== Math.min(partSize, bytes - offset)) throw new Error("会议存证源文件长度变化");
      hash.update(chunk);
      await this.immutable(scope, partKey(path, parts++), chunk);
    }
    return { path, bytes, sha256: hash.digest("hex"), parts };
  }

  async seal(
    scope: EvidenceScope, sealedAt: string, metadata: EvidenceJson, artifacts: ReadonlyMap<string, EvidenceArtifact>,
  ): Promise<Buffer> {
    if (!Number.isFinite(Date.parse(sealedAt))) throw new Error("会议存证封存时间无效");
    for (const name of artifacts.keys()) artifactPath(name);
    await this.appendEntry(scope, { id: "seal", kind: "seal", at: sealedAt, payload: null });
    const { records, tail } = await this.entries(scope);
    const files = new Map(artifacts);
    files.set("ledger.json", evidenceJson(records));
    const items: EvidenceItem[] = [];
    for (const name of [...files.keys()].sort()) items.push(await this.storeArtifact(scope, name, files.get(name)!));
    const manifest = evidenceJson({
      version: 1, workspace: scope.workspace, meeting: scope.meeting,
      ledger: { sequence: tail.sequence, sha256: tail.digest }, metadata, files: items,
    } satisfies EvidenceManifest);
    const root = evidenceHash(manifest);
    await this.immutable(scope, manifestObject, manifest);
    if (this.tsa && (await this.vault.read(scope, "tsa-response.bin")) === null) {
      const response = await this.tsa.timestamp(Uint8Array.from(root));
      if (response.byteLength === 0) throw new Error("会议存证时间戳回执为空");
      await this.vault.create(scope, "tsa-response.bin", response);
    }
    await this.immutable(scope, rootObject, root);
    return root;
  }

  async verifiedManifest(scope: EvidenceScope, projectedRoot: string | undefined): Promise<EvidenceManifest> {
    const root = await this.vault.read(scope, rootObject);
    if (root === null || projectedRoot === undefined || !hashPattern.test(projectedRoot) || root.toString("hex") !== projectedRoot) {
      throw new Error("工作区会议存证投影与可信根不匹配");
    }
    const manifest = await this.vault.read(scope, manifestObject);
    if (manifest === null) throw new Error("缺少会议存证清单");
    const decoded = verifyEvidenceManifest(manifest, root);
    const { tail } = await this.entries(scope);
    if (!tail.sealed || tail.digest !== decoded.ledger.sha256 || tail.sequence !== decoded.ledger.sequence) {
      throw new Error("会议存证账本与清单不匹配");
    }
    return decoded;
  }

  async readVerifiedArtifact(scope: EvidenceScope, item: EvidenceItem): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.artifactChunks(scope, item)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  private async *artifactChunks(scope: EvidenceScope, item: EvidenceItem) {
    const key = fileKey(item.path);
    if (item.parts === undefined) {
      const bytes = await this.vault.read(scope, key);
      if (bytes === null) throw new Error("缺少会议存证产物");
      verifyEvidenceArtifact(item, bytes);
      yield bytes;
      return;
    }
    if (item.parts !== Math.ceil(item.bytes / partSize)) throw new Error("会议存证产物分块数量无效");
    const hash = createHash("sha256");
    for (let index = 0; index < item.parts; index++) {
      const chunk = await this.vault.read(scope, partKey(item.path, index));
      if (chunk?.length !== Math.min(partSize, item.bytes - index * partSize)) throw new Error("会议存证分块长度不匹配");
      hash.update(chunk);
      if (index === item.parts - 1 && hash.digest("hex") !== item.sha256) throw new Error("会议存证产物 SHA-256 不匹配");
      yield chunk;
    }
  }

  async exportPackage(scope: EvidenceScope, projectedRoot: string | undefined) {
    const manifest = await this.verifiedManifest(scope, projectedRoot);
    const manifestBytes = await this.vault.read(scope, manifestObject);
    if (manifestBytes === null) throw new Error("缺少会议存证清单");
    verifyEvidenceManifest(manifestBytes, Buffer.from(projectedRoot!, "hex"));
    const tsa = await this.vault.read(scope, "tsa-response.bin");
    const instructions = Buffer.from([
      "从独立存证域取得会议可信根 SHA-256，不使用来自存证包或工作区投影的值。",
      "解包后运行 python3 verify-meeting-evidence.py <目录> --trusted-root <可信根>",
      "如果附有 TSA 回执，另用其供应商/协议的验证器核对可信根。",
    ].join("\n") + "\n");
    const entry = (path: string, data: Buffer) => ({ path, bytes: data.length, chunks: (async function* () { yield data; })() });
    const artifacts = (item: EvidenceItem) => this.artifactChunks(scope, item);
    return streamEvidenceTar((async function* () {
      yield entry(manifestObject, manifestBytes);
      for (const item of manifest.files) yield { path: item.path, bytes: item.bytes, chunks: artifacts(item) };
      if (tsa) yield entry("tsa-response.bin", tsa);
      yield entry("VERIFICATION.txt", instructions);
    })());
  }
}
