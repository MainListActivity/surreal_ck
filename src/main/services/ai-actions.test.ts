import { describe, expect, test } from "bun:test";
import { executeAiAction } from "./ai-actions";

describe("executeAiAction", () => {
  test("open-workbook 意图转换为 editor 路由", async () => {
    const result = await executeAiAction({
      intent: {
        type: "open-workbook",
        workbookId: "workbook:case",
        label: "债权工作簿",
      },
    });

    expect(result).toEqual({
      ok: true,
      navigation: {
        type: "navigate",
        screen: "editor",
        workbookId: "workbook:case",
      },
    });
  });
});
