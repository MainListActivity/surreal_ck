Status: done
Label: done

# RR-006 — 人工检索 session 与独立检索窗口壳

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

实现低置信/未命中后的人工检索入口。workflow 不让 search tool 自动开窗，而是在编排层创建持久 research session 并发出 manual research suspend。主进程打开独立检索窗口，窗口由可信本地壳和外部 WebView 组成。

V1 检索窗口只允许 http/https 导航。外部网页没有主进程 RPC 权限；所有记录、保存、完成检索动作都发生在可信壳中。

## Acceptance criteria

- [x] 低置信或 miss 状态创建持久 research session，并把 sessionId 放入 suspend payload。
- [x] research session 记录 originating run、query/context、resourceType、workspace、createdBy 和 open 状态。
- [x] 主进程可根据 sessionId 打开独立检索窗口。
- [x] 检索窗口可信壳能展示 session 基础信息和目标 query/resourceType。
- [x] 外部 WebView 只能导航到 http/https URL，禁止 file/views/javascript 等协议。
- [x] 外部网页不获得应用 RPC、数据库、AI 设置或保存资源权限。
- [x] 检索窗口关闭、取消或 session 取消时状态可被持久化。
- [x] 测试覆盖 session 创建、suspend payload、URL 协议校验、窗口状态消息和权限边界的可测试部分。

## Blocked by

- `.scratch/resource-retrieval/issues/04-resource-agent-readonly-citations.md`
