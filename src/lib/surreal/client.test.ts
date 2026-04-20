import { describe, expect, it } from 'vitest';

import { connectionState, dbQuery, dbCreate, dbMerge, dbDelete, dbUpsert } from './client';

describe('client (local-first IPC 架构)', () => {
  it('connectionState 初始值为 connected（本地 DB 始终可用）', () => {
    let snapshot: { state: string } | undefined;
    const unsub = connectionState.subscribe((s) => {
      snapshot = s;
    });
    expect(snapshot?.state).toBe('connected');
    unsub();
  });

  it('导出 dbQuery / dbCreate / dbMerge / dbDelete / dbUpsert', () => {
    expect(typeof dbQuery).toBe('function');
    expect(typeof dbCreate).toBe('function');
    expect(typeof dbMerge).toBe('function');
    expect(typeof dbDelete).toBe('function');
    expect(typeof dbUpsert).toBe('function');
  });
});
