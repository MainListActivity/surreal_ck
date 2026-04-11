import { describe, expect, it, vi } from 'vitest';

vi.mock('../features/auth/auth', () => ({
  authGateway: {
    startLogin: vi.fn(),
    logout: vi.fn(),
  },
  useAuthSnapshot: () => ({
    status: 'authenticated',
    isLoggedIn: true,
    user: {
      sub: 'u1',
      name: 'Test User',
      email: 'test@example.com',
      recordId: 'app_user:u1',
    },
    updatedAt: Date.now(),
  }),
}));

vi.mock('../lib/surreal/client', () => ({
  useConnectionSnapshot: () => ({
    state: 'connected',
    updatedAt: Date.now(),
  }),
}));

vi.mock('../lib/surreal/provider', () => ({
  useSurrealClient: () => ({
    query: vi.fn(),
  }),
}));

vi.mock('../features/workbook/app-shell', () => ({
  AppShell: (props: { view: string; showTemplateGallery?: boolean; activePanel?: string }) => (
    <div data-testid="app-shell">
      <span>{props.view}</span>
      <span>{props.showTemplateGallery ? 'templates' : 'default'}</span>
      <span>{props.activePanel ?? 'none'}</span>
    </div>
  ),
  AuthScreen: (props: { title: string }) => <div>{props.title}</div>,
}));

vi.mock('../forms/intake-form', () => ({
  IntakeForm: (props: { workspaceId: string; formSlug: string }) => (
    <div data-testid="public-form">{props.workspaceId}:{props.formSlug}</div>
  ),
}));

describe('router module', () => {
  it('exports a router provider', async () => {
    const mod = await import('./router');

    expect(mod.router).toBeDefined();
    expect(mod.AppRouterProvider).toBeTypeOf('function');
  });
});
