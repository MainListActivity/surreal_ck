import { ApplicationMenu } from "electrobun/bun";
import type { ApplicationMenuItemConfig } from "electrobun/bun";

/**
 * 注册原生应用菜单。
 *
 * macOS 上 WebView 必须通过原生菜单的 role 才能把 Cmd+C/V/X/A/Z 等系统快捷键
 * 转发为 NSResponder 选择子（cut:/copy:/paste:/selectAll:/undo:/redo:），否则
 * WebView 不会触发 DOM 的 copy/paste 事件，所有文本框、表格剪贴板能力都失效。
 *
 * Linux/Windows 由 webview 内置快捷键直接处理，但保留同一份菜单配置不会冲突。
 */
export function installApplicationMenu() {
  const editSubmenu: ApplicationMenuItemConfig[] = [
    { role: "undo", accelerator: "CommandOrControl+Z" },
    { role: "redo", accelerator: "Shift+CommandOrControl+Z" },
    { type: "separator" },
    { role: "cut", accelerator: "CommandOrControl+X" },
    { role: "copy", accelerator: "CommandOrControl+C" },
    { role: "paste", accelerator: "CommandOrControl+V" },
    { role: "pasteAndMatchStyle", accelerator: "Shift+CommandOrControl+V" },
    { role: "delete" },
    { role: "selectAll", accelerator: "CommandOrControl+A" },
  ];

  const menu: ApplicationMenuItemConfig[] = [
    {
      label: "SurrealCK",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide", accelerator: "CommandOrControl+H" },
        { role: "hideOthers", accelerator: "Alt+CommandOrControl+H" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit", accelerator: "CommandOrControl+Q" },
      ],
    },
    { label: "编辑", submenu: editSubmenu },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", accelerator: "CommandOrControl+M" },
        { role: "zoom" },
        { role: "close", accelerator: "CommandOrControl+W" },
      ],
    },
  ];

  try {
    ApplicationMenu.setApplicationMenu(menu);
  } catch (err) {
    console.warn("[main] setApplicationMenu failed:", err);
  }
}
