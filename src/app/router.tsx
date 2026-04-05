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
import {
  findWorkbookById,
  getDefaultPanelForTemplate,
  getDefaultWorkbookId,
  resolveWorkbookForTemplate,
} from '../features/workbook/mock-data';
import { AppShell, AuthScreen } from '../features/workbook/app-shell';

function RootLayout() {
  return <Outlet />;
}

function RequireAuth({ children }: { children: (displayName: string) => ReactNode }) {
  const auth = useAuthSnapshot();

  if (auth.status === 'checking' || auth.status === 'authorizing') {
    return <AuthScreen title="Authorizing workspace" body="Completing OIDC login and preparing the workbook session." />;
  }

  if (!auth.isLoggedIn) {
    return (
      <AuthScreen
        title="Sign in to open the workbook"
        body="Authentication runs fully in the SPA with OIDC Authorization Code + PKCE. The only backend interaction after login is SurrealDB."
        error={auth.error}
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
  return value === 'record' || value === 'graph' || value === 'recent' || value === 'setup' || value === 'admin';
}

function parsePanelSearch(search: Record<string, unknown>, fallback: SidebarPanel): { panel: SidebarPanel } {
  return {
    panel: isSidebarPanel(search.panel) ? search.panel : fallback,
  };
}

function HomeRoute() {
  return <Navigate to="/workbooks/$workbookId" params={{ workbookId: getDefaultWorkbookId() }} search={{ panel: 'graph' }} replace />;
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
            const workbook = resolveWorkbookForTemplate(templateKey);
            const panel = getDefaultPanelForTemplate(templateKey);
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId: workbook.id },
              search: { panel },
            });
          }}
          onSelectWorkbook={(workbookId) => {
            const workbook = findWorkbookById(workbookId);
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId: workbook.id },
              search: { panel: getDefaultPanelForTemplate(workbook.templateKey) },
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
  const workbookId = getDefaultWorkbookId();

  return (
    <RequireAuth>
      {(displayName) => (
        <AppShell
          view="workbook"
          activeWorkbookId={workbookId}
          activePanel="admin"
          displayName={displayName}
          onSelectTemplate={(templateKey: TemplateKey) => {
            const workbook = resolveWorkbookForTemplate(templateKey);
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId: workbook.id },
              search: { panel: getDefaultPanelForTemplate(templateKey) },
            });
          }}
          onSelectWorkbook={(nextWorkbookId) => {
            const workbook = findWorkbookById(nextWorkbookId);
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId: workbook.id },
              search: { panel: getDefaultPanelForTemplate(workbook.templateKey) },
            });
          }}
          onSelectPanel={(panel) => {
            void navigate({
              to: '/workbooks/$workbookId',
              params: { workbookId },
              search: { panel },
            });
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

function WorkbookRoute() {
  const navigate = useNavigate();
  const { workbookId } = workbookRoute.useParams();
  const { panel } = useSearch({ from: '/workbooks/$workbookId' });

  return (
    <RequireAuth>
      {(displayName) => {
        const workbook = findWorkbookById(workbookId);

        return (
          <AppShell
            view="workbook"
            activeWorkbookId={workbook.id}
            activePanel={panel}
            displayName={displayName}
            onSelectTemplate={(templateKey) => {
              const nextWorkbook = resolveWorkbookForTemplate(templateKey);
              void navigate({
                to: '/workbooks/$workbookId',
                params: { workbookId: nextWorkbook.id },
                search: { panel: getDefaultPanelForTemplate(templateKey) },
              });
            }}
            onSelectWorkbook={(nextWorkbookId) => {
              const nextWorkbook = findWorkbookById(nextWorkbookId);
              void navigate({
                to: '/workbooks/$workbookId',
                params: { workbookId: nextWorkbook.id },
                search: {
                  panel:
                    panel === 'admin'
                      ? getDefaultPanelForTemplate(nextWorkbook.templateKey)
                      : panel,
                },
              });
            }}
            onSelectPanel={(nextPanel) => {
              void navigate({
                to: '/workbooks/$workbookId',
                params: { workbookId: workbook.id },
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
        );
      }}
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

const workbookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workbooks/$workbookId',
  validateSearch: (search) => parsePanelSearch(search as Record<string, unknown>, 'graph'),
  component: WorkbookRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, callbackRoute, templatesRoute, adminRoute, workbookRoute]);

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
