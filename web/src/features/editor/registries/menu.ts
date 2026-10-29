/**
 * 顶栏右侧菜单项注册表。
 *
 * 除导出外所有 action 仍是 noop：点击仅关闭菜单。导出由调用方注入 handler，
 * 使本模块不依赖 editor store，可在纯 bun 测试中直接构造。
 */
export type MenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  action: () => void | Promise<void>;
};

export type MenuHandlers = {
  exportCsv: () => void | Promise<void>;
};

const noop = () => {};

export function buildMenuRegistry(handlers: MenuHandlers): MenuItem[] {
  return [
    { id: "export", label: "导出为 CSV", action: handlers.exportCsv },
    { id: "print", label: "打印", action: noop },
    { id: "copyLink", label: "复制链接", action: noop },
    { id: "history", label: "版本历史", action: noop },
    { id: "delete", label: "删除工作簿", danger: true, action: noop },
  ];
}
