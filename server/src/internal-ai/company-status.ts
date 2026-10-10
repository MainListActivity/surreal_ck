import { randomBytes, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { COMPANY_PROOF_AUDIENCE, COMPANY_PROOF_ISSUER, COMPANY_PROOF_TRUST, type CompanyProofClaims } from "@surreal-ck/shared";
import { HttpError } from "../http-error";
import type { CompanyProofAnchor } from "./company-proof";

const statusSchema = z.object({
  iss: z.literal(COMPANY_PROOF_ISSUER), aud: z.literal(COMPANY_PROOF_AUDIENCE),
  jti: z.string().min(1).max(200), valid: z.literal(true), version: z.number().int().positive(),
  approvalVersion: z.number().int().positive().nullable(), checkedAt: z.number().int(),
  iat: z.number().int(), exp: z.number().int(), nonce: z.string(),
}).strict();
const denied = () => new HttpError(422, "company-status-unavailable", "公司证明当前状态不可核定或已失效");
/** 签发方-校检方时钟漂移是常态：checkedAt/iat 正向给30秒容差；负向新鲜度与exp过期仍严格，fail-safe方向不松。 */
const STATUS_CLOCK_TOLERANCE_SECONDS = 30;

/** 固定用途、公钥、jti、随机nonce和最长60秒窗口；不接受proof JWT作为状态答复。 */
export function verifyCompanyStatus(jwt: string, claims: Pick<CompanyProofClaims, "jti" | "exp" | "approval">, nonce: string, now: number, trust: CompanyProofAnchor = COMPANY_PROOF_TRUST): void {
  try {
    if (jwt.length > 32000) throw denied();
    const parts = jwt.split(".");
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw denied();
    const [h, b, sig] = parts as [string, string, string];
    const header: unknown = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    const parsedHeader = z.object({ alg: z.literal("EdDSA"), typ: z.literal("sck-internal-ai-status+jwt"), kid: z.literal(trust.kid) }).strict().parse(header);
    void parsedHeader;
    if (!verify(null, Buffer.from(`${h}.${b}`), createPublicKey({ key: trust.jwk, format: "jwk" }), Buffer.from(sig, "base64url"))) throw denied();
    const status = statusSchema.parse(JSON.parse(Buffer.from(b, "base64url").toString("utf8")));
    const seconds = Math.floor(now / 1000);
    if (status.jti !== claims.jti || status.nonce !== nonce || status.approvalVersion !== (claims.approval?.version ?? null)
      || status.checkedAt > seconds + STATUS_CLOCK_TOLERANCE_SECONDS || seconds - status.checkedAt >= 60 || status.iat < status.checkedAt || status.iat > seconds + STATUS_CLOCK_TOLERANCE_SECONDS
      || status.exp <= seconds || status.exp > status.checkedAt + 60 || claims.exp <= seconds) throw denied();
  } catch { throw denied(); }
}

/** 能力仅在进程内保留至proof到期，绝不入库/日志。重启后无能力即拒绝，须重新受审投递。 */
export class CompanyStatusClient {
  private readonly proofs = new Map<string, CompanyProofClaims>();
  constructor(private readonly url: string | undefined, private readonly request: typeof fetch = fetch) {}
  async check(claims: CompanyProofClaims): Promise<void> {
    try {
      if (!this.url || claims.exp <= Math.floor(Date.now() / 1000)) throw denied();
      const url = new URL(this.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || url.pathname !== "/internal-ai/status") throw denied();
      const nonce = randomBytes(24).toString("base64url");
      const response = await this.request(url, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${claims.status.bearer}`, "x-sck-nonce": nonce } });
      if (!response.ok) throw denied();
      const bytes = await response.text();
      if (bytes.length > 40000) throw denied();
      const envelope = z.object({ status: z.string().max(32000) }).strict().parse(JSON.parse(bytes));
      verifyCompanyStatus(envelope.status, claims, nonce, Date.now());
    } catch { throw denied(); }
  }
  remember(activity: string, claims: CompanyProofClaims): void {
    for (const [id, value] of this.proofs) if (value.exp <= Math.floor(Date.now() / 1000)) this.proofs.delete(id);
    this.proofs.set(activity, claims);
  }
  async current(activity: string, jti: string): Promise<void> {
    const claims = this.proofs.get(activity);
    if (!claims || claims.jti !== jti) throw denied();
    await this.check(claims);
  }
}
export type CompanyStatus = Pick<CompanyStatusClient, "check" | "remember" | "current">;
