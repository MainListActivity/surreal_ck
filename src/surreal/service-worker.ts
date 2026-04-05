const SERVICE_WORKER_PATH = '/app-sw.js';

export async function registerAppServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  if (import.meta.env.DEV) {
    return;
  }

  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_PATH, {
      scope: '/',
    });
  } catch (error) {
    console.warn('Failed to register app service worker.', error);
  }
}

