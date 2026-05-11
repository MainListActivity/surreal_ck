Status: done
Label: done

# RR-002 — Embedding profile 与索引状态

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

在资源主数据之上增加独立 embedding 配置和索引状态模型。资源保存不依赖 embedding 配置；没有配置时资源仍可保存并标记为 disabled。配置存在时，资源 embedding 作为可再生索引独立于资源主记录保存，并按 profile 隔离 provider、model、dimensions 和版本。

完成后，系统应能表达 pending/indexed/failed/disabled/stale 等状态，并支持资源级重试索引请求。

## Acceptance criteria

- [x] embedding provider/model/dimensions 配置独立于聊天模型设置。
- [x] embedding profile key 能稳定区分 provider、model、dimensions 和版本。
- [x] resource embedding 与 resource item 分开保存，且同一资源可按不同 profile 表达索引状态。
- [x] 不同 profile 的向量不会被混用于同一次相似度检索。
- [x] embedding 未配置时，资源保存成功并暴露 disabled 状态。
- [x] embedding 生成失败时记录 failed 状态和错误摘要，资源主数据不回滚。
- [x] profile 变更后旧 embedding 被标记为 stale 或进入待重算状态。
- [x] 支持资源级 retry indexing 请求，把失败或 stale 状态重新置为待处理。
- [x] 测试覆盖 profile key、disabled、pending/indexed/failed、profile 隔离、stale 标记和 retry 状态转换。

## Blocked by

- `.scratch/resource-retrieval/issues/01-resource-main-data.md`

