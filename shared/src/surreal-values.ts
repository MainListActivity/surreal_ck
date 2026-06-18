/**
 * SurrealDB 空值写入约定（全仓唯一来源）。
 *
 * SurrealDB 里 `null` 和 `NONE` 是两个不同的值语义：
 * - JS `null`      → Surreal `NULL`（一个具体的值）
 * - JS `undefined` → Surreal `NONE` / 字段不出现
 * - `option<T>` / `T | NONE` 字段接受「有值」或 `NONE`，**不接受 `NULL`**——
 *   往 `option<T>` 写 `null` 会被引擎按类型不符拒绝，create / update / merge 三条
 *   写入路径都会失败。
 *
 * 因此除非字段被显式定义为允许 `null`，TS 侧绝不能把 `null` 交给 SDK：未填写就省略，
 * 清空就传 `undefined`。这两个 helper 把这条规则收敛到一处，写库前按写入类型选用：
 *
 * - {@link omitNullishSurrealFields}：给 `CREATE` / `INSERT` / `CONTENT`——未填字段直接省略。
 * - {@link mapNullsToSurrealNone}：给 `UPDATE` / `MERGE` / `SET`——显式清空转成 `undefined`(NONE)。
 *
 * 背景见 docs/solutions/database-issues/surrealdb-null-none-value-mapping-2026-05-02.md。
 */

/** `CONTENT` / create 用：丢弃所有 `null` / `undefined` 字段（未填写就不写）。 */
export function omitNullishSurrealFields<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

/** `MERGE` / update 用：把 `null` 改成 `undefined`(NONE)，其余原样保留（含字段存在性）。 */
export function mapNullsToSurrealNone<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: T[K] | undefined } {
  const out = {} as { [K in keyof T]: T[K] | undefined };
  for (const [key, value] of Object.entries(obj)) {
    out[key as keyof T] = (value === null ? undefined : value) as T[keyof T] | undefined;
  }
  return out;
}

/** 单字段 `SET` 用：`null` → `undefined`(NONE)，其余原样。 */
export function mapNullToSurrealNone<T>(value: T): T | undefined {
  return value === null ? undefined : value;
}
