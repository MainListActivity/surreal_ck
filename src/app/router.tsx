import {
  Navigate,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useSearch,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { authGateway, useAuthSnapshot } from '../features/auth/auth';
import { AppShell, AuthScreen } from '../features/workbook/app-shell';
import type { SidebarPanel } from '../features/workbook/mock-data';
import { IntakeForm } from '../forms/intake-form';
import { useConnectionSnapshot } from '../lib/surreal/client';
import { useSurrealClient } from '../lib/surreal/provider';
import type { UserProfile } from '../lib/surreal/types';

function RootLayout() {
  return <Outlet />;
}

function RequireAuth({ children }: { children: (user: UserProfile) => ReactNode }) {
  const auth = useAuthSnapshot();
  const connection = useConnectionSnapshot();

  if (auth.status === 'checking' || auth.status === 'authorizing') {
    return <AuthScreen title="正在恢复工作区" body="正在完成 OIDC 登录并恢复你上次打开的工作簿。" />;
  }

  if (!auth.isLoggedIn || !auth.user || connection.state === 'auth-failed') {
    return (
      <AuthScreen
        title="登录后继续处理债权申报工作簿"
        body="认证在前端完成，恢复后会自动返回上次打开的文档或工作簿。"
        error={connection.state === 'auth-failed' ? (connection.detail ?? auth.error) : auth.error}
        actionLabel="继续登录"
        onAction={() => {
          void authGateway.startLogin().catch(() => undefined);
        }}
      />
    );
  }

  return children(auth.user);
}

function isSidebarPanel(value: unknown): value is SidebarPanel {
  return value === 'none'
    || value === 'record'
    || value === 'graph'
    || value === 'history'
    || value === 'review'
    || value === 'ai'
    || value === 'admin';
}

function parsePanelSearch(search: Record<string, unknown>, fallback: SidebarPanel): { panel: SidebarPanel } {
  return {
    panel: isSidebarPanel(search.panel) ? search.panel : fallback,
  };
}

function HomeRoute() {
  return <Navigate to="/workbooks" search={{ panel: 'none' }} replace />;
}

function CallbackRoute() {
  return <AuthScreen title="正在恢复登录" body="正在处理回调并恢复你的工作区状态。" />;
}

function WorkbooksRoute() {
  const navigate = useNavigate();

  return (
    <RequireAuth>
      {(user) => (
        <AppShell
          view="home"
          displayName={user.name ?? user.email ?? user.sub}
          ownerUserId={user.recordId}
          onSelectWorkbook={(workbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: 'none' },
            });
          }}
          onSelectPanel={() => undefined}
          onShowHome={() => undefined}
          onShowTemplates={() => {
            void navigate({ to: '/templates', search: { panel: 'none' } });
          }}
          onShowAdmin={() => {
            void navigate({ to: '/admin', search: { panel: 'admin' } });
          }}
          onOpenPublishedForm={(workspaceId, formSlug) => {
            void navigate({
              to: '/public/$workspaceId/forms/$formSlug',
              params: { workspaceId, formSlug },
            });
          }}
          onLogout={() => {
            void authGateway.logout().catch(() => undefined);
          }}
        />
      )}
    </RequireAuth>
  );
}

function TemplatesRoute() {
  const navigate = useNavigate();

  return (
    <RequireAuth>
      {(user) => (
        <AppShell
          view="home"
          displayName={user.name ?? user.email ?? user.sub}
          ownerUserId={user.recordId}
          showTemplateGallery={true}
          onSelectWorkbook={(workbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: 'none' },
            });
          }}
          onSelectPanel={() => undefined}
          onShowHome={() => {
            void navigate({ to: '/workbooks', search: { panel: 'none' } });
          }}
          onShowTemplates={() => undefined}
          onShowAdmin={() => {
            void navigate({ to: '/admin', search: { panel: 'admin' } });
          }}
          onOpenPublishedForm={(workspaceId, formSlug) => {
            void navigate({
              to: '/public/$workspaceId/forms/$formSlug',
              params: { workspaceId, formSlug },
            });
          }}
          onLogout={() => {
            void authGateway.logout().catch(() => undefined);
          }}
        />
      )}
    </RequireAuth>
  );
}

