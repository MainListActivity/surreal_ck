# SCK-NQ-10 原生配额发布验收矩阵

> **状态：已冻结（2026-09-29）**
>
> 老板决定（2026-09-29）：生产 SurrealDB 按现状运行——当前为单机 native-quota
> fork 部署，数据面部署拓扑不得变更；本矩阵对应的生产收口方案随之冻结。
> 下述验收口径仅作备查保留：全部用例为当前部署 backend 的认证口径，收口流程
> 须在阶段一按实际部署拓扑重写后重启。
>
> 关联任务：`477e239e-2f1c-46c8-a377-4be98b9341d7`（冻结归档）、
> `98ba14f2-7601-4345-9e5a-88a09da86665`（backend 配额契约实测与认证差距评估）。

## 自动化证据

| 能力/故障 | 自动化证据 |
| --- | --- |
| database Owner 篡改旧 plan/counter/event 不能绕过 | `native-quota-cross-repo.integration.test.ts` legacy tamper + native reject |
| exact/regex table/field/record | 同一 RocksDB E2E 分别以 exact field/record 和 `^ent_` table/field/record 触发上限 |
| 字段首期限制 | exact 表第三个字段、regex 表第四个字段分别原子拒绝 |
| 批量原子 | 余量 1 时插入 2 条，全批拒绝且物理 count 不变 |
| 并发最后名额 | 10 个 surrealdb-js WSS participant 会话争抢 3 个名额，精确 3 成功 |
| Owner/participant/IAM | namespace Owner 可管理 policy；database Owner/participant 不能修改 policy/DDL |
| HTTP/WSS/浏览器错误 | `Quota` envelope 在 HTTP 与 WSS 保真；participant DTO 裁剪且保留草稿 |
| upgrade applied/readback | generation 1→2 readback 后才使用新增容量 |
| downgrade/retention 非恶化 | 已有 5 条降至 limit 2 不删数；拒绝增长，允许 update/delete/净零 |
| drift/generation race | 外部 generation 变化后 stale apply 结构化失败，再按 fresh generation 修复 |
| rebuild | `REBUILD QUOTA IF NEEDED` 后 ledger ready/trusted |
| engine restart | 同一 RocksDB 路径重启后 policy/generation/usage/enforcement 保持 |
| snapshot restore | 冷 snapshot 到隔离路径，制造差异后恢复并核对 count/policy/ledger |
| cleanup migration | generation-guard policy reassert 与旧 event 删除同事务，native reject 仍有效 |
| migration conductor | 真实 RocksDB 上 inventory/manifest/rebuild/materialization/readback、重启恢复、五 cohort、event cutover 与 30 日 cleanup eligibility |
| vanilla 拒绝 | 真实 upstream 3.2.3 进程被 production capability gate 拒绝 |
| unknown capability/未认证 backend | `startup-gate.test.ts` fail-closed fixtures |
| grace/retention/override | `subscription-lifecycle.integration.test.ts` + lifecycle table tests |
| commit unknown/fault injection/multi-node | fork `quota_backend_contract` + `quota_rocksdb_certification` |
| multi-arch/SBOM/provenance/漏洞 | fork candidate manifest + 下游 acceptance workflow 重新校验 |
| digest-only deployment | compose required interpolation + workflow resolved config gate |

本地可重复命令：

```bash
pnpm test:quota:cross-repo
pnpm test:quota:integration
pnpm lint
pnpm typecheck
pnpm test
```

fork 定向命令：

```bash
cargo test -p surrealdb-core --no-default-features --features kv-mem \
  --lib 'kvs::tests::mem::quota_' -- --test-threads=1
cargo test -p surrealdb-core --no-default-features --features kv-rocksdb \
  --lib 'kvs::tests::rocksdb::quota_' -- --test-threads=1
cargo test -p surrealdb-core --no-default-features --features kv-rocksdb \
  quota_rocksdb_certification -- --test-threads=1
cargo test -p surrealdb-server capability::tests --lib
python3 -m unittest scripts/native-quota/test_release_manifest.py
```

## 手工发布证据

每次发布由
`.github/workflows/native-quota-release-acceptance.yml` 生成并保留 90 日：

- verified candidate identity；
- 默认 keyless candidate/image 校验；无证书场景只可显式选择并记录 signature waiver；
- live RocksDB capability；
- OCI multi-arch index；
- 不含凭证的 digest-only compose 校验证据；
- keyless signed downstream acceptance statement。

cohort 的 24h/48h 观察窗、pause/resume、生产 dispatch 和 30 日 cleanup 不能由单次
测试伪造；必须按
[`native-quota-release-cutover.md`](../runbooks/native-quota-release-cutover.md)
留存真实运行记录。
