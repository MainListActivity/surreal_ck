import { createHash, createPublicKey, verify } from "node:crypto";
import {
  COMPANY_PROOF_ALG, COMPANY_PROOF_AUDIENCE, COMPANY_PROOF_GOAL, COMPANY_PROOF_ISSUER,
  COMPANY_PROOF_MAX_AGE_SECONDS, COMPANY_PROOF_MAX_BYTES, COMPANY_PROOF_PROJECT, COMPANY_PROOF_TRUST,
  COMPANY_PROOF_TYP, companyProofClaimsSchema, type CompanyProofClaims,
} from "@surreal-ck/shared";
import { HttpError } from "../http-error";

/** 信任锚形状：生产永远用 COMPANY_PROOF_TRUST；仅测试可注入自签钥匙。 */
export type CompanyProofAnchor = { readonly alg: string; readonly kid: string; readonly jwk: Record<string, unknown> };

const denied = (code: string, message: string) => new HttpError(422, code, message);

function segment(part: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw denied("company-proof-malformed", "公司证明格式无效");
  return Buffer.from(part, "base64url").toString("utf8");
}

/**
 * 独立验签公司内部AI证明。
 *
 * 与公司侧 `verifyCompanyProof` 参考实现等价但**不共用代码**：产品必须自己固定信任锚，
 * 否则公司程序一改产品就跟着放行。`trust` 仅测试注入用，生产路径一律走固定的 COMPANY_PROOF_TRUST。
 *
 * 验签通过只代表"公司确实签过这份声明"，不代表余额、价目或启用授权已获得——
 * 那由登记与 enable 的 fail-closed 校验负责。
 *
 * `status.bearer` 是公司签发的状态能力秘密：只进哈希，绝不落库明文、绝不进响应或日志。
 */
export function verifyCompanyProof(jwt: string, now: number, trust: CompanyProofAnchor = COMPANY_PROOF_TRUST): CompanyProofClaims {
  if (jwt.length > COMPANY_PROOF_MAX_BYTES) throw denied("company-proof-too-large", "公司证明过大");
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw denied("company-proof-malformed", "公司证明格式无效");
  const [headerPart, bodyPart, signaturePart] = parts as [string, string, string];
  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(segment(headerPart));
    claims = JSON.parse(segment(bodyPart));
  } catch { throw denied("company-proof-malformed", "公司证明格式无效"); }
  if (!header || typeof header !== "object") throw denied("company-proof-malformed", "公司证明格式无效");
  const head = header as Record<string, unknown>;
  if (Object.keys(head).length !== 3 || head.alg !== COMPANY_PROOF_ALG || head.kid !== trust.kid || head.typ !== COMPANY_PROOF_TYP) {
    throw denied("company-proof-anchor-mismatch", "公司证明信任锚不匹配");
  }
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey({ key: trust.jwk, format: "jwk" }); } catch { throw denied("company-proof-anchor-invalid", "公司证明信任锚不可用"); }
  let signature: Buffer;
  try { signature = Buffer.from(signaturePart, "base64url"); } catch { throw denied("company-proof-malformed", "公司证明格式无效"); }
  if (!verify(null, Buffer.from(`${headerPart}.${bodyPart}`, "utf8"), key, signature)) {
    throw denied("company-proof-signature-invalid", "公司证明签名无效");
  }
  if (!claims || typeof claims !== "object") throw denied("company-proof-malformed", "公司证明格式无效");
  const record = claims as Record<string, unknown>;
  const seconds = Math.floor(now / 1000);
  if (record.iss !== COMPANY_PROOF_ISSUER || record.aud !== COMPANY_PROOF_AUDIENCE) {
    throw denied("company-proof-anchor-mismatch", "公司证明签发方或受众不匹配");
  }
  if (!Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.exp)) throw denied("company-proof-malformed", "公司证明缺少时间声明");
  const iat = record.iat as number, exp = record.exp as number;
  if (exp <= seconds || iat > seconds || exp <= iat || exp - iat > COMPANY_PROOF_MAX_AGE_SECONDS) {
    throw denied("company-proof-expired", "公司证明已过期或时间窗非法");
  }
  if (record.project !== COMPANY_PROOF_PROJECT || record.goal !== COMPANY_PROOF_GOAL) {
    throw denied("company-proof-scope-mismatch", "公司证明目标或项目不匹配");
  }
  // 严格 claims：未知字段、缺字段、类型不符一律拒绝，不猜测、不补默认值。
  const parsed = companyProofClaimsSchema.safeParse(record);
  if (!parsed.success) throw denied("company-proof-claims-invalid", "公司证明声明不合法");
  const value = parsed.data;
  if (value.lease.taskId !== value.requestTask || (value.approval && value.approval.digest !== value.configurationDigest)) {
    throw denied("company-proof-scope-mismatch", "公司证明租约或批准摘要不匹配");
  }
  if (value.documentHash !== value.manifest.documentHash || value.configurationDigest !== value.manifest.configurationDigest) {
    throw denied("company-proof-digest-mismatch", "公司证明摘要与文档不一致");
  }
  if (value.type === "development-disabled" && value.paidCallsAllowed !== 0) throw denied("company-proof-claims-invalid", "禁用证明不得携带付费许可");
  if (value.type === "approved-service" && value.paidCallsAllowed !== 1) throw denied("company-proof-claims-invalid", "受审服务证明必须携带付费许可");
  if (value.scope === "register-disabled" && value.type !== "development-disabled") throw denied("company-proof-claims-invalid", "登记范围与证明类型不符");
  if (value.scope === "enable" && (value.type !== "approved-service" || !value.approval)) {
    throw denied("company-proof-claims-invalid", "启用范围必须带受审服务证据与独立批准");
  }
  return value;
}

/** 状态能力秘密只以哈希参与审计；明文即刻丢弃，不落库、不进响应。 */
export function statusCapabilityHash(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}
