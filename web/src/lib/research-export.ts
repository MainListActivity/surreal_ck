/**
 * LCA09 研究报告导出：仅包含当前可展示的引用信息。
 *
 * 导出在前端完成，不重新读取或嵌入锁定正文（不发起任何平台内容请求）；
 * 引用按当前权限状态分级呈现：可核验 → 版本/定位/哈希/时间；锁定 → 摘录保留、
 * 全文注明锁定；墓碑（撤回/许可终止/删除）→ 只显示 tombstone 与原因类别；
 * 不可核验 → 说明原因。此前已合法交付的本地导出不宣称远程回收。
 */
import { citationStatusReasonLabel, type CitationStatusEntry } from "@surreal-ck/shared";
import type { ResourceCitationDTO } from "@surreal-ck/shared";
import { researchCitationHref } from "./research-citation";

export type ReportExportInput = {
  workspaceSlug: string | null;
  question: string;
  /** 报告原文（用户成果，原样导出，不重写）。 */
  answerText: string;
  citations: ResourceCitationDTO[];
  /** versionPublicId → 当前权限状态（loadCitationStatuses 结果）。 */
  statuses: Map<string, CitationStatusEntry>;
  /** 引用捕获时间（报告消息或资源的可用时间戳）；缺失时省略该行。 */
  capturedAt?: string;
  exportedAt: string;
};

export function buildReportMarkdown(input: ReportExportInput): string {
  const lines: string[] = [];
  lines.push(`# 研究报告导出`);
  lines.push("");
  lines.push(`- 问题：${input.question}`);
  lines.push(`- 导出时间：${input.exportedAt}`);
  lines.push(`- 说明：导出仅包含当前可展示的引用信息；锁定或撤回的全文不会重新读取或嵌入。已交付的本地导出不受后续权限变化影响。`);
  lines.push("");
  lines.push("## 报告原文");
  lines.push("");
  lines.push(input.answerText);
  lines.push("");
  lines.push("## 引用");
  lines.push("");

  if (input.citations.length === 0) {
    lines.push("（无引用）");
    return lines.join("\n");
  }

  for (const citation of input.citations) {
    const platform = citation.platformContent;
    const status = platform?.versionPublicId ? input.statuses.get(platform.versionPublicId) : undefined;
    if (!platform) {
      // 工作区资料引用：按其原有 workspace 权限继续可用。
      lines.push(`### [${citation.index}] ${citation.title}`);
      lines.push("");
      lines.push("- 状态：工作区资料（按工作区权限可见）");
      appendExcerpt(lines, citation);
      continue;
    }
    lines.push(`### [${citation.index}] ${citation.title}`);
    lines.push("");
    if (!platform.versionPublicId) {
      lines.push("- 状态：历史引用指针不完整，需重新研究");
      continue;
    }
    if (!status) {
      lines.push("- 状态：当前无法核验（权限状态未知），摘录暂不展示");
      continue;
    }
    const capturedLine = input.capturedAt ? `（捕获于 ${input.capturedAt}）` : "";
    if (status.state === "verifiable") {
      lines.push(`- 状态：可核验${capturedLine}`);
      lines.push(`- 精确版本：${platform.versionPublicId}`);
      if (platform.locator) {
        lines.push(`- 定位：start=${platform.locator.start} end=${platform.locator.end} bodyDigest=${platform.locator.bodyDigest}`);
      }
      if (platform.quoteSha256) lines.push(`- 摘录哈希：${platform.quoteSha256}`);
      if (platform.entitlementRevision) lines.push(`- 捕获时授权修订：${platform.entitlementRevision}`);
      const href = researchCitationHref(input.workspaceSlug, citation);
      if (href) lines.push(`- 全文指针：${href}（打开时经当前授权核验）`);
      appendExcerpt(lines, citation);
    } else if (status.state === "locked") {
      lines.push(`- 状态：全文已锁定${capturedLine}——${citationStatusReasonLabel(status.reason)}`);
      if (platform.versionPublicId) lines.push(`- 捕获版本：${platform.versionPublicId}`);
      lines.push("- 摘录为捕获时合法保留的成果；全文在恢复相应授权后可重新打开。");
      appendExcerpt(lines, citation);
    } else if (status.state === "tombstoned") {
      lines.push(`- 状态：内容已不可用${capturedLine}——${citationStatusReasonLabel(status.reason)}`);
      lines.push("- 摘录不再展示；此处仅保留 tombstone 与原因类别，不替代被要求删除的实质内容。");
    } else {
      lines.push(`- 状态：当前无法核验${capturedLine}——${citationStatusReasonLabel(status.reason)}`);
      lines.push("- 摘录暂不展示；权限恢复后重新打开报告即可重新核验。");
    }
  }
  return lines.join("\n");
}

function appendExcerpt(lines: string[], citation: ResourceCitationDTO): void {
  const excerpt = citation.evidence?.[0]?.text;
  if (!excerpt) return;
  lines.push("");
  lines.push("> " + excerpt.replaceAll("\n", "\n> "));
}

/** 触发浏览器下载；导出在本地完成，服务端不留存。 */
export function downloadReportMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
