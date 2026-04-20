/**
 * 应用路由（local-first 版本）
 *
 * 移除了 OIDC 认证守卫（RequireAuth），local-first 模式下无需登录，
 * 用户身份由 Bun 主进程通过 IPC 提供的本地 deviceId 标识。
 */
import {
  Navigate,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";

import { AppShell } from "../features/workbook/app-shell";
import type { SidebarPanel } from "../features/workbook/mock-data";
import { IntakeForm } from "../forms/intake-form";
import db from "../lib/surreal/db-adapter";

function RootLayout() {
  return <Outlet />;
}

function isSidebarPanel(value: unknown): value is SidebarPanel {
  return (
    value === "none" ||
    value === "record" ||
    value === "graph" ||
    value === "history" ||
    value === "review" ||
    value === "ai" ||
    value === "admin"
  );
}

function parsePanelSearch(
  search: Record<string, unknown>,
  fallback: SidebarPanel,
): { panel: SidebarPanel } {
  return {
    panel: isSidebarPanel(search.panel) ? search.panel : fallback,
  };
}

function HomeRoute() {
  return (
    <Navigate to="/workbooks" search={{ panel: "none" }} replace />
  );
}

function WorkbooksRoute() {
  const navigate = useNavigate();

  return (
    <AppShell
      view="home"
      displayName="本地用户"
      ownerUserId="local"
      onSelectWorkbook={(workbookId) => {
        void navigate({
          to: "/sheet/$id",
          params: { id: workbookId },
          search: { panel: "none" },
        });
      }}
      onSelectPanel={() => undefined}
      onShowHome={() => undefined}
      onShowTemplates={() => {
        void navigate({ to: "/templates", search: { panel: "none" } });
      }}
      onShowAdmin={() => {
        void navigate({ to: "/admin", search: { panel: "admin" } });
      }}
      onOpenPublishedForm={(workspaceId, formSlug) => {
        void navigate({
          to: "/public/$workspaceId/forms/$formSlug",
          params: { workspaceId, formSlug },
        });
      }}
      onLogout={() => undefined}
    />
  );
}

function TemplatesRoute() {
  const navigate = useNavigate();

  return (
    <AppShell
      view="home"
      displayName="本地用户"
      ownerUserId="local"
      showTemplateGallery={true}
      onSelectWorkbook={(workbookId) => {
        void navigate({
          to: "/sheet/$id",
          params: { id: workbookId },
          search: { panel: "none" },
        });
      }}
      onSelectPanel={() => undefined}
      onShowHome={() => {
        void navigate({ to: "/workbooks", search: { panel: "none" } });
      }}
      onShowTemplates={() => undefined}
      onShowAdmin={() => {
        void navigate({ to: "/admin", search: { panel: "admin" } });
      }}
      onOpenPublishedForm={(workspaceId, formSlug) => {
        void navigate({
          to: "/public/$workspaceId/forms/$formSlug",
          params: { workspaceId, formSlug },
        });
      }}
      onLogout={() => undefined}
    />
  );
}

function SheetRoute() {
  const navigate = useNavigate();
  const { id } = sheetRoute.useParams();
  const { panel } = useSearch({ from: "/sheet/$id" });

  return (
    <AppShell
      view="editor"
      activeWorkbookId={id}
      activePanel={panel}
      displayName="本地用户"
      ownerUserId="local"
      onSelectWorkbook={(nextId) => {
        void navigate({
          to: "/sheet/$id",
          params: { id: nextId },
          search: { panel: panel === "admin" ? "none" : panel },
        });
      }}
      onSelectPanel={(nextPanel) => {
        void navigate({
          to: "/sheet/$id",
          params: { id },
          search: { panel: nextPanel },
        });
      }}
      onShowHome={() => {
        void navigate({ to: "/workbooks", search: { panel: "none" } });
      }}
      onShowTemplates={() => {
        void navigate({ to: "/templates", search: { panel: "none" } });
      }}
      onShowAdmin={() => {
        void navigate({
          to: "/sheet/$id",
          params: { id },
          search: { panel: "admin" },
        });
      }}
      onOpenPublishedForm={(workspaceId, formSlug) => {
        void navigate({
          to: "/public/$workspaceId/forms/$formSlug",
          params: { workspaceId, formSlug },
        });
      }}
      onLogout={() => undefined}
    />
  );
}

function AdminRoute() {
  const navigate = useNavigate();
  const { panel } = useSearch({ from: "/admin" });

  return (
    <AppShell
      view="editor"
      activePanel={panel}
      displayName="本地用户"
      ownerUserId="local"
      onSelectWorkbook={(workbookId) => {
        void navigate({
          to: "/sheet/$id",
          params: { id: workbookId },
          search: { panel: "admin" },
        });
      }}
      onSelectPanel={(nextPanel) => {
        void navigate({ to: "/admin", search: { panel: nextPanel } });
      }}
      onShowHome={() => {
        void navigate({ to: "/workbooks", search: { panel: "none" } });
      }}
      onShowTemplates={() => {
        void navigate({ to: "/templates", search: { panel: "none" } });
      }}
      onShowAdmin={() => undefined}
      onOpenPublishedForm={(workspaceId, formSlug) => {
        void navigate({
          to: "/public/$workspaceId/forms/$formSlug",
          params: { workspaceId, formSlug },
        });
      }}
      onLogout={() => undefined}
    />
  );
}

function PublicFormRoute() {
  const { workspaceId, formSlug } = publicFormRoute.useParams();

  return (
    <IntakeForm
      db={db}
      workspaceId={workspaceId}
      formSlug={formSlug}
    />
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRoute,
});

const workbooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workbooks",
  validateSearch: (search) =>
    parsePanelSearch(search as Record<string, unknown>, "none"),
  component: WorkbooksRoute,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  validateSearch: (search) =>
    parsePanelSearch(search as Record<string, unknown>, "none"),
  component: TemplatesRoute,
});

const sheetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sheet/$id",
  validateSearch: (search) =>
    parsePanelSearch(search as Record<string, unknown>, "none"),
  component: SheetRoute,
});

// Legacy redirect: /workbooks/$workbookId → /sheet/$id
function WorkbookLegacyRedirect() {
  const { workbookId } = workbookLegacyRoute.useParams();
  return (
    <Navigate
      to="/sheet/$id"
      params={{ id: workbookId }}
      search={{ panel: "none" }}
      replace
    />
  );
}

const workbookLegacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workbooks/$workbookId",
  validateSearch: (search) =>
    parsePanelSearch(search as Record<string, unknown>, "none"),
  component: WorkbookLegacyRedirect,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  validateSearch: (search) =>
    parsePanelSearch(search as Record<string, unknown>, "admin"),
  component: AdminRoute,
});

const publicFormRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/public/$workspaceId/forms/$formSlug",
  component: PublicFormRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  workbooksRoute,
  templatesRoute,
  sheetRoute,
  workbookLegacyRoute,
  adminRoute,
  publicFormRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultStructuralSharing: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function AppRouterProvider() {
  return <RouterProvider router={router} />;
}
