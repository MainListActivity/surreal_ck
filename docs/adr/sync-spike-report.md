# Sync Spike Report

- Generated At: 2026-05-11T15:39:32.649Z
- Conclusion: 当前可按 ADR echo 防护方案继续落地；远端未验证时保持 WORKAROUND 标记。

| # | Check | Status |
|---|---|---|
| 1 | embedded localdb: DEFINE PARAM 后续查询可读 | PASS |
| 2 | embedded localdb: EVENT 可读 PARAM | PASS |
| 3 | embedded localdb: 普通 CREATE/UPDATE 自动注入 origin | PASS |
| 5 | embedded localdb: 显式 remote origin 不被 EVENT 覆盖 | PASS |
| 4 | embedded localdb: CHANGEFEED 包含 _origin_session_id | PASS |
| 6 | embedded localdb: EVENT UPDATE 无无限自循环 | PASS |
| 7 | embedded localdb: CHANGEFEED 是否记录 EVENT 二次字段写入 | PASS |
| 0 | remote SurrealDB Cloud | WORKAROUND |

## Details

### 1. embedded localdb: DEFINE PARAM 后续查询可读

Status: PASS

```text
[{"sid":"8e0c99c8-aa24-4113-9d4d-bbec81778a8a"}]
```

### 2. embedded localdb: EVENT 可读 PARAM

Status: PASS

```text
[[{"_origin_session_id":"8e0c99c8-aa24-4113-9d4d-bbec81778a8a"}]]
```

### 3. embedded localdb: 普通 CREATE/UPDATE 自动注入 origin

Status: PASS

```text
[[{"_origin_session_id":"8e0c99c8-aa24-4113-9d4d-bbec81778a8a"}]]
```

### 5. embedded localdb: 显式 remote origin 不被 EVENT 覆盖

Status: PASS

```text
[[{"_origin_session_id":"remote:vs1"}]]
```

### 4. embedded localdb: CHANGEFEED 包含 _origin_session_id

Status: PASS

```text
[[{"changes":[{"define_table":{"changefeed":{"expiry":"1w","original":false},"drop":false,"id":0,"kind":{"kind":"ANY"},"name":"sync_spike_805fada3_93f9_415d_b5c3_3f3ee87a43a4","permissions":{"create":true,"delete":true,"select":true,"update":true},"schemafull":false}}],"versionstamp":"116556691711328256"},{"changes":[{"update":{"_origin_session_id":"8e0c99c8-aa24-4113-9d4d-bbec81778a8a","id":"sync_spike_805fada3_93f9_415d_b5c3_3f3ee87a43a4:one","name":"local"}},{"update":{"id":"sync_spike_805fada3_93f9_415d_b5c3_3f3ee87a43a4:one","name":"local"}}],"versionstamp":"116556691711393792"},{"changes":[{"update":{"_origin_session_id":"remote:vs1","id":"sync_spike_805fada3_93f9_415d_b5c3_3f3ee87a43a4:one","name":"remote"}}],"versionstamp":"116556691711459328"}]]
```

### 6. embedded localdb: EVENT UPDATE 无无限自循环

Status: PASS

```text
SHOW CHANGES 返回，脚本未阻塞。
```

### 7. embedded localdb: CHANGEFEED 是否记录 EVENT 二次字段写入

Status: PASS

```text
变更流可见 origin 字段，可按 ADR echo 过滤。
```

### 0. remote SurrealDB Cloud

Status: WORKAROUND

```text
未设置 SYNC_SPIKE_REMOTE_URL / SYNC_SPIKE_REMOTE_JWT，本次只验证 embedded localdb。
```

