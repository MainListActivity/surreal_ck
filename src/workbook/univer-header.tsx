import { createElement, useState } from 'react';
import type { FUniver } from '@univerjs/core/lib/facade';

export interface UniverHeaderOptions {
  workbookName: string;
  displayName?: string;
  workbooks: Array<{ id: string; name: string; updated_at?: string | null }>;
  activeWorkbookId?: string;
  onSelectWorkbook?: (id: string) => void;
  onShowAdmin?: () => void;
  onLogout?: () => void;
}

/**
 * Left header component: sidebar toggle (workbook switcher) + editable doc title.
 */
function HeaderLeft({
  workbookName,
  workbooks,
  activeWorkbookId,
  onSelectWorkbook,
}: Pick<UniverHeaderOptions, 'workbookName' | 'workbooks' | 'activeWorkbookId' | 'onSelectWorkbook'>) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(workbookName);
  const [isEditing, setIsEditing] = useState(false);

  // Sync when workbookName changes (workbook switch)
  if (!isEditing && title !== workbookName) {
    setTitle(workbookName);
  }

  return createElement('div', { className: 'ck-header-left' },
    // Workbook switcher button
    createElement('button', {
      className: 'ck-header-btn ck-header-btn--icon',
      type: 'button',
      title: open ? '关闭工作簿列表' : '切换工作簿',
      'aria-label': open ? '关闭工作簿列表' : '切换工作簿',
      onClick: () => setOpen((v) => !v),
    },
      createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        createElement('rect', { x: 2, y: 3, width: 12, height: 1.5, rx: 0.75, fill: 'currentColor' }),
        createElement('rect', { x: 2, y: 7.25, width: 12, height: 1.5, rx: 0.75, fill: 'currentColor' }),
        createElement('rect', { x: 2, y: 11.5, width: 12, height: 1.5, rx: 0.75, fill: 'currentColor' }),
      ),
    ),

    // Workbook dropdown
    open && createElement('div', { className: 'ck-header-dropdown' },
      workbooks.map((wb) =>
        createElement('button', {
          key: wb.id,
          className: `ck-header-dropdown__item ${wb.id === activeWorkbookId ? 'ck-header-dropdown__item--active' : ''}`,
          type: 'button',
          onClick: () => {
            onSelectWorkbook?.(wb.id);
            setOpen(false);
          },
        }, wb.name),
      ),
    ),

    // Editable title
    isEditing
      ? createElement('input', {
        className: 'ck-header-title-input',
        value: title,
        autoFocus: true,
        'aria-label': '工作簿标题',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value),
        onBlur: () => setIsEditing(false),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLElement).blur();
        },
      })
      : createElement('button', {
        className: 'ck-header-title',
        type: 'button',
        title: '点击重命名',
        'aria-label': `工作簿：${title}。点击重命名。`,
        onClick: () => setIsEditing(true),
      }, title || createElement('span', { className: 'ck-header-title__placeholder' }, '未命名')),
  );
}

/**
 * Right header component: share button + user avatar.
 */
function HeaderRight({ displayName, onLogout }: Pick<UniverHeaderOptions, 'displayName' | 'onLogout'>) {
  const initials = (displayName ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w: string) => w[0].toUpperCase())
    .join('') || '?';

  const handleShare = () => {
    void navigator.clipboard.writeText(window.location.href).catch(() => undefined);
  };

  return createElement('div', { className: 'ck-header-right' },
    // Share button
    createElement('button', {
      className: 'ck-header-btn ck-header-btn--share',
      type: 'button',
      title: '复制链接到剪贴板',
      'aria-label': '分享工作簿',
      onClick: handleShare,
    },
      createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true, style: { marginRight: 5 } },
        createElement('circle', { cx: 11, cy: 2.5, r: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
        createElement('circle', { cx: 3, cy: 7, r: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
        createElement('circle', { cx: 11, cy: 11.5, r: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
        createElement('line', { x1: 4.7, y1: 6.1, x2: 9.3, y2: 3.4, stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        createElement('line', { x1: 4.7, y1: 7.9, x2: 9.3, y2: 10.6, stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      ),
      '分享',
    ),

    // Avatar — clicking shows logout if available
    createElement('button', {
      className: 'ck-header-avatar',
      type: 'button',
      title: onLogout ? `${displayName ?? '用户'} — 点击退出` : (displayName ?? '用户'),
      'aria-label': displayName ?? '用户',
      onClick: onLogout ?? undefined,
    }, initials),
  );
}

/**
 * Register left and right custom header extensions into Univer's header bar.
 *
 * The top bar (title, avatar, autosave) is now owned by the React shell
 * (EditorChrome → ck-editor-topbar). These slots are intentionally left empty
 * so Univer's native header area is used only for the menu bar.
 */
export function mountUniverHeaderExtensions(
  univerAPI: FUniver,
  _opts: UniverHeaderOptions,
): void {
  univerAPI.registerUIPart(
    'custom-left' as Parameters<typeof univerAPI.registerUIPart>[0],
    () => null,
  );

  univerAPI.registerUIPart(
    'custom-right' as Parameters<typeof univerAPI.registerUIPart>[0],
    () => null,
  );
}
