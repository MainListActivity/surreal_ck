import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplatePackScripts } from "./index";

type VoteOption = { key: string; label: string };
type VoteAgendaItem = { title: string; options: VoteOption[]; allowChange: boolean };
type RosterPreset = { key: string; sheet_key: string; display_key: string; check_key?: string; vote_weight_key?: string; vote_agenda?: VoteAgendaItem[] };
type ColumnDef = { key: string; field_type: string; required?: boolean; constraints?: { min?: number } };
type SampleRecord = { key: string; values: Record<string, unknown> };
type SheetDef = { key: string; column_defs: ColumnDef[]; sample_records?: SampleRecord[] };

// 从模板包 SurrealQL 中截取 `<field>: [ ... ]` 字面量；仅用于只含字符串/数字/布尔/嵌套对象的配置片段。
function extractArrayLiteral(sql: string, field: string, from = 0): string {
  const start = sql.indexOf(`${field}: [`, from);
  if (start < 0) throw new Error(`missing ${field}`);
  let depth = 0;
  let inString = false;
  for (let i = sql.indexOf("[", start); i < sql.length; i += 1) {
    const char = sql[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return sql.slice(sql.indexOf("[", start), i + 1);
    }
  }
  throw new Error(`unterminated ${field}`);
}

function parseSurqlLiteral<T>(literal: string): T {
  const json = literal
    .replace(/d"([^"]*)"/g, '"$1"')
    .replace(/([{,\s])([A-Za-z_][A-Za-z0-9_]*):/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json) as T;
}

function sheetDefs(sql: string): SheetDef[] {
  return parseSurqlLiteral<SheetDef[]>(extractArrayLiteral(sql, "sheet_defs"));
}

function rosterPresets(sql: string): RosterPreset[] {
  return parseSurqlLiteral<RosterPreset[]>(extractArrayLiteral(sql, "roster_meeting_presets"));
}

const NUMERIC_FIELD_TYPES = new Set(["decimal", "number", "integer"]);
const OPTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

// 表决配置接线校验：选项可识别、权重为名册表上的显式数值字段，返回全部问题便于断言。
function voteWiringProblems(presets: RosterPreset[], sheets: SheetDef[]): string[] {
  const problems: string[] = [];
  for (const preset of presets) {
    const roster = sheets.find((sheet) => sheet.key === preset.sheet_key);
    if (!roster) {
      problems.push(`${preset.key}: unknown sheet ${preset.sheet_key}`);
      continue;
    }
    const agenda = preset.vote_agenda;
    if (agenda !== undefined) {
      if (!Array.isArray(agenda) || agenda.length === 0) problems.push(`${preset.key}: empty vote_agenda`);
      const titles = new Set<string>();
      for (const [index, item] of (agenda ?? []).entries()) {
        const at = `${preset.key}.vote_agenda[${index}]`;
        if (typeof item.title !== "string" || item.title.trim() === "") problems.push(`${at}: blank title`);
        else if (titles.has(item.title)) problems.push(`${at}: duplicate title ${item.title}`);
        else titles.add(item.title);
        if (typeof item.allowChange !== "boolean") problems.push(`${at}: allowChange must be boolean`);
        if (!Array.isArray(item.options) || item.options.length < 2) {
          problems.push(`${at}: needs at least two options`);
          continue;
        }
        const keys = new Set<string>();
        const labels = new Set<string>();
        for (const option of item.options) {
          if (typeof option.key !== "string" || !OPTION_KEY_PATTERN.test(option.key)) problems.push(`${at}: invalid option key ${String(option.key)}`);
          else if (keys.has(option.key)) problems.push(`${at}: duplicate option key ${option.key}`);
          else keys.add(option.key);
          if (typeof option.label !== "string" || option.label.trim() === "") problems.push(`${at}: blank option label`);
          else if (labels.has(option.label)) problems.push(`${at}: duplicate option label ${option.label}`);
          else labels.add(option.label);
        }
      }
    }
    const weightKey = preset.vote_weight_key;
    if (weightKey === undefined) continue;
    if (agenda === undefined) problems.push(`${preset.key}: vote_weight_key without vote_agenda`);
    const column = roster.column_defs.find((candidate) => candidate.key === weightKey);
    if (!column) {
      problems.push(`${preset.key}: vote_weight_key ${weightKey} is not a column of ${roster.key}`);
      continue;
    }
    if (!NUMERIC_FIELD_TYPES.has(column.field_type)) problems.push(`${preset.key}: vote_weight_key ${weightKey} is ${column.field_type}, not numeric`);
    if (column.constraints?.min === undefined || column.constraints.min < 0) problems.push(`${preset.key}: vote_weight_key ${weightKey} must forbid negative weights`);
    if ([preset.display_key, preset.check_key].includes(weightKey)) problems.push(`${preset.key}: vote_weight_key reuses identity column ${weightKey}`);
    for (const record of roster.sample_records ?? []) {
      const value = record.values[weightKey];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        problems.push(`${preset.key}: sample ${record.key} has invalid weight ${String(value)}`);
      }
    }
  }
  return problems;
}

