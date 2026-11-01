import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Modal by default; a non-modal panel leaves the field and results visible while it changes them. */
export function Panel({ open, onClose, title, children, modal = true, className = '' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; modal?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), opener = useRef<Element | null>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      if (modal) dialog.showModal(); else { dialog.show(); dialog.querySelector<HTMLElement>('input, button:not([aria-label^="Close"])')?.focus(); }
    }
    if (!open && dialog.open) { dialog.close(); if (!modal) (opener.current as HTMLElement | null)?.focus?.(); }
  }, [open, modal]);
  return <dialog ref={ref} className={`floating-panel ${className}`} aria-label={title} onCancel={onClose} onClose={onClose}
    onKeyDown={event => { if (!modal && event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <header><h2>{title}</h2><button onClick={onClose} aria-label={`Close ${title}`}>✕</button></header>{children}
  </dialog>;
}

export type FilterState = { moods: string[] | null; minimum: number; bounds: [string, string][] };
export const clearFilters = (): FilterState => ({ moods: null, minimum: 1, bounds: [['', ''], ['', ''], ['', '']] });
export const filtersActive = (filters: FilterState) => filters.moods !== null || filters.minimum > 1 || filters.bounds.some(pair => pair.some(Boolean));
export function filterPayload(filters: FilterState, categories: { id: string }[], intensity: boolean) {
  return {
    moods: filters.moods === null && (filters.minimum === 1 || !intensity) ? null :
      (filters.moods ?? categories.map(c => c.id)).map(mood_id => ({ mood_id, minimum_intensity: intensity ? filters.minimum : null })),
    bounds: filters.bounds.some(pair => pair.some(Boolean)) ? filters.bounds.map(([low, high]) => [low === '' ? -1e308 : Number(low), high === '' ? 1e308 : Number(high)]) : null,
  };
}
export const boundsInvalid = (filters: FilterState) => filters.bounds.some(([low, high]) => [low, high].some(value => value !== '' && !Number.isFinite(Number(value))) ||
  (low !== '' && high !== '' && Number(low) > Number(high)));
/** Toggle one mood; `null` means every category is included. */
export function toggleMood(filters: FilterState, id: string, categories: { id: string }[], only = false): FilterState {
  if (only) return { ...filters, moods: [id] };
  const moods = filters.moods ?? categories.map(c => c.id);
  const next = moods.includes(id) ? moods.filter(mood => mood !== id) : [...moods, id];
  return { ...filters, moods: categories.every(c => next.includes(c.id)) ? null : next };
}

/** Valid changes apply immediately (typed bounds after a short pause); invalid bounds leave the active filters unchanged. */
export function FilterPanel({ open, onClose, value, onApply, categories, intensity, matching, total }: {
  open: boolean; onClose: () => void; value: FilterState; onApply: (value: FilterState) => void;
  categories: { id: string; label: string }[]; intensity: boolean; matching?: number | null; total?: number;
}) {
  const [draft, setDraft] = useState(value), [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (open) { setDraft(value); setError(''); } }, [open, value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (next: FilterState, delay = 0) => {
    setDraft(next); clearTimeout(timer.current);
    if (boundsInvalid(next)) { setError('Each minimum must be a number no greater than its maximum. Active filters are unchanged.'); return; }
    setError('');
    if (delay) timer.current = setTimeout(() => onApply(next), delay); else onApply(next);
  };
  return <Panel open={open} onClose={onClose} title="Explore by mood" modal={false} className="filter-panel">
    <p className="filter-count" role="status">{matching == null ? `All ${total ?? ''} recordings shown` : `${matching} of ${total} recordings match`} · changes apply immediately</p>
    <fieldset><legend>Original historical categories</legend><div className="filter-shortcuts">
      <button type="button" onClick={() => change({ ...draft, moods: null })}>All moods</button>
      <button type="button" onClick={() => change({ ...draft, moods: [] })}>Select none</button></div>
      {categories.map(category => <div className="mood-option" key={category.id}><label>
        <input type="checkbox" checked={draft.moods === null || draft.moods.includes(category.id)} onChange={() => change(toggleMood(draft, category.id, categories))}/>{category.label}</label>
        <button type="button" className="mood-only" aria-label={`Only ${category.label}`} onClick={() => change(toggleMood(draft, category.id, categories, true))}>Only</button></div>)}
      {draft.moods?.length === 0 && <p className="fine-print">No mood selected: nothing matches until a mood is chosen.</p>}
    </fieldset>
    <fieldset><legend>Minimum geometric intensity</legend><label className="intensity-filter">
      <input aria-label="Minimum geometric intensity" type="range" min={1} max={10} step={.1} disabled={!intensity} value={draft.minimum}
        onChange={e => change({ ...draft, minimum: Number(e.target.value) }, 150)}/><output>{draft.minimum.toFixed(1)} / 10</output></label>
      <p className="fine-print">{intensity ? 'Includes equality. Applies to each selected mood; this is geometry, not confidence.' : 'Intensity is unavailable for this mapping.'}</p>
    </fieldset>
    <fieldset><legend>Continuous RTP region</legend><p className="fine-print">Inclusive raw coordinates. Leave a bound empty for any value. You can also drag a rectangle in a 2D view.</p>
      <div className="bound-row bound-head" aria-hidden="true"><span/><span>Min</span><span>Max</span></div>
      {(['Rhythm', 'Texture', 'Pitch'] as const).map((axis, index) => <div className="bound-row" key={axis}><span>{axis}</span>
        {(['minimum', 'maximum'] as const).map((side, sideIndex) => <input key={side} aria-label={`${axis} ${side}`} type="number" step="any" placeholder="Any"
          value={draft.bounds[index][sideIndex]} onChange={e => {
            const bounds = draft.bounds.map(pair => [...pair] as [string, string]); bounds[index][sideIndex] = e.target.value; change({ ...draft, bounds }, 350);
          }}/>)}</div>)}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="panel-actions"><button type="button" onClick={() => change(clearFilters())}>Reset filters</button><button type="button" className="primary" onClick={onClose}>Done</button></div>
  </Panel>;
}
