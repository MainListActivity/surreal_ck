/**
 * 提案确认写的字段编解码契约（web 与 server 共用一份）。
 *
 * 背景：提案确认写从「浏览器直连」搬到「服务端受栅栏端点」后，两端必须对
 * 「同一组 values 如何落到业务表列」给出**完全一致**的判断，否则卡片显示的
 * 「写入成功」与库里实际落下的值会漂移。原先这套判断散在 web 的 editor-store
 * （label 归一）与 data-table-runtime（类型强制 / 只写变化字段），这里收敛为共享
 * 纯函数，两端各自调用同一份——同口径搬迁，不是新规则。
 */

/** web/lib/record-id 同口径的 `table:id` 判定；reference 值在 SDK 边界据此包 RecordId。 */
export function isLikelyRecordId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  return colon > 0 && colon < value.length - 1;
}

/** 提案写入只需要这几列属性：label 归一、reference 归一。 */
export type ProposalFieldColumn = {
  key: string;
  label?: string;
  fieldType: string;
  referenceMultiple?: boolean;
};

/**
 * 提案 values 的键归一：模型有时照抄列 label 而非存储 key。
 * 存储 key 始终优先；只有唯一 label 才能归一；歧义 label 与归一后撞键都整笔拒绝，
 * 绝不静默折叠（否则丢值或覆盖不可见）。
 */
export function normalizeProposalValues(
  values: Record<string, unknown>,
  columns: ProposalFieldColumn[],
): { ok: true; values: Record<string, unknown> } | { ok: false; message: string } {
  const fieldKeys = new Set(columns.map((column) => column.key));
  const labelToKeys = new Map<string, string[]>();
  for (const column of columns) {
    if (!column.label || column.label === column.key) continue;
    const keys = labelToKeys.get(column.label) ?? [];
    keys.push(column.key);
    labelToKeys.set(column.label, keys);
  }

  const next: Record<string, unknown> = {};
  let changed = false;
  const sourcesByTarget = new Map<string, string>();
  for (const [field, value] of Object.entries(values)) {
    let key = field;
    if (!fieldKeys.has(field)) {
      const matches = labelToKeys.get(field);
      if (matches?.length === 1) key = matches[0];
      else if (matches && matches.length > 1) {
        return { ok: false, message: `字段 label「${field}」存在歧义，已拒绝写入。` };
      }
    }
    const previousSource = sourcesByTarget.get(key);
    if (previousSource !== undefined) {
      return { ok: false, message: `字段「${previousSource}」与「${field}」归一后目标相同，已拒绝写入。` };
    }
    if (key !== field) changed = true;
    sourcesByTarget.set(key, field);
    next[key] = value;
  }
  return { ok: true, values: changed ? next : values };
}

/** 只保留与现有值真正不同的字段；全未变化时返回空对象（调用方据此零写入）。 */
export function changedProposalValues(
  previous: Record<string, unknown>,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(requested).filter(([key, value]) => !sameProposalValue(previous[key], value)),
  );
}

export function sameProposalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** 未知列 → 具名拒绝，避免把拼错的键当成引擎未知字段整笔失败。 */
export function unknownProposalKeys(
  values: Record<string, unknown>,
  columns: ProposalFieldColumn[],
): string[] {
  const known = new Set(columns.map((column) => column.key));
  return Object.keys(values).filter((key) => !known.has(key));
}