describe("template pack scripts", () => {
  test("空选择不播种任何模板包", async () => {
    await expect(
      loadTemplatePackScripts({
        selectedPacks: [],
        packsDir: join(tmpdir(), "directory-that-does-not-need-to-exist"),
      }),
    ).resolves.toEqual([]);
  });

  test("仅新增数据文件即可按部署配置顺序发现模板包", async () => {
    const packsDir = await mkdtemp(join(tmpdir(), "surreal-ck-template-packs-"));
    try {
      await writeFile(join(packsDir, "test-pack.surql"), "-- test pack", "utf8");
      await writeFile(join(packsDir, "claims-demo.surql"), "-- claims demo", "utf8");

      await expect(
        loadTemplatePackScripts({ selectedPacks: ["claims-demo", "test-pack"], packsDir }),
      ).resolves.toEqual([
        { name: "claims-demo", fileName: "claims-demo.surql", sql: "-- claims demo" },
        { name: "test-pack", fileName: "test-pack.surql", sql: "-- test pack" },
      ]);
    } finally {
      await rm(packsDir, { recursive: true });
    }
  });

  test("未知模板包返回明确错误", async () => {
    const packsDir = await mkdtemp(join(tmpdir(), "surreal-ck-template-packs-"));
    try {
      await expect(
        loadTemplatePackScripts({ selectedPacks: ["missing-pack"], packsDir }),
      ).rejects.toThrow("unknown template pack: missing-pack");
    } finally {
      await rm(packsDir, { recursive: true });
    }
  });

  test("拒绝可能越过模板包目录的非法包名", async () => {
    await expect(
      loadTemplatePackScripts({ selectedPacks: ["../outside"] }),
    ).rejects.toThrow("invalid template pack name: ../outside");
  });

  test("法律入门模板包可幂等重入且不覆盖未声明的结构字段", async () => {
    const [script] = await loadTemplatePackScripts({ selectedPacks: ["legal-starter"] });

    expect(script?.sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(script?.sql).toContain("label = $input.label");
    expect(script?.sql).not.toContain("column_defs = $input.column_defs");
    for (const key of ["case", "entity", "compliance", "diligence", "asset"]) {
      expect(script?.sql).toContain(`key: "${key}"`);
    }
  });

  test("破产债权模板包为纯数据文件且声明两表形状的幂等更新", async () => {
    const [script] = await loadTemplatePackScripts({ selectedPacks: ["bankruptcy-claims"] });

    // 纯数据文件：只 INSERT 模板行，不定义平台 schema。
    expect(script?.sql).not.toContain("DEFINE");
    expect(script?.sql).toContain("ON DUPLICATE KEY UPDATE");
    // 幂等更新只覆盖声明字段；旧顶层 column_defs 兼容输入与管理员自定义不被覆盖。
    expect(script?.sql).not.toContain("column_defs = $input.column_defs");
    for (const field of ["sheet_defs", "quick_tasks", "row_analysis", "default_dashboard", "roster_meeting_presets"]) {
      expect(script?.sql).toContain(`${field} = $input.${field}`);
    }
    // 两表形状：债权人 + 债权申报（引用回 creditors）。
    for (const key of ["creditors", "claims"]) {
      expect(script?.sql).toContain(`key: "${key}"`);
    }
    expect(script?.sql).toContain('reference_sheet_key: "creditors"');
    expect(script?.sql).toMatch(/roster_meeting_presets:\s*\[/);
    for (const clause of [
      'label: "债权人会议"',
      'sheet_key: "creditors"',
      'display_key: "creditor_name"',
      'check_key: "identity_number"',
      'check_label: "证件号码后四位"',
      'check_mode: "suffix4"',
    ]) {
      expect(script?.sql).toContain(clause);
    }
    const taskCount = script?.sql.match(/task_text:/g)?.length ?? 0;
    expect(taskCount).toBeGreaterThanOrEqual(5);
    expect(script?.sql).toContain('risk: "write"');
  });
  test("破产债权模板包的会议表决议程与名册显式权重字段接线有效", async () => {
    const [script] = await loadTemplatePackScripts({ selectedPacks: ["bankruptcy-claims"] });
    const sql = script!.sql;
    const sheets = sheetDefs(sql);
    const presets = rosterPresets(sql);

    // 不新增模板表：名册与申报两表形状不变。
    expect(sheets.map((sheet) => sheet.key)).toEqual(["creditors", "claims"]);
    expect(presets.map((preset) => preset.key)).toEqual(["creditor-meeting"]);
    expect(voteWiringProblems(presets, sheets)).toEqual([]);

    const [preset] = presets;
    expect(preset!.vote_weight_key).toBe("voting_weight");
    expect(preset!.vote_agenda!.length).toBeGreaterThanOrEqual(1);
    for (const item of preset!.vote_agenda!) {
      expect(item.options.map((option) => option.key)).toEqual(["approve", "reject", "abstain"]);
      expect(item.options.map((option) => option.label)).toEqual(["赞成", "反对", "弃权"]);
    }
    // 同一议程中既有可改票项也有单次锁定项，覆盖两种会议规则。
    expect(new Set(preset!.vote_agenda!.map((item) => item.allowChange))).toEqual(new Set([true, false]));

    // 权重是管理员在名册表上维护的显式数值列，而非引用申报金额的隐式汇总。
    const [creditors, claims] = sheets;
    const weight = creditors!.column_defs.find((column) => column.key === "voting_weight");
    expect(weight).toEqual(expect.objectContaining({ field_type: "decimal", constraints: { min: 0 } }));
    expect(weight!.required).toBeUndefined();
    expect(claims!.column_defs.some((column) => column.key === "voting_weight")).toBe(false);
    expect(creditors!.column_defs.some((column) => column.field_type === "reference" || column.field_type === "formula")).toBe(false);
    // 样例未全量填写权重：未维护时不由系统推导。
    const sampled = creditors!.sample_records!.filter((record) => record.values.voting_weight !== undefined);
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled.length).toBeLessThan(creditors!.sample_records!.length);
  });

  test("表决接线校验能识别错误的选项与权重配置", () => {
    const sheets: SheetDef[] = [
      {
        key: "roster",
        column_defs: [
          { key: "name", field_type: "text" },
          { key: "code", field_type: "text" },
          { key: "weight", field_type: "decimal", constraints: { min: 0 } },
          { key: "loose_weight", field_type: "decimal" },
        ],
        sample_records: [{ key: "bad", values: { weight: -1 } }],
      },
      { key: "detail", column_defs: [{ key: "amount", field_type: "decimal", constraints: { min: 0 } }] },
    ];
    const base = { key: "entry", sheet_key: "roster", display_key: "name", check_key: "code" };
    const agenda: VoteAgendaItem[] = [{
      title: "议题",
      options: [{ key: "yes", label: "同意" }, { key: "no", label: "不同意" }],
      allowChange: true,
    }];

    expect(voteWiringProblems([{ ...base, vote_agenda: agenda }], [{ ...sheets[0]!, sample_records: [] }])).toEqual([]);
    expect(voteWiringProblems([
      { ...base, vote_agenda: [] },
      { ...base, key: "single", vote_agenda: [{ title: "议题", options: [{ key: "yes", label: "同意" }], allowChange: true }] },
      {
        ...base,
        key: "dup",
        vote_agenda: [
          { title: "议题", options: [{ key: "yes", label: "同意" }, { key: "yes", label: "同意" }], allowChange: true },
          { title: "议题", options: [{ key: "Bad Key", label: " " }, { key: "no", label: "否" }], allowChange: "yes" as unknown as boolean },
        ],
      },
    ], sheets)).toEqual([
      "entry: empty vote_agenda",
      "single.vote_agenda[0]: needs at least two options",
      "dup.vote_agenda[0]: duplicate option key yes",
      "dup.vote_agenda[0]: duplicate option label 同意",
      "dup.vote_agenda[1]: duplicate title 议题",
      "dup.vote_agenda[1]: allowChange must be boolean",
      "dup.vote_agenda[1]: invalid option key Bad Key",
      "dup.vote_agenda[1]: blank option label",
    ]);
    expect(voteWiringProblems([
      { ...base, vote_weight_key: "weight" },
      { ...base, key: "missing", vote_agenda: agenda, vote_weight_key: "amount" },
      { ...base, key: "text", vote_agenda: agenda, vote_weight_key: "code" },
      { ...base, key: "loose", vote_agenda: agenda, vote_weight_key: "loose_weight" },
      { ...base, key: "sample", vote_agenda: agenda, vote_weight_key: "weight" },
    ], sheets)).toEqual([
      "entry: vote_weight_key without vote_agenda",
      "entry: sample bad has invalid weight -1",
      "missing: vote_weight_key amount is not a column of roster",
      "text: vote_weight_key code is text, not numeric",
      "text: vote_weight_key code must forbid negative weights",
      "text: vote_weight_key reuses identity column code",
      "loose: vote_weight_key loose_weight must forbid negative weights",
      "sample: sample bad has invalid weight -1",
    ]);
  });
});
