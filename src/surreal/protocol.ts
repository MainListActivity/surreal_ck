import type { Tokens } from 'surrealdb';

import type { ConnectionSnapshot } from './types';

export interface WorkerRequestMap {
  connect: undefined;
  close: undefined;
  signIn: {
    email: string;
    password: string;
  };
  restoreSession: undefined;
  signOut: undefined;
  getConnectionSnapshot: undefined;
}

export interface WorkerResponseMap {
  connect: boolean;
  close: true;
  signIn: Tokens;
  restoreSession: Tokens | null;
  signOut: true;
  getConnectionSnapshot: ConnectionSnapshot;
}

export type WorkerRequestType = keyof WorkerRequestMap;

export interface WorkerRequest<T extends WorkerRequestType = WorkerRequestType> {
  id: string;
  type: T;
  payload: WorkerRequestMap[T];
}

export interface WorkerSuccessResponse<T extends WorkerRequestType = WorkerRequestType> {
  id: string;
  ok: true;
  result: WorkerResponseMap[T];
}

export interface WorkerErrorResponse {
  id: string;
  ok: false;
  error: string;
}

export type WorkerResponse<T extends WorkerRequestType = WorkerRequestType> =
  | WorkerSuccessResponse<T>
  | WorkerErrorResponse;

export interface ConnectionStateEvent {
  kind: 'connection-state';
  snapshot: ConnectionSnapshot;
}

export type WorkerEvent = ConnectionStateEvent;

