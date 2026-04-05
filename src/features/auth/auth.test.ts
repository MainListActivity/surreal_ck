import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authGateway, bootstrapAuth, getOidcConfig, getStoredTokens } from './auth';

describe('oidc auth gateway', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    await authGateway.logout(window.localStorage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses /callback as the default redirect uri', () => {
    window.history.replaceState({}, '', '/workbooks/123?view=grid');

    expect(getOidcConfig().redirectUri).toBe('http://localhost:3000/callback');
  });

  it('stores the pre-login location and sends authorize requests to /callback', async () => {
    window.history.replaceState({}, '', '/workbooks/123?view=grid#cell-9');

    const authorizeUrl = await authGateway.startLogin(window.localStorage, false);
    const pendingLogin = window.localStorage.getItem('surreal_ck.oidc.login');

    expect(authorizeUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback');
    expect(pendingLogin).toContain('"returnTo":"/workbooks/123?view=grid#cell-9"');
  });

  it('only handles code exchange on the callback route and then redirects back', async () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    window.history.replaceState({}, '', '/workspace');
    await authGateway.startLogin(window.localStorage, false);

    const pendingLogin = JSON.parse(window.localStorage.getItem('surreal_ck.oidc.login') ?? '{}') as {
      state: string;
    };

    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'header.payload.signature',
        refresh_token: 'refresh-token',
        id_token: 'header.payload.signature',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    })) as unknown as typeof fetch;

    window.history.replaceState({}, '', `/callback?code=test-code&state=${pendingLogin.state}`);

    await bootstrapAuth(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      'https://o.maplayer.top/t/ck/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams),
      }),
    );
    expect(getStoredTokens(window.localStorage)?.refreshToken).toBe('refresh-token');
    expect(replaceStateSpy).toHaveBeenCalledWith({}, document.title, '/workspace');
    expect(window.location.pathname).toBe('/workspace');
  });

  it('ignores code params outside the callback route', async () => {
    const fetcher = vi.fn();
    window.history.replaceState({}, '', '/workspace?code=test-code&state=test-state');

    await bootstrapAuth(fetcher as typeof fetch);

    expect(fetcher).not.toHaveBeenCalled();
    expect(getStoredTokens(window.localStorage)).toBeNull();
  });
});
