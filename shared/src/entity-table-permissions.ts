import { isSafeSheetTableName } from "./resource-quota";

/**
 * 实体表（sheet.table_name 背后的业务数据表）成员 DML 权限谓词。
 *
 * 判定口径与现有 workspace schema 一致：fn::current_user() 对 participant /
 * employee（RECORD 会话）直接返回 $auth 的 user record，对 admin（JWT 会话）
 * 按 $token.sub 反查 user——任何能解析到本 workspace user 记录的活跃身份
 * 都获得成员级 DML。disabled_at != NONE 的已移除成员在既有会话/token 上限内
 * 也被立即拒绝，不需要等凭证过期。
 *
 * admin JWT 会话另有 Owner system role（DDL + DML 不受 PERMISSIONS 约束），
 * 这里只约束 RECORD 会话侧；DDL 始终由 access 类型隔离，谓词不表达 DDL。
 */
export const ENTITY_TABLE_MEMBER_PERMISSION_WHERE =
  "fn::current_user() != NONE AND fn::current_user().disabled_at = NONE";

/** 新建实体表 DEFINE TABLE 尾部携带的 PERMISSIONS 子句。 */
export const ENTITY_TABLE_MEMBER_PERMISSIONS =
  `PERMISSIONS FOR select, create, update, delete WHERE ${ENTITY_TABLE_MEMBER_PERMISSION_WHERE}`;

/**
 * 既有实体表的权限回填语句（root / 控制面维护会话执行）。ALTER TABLE 只改
 * PERMISSIONS 子句，其余表定义（CHANGEFEED、字段、事件）与全部记录保持原样。
 */
export function buildEntityTableMemberPermissionsAlter(tableName: string): string {
  if (!isSafeSheetTableName(tableName)) {
    throw new Error(`invalid entity table name: ${tableName}`);
  }
  return `ALTER TABLE ${tableName} ${ENTITY_TABLE_MEMBER_PERMISSIONS};`;
}
