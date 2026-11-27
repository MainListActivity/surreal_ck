import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { receipt } from "./roster-votes";
import type { EvidenceEvent } from "./evidence-ledger";

const font = fileURLToPath(new URL("../fonts/NotoSansHans-Regular.otf", import.meta.resolve("@embedpdf/fonts-sc")));

export function renderVoteReceipt(record: Awaited<ReturnType<typeof receipt>>): Promise<Buffer> {
  const title = "会议表决个人回执";
  const document = new PDFDocument({ size: "A4", margin: 44, info: { Title: title } });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
    document.font(font).fontSize(18).text(title).moveDown().fontSize(11);
    document.text(`核验姓名：${record.name}`);
    document.text(`议题：${record.title}`);
    document.text(`议题版本：${record.version}`);
    document.text(`截止时间（UTC）：${record.deadline}`);
    document.text(`提交时间（UTC）：${record.at}`);
    document.text(`提交序号：${record.revision}`);
    document.text(`选择：${record.label}`);
    if (record.note) document.text(`本人说明：${record.note}`);
    document.end();
  });
}

export function renderEvidenceSummary(meeting: string, title: string, sealedAt: string, events: readonly EvidenceEvent[]): Promise<Buffer> {
  const at = new Date(sealedAt);
  const document = new PDFDocument({ size: "A4", margin: 44, info: { Title: "会议存证摘要", CreationDate: at, ModDate: at } });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
    document.font(font).fontSize(18).text("会议存证摘要").moveDown().fontSize(11);
    document.text(`${title} · ${meeting}`).moveDown();
    for (const event of events) {
      document.text(`${event.at} · ${event.kind} · ${JSON.stringify(event.payload)}`);
    }
    document.end();
  });
}
