import { useEffect, useReducer } from 'react';

export interface Toast {
  id: string;
  message: string;
  /** Milliseconds before auto-dismiss. Default 5000. */
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
}

type ToastAction =
  | { type: 'add'; toast: Toast }
  | { type: 'dismiss'; id: string };

function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'add':
      return { toasts: [...state.toasts, action.toast] };
    case 'dismiss':
      return { toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

export interface ToastRegionProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

/**
 * Accessible toast region. `aria-live="polite"` ensures screen readers announce
 * each new toast without interrupting current speech.
 */
export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  return (
    <div
      className="toast-region"
      aria-live="polite"
      aria-label="Notifications"
      role="status"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration ?? 5000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  return (
    <div className="toast">
      <span className="toast__message">{toast.message}</span>
      <button
        className="ghost-button toast__close"
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Hook that manages a toast queue. Returns the current toasts and a function to
 * enqueue a new one.
 */
export function useToasts() {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [] });

  function addToast(message: string, duration = 5000) {
    const id = crypto.randomUUID();
    dispatch({ type: 'add', toast: { id, message, duration } });
  }

  function dismissToast(id: string) {
    dispatch({ type: 'dismiss', id });
  }

  return { toasts: state.toasts, addToast, dismissToast };
}

/**
 * Watches the intake_submission table via LIVE SELECT and fires a toast
 * when a new submission arrives.
 *
 * Returns a cleanup function.
 */
export function watchFormSubmissions(
  db: import('surrealdb').Surreal,
  _workspaceId: string,
  onSubmission: (message: string) => void,
): () => Promise<void> {
  let liveQuery: import('surrealdb').LiveSubscription | undefined;

  void (async () => {
    try {
      const { Table } = await import('surrealdb');
      liveQuery = await db.live(new Table('intake_submission'));
      liveQuery.subscribe((message: import('surrealdb').LiveMessage) => {
        if (message.action === 'CREATE') {
          onSubmission('收到新的表单提交');
        }
      });
    } catch {
      // LIVE SELECT failure is non-fatal.
    }
  })();

  return async () => {
    await liveQuery?.kill();
  };
}

/**
 * Returns a CSS class that highlights a newly-inserted row for 3 seconds.
 * The class should trigger a CSS animation that fades the highlight out.
 */
export function useRowHighlight(recordId: string | null): string {
  return recordId ? 'row-highlight' : '';
}
