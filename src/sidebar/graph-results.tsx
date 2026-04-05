import type { GraphResultItem, GraphTraverseResult } from '../formulas/graph-traverse';

export interface GraphResultsPanelProps {
  result: GraphTraverseResult | null;
  isLoading?: boolean;
  error?: string | null;
  onSelectRecord?: (recordId: string) => void;
}

/**
 * Sidebar panel that shows the full GRAPH_TRAVERSE result list.
 * Opened when the user clicks a formula result cell.
 */
export function GraphResultsPanel({
  result,
  isLoading,
  error,
  onSelectRecord,
}: GraphResultsPanelProps) {
  if (isLoading) {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Graph results</p>
        <p className="sidebar-copy">Traversing graph…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Graph results</p>
        <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>
          {error}
        </p>
      </div>
    );
  }

  if (!result || result.items.length === 0) {
    return (
      <div className="sidebar-panel__content">
        <p className="eyebrow">Graph results</p>
        <p className="sidebar-copy">No results for this traversal.</p>
      </div>
    );
  }

  return (
    <div className="sidebar-panel__content">
      <p className="eyebrow">Graph results</p>
      <h2>{result.items.length} node{result.items.length !== 1 ? 's' : ''}</h2>
      <ul className="sidebar-list sidebar-list--flush graph-results-list" role="list">
        {result.items.map((item) => (
          <GraphResultRow key={item.recordId} item={item} onSelect={onSelectRecord} />
        ))}
      </ul>
    </div>
  );
}

function GraphResultRow({
  item,
  onSelect,
}: {
  item: GraphResultItem;
  onSelect?: (recordId: string) => void;
}) {
  return (
    <li>
      <button
        className="ghost-button graph-result-row"
        type="button"
        style={{ width: '100%', textAlign: 'left', padding: 'var(--space-sm) 0' }}
        onClick={() => onSelect?.(item.recordId)}
      >
        <div>
          <strong>{item.label}</strong>
          <p className="mono-cell" style={{ margin: 0 }}>
            {item.recordId}
          </p>
        </div>
        <span className="status-chip status-chip--compact">{item.entityType}</span>
      </button>
    </li>
  );
}
