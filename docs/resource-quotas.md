# 工作区资源配额

每个工作区对应一个独立的 SurrealDB database。资源套餐和工作区的绑定保存在该
workspace database 的 `workspace_resource_quota:current`，因此不存在跨工作区的
计数或权限查询。

## 套餐

| 套餐 | 数据表 | 每张数据表字段 | 每张数据表记录 |
|---|---:|---:|---:|
| Plus | 1 | 3 | 2 |
| Pro | 2 | 6 | 4 |
| Max | 3 | 9 | 6 |

套餐记录位于 `resource_quota_plan:plus`、`:pro`、`:max`。数据表创建和字段变化由
`sheet` 上的同步事件检查；记录创建和删除由每张动态实体表自己的
`resource_quota_guard` 事件计量。任一闸门失败都会回滚当前事务。

## 手工给工作区切换套餐

连接目标 workspace database 后执行：

```surql
UPDATE ONLY workspace_resource_quota:current
  SET plan = resource_quota_plan:pro
  RETURN AFTER;
```

也可以先把
[`shared/sql/manual/resource-quota/assign-plan.surql`](../shared/sql/manual/resource-quota/assign-plan.surql)
中的 `ws_replace_me` 和套餐改为目标值，再通过 CLI 执行：

```bash
surreal sql \
  --endpoint ws://127.0.0.1:8000 \
  --username root \
  --password root \
  --namespace main \
  --database _system \
  --multi \
  < shared/sql/manual/resource-quota/assign-plan.surql
```

配额控制属于平台控制面操作，生产环境不要向工作区用户暴露 root 凭证。

## 信任边界

当前架构让工作区管理员通过 `admin` access 获得 SurrealDB `Owner`，以便浏览器直连
执行字段 DDL。`Owner` 可以绕过记录权限、修改套餐或移除事件，因此这里的事件保证
应用正常创建路径在并发下不超额，但不是面对恶意工作区管理员的不可篡改计费边界。
若产品需要强制计费隔离，必须先调整身份架构：不再向租户会话授予 `Owner`，并把所有
结构变更收口到可信控制面；这会改变当前“管理员浏览器直连 DDL”的 ADR，不能只靠本
增量解决。

## 手工修改某个工作区的套餐额度

套餐记录保存在各 workspace database 内，因此下面的修改只影响目标工作区。把 Plus
的数据表上限从 1 改为 2：

```surql
UPDATE ONLY resource_quota_plan:plus
  SET max_sheets = 2
  RETURN AFTER;
```

可直接编辑并执行
[`shared/sql/manual/resource-quota/update-plus.surql`](../shared/sql/manual/resource-quota/update-plus.surql)。
使用 Plus 的工作区会在该语句提交后立即获得第二张数据表额度，不需要重建事件或重启服务。

## 查看有效配额和用量

```surql
SELECT
  plan.key AS plan,
  plan.max_sheets AS max_sheets,
  plan.max_fields_per_sheet AS max_fields_per_sheet,
  plan.max_records_per_sheet AS max_records_per_sheet,
  sheet_count
FROM ONLY workspace_resource_quota:current;

SELECT sheet, record_count
FROM sheet_resource_usage
ORDER BY sheet;
```

## 本地验证

测试会使用本机 `surreal` CLI 启动独立的内存实例，不会接触开发数据。本次实现验证
使用的 CLI 版本为 `3.0.5`：

```bash
pnpm run test:quota:local
```

若已有测试实例，可以复用：

```bash
LOCAL_SURREAL_URL=ws://127.0.0.1:8000 pnpm run test:quota:local
```

测试覆盖 Plus / Pro / Max 的数据表、字段和记录临界值，并验证把 Plus 从 1 张改成
2 张后第二张数据表可以立即创建。
