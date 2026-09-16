# 平台法律内容本地 Runner

本地 Runner 只负责把本地采集/清洗 agent 产出的 **成品 `IngestionBatch` JSON** 推送到平台内容 MCP。它不抓取网页、不持有 SurrealDB root、不自动绕过运营审核；来源站点适配和正文许可判断必须在本地完成，并由运营端登记来源许可。

## 配置

```bash
export CONTENT_MCP_URL=https://api.example.com/api/ops/mcp
export CONTENT_ACCESS_TOKEN='从 OAuth 授权得到的短期 access token'
export CONTENT_BATCH_FILE=/absolute/path/batch.json
export CONTENT_CHECKPOINT_FILE=/absolute/path/content-runner-checkpoint.json
```

`CONTENT_ACCESS_TOKEN` 不会写入检查点或日志。检查点只保存幂等键、公开 `batchId`、审阅时间和发布状态。

## 运行

```bash
# 先发现契约、提交、完整分页 inspect；默认停在人工审阅
pnpm content:runner

# 仅用于本地 MCP 联调的合成文书，不代表真实来源许可
CONTENT_MCP_URL=... CONTENT_ACCESS_TOKEN=... pnpm content:runner -- --fixture

# 只有人工在运营端确认后，才显式允许发布
CONTENT_PUBLISH_CONFIRM=YES pnpm content:runner -- --publish
```

Runner 的顺序固定为：`initialize` → `get_data_contract` → `submit_batch`（同 actor/幂等键可安全重跑）→ 分页 `inspect_batch`。没有 `--publish` 时永远不调用 `publish_batch`；`--publish` 仍要求 `CONTENT_PUBLISH_CONFIRM=YES`，且只提交状态为 `ready` 的条目。

## Codex OAuth / MCP 验收

生产验收使用 `.scratch/legal-content-mcp/scripts/ego-mcp-e2e.mjs` 完成真人登录与
同意，再使用 `.scratch/legal-content-mcp/scripts/mcp-oauth-e2e.mjs` 换取 token 并
调用五工具。两个脚本只在本机临时目录读写 0600 文件，绝不把密码、授权码或 token
写入仓库或终端输出：

```bash
# Ego 页面脚本：必须在用户明确交还 TaskSpace 后运行；默认复用 TaskSpace 1 / p1。
# ego-browser 的 Node runtime 只接受 heredoc；替换成你的工作区绝对路径。
rtk proxy ego-browser nodejs <<'EOF'
await import('file:///Users/y/IdeaProjects/surreal_ck/.scratch/legal-content-mcp/scripts/ego-mcp-e2e.mjs')
EOF

# 回调已生成后，执行发现、五工具、刷新、重连和撤销验收
CONTENT_MCP_URL=https://l.maplayer.top/api/ops/mcp \
  rtk proxy node .scratch/legal-content-mcp/scripts/mcp-oauth-e2e.mjs
```

验收脚本默认只提交并 inspect。要执行明确的发布测试，必须同时提供一个已登记且
获许可的成品批次（或显式标记为 synthetic 的 `--fixture`）以及：

```bash
CONTENT_PUBLISH_CONFIRM=YES \
  rtk proxy node .scratch/legal-content-mcp/scripts/mcp-oauth-e2e.mjs --fixture --publish
```

需要执行 SCK-LCM-10 的完整生产验收时，再明确加入 `--full-lifecycle`：它会使用
不可售的 synthetic 文书和法规，验证文书发布、修订、撤回、恢复、法规条文拆分及
已发布投影读取。流程结束时文书和法规均恢复为已发布状态；不会创建真实来源或可售数据。

```bash
CONTENT_PUBLISH_CONFIRM=YES \
  rtk proxy node .scratch/legal-content-mcp/scripts/mcp-oauth-e2e.mjs \
  --fixture --publish --full-lifecycle
```

`--fixture` 仅用于协议联调，来源键 `fixture.synthetic.cn` 未登记时应准确记录
`source_not_registered`，不能把这种结果当作真实法规/裁判文书发布成功。详细结果写入
`CONTENT_E2E_REPORT_FILE`（默认 `/tmp/sck-mcp-e2e-report.json`），摘要不包含凭证。

## 采集与持续更新约定

- 本地 agent 应为每次采集生成稳定的 `idempotencyKey`，同一来源记录使用 `source.recordKey`，重叠发现由服务端按来源记录和正文摘要去重。
- 每次运行保留检查点；网络错误、401、refresh 失败或来源被撤权时停止远端操作，重新 OAuth 登录后再继续。
- 采集失败、正文不完整、法条/引用无法定位时，保留 `fieldIssues`、`evidence` 和 `processing`，不要伪造完整正文；批次会在运营端显示失败原因。
- 来源许可由 `/api/content/sources` 管理。新的许可修订不会改写历史批次，提交时生效的修订会写入 `sourceLicenseSnapshot`。
- 运行器不创建定时任务。需要定时采集时由运营明确配置本地 scheduler，并保持默认“提交后待审核”。

## 脱机与重跑

如果提交前离线，检查点不会前进；恢复网络后可重跑相同命令。若提交已成功但进程在写检查点前退出，按相同幂等键重跑会得到原批次，而不会重复入库。更换输入内容时必须更换幂等键，或明确使用 `--force` 并更换检查点文件。

## 当前限制

首期不提供可视化爬虫/清洗编辑器，也不内置真实中国大陆法规或裁判文书抓取器。只有已登记、许可状态允许 `submit` 的来源才能进入成品批次；真实来源的获取、清洗和许可证明仍由本地 agent 与运营审核负责。
