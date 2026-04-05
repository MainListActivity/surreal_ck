import { connectToSurreal } from './client';
import { restoreSession } from './auth';

export async function bootstrapSurreal(): Promise<void> {
  const connected = await connectToSurreal();

  if (connected) {
    await restoreSession();
  }
}
