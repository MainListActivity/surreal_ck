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
import type { SidebarPanel, TemplateKey } from '../features/workbook/mock-data';
import { getDefaultPanelForTemplate } from '../features/workbook/mock-data';
import { AppShell, AuthScreen } from '../features/workbook/app-shell';
import { useConnectionSnapshot } from '../lib/surreal/client';

function RootLayout() {
  return <Outlet />;
}

function RequireAuth({ children }: { children: (displayName: string) => ReactNode }) {
  const auth = useAuthSnapshot();
  const connection = useConnectionSnapshot();

  if (auth.status === 'checking' || auth.status === 'authorizing') {
    return <AuthScreen title="Authorizing workspace" body="Completing OIDC login and preparing the workbook session." />;
  }

  if (!auth.isLoggedIn || connection.state === 'auth-failed') {
    return (
      <AuthScreen
        title="Sign in to open the workbook"
        body="Authentication runs fully in the SPA with OIDC Authorization Code + PKCE. The only backend interaction after login is SurrealDB."
        error={connection.state === 'auth-failed' ? (connection.detail ?? auth.error) : auth.error}
        actionLabel="Continue with MapLayer"
        onAction={() => {
          void authGateway.startLogin().catch(() => undefined);
        }}
      />
    );
  }

  return children(auth.user?.name ?? auth.user?.email ?? auth.user?.sub ?? 'Workspace user');
}

function isSidebarPanel(value: unknown): value is SidebarPanel {
  return value === 'none' || value === 'record' || value === 'graph' || value === 'recent' || value === 'setup' || value === 'admin';
}

function parsePanelSearch(search: Record<string, unknown>, fallback: SidebarPanel): { panel: SidebarPanel } {
  return {
    panel: isSidebarPanel(search.panel) ? search.panel : fallback,
  };
}

/** Home route — redirect to the workbook list view; let AppShell pick the first workbook from DB. */
function HomeRoute() {
  return <Navigate to="/workbooks" search={{ panel: 'none' }} replace />;
}

function CallbackRoute() {
  return <AuthScreen title="Authorizing workspace" body="Completing OIDC callback and restoring the workbook route." />;
}

function TemplatesRoute() {
  const navigate = useNavigate();

  return (
    <RequireAuth>
      {(displayName) => (
        <AppShell
          view="template-picker"
          displayName={displayName}
          onSelectTemplate={(templateKey) => {
            const panel = getDefaultPanelForTemplate(templateKey);
            // Navigate to /workbooks with the template panel — AppShell loads the real workbook from DB.
            void navigate({ to: '/workbooks', search: { panel } });
          }}
          onSelectWorkbook={(workbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: 'none' },
            });
          }}
          onSelectPanel={() => undefined}
          onShowTemplates={() => undefined}
          onShowAdmin={() => {
            void navigate({ to: '/admin' });
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

  return (
    <RequireAuth>
      {(displayName) => (
        <AppShell
          view="workbook"
          activePanel="admin"
          displayName={displayName}
          onSelectTemplate={(templateKey: TemplateKey) => {
            const panel = getDefaultPanelForTemplate(templateKey);
            void navigate({ to: '/workbooks', search: { panel } });
          }}
          onSelectWorkbook={(workbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: 'none' },
            });
          }}
          onSelectPanel={(panel) => {
            void navigate({ to: '/workbooks', search: { panel } });
          }}
          onShowTemplates={() => {
            void navigate({ to: '/templates' });
          }}
          onShowAdmin={() => undefined}
          onLogout={() => {
            void authGateway.logout().catch(() => undefined);
          }}
        />
      )}
    </RequireAuth>
  );
}

/** /workbooks — no specific ID; AppShell loads from DB and defaults to first workbook. */
function WorkbooksRoute() {
  const navigate = useNavigate();
  const { panel } = useSearch({ from: '/workbooks' });

  return (
    <RequireAuth>
      {(displayName) => (
        <AppShell
          view="workbook"
          activePanel={panel}
          displayName={displayName}
          onSelectTemplate={(templateKey) => {
            void navigate({ to: '/workbooks', search: { panel: getDefaultPanelForTemplate(templateKey) } });
          }}
          onSelectWorkbook={(workbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel },
            });
          }}
          onSelectPanel={(nextPanel) => {
            void navigate({ to: '/workbooks', search: { panel: nextPanel } });
          }}
          onShowTemplates={() => {
            void navigate({ to: '/templates' });
          }}
          onShowAdmin={() => {
            void navigate({ to: '/admin' });
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
      {(displayName) => (
        <AppShell
          view="workbook"
          activeWorkbookId={workbookId}
          activePanel={panel}
          displayName={displayName}
          onSelectTemplate={(templateKey) => {
            void navigate({ to: '/workbooks', search: { panel: getDefaultPanelForTemplate(templateKey) } });
          }}
          onSelectWorkbook={(nextWorkbookId) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId: nextWorkbookId },
              search: {
                panel: panel === 'admin' ? 'none' : panel,
              },
            });
          }}
          onSelectPanel={(nextPanel) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel: nextPanel },
            });
          }}
          onShowTemplates={() => {
            void navigate({ to: '/templates' });
          }}
          onShowAdmin={() => {
            void navigate({ to: '/admin' });
          }}
          onLogout={() => {
            void authGateway.logout().catch(() => undefined);
          }}
        />
      )}
    </RequireAuth>
  );
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

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates',
  component: TemplatesRoute,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminRoute,
});

const workbooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workbooks',
  validateSearch: (search) => parsePanelSearch(search as Record<string, unknown>, 'graph'),
  component: WorkbooksRoute,
});

const workbookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workbooks/$workbookId',
  validateSearch: (search) => parsePanelSearch(search as Record<string, unknown>, 'graph'),
  component: WorkbookRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  callbackRoute,
  templatesRoute,
  adminRoute,
  workbooksRoute,
  workbookRoute,
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
