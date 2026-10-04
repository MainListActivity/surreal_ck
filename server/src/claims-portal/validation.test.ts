import { describe, expect, test } from "bun:test";
import { HttpError } from "../http-error";
import { MAX_ATTACHMENT_BYTES } from "./constants";
import { assertAttachmentMeta, normalizeDraft } from "./validation";

describe("claims-portal validation", () => {
  test("normalizeDraft 拒绝非法 interest_method 与颠倒日期", () => {
    expect(() => normalizeDraft({ interest_method: "compound" })).toThrow(HttpError);
    expect(() =>
      normalizeDraft({
        interest_start: "2024-07-01T00:00:00.000Z",
        interest_end: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow(HttpError);
    expect(normalizeDraft({ principal: 100, interest_method: "simple" }).principal).toBe(100);
  });

  test("附件类型 / MIME / 大小超限拒绝", () => {
    expect(() =>
      assertAttachmentMeta({
        attachmentType: "invoice",
        fileName: "a.pdf",
        contentType: "application/pdf",
        byteSize: 10,
      }),
    ).toThrow(HttpError);

    expect(() =>
      assertAttachmentMeta({
        attachmentType: "contract",
        fileName: "a.bin",
        contentType: "application/octet-stream",
        byteSize: 10,
      }),
    ).toThrow(HttpError);

    expect(() =>
      assertAttachmentMeta({
        attachmentType: "contract",
        fileName: "a.pdf",
        contentType: "application/pdf",
        byteSize: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow(HttpError);

    expect(
      assertAttachmentMeta({
        attachmentType: "judgment",
        fileName: "j.pdf",
        contentType: "application/pdf",
        byteSize: 100,
      }).attachmentType,
    ).toBe("judgment");
  });
});
