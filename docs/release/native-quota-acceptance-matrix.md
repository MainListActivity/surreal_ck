# SCK-NQ-10 原生配额发布验收矩阵

## 自动化证据

| 能力/故障 | 自动化证据 |
| --- | --- |
| database Owner 篡改旧 plan/counter/event 不能绕过 | `native-quota-cross-repo.integration.test.ts` legacy tamper + native reject |
| exact/regex table/field/record | 同一 RocksDB E2E 的 `ent_forbidden`、`^ent_`、`ent_claim` |
| 字段首期限制 | 第三个 `DEFINE FIELD` 原子拒绝 |
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
| vanilla 拒绝 | 真实 upstream 3.2.3 进程被 production capability gate 拒绝 |
| unknown capability/未认证 backend | `startup-gate.test.ts` fail-closed fixtures |
| grace/retention/override | `subscription-lifecycle.integration.test.ts` + lifecycle table tests |
| commit unknown/fault injection/multi-node | fork `quota_backend_contract` + `quota_rocksdb_certification` |
| multi-arch/SBOM/provenance/漏洞 | fork candidate manifest + 下游 acceptance workflow 重新校验 |
| digest-only deployment | compose required interpolation + workflow resolved config gate |

本地可重复命令：

```bash
pnpm test:quota:cross-repo
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
- 可选 signature waiver；
- live RocksDB capability；
- OCI multi-arch index；
- resolved digest-only compose；
- keyless signed downstream acceptance statement。

cohort 的 24h/48h 观察窗、pause/resume、生产 dispatch 和 30 日 cleanup 不能由单次
测试伪造；必须按
[`native-quota-release-cutover.md`](../runbooks/native-quota-release-cutover.md)
留存真实运行记录。
