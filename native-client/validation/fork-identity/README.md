# 隔离用户 fork 身份边界验证

日期：2026-11-10；应用源码基线 e2ee002（测试所用schema与8cd70f9一致）。仅云机本地内存数据库和本地JWKS测试服务，未连接生产、读取.env或获取公司测试grant。所有服务在测试后已关闭。本文记录已完成证据，不是生产漏洞影响结论。

## 引擎与输入

- 官方用户fork产物：https://github.com/MainListActivity/surrealdb/releases/download/sck-3.3.0-native-quota.1-candidate.105/surreal-native-quota.linux-amd64.tgz
- 69,856,050字节；SHA256 `06af02af91e90a245f1f30a145629d965ed8837912118915c11b1d46812ec49e`，实际下载后校验一致。
- Release commit `f30704bce91412b14a9d4be96809786d83c1a858`；实际version输出 `3.3.0-native-quota.1+sha.f30704bce914 for linux on x86_64`。
- Bun 1.3.12，独立probe最小依赖安装，不改应用package或锁文件。隔离shared/package.json仅调整wildcard导出扩展名供Bun解析TS。
- 122个SQL文件与原仓库逐字节hash一致，见sql-hashes.json。workspace schema加载至060。未新增或修改SQL。
- 维护身份仅准备/停用本地fixture与加载schema；业务断言使用独立RECORD/participant JWT会话，未用root代替参与者。

## 已完成结果

1. 原entity-member-permissions集成测试：3通过、34断言。成员CRUD、DDL拒绝、停用后实体DML撤销等按该测试实际断言验证。
2. 原employee-lifecycle中participant RECORD用例：1通过、1断言，验证创建其他user记录被拒。原测试名称“不能写user”不能扩展成所有自身字段更新均受保护。
3. 隔离SDK补测：1通过、4断言。停用participant仍可重新authenticate；自身记录的disabled_at可清除；自身is_admin可写为true。最后两项只证明字段写入，未证明实际跨用户越权或admin access提升。

三个日志仅包含测试名称/结果，无token、私钥或身份凭据。补测只在独立副本使用SDK记录更新，不将其加入生产入口。进一步权限影响与索引复活验证已停止，没有继续扩大验证。

## 边界与处置

- 未验证生产schema版本/生产账号影响、JWT admin或DDL升级、reconciler索引恢复，也未测试认证信令的真实并发规则。
- 不修改SQL、不部署、不调整用户权限或安全配置。缺少仓库要求的SurrealQL技能，不能据此擅自补迁移。
- native-signaling仍无条件阻断企业认证入口。静态active索引或旧scope不能在修复及回归验收前被宣称为可靠撤销权威。
- 后续防护要求见native-signaling/README.md：身份/成员权限字段不可由普通成员修改、认证与既有会话撤销一致、控制面权威记录不能被reconciler从用户可改记录反向复活。
