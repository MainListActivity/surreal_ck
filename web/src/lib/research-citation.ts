import type { ResourceCitationDTO } from "@surreal-ck/shared";
import { contentReaderPath } from "./route";

/** 只用服务端登记的精确版本指针构造回链；不回退为可能变化的来源网址。 */
export function researchCitationHref(slug: string | null, citation: ResourceCitationDTO): string | null {
  const content = citation.platformContent;
  if (!slug || !content?.versionPublicId) return null;
  const locator = content.locator;
  const fragment = locator ? new URLSearchParams({
    start: String(locator.start), end: String(locator.end), digest: locator.bodyDigest,
  }).toString() : "";
  return `${contentReaderPath(slug, content.versionPublicId)}${fragment ? `#research=${fragment}` : ""}`;
}

/** 当前重新授权的正文必须仍与引用摘要一致，才展示被引用的位置。 */
export async function researchCitationExcerpt(body: string, hash: string): Promise<string | null> {
  if (!hash.startsWith("#research=")) return null;
  const params = new URLSearchParams(hash.slice("#research=".length));
  const start = Number(params.get("start"));
  const end = Number(params.get("end"));
  if (!params.has("start") || !params.has("end") || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end <= start || end > body.length || end - start > 800) return null;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return digest === params.get("digest") ? body.slice(start, end) : null;
}
