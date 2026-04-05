import { describe, expect, it, vi } from 'vitest';

import { createFormulaDebounce, graphTraverse } from './graph-traverse';

// ─── Mock DB factory ─────────────────────────────────────────────────────────

const createMockDb = (queryResponses: Array<unknown> = []) => {
  let callIndex = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: vi.fn(async (..._args: any[]) => {
      const response = queryResponses[callIndex++];
      // null sentinel means "query threw an error"
      if (response === null) throw new Error('mock query error');
      if (response instanceof Error) throw response;
      return response ?? [[]];
    }),
  };
};

// ─── graphTraverse ───────────────────────────────────────────────────────────

describe('graphTraverse — input validation', () => {
  it('returns #VALUE! for empty startNode', async () => {
    const db = createMockDb();
    expect(await graphTraverse(db as never, '', 'owns', 1)).toBe('#VALUE!');
  });

  it('returns #VALUE! for startNode without colon (not a record ID)', async () => {
    const db = createMockDb();
    expect(await graphTraverse(db as never, 'notARecordId', 'owns', 1)).toBe('#VALUE!');
  });

  it('returns #NAME? for empty relationship', async () => {
    const db = createMockDb();
    expect(await graphTraverse(db as never, 'company:acme', '', 1)).toBe('#NAME?');
  });

  it('returns #VALUE! for depth = 0', async () => {
    const db = createMockDb();
    expect(await graphTraverse(db as never, 'company:acme', 'owns', 0)).toBe('#VALUE!');
  });

  it('returns #VALUE! for depth = 11', async () => {
    const db = createMockDb();
    expect(await graphTraverse(db as never, 'company:acme', 'owns', 11)).toBe('#VALUE!');
  });

  it('returns #VALUE! for non-integer depth', async () => {
    const db = createMockDb();
    expect(await graphTraverse(db as never, 'company:acme', 'owns', 1.5)).toBe('#VALUE!');
  });
});

describe('graphTraverse — REF error', () => {
  it('returns #REF! when start node does not exist', async () => {
    // First query (existence check) returns empty
    const db = createMockDb([[/* empty result */]]);
    expect(await graphTraverse(db as never, 'company:deleted', 'owns', 1)).toBe('#REF!');
  });
});

describe('graphTraverse — happy path', () => {
  it('returns cell label with first 5 results', async () => {
    const db = createMockDb([
      // exists check: [[row, ...]]
      [[{ id: 'company:acme', name: 'Acme Corp' }]],
      // hop 1 traversal: [[{ targets: [...] }]]
      [
        [
          {
            targets: [
              { id: 'company:beta', name: 'Beta LLC' },
              { id: 'company:gamma', name: 'Gamma Inc' },
              { id: 'company:delta', name: 'Delta Co' },
              { id: 'company:epsilon', name: 'Epsilon SA' },
              { id: 'company:zeta', name: 'Zeta GmbH' },
              { id: 'company:eta', name: 'Eta Ltd' },
            ],
          },
        ],
      ],
    ]);

    const result = await graphTraverse(db as never, 'company:acme', 'owns', 1);
    expect(result).not.toBe('#REF!');
    expect(result).not.toBe('#VALUE!');
    expect(result).not.toBe('#NAME?');
    expect(result).not.toBe('#TIMEOUT!');

    const r = result as { cellLabel: string; items: unknown[] };
    expect(r.cellLabel).toContain('+1 more');
    expect(r.items).toHaveLength(6);
  });

  it('resolves label using name > label > first string field priority', async () => {
    const db = createMockDb([
      [[{ id: 'company:a', name: 'Named Corp' }]],
      [[{ targets: [{ id: 'company:b', label: 'Label Corp' }] }]],
    ]);

    const result = await graphTraverse(db as never, 'company:a', 'owns', 1);
    const r = result as { cellLabel: string; items: Array<{ label: string }> };
    expect(r.items[0].label).toBe('Label Corp');
  });

  it('shows "(no results)" for valid node with no edges', async () => {
    const db = createMockDb([
      [[{ id: 'company:leaf', name: 'Leaf Co' }]],
      [[{ targets: [] }]],
    ]);

    const result = await graphTraverse(db as never, 'company:leaf', 'owns', 1);
    const r = result as { cellLabel: string };
    expect(r.cellLabel).toBe('(no results)');
  });
});

describe('graphTraverse — cycle detection', () => {
  it('does not visit the same node twice (A→B→A cycle)', async () => {
    const db = createMockDb([
      // exists check
      [[{ id: 'company:a' }]],
      // hop 1: a → b
      [[{ targets: [{ id: 'company:b', name: 'B Corp' }] }]],
      // hop 2: b → a (cycle back)
      [[{ targets: [{ id: 'company:a', name: 'A Corp' }] }]],
    ]);

    const result = await graphTraverse(db as never, 'company:a', 'owns', 2);
    const r = result as { items: Array<{ recordId: string }> };
    // company:a should not appear in results (was already visited)
    expect(r.items.map((i) => i.recordId)).not.toContain('company:a');
    expect(r.items).toHaveLength(1); // only company:b
  });
});

describe('graphTraverse — NAME? error', () => {
  it('returns #NAME? when relationship yields null on first hop', async () => {
    const db = createMockDb([
      [[{ id: 'company:acme' }]], // exists check passes
      null, // traversal query throws → null
    ]);

    expect(await graphTraverse(db as never, 'company:acme', 'nonexistent_rel', 1)).toBe('#NAME?');
  });
});

// ─── createFormulaDebounce ────────────────────────────────────────────────────

describe('createFormulaDebounce', () => {
  it('calls onTableChanged after debounce ms', async () => {
    vi.useFakeTimers();
    const onTableChanged = vi.fn();
    const debounce = createFormulaDebounce({ onTableChanged, debounceMs: 100, maxWaitMs: 500 });

    debounce.notify('company');

    vi.advanceTimersByTime(99);
    expect(onTableChanged).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTableChanged).toHaveBeenCalledWith('company');

    debounce.destroy();
    vi.useRealTimers();
  });

  it('resets trailing timer on repeated calls but fires at maxWait', async () => {
    vi.useFakeTimers();
    const onTableChanged = vi.fn();
    const debounce = createFormulaDebounce({ onTableChanged, debounceMs: 500, maxWaitMs: 2_000 });

    // Simulate rapid events every 400ms (would push trailing debounce indefinitely)
    for (let i = 0; i < 6; i++) {
      debounce.notify('company');
      vi.advanceTimersByTime(400);
    }

    // After 2400ms total, maxWait (2000ms) should have fired
    expect(onTableChanged).toHaveBeenCalledWith('company');

    debounce.destroy();
    vi.useRealTimers();
  });

  it('fires independently per table name', async () => {
    vi.useFakeTimers();
    const onTableChanged = vi.fn();
    const debounce = createFormulaDebounce({ onTableChanged, debounceMs: 100, maxWaitMs: 500 });

    debounce.notify('company');
    debounce.notify('person');
    vi.advanceTimersByTime(110);

    expect(onTableChanged).toHaveBeenCalledWith('company');
    expect(onTableChanged).toHaveBeenCalledWith('person');
    expect(onTableChanged).toHaveBeenCalledTimes(2);

    debounce.destroy();
    vi.useRealTimers();
  });
});
