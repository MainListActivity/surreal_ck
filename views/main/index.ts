// webview 入口——先初始化 IPC，再挂载 React 应用
// electrobun 的 view 环境在此注入全局 __electrobunWebviewId 等变量

// 导入 IPC 客户端（完成 WebSocket 握手）
import "./ipc";

// 挂载 React 应用（沿用 src/main.tsx 的逻辑）
import "../../src/main.tsx";
