import { useMutation } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Surreal } from 'surrealdb';

import { authGateway, useAuthSnapshot } from './auth';
import {
  authenticateSurrealAccessToken,
  attachConnectionListeners,
  connectionState,
  getDefaultConnectParams,
  getEnvironmentConfig,
  type SurrealConnectParams,
} from './client';

export interface SurrealProviderProps {
  children: ReactNode;
  endpoint?: string;
  client?: Surreal;
  params?: Partial<SurrealConnectParams>;
  autoConnect?: boolean;
}

export interface SurrealProviderState {
  client: Surreal;
  isConnecting: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  connect: () => Promise<true>;
  close: () => Promise<true>;
}

const SurrealContext = createContext<SurrealProviderState | undefined>(undefined);

export function SurrealProvider({
  children,
  client,
  endpoint,
  params,
  autoConnect = true,
}: SurrealProviderProps) {
  const [instance] = useState(() => client ?? new Surreal());
  const auth = useAuthSnapshot();
  const config = getEnvironmentConfig();
  const resolvedEndpoint = endpoint ?? config.surrealUrl;
  const resolvedParams = useMemo(() => getDefaultConnectParams(import.meta.env, params), [params]);
  const {
    mutateAsync: connectMutation,
    isPending,
    isSuccess,
    isError,
    error,
    reset,
  } = useMutation({
    mutationFn: async () => {
      const accessToken = await authGateway.validAccessToken();

      if (!accessToken) {
        connectionState.set('auth-failed', 'Authentication required');
        throw new Error('Authentication required');
      }

      attachConnectionListeners(instance);
      connectionState.set('connecting');
      await instance.connect(resolvedEndpoint, resolvedParams);
      await instance.use({
        namespace: config.namespace,
        database: config.database,
      });
      await authenticateSurrealAccessToken(accessToken, instance);
      return true as const;
    },
  });

  const connect = useCallback(() => connectMutation(), [connectMutation]);
  const close = useCallback(async () => {
    reset();
    connectionState.set('disconnected');
    return instance.close();
  }, [instance, reset]);

  useEffect(() => {
    if (!autoConnect) {
      return;
    }

    if (!auth.isLoggedIn) {
      reset();
      connectionState.set(auth.status === 'error' ? 'auth-failed' : 'disconnected', auth.error);
      void instance.close().catch(() => undefined);
      return;
    }

    void connect().catch(() => undefined);
  }, [auth.error, auth.isLoggedIn, auth.status, autoConnect, connect, instance, reset]);

  useEffect(
    () => () => {
      void close();
    },
    [close],
  );

  const value = useMemo<SurrealProviderState>(
    () => ({
      client: instance,
      isConnecting: isPending,
      isSuccess,
      isError,
      error,
      connect,
      close,
    }),
    [connect, close, error, instance, isError, isPending, isSuccess],
  );

  return <SurrealContext.Provider value={value}>{children}</SurrealContext.Provider>;
}

export function useSurreal(): SurrealProviderState {
  const context = useContext(SurrealContext);

  if (!context) {
    throw new Error('useSurreal must be used within a SurrealProvider');
  }

  return context;
}

export function useSurrealClient(): Surreal {
  return useSurreal().client;
}
