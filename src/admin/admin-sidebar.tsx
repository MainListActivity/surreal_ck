import { useState } from 'react';
import type { Surreal } from 'surrealdb';

import { EntityTypesPanel } from './entity-types';
import { FormBuilderPanel } from './form-builder';
import { RelationTypesPanel } from './relation-types';
import { WorkspaceMembersPanel } from './workspace-members';

type AdminSection = 'entity-types' | 'relation-types' | 'form-builder' | 'workspace-members';

const SECTION_LABELS: Record<AdminSection, string> = {
  'entity-types': '实体类型',
  'relation-types': '关系类型',
  'form-builder': '表单构建',
  'workspace-members': '工作区成员',
};

export interface AdminSidebarProps {
  db: Surreal;
  workspaceId: string;
  workbookId: string;
  wsKey: string;
  isAdmin: boolean;
}

export function AdminSidebar({ db, workspaceId, workbookId, wsKey, isAdmin }: AdminSidebarProps) {
  const [activeSection, setActiveSection] = useState<AdminSection>('entity-types');

  if (!isAdmin) {
    return null;
  }

  return (
    <div className="sidebar-panel__content admin-sidebar">
      <p className="eyebrow">管理工具</p>
      <nav className="admin-sidebar__nav" aria-label="管理模块">
        {(Object.keys(SECTION_LABELS) as AdminSection[]).map((key) => (
          <button
            key={key}
            className={`rail-button ${activeSection === key ? 'rail-button--active' : ''}`}
            type="button"
            onClick={() => setActiveSection(key)}
          >
            {SECTION_LABELS[key]}
          </button>
        ))}
      </nav>

      <div className="admin-sidebar__content">
        {activeSection === 'entity-types' && (
          <EntityTypesPanel db={db} workspaceId={workspaceId} workbookId={workbookId} wsKey={wsKey} />
        )}
        {activeSection === 'relation-types' && (
          <RelationTypesPanel db={db} workspaceId={workspaceId} wsKey={wsKey} />
        )}
        {activeSection === 'form-builder' && (
          <FormBuilderPanel db={db} workspaceId={workspaceId} workbookId={workbookId} />
        )}
        {activeSection === 'workspace-members' && (
          <WorkspaceMembersPanel db={db} workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
