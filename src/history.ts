import { useCallback, useState } from 'react';

type Entry<T> = { value: T; label: string };
type Stack<T> = { past: Entry<T>[]; present: T; future: Entry<T>[]; last: { key: string; at: number } | null };
const LIMIT = 100, COALESCE_MS = 1200;

/** In-memory undo/redo for one open draft. Opening another draft resets it; nothing is stored. */
export function useHistory<T>(initial: () => T) {
  const [stack, setStack] = useState<Stack<T>>(() => ({ past: [], present: initial(), future: [], last: null }));
  /** Record an edit. Consecutive edits sharing `coalesce` (typing, dragging) within a moment become one step. */
  const commit = useCallback((update: (current: T) => T, label: string, coalesce?: string) => setStack(current => {
    const value = update(current.present);
    if (Object.is(value, current.present)) return current;
    const now = Date.now(), merge = !!coalesce && current.last?.key === coalesce && now - current.last.at < COALESCE_MS && current.past.length > 0;
    return { past: merge ? current.past : [...current.past, { value: current.present, label }].slice(-LIMIT), present: value, future: [],
      last: coalesce ? { key: coalesce, at: now } : null };
  }), []);
  /** Replace the present without an undo step (state the user did not author, such as a server response). */
  const replace = useCallback((update: (current: T) => T) => setStack(current => ({ ...current, present: update(current.present) })), []);
  /** Apply a change to every remembered state, e.g. a new saved revision that undo must not roll back. */
  const rebase = useCallback((update: (value: T) => T) => setStack(current => ({ ...current, present: update(current.present),
    past: current.past.map(entry => ({ ...entry, value: update(entry.value) })), future: current.future.map(entry => ({ ...entry, value: update(entry.value) })) })), []);
  const reset = useCallback((value: T) => setStack({ past: [], present: value, future: [], last: null }), []);
  const undo = useCallback(() => setStack(current => {
    const entry = current.past.at(-1); if (!entry) return current;
    return { past: current.past.slice(0, -1), present: entry.value, future: [{ value: current.present, label: entry.label }, ...current.future], last: null };
  }), []);
  const redo = useCallback(() => setStack(current => {
    const [entry, ...future] = current.future; if (!entry) return current;
    return { past: [...current.past, { value: current.present, label: entry.label }], present: entry.value, future, last: null };
  }), []);
  return { value: stack.present, commit, replace, rebase, reset, undo, redo,
    undoLabel: stack.past.at(-1)?.label ?? null, redoLabel: stack.future[0]?.label ?? null };
}

/** Ctrl/⌘+Z, Ctrl/⌘+Shift+Z and Ctrl+Y outside text fields, which keep their native text undo. */
export function undoKey(event: React.KeyboardEvent): 'undo' | 'redo' | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const target = event.target as HTMLElement;
  if (target.closest('input:not([type=checkbox]):not([type=range]), textarea, [contenteditable="true"]')) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  return key === 'y' ? 'redo' : null;
}
