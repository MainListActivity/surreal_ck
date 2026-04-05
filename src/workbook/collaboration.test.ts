import { describe, expect, it, vi } from 'vitest';

import {
  COLLAB_COMMAND_WHITELIST,
  createCollabController,
  shouldBroadcastCommand,
} from './collaboration';

// Minimal SurrealDB mock for collab tests
const createMockDb = () => {
  type LiveCallback = (message: { action: string; value: unknown }) => void;
  const liveCallbacks: LiveCallback[] = [];

  const liveQuery = {
    subscribe: vi.fn((handler: LiveCallback) => {
      liveCallbacks.push(handler);
      return () => {
        const idx = liveCallbacks.indexOf(handler);
        if (idx >= 0) {
          liveCallbacks.splice(idx, 1);
        }
      };
    }),
    kill: vi.fn(async () => undefined),
  };

  const emit = (action: string, value: unknown) => {
    for (const cb of liveCallbacks) {
      cb({ action, value });
    }
  };

  return {
    db: {
      live: vi.fn(async () => liveQuery),
      kill: vi.fn(async () => undefined),
      query: vi.fn(async () => [[]]),
    },
    emit,
  };
};

const WORKBOOK_ID = 'workbook:test';
const WORKSPACE_ID = 'workspace:test';
const CLIENT_ID = 'client-abc';

describe('shouldBroadcastCommand', () => {
  it('returns true for whitelisted MUTATION type not from collab', () => {
    expect(shouldBroadcastCommand('sheet.set-range-values-mutation', 2, false)).toBe(true);
  });

  it('returns false for fromCollab=true (infinite loop prevention)', () => {
    expect(shouldBroadcastCommand('sheet.set-range-values-mutation', 2, true)).toBe(false);
  });

  it('returns false for non-MUTATION type (type !== 2)', () => {
    expect(shouldBroadcastCommand('sheet.set-range-values-mutation', 1, false)).toBe(false);
  });

  it('returns false for command not in whitelist', () => {
    expect(shouldBroadcastCommand('sheet.some-unknown-operation', 2, false)).toBe(false);
  });
});

describe('COLLAB_COMMAND_WHITELIST', () => {
  it('includes common cell value and style commands', () => {
    expect(COLLAB_COMMAND_WHITELIST.has('sheet.set-range-values-mutation')).toBe(true);
    expect(COLLAB_COMMAND_WHITELIST.has('sheet.set-range-style-mutation')).toBe(true);
    expect(COLLAB_COMMAND_WHITELIST.has('sheet.insert-row-mutation')).toBe(true);
    expect(COLLAB_COMMAND_WHITELIST.has('sheet.remove-col-mutation')).toBe(true);
  });
});

describe('createCollabController', () => {
  it('starts a live query subscription on start()', async () => {
    const { db } = createMockDb();
    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );

    await controller.start();

    expect(db.live).toHaveBeenCalledTimes(1);
  });

  it('kills the live query on stop()', async () => {
    const { db } = createMockDb();
    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );

    await controller.start();
    controller.stop();

    // kill should have been called on the live query
    expect(db.live).toHaveBeenCalled();
  });

  it('applies remote command for CREATE events from other clients', async () => {
    const { db, emit } = createMockDb();
    const onRemoteCommand = vi.fn();

    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      onRemoteCommand,
      vi.fn(),
      vi.fn(),
    );

    await controller.start();

    emit('CREATE', {
      id: 'mutation:1',
      workbook: WORKBOOK_ID,
      workspace: WORKSPACE_ID,
      command_id: 'sheet.set-range-values-mutation',
      params: { value: 'hello' },
      client_id: 'other-client',
      created_at: new Date().toISOString(),
    });

    expect(onRemoteCommand).toHaveBeenCalledWith({
      command_id: 'sheet.set-range-values-mutation',
      params: { value: 'hello' },
    });
  });

  it('suppresses own mutations coming back from LIVE SELECT', async () => {
    const { db, emit } = createMockDb();
    const onRemoteCommand = vi.fn();

    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      onRemoteCommand,
      vi.fn(),
      vi.fn(),
    );

    await controller.start();

    emit('CREATE', {
      id: 'mutation:1',
      workbook: WORKBOOK_ID,
      workspace: WORKSPACE_ID,
      command_id: 'sheet.set-range-values-mutation',
      params: { value: 'hello' },
      client_id: CLIENT_ID, // same client — should be suppressed
      created_at: new Date().toISOString(),
    });

    expect(onRemoteCommand).not.toHaveBeenCalled();
  });

  it('triggers snapshot and logs error for unknown command_id', async () => {
    const { db, emit } = createMockDb();
    const onRemoteCommand = vi.fn();
    const onSnapshotNeeded = vi.fn();

    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      onRemoteCommand,
      onSnapshotNeeded,
      vi.fn(),
    );

    await controller.start();

    emit('CREATE', {
      id: 'mutation:99',
      workbook: WORKBOOK_ID,
      workspace: WORKSPACE_ID,
      command_id: 'sheet.unknown-evil-operation',
      params: {},
      client_id: 'other-client',
      created_at: new Date().toISOString(),
    });

    expect(onRemoteCommand).not.toHaveBeenCalled();
    expect(onSnapshotNeeded).toHaveBeenCalled();
  });

  it('ignores UPDATE and DELETE events', async () => {
    const { db, emit } = createMockDb();
    const onRemoteCommand = vi.fn();

    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      onRemoteCommand,
      vi.fn(),
      vi.fn(),
    );

    await controller.start();

    emit('UPDATE', { command_id: 'sheet.set-range-values-mutation', client_id: 'other', params: {} });
    emit('DELETE', { command_id: 'sheet.set-range-values-mutation', client_id: 'other', params: {} });

    expect(onRemoteCommand).not.toHaveBeenCalled();
  });

  it('replays missed mutations below threshold on reconnect', async () => {
    const { db, emit } = createMockDb();
    const onRemoteCommand = vi.fn();

    const missedTs = new Date(Date.now() - 5_000).toISOString(); // 5s ago — under 30s threshold
    db.query.mockResolvedValueOnce([
      [
        {
          id: 'mutation:2',
          workbook: WORKBOOK_ID,
          workspace: WORKSPACE_ID,
          command_id: 'sheet.set-range-values-mutation',
          params: { value: 'missed' },
          client_id: 'other-client',
          created_at: new Date().toISOString(),
        },
      ],
    ]);

    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      onRemoteCommand,
      vi.fn(),
      vi.fn(),
    );

    await controller.start();

    const result = await controller.handleReconnect(missedTs);

    expect(result).toBe('replay');
    expect(onRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command_id: 'sheet.set-range-values-mutation' }),
    );
  });

  it('falls back to snapshot when gap exceeds time threshold', async () => {
    const { db } = createMockDb();
    const onSnapshotNeeded = vi.fn();

    const oldTs = new Date(Date.now() - 60_000).toISOString(); // 60s ago — over 30s threshold

    // Return 0 missed mutations but the time gap alone triggers snapshot
    db.query.mockResolvedValueOnce([[]]);

    const controller = createCollabController(
      db as never,
      WORKBOOK_ID,
      WORKSPACE_ID,
      CLIENT_ID,
      vi.fn(),
      onSnapshotNeeded,
      vi.fn(),
    );

    await controller.start();

    const result = await controller.handleReconnect(oldTs);

    expect(result).toBe('snapshot');
    expect(onSnapshotNeeded).toHaveBeenCalled();
  });
});
