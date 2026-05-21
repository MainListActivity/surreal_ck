/**
 * 顶栏右侧菜单项注册表。
 *
 * 当前所有 action 都是 noop：点击仅关闭菜单。未来实现某项功能时，
 * 替换该项的 action 实现，无需修改 EditorTopbar 容器。
 */
export type MenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  action: () => void | Promise<void>;
};

const noop = () => {};

export const menuRegistry: MenuItem[] = [
  { id: "export", label: "导出为 Excel", action: noop },
  { id: "print", label: "打印", action: noop },
  { id: "copyLink", label: "复制链接", action: noop },
  { id: "history", label: "版本历史", action: noop },
  { id: "delete", label: "删除工作簿", danger: true, action: noop },
];
