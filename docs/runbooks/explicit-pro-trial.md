# 显式七日 Pro 受控试用

普通 `/api/workspaces` 创建不再自动生成十四日 trial；返回 `commercial-source-required`。用户经 `/api/pro-trial/accounts`、`preview` 核对范围并主动确认后调用 `start`。仅 active 计费账户 owner/admin 且具显式资格可启动；workspace admin 身份不构成资格。

## 发布准备

`shared/sql/system/026-explicit-pro-trial.surql` 仅新增控制面表、字段、唯一索引和不可变事件，无存量数据改写、无默认商业配置/资格/额度。无新增环境变量或主机准备；沿用现有 system migration 发布入口和自有 native quota fork。

上线前审批 Pro 核心 product revision：仅 search/read/cite、research 与共享 `ai_cycle_allowance`，不含 export/专业模块/Max 通道；引用 trial 类型且 `^ent_` table/field/record 有限容量的不可变资源模板。每个 collection 必须有至少一条许可有效、发布状态有效且支持研究的内容，供应才可激活。容量、额度、研究费率、提醒时点由审批版本给出，本文不提供商业数值。

使用 operator 的 `subscription.manage` 能力，通过受控运维通道调用：

- `POST /api/ops/pro-trial/configuration`：`revisionKey`、`productRevision`、`researchRate`、`rateRevision`（至少 2）、`reminderHours`（1–167 小时）、`fixture`、`reason`、`enabled`（默认 true）。同 key 内容不可改；新配置使用新 key。费率修订必须避免与既有不同费率修订冲突。`enabled:false` 停止新领取；已有领取仍可按原不可变版本恢复。
- `POST /api/ops/pro-trial/eligibility`：`accountKey`、`enabled`、`reason`。仅已有 active 账户可被放行；不新增账号或将 workspace admin 提升为计费管理员。撤销资格会拒绝原请求恢复。

fixture:true 显示内部验收说明，不能作为正式商业承诺；语义检索销售承诺仍依赖 LCA12。禁止直接找 token、手工 root 业务写入或开启机器通道。

## 时钟、故障与恢复

预览起止时间为服务端估计；首次领取数据库 `time::now()` 固定开始与开始 + 7d 的截止，期间失败仍消耗原七日，不重置计时。客户端只回传展示版本用于变更校验，不能指定商品、额度或期限。

账户领取 slot/幂等请求用数据库事务收敛；同账户已有有效 trial（包括旧订阅 trial）不能再次领取。十分钟供应 lease 防止并发执行，失败释放；进程中断待 lease 超时，使用原账户、name、slug、key 重试。页面在本会话保存这些公开字段以恢复；身份、资格每次重新核验。当前配置切换不会更换旧请求的冻结版本。关闭配置停止新领取，撤销账户资格用于停止旧请求恢复。

恢复沿用 workspace reservation、订阅来源和内容投影/AI grant。产品、配额、内容许可投影与额度读回确认后，workspace active 和 claim active 在同一事务提交。无授权/无内容/过期/lease 丢失即拒绝激活。已生成但未就绪的数据库保留以恢复，不自动删除。

到期交由 LCA08 的订阅生命周期/内容撤回和 LCA09 当前权限引用/成果保留处理。Plus/Pro/Max 转换必须使用新商业来源及新周期；旧 trial bucket 不继承。提醒目前为成员配额页内提示（刷新间隔一分钟），不发送邮件或自动购买。

## 上线验收与回滚

实现阶段本地数据库供应/并发和受控页面检查，不替代生产用户身份与真实内容研究实测。独立验收后另开合入部署任务，在获批 fixture 配置下记录：显式启动回执、邀请成员后共享范围/余额、一项关键词/语义研究、引用打开、成果保存、准确截止权限收回、保留成果、Plus/Pro/Max 新来源及周期不继承旧余额。测成员/仅 workspace admin 拒绝、跨账户隔离、并发与中断恢复。生产模型调用或计费操作按受控运维授权范围执行。

回滚先禁用当前配置并撤销未完成测试账户资格，再回滚应用提交。新增控制面结构和已发 trial 不删除。回滚/恢复目标的入口语义由发布脚本门禁强制执行（见 production-release.md「切换与回滚的可执行门禁」）：目标是会恢复隐式试用创建的旧 origin（LCA10 之前，公共创建入口自授 trial）时，发布与自动回滚都会被拒绝，不会在人工处置前静默恢复旧入口。保留已有 workspace 和成果，继续使用订阅有效期与当前权限约束。