function WorkbookRoute() {
  const navigate = useNavigate();
  const { workbookId } = workbookRoute.useParams();
  const { panel } = useSearch({ from: '/workbooks/$workbookId' });

  return (
    <RequireAuth>
      {(user) => (
        <AppShell
          view="editor"
          activeWorkbookId={workbookId}
          activePanel={panel}
          displayName={user.name ?? user.email ?? user.sub}
          ownerUserId={user.recordId}
          onSelectWorkbook={(nextWorkbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId: nextWorkbookId },
              search: { panel: panel === 'admin' ? 'none' : panel },
            });
          }}
          onSelectPanel={(nextPanel) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: nextPanel },
            });
          }}
          onShowHome={() => {
            void navigate({ to: '/workbooks', search: { panel: 'none' } });
          }}
          onShowTemplates={() => {
            void navigate({ to: '/templates', search: { panel: 'none' } });
          }}
          onShowAdmin={() => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: 'admin' },
            });
          }}
          onOpenPublishedForm={(workspaceId, formSlug) => {
            void navigate({
              to: '/public/$workspaceId/forms/$formSlug',
              params: { workspaceId, formSlug },
            });
          }}
          onLogout={() => {
            void authGateway.logout().catch(() => undefined);
          }}
        />
      )}
    </RequireAuth>
  );
}

function AdminRoute() {
  const navigate = useNavigate();
  const { panel } = useSearch({ from: '/admin' });

  return (
    <RequireAuth>
      {(user) => (
        <AppShell
          view="editor"
          activePanel={panel}
          displayName={user.name ?? user.email ?? user.sub}
          ownerUserId={user.recordId}
          onSelectWorkbook={(workbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: 'admin' },
            });
          }}
          onSelectPanel={(nextPanel) => {
            void navigate({ to: '/admin', search: { panel: nextPanel } });
          }}
          onShowHome={() => {
            void navigate({ to: '/workbooks', search: { panel: 'none' } });
          }}
          onShowTemplates={() => {
            void navigate({ to: '/templates', search: { panel: 'none' } });
          }}
          onShowAdmin={() => undefined}
          onOpenPublishedForm={(workspaceId, formSlug) => {
            void navigate({
              to: '/public/$workspaceId/forms/$formSlug',
              params: { workspaceId, formSlug },
            });
          }}
          onLogout={() => {
            void authGateway.logout().catch(() => undefined);
          }}
        />
      )}
    </RequireAuth>
  );
}

function PublicFormRoute() {
  const db = useSurrealClient();
  const { workspaceId, formSlug } = publicFormRoute.useParams();

  return <IntakeForm db={db} workspaceId={workspaceId} formSlug={formSlug} />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
});

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/callback',
  component: CallbackRoute,
});

const workbooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workbooks',
  validateSearch: (search) => parsePanelSearch(search as Record<string, unknown>, 'none'),
  component: WorkbooksRoute,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates',
  validateSearch: (search) => parsePanelSearch(search as Record<string, unknown>, 'none'),
  component: TemplatesRoute,
});

const workbookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workbooks/$workbookId',
  validateSearch: (search) => parsePanelSearch(search as Record<string, unknown>, 'none'),
  component: WorkbookRoute,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  validateSearch: (search) => parsePanelSearch(search as Record<string, unknown>, 'admin'),
  component: AdminRoute,
});

const publicFormRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/public/$workspaceId/forms/$formSlug',
  component: PublicFormRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  callbackRoute,
  workbooksRoute,
  templatesRoute,
  workbookRoute,
  adminRoute,
  publicFormRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultStructuralSharing: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouterProvider() {
  return <RouterProvider router={router} />;
}
