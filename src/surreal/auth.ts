import type { Tokens } from 'surrealdb';

import { surreal, type SurrealWorkerClient } from './client';

export async function signIn(
  email: string,
  password: string,
  client: SurrealWorkerClient = surreal,
): Promise<Tokens> {
  return client.signIn(email, password);
}

export async function restoreSession(
  client: SurrealWorkerClient = surreal,
): Promise<Tokens | null> {
  return client.restoreSession();
}

export async function signOut(client: SurrealWorkerClient = surreal): Promise<void> {
  await client.signOut();
}
