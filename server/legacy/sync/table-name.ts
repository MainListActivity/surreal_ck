export function assertSafeTableName(table: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) {
    throw new Error(`[sync] unsafe table name: ${table}`);
  }
}
