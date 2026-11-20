import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { CLAIM_PROGRESS_LABELS } from "@surreal-ck/shared/claims-portal";
import type { ClaimsPortalService } from "./service";

type PortalRecord = Awaited<ReturnType<ClaimsPortalService["getSubmission"]>>;

const fontPath = fileURLToPath(new URL(
  "../fonts/NotoSansHans-Regular.otf",
  import.meta.resolve("@embedpdf/fonts-sc"),
));

function value(input: unknown): string {
  return typeof input === "number" ? input.toFixed(2) : (typeof input === "string" && input ? input : "—");
}

export function renderClaimRecordPdf(record: PortalRecord, submission: NonNullable<PortalRecord["submission"]>): Promise<Buffer> {
  const title = "我的申报与往来记录";
  const document = new PDFDocument({ size: "A4", margin: 44, info: { Title: title } });
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  document.font(fontPath).fontSize(18).text(title).moveDown();
  document.fontSize(11).text(`识别码：${value(submission.identityCode)}`);
  document.text(`提交时间：${value(submission.submittedAt)}`);
  document.text(`申报本金：${value(submission.principal)}　违约金：${value(submission.penalty)}`);
  document.text(`计息区间：${value(submission.interestStart)} 至 ${value(submission.interestEnd)}`);
  document.text(`申报说明：${value(submission.statement)}`);
  if (record.progress.events.length) {
    document.moveDown().fontSize(14).text("申报进度").fontSize(11);
    for (const event of record.progress.events) {
      document.text(`${event.createdAt} · ${CLAIM_PROGRESS_LABELS[event.stage]} · ${event.actor}`);
    }
  }
  const attachments = new Map(record.attachments.map((entry) => [entry.id, entry.fileName]));
  if (record.supplements.length) {
    document.moveDown().fontSize(14).text("补正往来").fontSize(11);
    for (const entry of record.supplements) {
      const direction = entry.direction === "manager_request" ? "管理人要求" : "本人回复";
      document.text(`${value(entry.createdAt)} · ${direction}`);
      if (entry.dueAt) document.text(`补正截止：${value(entry.dueAt)}`);
      document.text(value(entry.body));
      if (Array.isArray(entry.attachmentIds) && entry.attachmentIds.length) {
        const names = entry.attachmentIds.map((id: unknown) => value(attachments.get(id)));
        document.text(`关联附件：${names.join("、")}`);
      }
      document.moveDown(0.5);
    }
  }
  if (record.decisions.length) {
    document.moveDown().fontSize(14).text("已发布审查结论").fontSize(11);
    for (const entry of record.decisions) {
      document.text(`第 ${entry.version} 版 · ${entry.publishedAt}`);
      document.text(`确认本金：${value(entry.confirmedPrincipal)}　确认利息：${value(entry.confirmedInterest)}`);
      document.text(`确认违约金：${value(entry.confirmedPenalty)}　未确认金额：${value(entry.unconfirmedAmount)}`);
      document.text(`理由：${entry.reason}`).moveDown(0.5);
    }
  }
  document.end();
  return result;
}
