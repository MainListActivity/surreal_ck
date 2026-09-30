---
title: Legacy Quota Guard Events Must Not Reference Removed Tables
date: 2026-09-30
category: database-issues
module: surrealdb
problem_type: database_issue
component: database
symptoms:
  - Workbook creation with template samples fails on native-quota workspaces.
  - INSERT into a freshly created entity table returns "The table 'sheet_resource_usage' does not exist".
  - The UI misreports the failure as "模板样例数据不符合字段定义".
root_cause: stale_schema_reference
resolution_type: code_fix
severity: high
related_components:
  - quota
  - workspace-migration
  - workbook-creation
tags:
  - surrealdb
  - quota
  - migration
  - event
  - record-exists
---

# Legacy Quota Guard Events Must Not Reference Removed Tables

## Problem

`resource_quota_guard` 事件体对 `sheet_resource_usage` / `workspace_resource_quota`
做表级 UPDATE/引用。021 清理迁移删除这三张表后，任何在清理之后安装的残留事件
都会让实体表上的 CREATE/DELETE 抛出 `TbNotFound`（缺失表的表级引用即抛错；
点查 record id 与 `INFO FOR` 不抛）。

## Fix

1. `buildRecordQuotaGuardSurql` 事件体改为 `IF record::exists(workspace_resource_quota:current)`
   包裹：点查哨兵对缺失表返回 false 不抛错，事件在 native 工作区自动失效，
   在 legacy 工作区行为不变。
2. `web` 建簿事务新增 `legacyRecordQuota` 选项；`create()` 先跑同一
   `record::exists` 探针，native 工作区不再安装 guard。探测失败默认按在线
   处理——硬化后的事件体保证安全方向。
3. 迁移 `039-legacy-quota-guard-residual.surql`（门控 `native_verified` /
   `cleanup_done`）物化枚举 `sheet.table_name`，移除 021 之后新建实体表上
   残留的旧 guard；随服务启动 `migrateAllWorkspaces` 重放，修复既有坏表。
4. `create()` 的错误翻译不再把 `processing event` / `does not exist` /
   `quota` 类基础设施错误包装成「样例数据不符合字段定义」。

## Notes

- `record::exists` 在 fork（3.3.0 基线）与上游 3.2.x 均存在，并对缺失表显式
  返回 `false`（`TbNotFound` 被吞）。
- 事件体内 `perms` 被禁用（`opt.new_with_perms(false)`），参与者写入同样
  经过哨兵，无额外权限要求。
- `INFO FOR DB/TABLE` 需要 `Base::Db` View 权限，RECORD access 成员不能用
  于事件内自检——不要用 INFO 做事件级探测。

## Follow-up: 首次部署被 039 自身卡死（已修复）

`sheet.table_name` 不限于 `ent_*` 前缀（生产存在 `qa_ver03_materials`）。
039 初次上线时把 `ent_*` 校验当 invariant，物化阶段抛错 → 启动迁移中止 →
健康检查失败 → 自动回滚。

修复：校验放宽为通用安全标识符（`^[a-z][a-z0-9_]{0,62}$`），物化层对仍不
安全的名字改为跳过并 `console.warn`，不再让单行异常数据中止启动迁移。
021 deferred cleanup 与 029 `record_activity` 回填的同名枚举走同一过滤。
