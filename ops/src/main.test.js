import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");

describe("运营启用摘要页面", () => {
  test("复用授权摘要 API，支持详情、分页与明确数据来源", () => {
    expect(source).toContain('data-view="activation"');
    expect(source).toContain("/ops/activation-summaries?limit=25");
    expect(source).toContain("/ops/activation-summaries/${encodeURIComponent(summaryId)}");
    expect(source).toContain('data-view="followup"');
    expect(source).toContain("/ops/activation-opportunities?limit=25");
    expect(source).toContain("/ops/follow-ups?limit=25");
    expect(source).toContain("/claim");
    expect(source).toContain("团队提供");
    expect(source).toContain('summary.contractVersion === "2"');
    expect(source).toContain("固定运行问题解决率");
    expect(source).toContain("不适用和结果待核实保持独立显示");
    expect(source).toContain("新鲜度以摘要更新时间");
    expect(source).toContain("逐指标口径与来源");
    expect(source).toContain("metric.definition");
    expect(source).toContain("各指标窗口见口径说明");
    expect(source).toContain("/ops/product-entitlements/workspaces/");
    expect(source).toContain("/ops/product-entitlements/assignments");
    expect(source).toContain("productAssignAttempt");
    expect(source).toContain("尚无可用 AI 额度账本");
    expect(source).toContain("资源 applied");
  });
});

describe("LCA13 运营解释与交付修复界面", () => {
  test("权益来源展示理由/操作者/撤销状态，赠送与撤销走独立能力端点", () => {
    expect(source).toContain("/ops/product-entitlements/grants");
    expect(source).toContain("/ops/product-entitlements/grants/revoke");
    expect(source).toContain("giftGrantAttempt");
    expect(source).toContain("撤销理由（写入审计）");
    expect(source).toContain("理由：");
    expect(source).toContain("操作者：");
    expect(source).toContain("已撤销");
  });

  test("交付修复先展示当前与目标影响，限定修订重试且幂等", () => {
    expect(source).toContain("/delivery-preview");
    expect(source).toContain("/delivery-repair");
    expect(source).toContain("expectedCurrentRevision");
    expect(source).toContain("当前快照修订");
    expect(source).toContain("目标绑定修订");
    expect(source).toContain("重试交付（限定修订）");
  });

  test("异常队列区分三类系统失败并排除正常到期", () => {
    expect(source).toContain("/ops/product-entitlements/exceptions");
    expect(source).toContain("已确认商业来源未交付");
    expect(source).toContain("内容投影故障");
    expect(source).toContain("AI 结算异常");
    expect(source).toContain("正常到期与合法 over_limit 不算系统失败");
  });

  test("AI 预留/结算状态展示卡死预留异常", () => {
    expect(source).toContain("可用 / 已预留 / 已结算");
    expect(source).toContain("暂停 / 已终止 / 已过期");
    expect(source).toContain("结算异常：");
    expect(source).toContain("内容投影核验");
  });
});
