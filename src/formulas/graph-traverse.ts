import type { DbAdapter } from '../lib/surreal/db-adapter';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GraphTraverseResult {
  /** Compact cell label: "A, B, C (+N more)" */
  cellLabel: string;
  /** Full result list for the sidebar panel */
  items: GraphResultItem[];
}

export interface GraphResultItem {
  recordId: string;
  label: string;
  entityType: string;
}

export type GraphTraverseError = '#REF!' | '#NAME?' | '#VALUE!' | '#TIMEOUT!';

// ─── Constants ───────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 10_000;
const MAX_CELL_DISPLAY = 5;
const MAX_CONCURRENT_QUERIES = 10;

/** Regex for a valid SurrealDB record ID: table:id */
const RECORD_ID_RE = /^[a-z_][a-z0-9_]*:.+$/i;

// ─── Concurrency limiter ─────────────────────────────────────────────────────

let activeQueries = 0;
const queryQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeQueries < MAX_CONCURRENT_QUERIES) {
      activeQueries++;
      resolve();
    } else {
      queryQueue.push(() => {
        activeQueries++;
        resolve();
      });
    }
  });
}

function releaseSlot(): void {
  activeQueries--;
  const next = queryQueue.shift();
  if (next) {
    next();
  }
}

// ─── Label resolution ────────────────────────────────────────────────────────

function resolveLabel(record: Record<string, unknown>, recordId: string): string {
  if (typeof record.name === 'string' && record.name) return record.name;
  if (typeof record.label === 'string' && record.label) return record.label;

  // First alphabetical string field
  const firstStringField = Object.keys(record)
    .filter((k) => k !== 'id' && typeof record[k] === 'string')
    .sort()[0];

  if (firstStringField && typeof record[firstStringField] === 'string') {
    return record[firstStringField] as string;
  }

  return recordId;
}

function extractTableName(recordId: string): string {
  return recordId.split(':')[0] ?? recordId;
}

// ─── Core traversal ──────────────────────────────────────────────────────────

/**
 * Validate inputs and run a breadth-first graph traversal.
 * Returns either a result object or an error token.
 */
export async function graphTraverse(
  db: DbAdapter,
  startNode: string,
  relationship: string,
  depth: number,
): Promise<GraphTraverseResult | GraphTraverseError> {
  // --- Input validation ---
  if (!startNode || typeof startNode !== 'string') return '#VALUE!';
  if (!RECORD_ID_RE.test(startNode.trim())) return '#VALUE!';
  if (!relationship || typeof relationship !== 'string' || !relationship.trim()) return '#NAME?';
  if (!Number.isInteger(depth) || depth < 1 || depth > 10) return '#VALUE!';

  const cleanStart = startNode.trim();
  const cleanRel = relationship.trim();

  await acquireSlot();

  try {
    return await Promise.race([
      runTraversal(db, cleanStart, cleanRel, depth),
      new Promise<GraphTraverseError>((resolve) =>
        setTimeout(() => resolve('#TIMEOUT!'), QUERY_TIMEOUT_MS),
      ),
    ]);
  } finally {
    releaseSlot();
  }
}

async function runTraversal(
  db: DbAdapter,
  startNode: string,
  relationship: string,
  depth: number,
): Promise<GraphTraverseResult | GraphTraverseError> {
  const visited = new Set<string>([startNode]);
  const allResults: GraphResultItem[] = [];

  // Verify start node exists
  const startResult = await db
    .query<[Array<Record<string, unknown>>]>(`SELECT * FROM $id`, { id: startNode })
    .catch(() => null);

  if (!startResult || !startResult[0]?.length) return '#REF!';

  // Breadth-first traversal: one query per depth level
  let frontier = [startNode];

  for (let hop = 0; hop < depth; hop++) {
    if (frontier.length === 0) break;

    // Use SurrealDB graph traversal arrow syntax:
    // SELECT ->{rel}.* FROM [$ids]
    // This follows outgoing edges of type `relationship` from all frontier nodes
    const result = await db
      .query<[Array<Record<string, unknown>>]>(
        `SELECT ->(${cleanSurrealIdentifier(relationship)})->? .* AS targets FROM $ids`,
        { ids: frontier },
      )
      .catch(() => null);

    if (!result || !result[0]) {
      // Relationship type not found in schema → #NAME?
      if (hop === 0) return '#NAME?';
      break;
    }

    const nextFrontier: string[] = [];

    for (const row of result[0]) {
      const targets = row.targets as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(targets)) continue;

      for (const target of targets) {
        const id = String(target.id ?? '');
        if (!id || visited.has(id)) continue;

        visited.add(id);
        nextFrontier.push(id);

        allResults.push({
          recordId: id,
          label: resolveLabel(target, id),
          entityType: extractTableName(id),
        });
      }
    }

    frontier = nextFrontier;
  }

  if (allResults.length === 0) {
    return { cellLabel: '(no results)', items: [] };
  }

  const displayed = allResults.slice(0, MAX_CELL_DISPLAY).map((r) => r.label);
  const extra = allResults.length - MAX_CELL_DISPLAY;
  const cellLabel =
    extra > 0 ? `${displayed.join(', ')} (+${extra} more)` : displayed.join(', ');

  return { cellLabel, items: allResults };
}

/**
 * Strip any non-identifier characters from a relationship name to prevent
 * SurrealQL injection via the formula argument.
 */
function cleanSurrealIdentifier(name: string): string {
  return name.replace(/[^a-z0-9_]/gi, '');
}

// ─── LIVE SELECT reactivity ──────────────────────────────────────────────────

export interface FormulaReactivityOptions {
  /** Called when one of the watched tables changes — debounced with max-wait. */
  onTableChanged: (tableName: string) => void;
  debounceMs?: number;
  maxWaitMs?: number;
}

/**
 * Creates a dependency map: tableName → Set<formulaCellRef>
 * and a debounced handler with max-wait ceiling.
 */
export function createFormulaDebounce(opts: FormulaReactivityOptions): {
  notify(tableName: string): void;
  destroy(): void;
} {
  const { onTableChanged, debounceMs = 500, maxWaitMs = 2_000 } = opts;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxTimers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    notify(tableName: string) {
      // Reset trailing debounce
      const existing = timers.get(tableName);
      if (existing) clearTimeout(existing);

      timers.set(
        tableName,
        setTimeout(() => {
          timers.delete(tableName);
          const max = maxTimers.get(tableName);
          if (max) {
            clearTimeout(max);
            maxTimers.delete(tableName);
          }
          onTableChanged(tableName);
        }, debounceMs),
      );

      // Set max-wait ceiling if not already set
      if (!maxTimers.has(tableName)) {
        maxTimers.set(
          tableName,
          setTimeout(() => {
            maxTimers.delete(tableName);
            const t = timers.get(tableName);
            if (t) {
              clearTimeout(t);
              timers.delete(tableName);
            }
            onTableChanged(tableName);
          }, maxWaitMs),
        );
      }
    },

    destroy() {
      for (const t of timers.values()) clearTimeout(t);
      for (const t of maxTimers.values()) clearTimeout(t);
      timers.clear();
      maxTimers.clear();
    },
  };
}
