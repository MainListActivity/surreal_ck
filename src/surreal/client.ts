/// <reference types="vite/client" />

import type { ConnectionSnapshot, ConnectionState } from './types';
import type {
  WorkerEvent,
  WorkerRequest,
  WorkerRequestMap,
  WorkerRequestType,
  WorkerResponse,
  WorkerResponseMap,
} from './protocol';

type Listener = (snapshot: ConnectionSnapshot) => void;

class ConnectionStateStore {
  #snapshot: ConnectionSnapshot = {
    state: 'idle',
    updatedAt: Date.now(),
  };

  #listeners = new Set<Listener>();

  getSnapshot(): ConnectionSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(state: ConnectionState, detail?: string, updatedAt = Date.now()): void {
    this.#snapshot = {
      state,
      detail,
      updatedAt,
    };

    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }
}

export const connectionState = new ConnectionStateStore();
let workerInstance: Worker | null = null;
let messageCounter = 0;
const inflight = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
  }
>();

function isWorkerEvent(message: WorkerResponse | WorkerEvent): message is WorkerEvent {
  return 'kind' in message;
}

function createWorker(): Worker {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse | WorkerEvent>) => {
    const message = event.data;

    if (isWorkerEvent(message)) {
      connectionState.set(
        message.snapshot.state,
        message.snapshot.detail,
        message.snapshot.updatedAt,
      );
      return;
    }

    const response = message;
    const pending = inflight.get(response.id);

    if (!pending) {
      return;
    }

    inflight.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
      return;
    }

    pending.reject(new Error(response.error));
  });

  return worker;
}

function getWorker(): Worker {
  workerInstance ??= createWorker();
  return workerInstance;
}

async function callWorker<T extends WorkerRequestType>(
  type: T,
  payload: WorkerRequestMap[T],
): Promise<WorkerResponseMap[T]> {
  const id = `surreal-${++messageCounter}`;
  const worker = getWorker();
  const request: WorkerRequest<T> = {
    id,
    type,
    payload,
  };

  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject });
    worker.postMessage(request);
  });
}

export interface SurrealWorkerClient {
  connect(): Promise<boolean>;
  close(): Promise<true>;
  signIn(email: string, password: string): Promise<WorkerResponseMap['signIn']>;
  restoreSession(): Promise<WorkerResponseMap['restoreSession']>;
  signOut(): Promise<true>;
  getConnectionSnapshot(): Promise<ConnectionSnapshot>;
}

export const surreal: SurrealWorkerClient = {
  connect() {
    return callWorker('connect', undefined);
  },
  close() {
    return callWorker('close', undefined);
  },
  signIn(email, password) {
    return callWorker('signIn', { email, password });
  },
  restoreSession() {
    return callWorker('restoreSession', undefined);
  },
  signOut() {
    return callWorker('signOut', undefined);
  },
  getConnectionSnapshot() {
    return callWorker('getConnectionSnapshot', undefined);
  },
};

export async function connectToSurreal(client: SurrealWorkerClient = surreal): Promise<boolean> {
  connectionState.set('connecting');
  return client.connect();
}
