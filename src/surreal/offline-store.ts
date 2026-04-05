interface StoredValue<T> {
  value: T;
}

const DB_NAME = 'surreal-ck-offline';
const STORE_NAME = 'runtime';

function openOfflineDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openOfflineDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = run(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

export async function readOfflineValue<T>(key: string): Promise<T | null> {
  const result = await withStore<StoredValue<T> | undefined>('readonly', (store) => store.get(key));
  return result?.value ?? null;
}

export async function writeOfflineValue<T>(key: string, value: T): Promise<void> {
  await withStore<IDBValidKey>('readwrite', (store) => store.put({ value }, key));
}

export async function removeOfflineValue(key: string): Promise<void> {
  await withStore<undefined>('readwrite', (store) => store.delete(key));
}

