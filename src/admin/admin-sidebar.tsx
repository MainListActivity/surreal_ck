import { useState } from 'react';
import type { Surreal } from 'surrealdb';

import { EntityTypesPanel } from './entity-types';
import { FormBuilderPanel } from './form-builder';
import { RelationTypesPanel } from './relation-types';
import { WorkspaceMembersPanel } from './workspace-members';

type AdminSection = 'entity-types' | 'relation-types' | 'form-builder' | 'workspace-members';

const SECTION_LABELS: Record<AdminSection, string> = {
  'entity-types': 'Entity Types',
  'relation-types': 'Relationship Types',
  'form-builder': 'Form Builder',
  'workspace-members': 'Workspace Members',
};

export interface AdminSidebarProps {
  db: Surreal;
  workspaceId: string;
  isAdmin: boolean;
}

export function AdminSidebar({ db, workspaceId, isAdmin }: AdminSidebarProps) {
  const [activeSection, setActiveSection] = useState<AdminSection>('entity-types');

  if (!isAdmin) {
    return null;
  }

  return (
    <div className="sidebar-panel__content admin-sidebar">
      <p className="eyebrow">Admin tools</p>
      <nav className="admin-sidebar__nav" aria-label="Admin sections">
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
          <EntityTypesPanel db={db} workspaceId={workspaceId} />
        )}
        {activeSection === 'relation-types' && (
          <RelationTypesPanel db={db} workspaceId={workspaceId} />
        )}
        {activeSection === 'form-builder' && (
          <FormBuilderPanel db={db} workspaceId={workspaceId} />
        )}
        {activeSection === 'workspace-members' && (
          <WorkspaceMembersPanel db={db} workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
