import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Recording, RTP } from './types';
import { axes, defaultWaypoints, generateSequence, rtpSeries, type Generation } from './trajectoryDesign';
import { postJSON, readJSON } from './api';
import { journeyTarget, type Recipe, type TargetSnapshot } from './journeys';
import { undoKey, useHistory } from './history';

type Shape = { name: string; waypoints: RTP[]; length: number };
export const defaultTargetName = 'Untitled target';
const fresh = (): Shape => ({ name: defaultTargetName, waypoints: defaultWaypoints(), length: 6 });
const shapeKey = (shape: Shape) => JSON.stringify([shape.name, shape.waypoints, shape.length]);
const fromRecipe = (recipe: Recipe | null): Shape => recipe ?
  { name: recipe.name, waypoints: recipe.target.waypoints.map(point => ({ ...point })), length: recipe.target.requested_count } : fresh();

/** Typing keeps its own text until it parses as a value from 1 to 5; values are kept exactly as typed. */
function WaypointInput({ label, value, disabled, onCommit, onFocus }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void; onFocus: () => void }) {
  const [text, setText] = useState<string | null>(null);
  return <input type="number" min={1} max={5} step={.1} aria-label={label} disabled={disabled} value={text ?? String(value)}
    onFocus={() => { setText(String(value)); onFocus(); }} onBlur={() => setText(null)}
    onChange={event => {
      if (text !== null) setText(event.target.value);
      const parsed = Number(event.target.value);
      if (event.target.value.trim() !== '' && Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) onCommit(parsed);
    }}/>;
}

export function TrajectoryDesigner({ records, disabled, expanded, onExpand, onGenerate, comparing, onDirtyChange }: {
  records: Recording[]; disabled: boolean; expanded: boolean; onExpand: (value: boolean) => void;
  onGenerate: (result: Generation, target: TargetSnapshot, name: string) => void; comparing: boolean; onDirtyChange?: (dirty: boolean) => void;
}) {
  const history = useHistory(fresh), shape = history.value, { waypoints, length, name } = shape;
  const [baseline, setBaseline] = useState(() => shapeKey(fresh()));
  const [notice, setNotice] = useState('');
  const [recipes, setRecipes] = useState<Recipe[]>([]), [recipe, setRecipe] = useState<Recipe | null>(null);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [failure, setFailure] = useState('');
  const [pending, setPending] = useState<{ type: 'open'; recipe: Recipe | null } | { type: 'delete' } | null>(null);
  const [dragAxis, setDragAxis] = useState<'all' | keyof RTP>('all'), [focused, setFocused] = useState<number | null>(null);
  const dirty = shapeKey(shape) !== baseline;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    readJSON<{ recipes: Recipe[] }>('recipes', { signal: controller.signal }).then(result => {
      setRecipes(result.recipes); setReady(true);
    }).catch(error => { if (!controller.signal.aborted) setFailure(error.message); });
    return () => controller.abort();
  }, []);
  const locked = disabled || busy || !!pending;
  const edit = (update: (current: Shape) => Shape, label: string, coalesce?: string) => {
    if (locked) return; history.commit(update, label, coalesce); setNotice(''); setFailure('');
  };
  function openRecipe(value: Recipe | null) {
    const next = fromRecipe(value);
    setRecipe(value); history.reset(next); setBaseline(shapeKey(next)); setPending(null); setFailure('');
    setNotice(value ? `Saved target opened · revision ${value.revision}` : 'New target'); onExpand(true);
  }
  function requestOpen(value: Recipe | null) {
    if (dirty) setPending({ type: 'open', recipe: value }); else openRecipe(value);
  }
  async function saveRecipe(duplicate = false) {
    setBusy(true); setFailure('');
    try {
      const saved = await postJSON<Recipe>(recipe && !duplicate ? `recipes/${recipe.id}` : 'recipes', {
        name: duplicate ? `${name.slice(0, 93)} (copy)` : name,
        revision: duplicate ? 0 : recipe?.revision ?? 0, target: journeyTarget(waypoints, length),
      });
      setRecipes(previous => [saved, ...previous.filter(item => item.id !== saved.id)]);
      setRecipe(saved); history.replace(current => ({ ...current, name: saved.name })); setBaseline(shapeKey({ ...shape, name: saved.name }));
      setNotice(duplicate ? 'Target duplicated in this browser' : 'Target saved in this browser');
      return saved;
    } catch (error) { setFailure((error as Error).message); return null; }
    finally { setBusy(false); }
  }
  async function reloadRecipes() {
    setBusy(true); setFailure('');
    try {
      const result = await readJSON<{ recipes: Recipe[] }>('recipes'); setRecipes(result.recipes); setReady(true);
      if (recipe) requestOpen(result.recipes.find(item => item.id === recipe.id) ?? null);
      else setNotice('Saved targets refreshed');
    } catch (error) { setFailure((error as Error).message); }
    finally { setBusy(false); }
  }
  async function deleteRecipe() {
    if (!recipe) return;
    setBusy(true); setFailure('');
    try {
      await postJSON(`recipes/${recipe.id}/delete`, { revision: recipe.revision });
      setRecipes(previous => previous.filter(item => item.id !== recipe.id)); openRecipe(null);
      setNotice('Target deleted · saved playlists keep their own copies');
    } catch (error) { setFailure((error as Error).message); }
    finally { setBusy(false); }
  }
  function generate(linked: Recipe | null) {
    const result = generateSequence(records, waypoints, length); setNotice(result.recordings.length ? '' : result.notices.join(' '));
    if (result.recordings.length) onGenerate(result, { ...journeyTarget(waypoints, length),
      recipe: linked ? { id: linked.id, name: linked.name, revision: linked.revision } : null }, name);
  }
  const [width, setWidth] = useState(680), host = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ point: number; axis: keyof RTP } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (element.clientWidth) setWidth(element.clientWidth); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const series = (key: keyof RTP) => rtpSeries.find(s => s.axis === key)!.name;
  const update = (point: number, axis: keyof RTP, value: number) =>
    edit(current => ({ ...current, waypoints: current.waypoints.map((item, index) => index === point ? { ...item, [axis]: value } : item) }),
      `${series(axis)} at waypoint ${point + 1}`, `waypoint-${point}-${axis}`);
  const insertAfter = (index: number) => edit(current => {
    const before = current.waypoints[index], after = current.waypoints[index + 1];
    const point = Object.fromEntries(axes.map(axis => [axis, Math.round((before[axis] + after[axis]) * 5) / 10])) as RTP;
    return { ...current, waypoints: [...current.waypoints.slice(0, index + 1), point, ...current.waypoints.slice(index + 1)] };
  }, `insert waypoint after ${index + 1}`);
  const x = (index: number) => 52 + index * (width - 80) / (waypoints.length - 1);
  const y = (value: number) => 26 + (5 - value) * 40;
  const ordered = dragAxis === 'all' ? rtpSeries : [...rtpSeries.filter(s => s.axis !== dragAxis), rtpSeries.find(s => s.axis === dragAxis)!];
  const playable = records.filter(record => record.playback_status === 'available').length;
  const label = (index: number) => index === 0 ? 'Start' : index === waypoints.length - 1 ? 'End' : `Waypoint ${index + 1}`;
  return <section className="trajectory-designer" aria-label="Target designer" onKeyDown={event => {
    const action = undoKey(event); if (!action) return;
    event.preventDefault(); event.stopPropagation(); if (!locked) history[action]();
  }}>
    <header><div><span className="eyebrow">TARGET · SHAPE → GENERATE → AUDITION → REFINE → SAVE</span><h2>Shape a target.</h2></div>
      <button onClick={() => onExpand(!expanded)} aria-expanded={expanded}>{expanded ? 'Hide target editor' : 'Edit target'}</button></header>
    <p className="design-explanation">A <strong>target</strong> is a desired Rhythm, Texture and Pitch shape. Generating turns it into a new <strong>playlist</strong> of recordings; each playlist keeps its own copy of the target it came from.</p>
    <div className="recipe-library"><label>Saved targets<select aria-label="Open saved target" value={recipe?.id ?? ''} disabled={locked || !ready}
      onChange={event => { const found = recipes.find(item => item.id === event.target.value); if (found) requestOpen(found); }}>
      <option value="">Choose a saved target…</option>{recipes.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}
    </select></label><button disabled={locked} onClick={() => requestOpen(null)}>New target</button><button disabled={locked} onClick={reloadRecipes}>Reload targets</button></div>
    <div className="recipe-titlebar"><label>Target name<input aria-label="Target name" maxLength={100} value={name} disabled={locked}
      onChange={event => { const value = event.target.value; edit(current => ({ ...current, name: value }), 'rename target', 'name'); }}/></label>
      <button disabled={locked || !ready || !name.trim() || (!dirty && !!recipe)} onClick={() => saveRecipe()}>Save target</button>
      <button disabled={locked || !ready || !name.trim()} onClick={() => saveRecipe(true)}>Duplicate target</button>
      <button disabled={locked || !recipe} onClick={() => setPending({ type: 'delete' })}>Delete target</button>
      <button disabled={locked || !history.undoLabel} aria-label="Undo target edit" title={history.undoLabel ? `Undo ${history.undoLabel}` : undefined} onClick={history.undo}>↶</button>
      <button disabled={locked || !history.redoLabel} aria-label="Redo target edit" title={history.redoLabel ? `Redo ${history.redoLabel}` : undefined} onClick={history.redo}>↷</button>
      <span className="recipe-state">{dirty ? 'Unsaved target' : recipe ? `Saved · r${recipe.revision}` : 'New target'}</span></div>
    {pending && <div className="playlist-confirm" role="group" aria-label="Confirm target action"><span>{pending.type === 'delete' ? `Delete “${name}”? Playlists keep their own copies.` : 'This target has unsaved changes.'}</span>
      {pending.type === 'open' ? <><button disabled={busy || disabled} onClick={async () => {
        const saved = await saveRecipe(); if (saved) openRecipe(pending.recipe?.id === saved.id ? saved : pending.recipe);
      }}>Save target and open</button>
        <button disabled={busy || disabled} onClick={() => openRecipe(pending.recipe)}>Discard target and open</button></> :
        <button disabled={busy || disabled} onClick={deleteRecipe}>Confirm delete target</button>}
      <button disabled={busy || disabled} onClick={() => setPending(null)}>Cancel target action</button></div>}
    {failure && <p className="playlist-error" role="alert">{failure}</p>}
    <div className="design-toolbar"><span>{waypoints.length} waypoints · values 1–5 · candidates: all {playable} playable recordings in the library (filters and search don’t apply)</span>
      <label>Sequence length<select aria-label="Generated sequence length" value={length} disabled={locked} onChange={event => { const value = Number(event.target.value); edit(current => ({ ...current, length: value }), 'sequence length'); }}>
      {Array.from({ length: 10 }, (_, i) => i + 3).map(value => <option key={value} value={value}>{value} recordings</option>)}</select></label>
      <button className="primary" disabled={locked} onClick={() => generate(recipe && !dirty ? recipe : null)}>Generate new playlist</button></div>
    {recipe && dirty && <p className="quality-note unlinked-note">Unsaved edits to “{recipe.name}”: a playlist generated now keeps its own copy of this shape and is not linked to the saved target.
      {' '}<button disabled={locked || !name.trim()} onClick={async () => { const saved = await saveRecipe(); if (saved) generate(saved); }}>Save target and generate</button></p>}
    <div hidden={!expanded}>
      <p className="design-explanation">Drag a handle vertically or type values below. Waypoints are evenly spaced by recording order.
        {comparing && ' Edits here apply to the next generation; the open playlist keeps its own copy of its target.'}</p>
      <div className="drag-axis" role="group" aria-label="Handles to drag"><span>Drag</span>{([{ axis: 'all', name: 'All' }, ...rtpSeries] as const).map(s =>
        <button key={s.axis} aria-pressed={dragAxis === s.axis} onClick={() => setDragAxis(s.axis)}>{s.name}</button>)}
        <span className="fine-print">Choose one axis when handles overlap.</span></div>
      <div className="trajectory-legend design-legend" role="group" aria-label="Graph key">{rtpSeries.map(s => <span key={s.axis}><svg width="26" height="8" aria-hidden="true">
        <line x1="0" x2="26" y1="4" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dash}/></svg>{s.name} / {s.axis}</span>)}</div>
      <div className="design-graph" ref={host}><svg width="100%" height="220" viewBox={`0 0 ${width} 220`} role="img" aria-label="Desired Rhythm, Texture and Pitch curves; target range 1 to 5">
        {[1, 2, 3, 4, 5].map(tick => <g key={tick}><line x1={44} x2={width - 24} y1={y(tick)} y2={y(tick)}/><text x={30} y={y(tick) + 4}>{tick}</text></g>)}
        {focused != null && focused < waypoints.length && <rect className="waypoint-focus" x={x(focused) - 16} y={16} width={32} height={180}/>}
        {ordered.map(series => { const active = dragAxis === 'all' || dragAxis === series.axis; return <g key={series.axis} opacity={active ? 1 : .35}>
          <path data-design-series={series.axis} d={waypoints.map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(point[series.axis])}`).join(' ')}
            fill="none" stroke={series.color} strokeWidth={2.5} strokeDasharray={series.dash}/>
          {waypoints.map((point, index) => <circle key={index} cx={x(index)} cy={y(point[series.axis])} r={9} fill={series.color} stroke="white" strokeWidth={2}
            aria-hidden="true" data-waypoint={index} data-target-axis={series.axis} className="target-handle" pointerEvents={active ? undefined : 'none'}
            onPointerDown={event => { if (locked) return; setFocused(index); dragging.current = { point: index, axis: series.axis }; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={event => { if (!dragging.current || locked) return;
              const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
              const value = Math.max(1, Math.min(5, Math.round((5 - ((event.clientY - bounds.top) * 220 / bounds.height - 26) / 40) * 10) / 10));
              update(dragging.current.point, dragging.current.axis, value);
            }} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}/>)}</g>; })}
        {waypoints.map((_, index) => <text key={index} x={x(index)} y={211} textAnchor="middle">{index === 0 ? 'Start' : index === waypoints.length - 1 ? 'End' : index + 1}</text>)}
      </svg></div>
      <table className="waypoint-table"><caption className="sr-only">Waypoint values</caption>
        <thead><tr><th scope="col">Waypoint</th>{rtpSeries.map(s => <th scope="col" key={s.axis} style={{ color: s.color }}>{s.name}</th>)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{waypoints.map((point, index) => <tr key={index} className={focused === index ? 'is-focused' : undefined}><th scope="row">{label(index)}</th>
          {rtpSeries.map(s => <td key={s.axis}><WaypointInput label={`Waypoint ${index + 1} ${s.name}`} value={point[s.axis]} disabled={locked}
            onFocus={() => setFocused(index)} onCommit={value => update(index, s.axis, value)}/></td>)}
          <td className="waypoint-actions">{index < waypoints.length - 1 && <button disabled={locked || waypoints.length >= 7} aria-label={`Insert waypoint after ${label(index)}`} onClick={() => insertAfter(index)}>+ Insert after</button>}
            {index > 0 && index < waypoints.length - 1 && <button disabled={locked} aria-label={`Remove waypoint ${index + 1}`}
              onClick={() => edit(current => ({ ...current, waypoints: current.waypoints.filter((_, i) => i !== index) }), `remove waypoint ${index + 1}`)}>Remove</button>}</td></tr>)}</tbody></table>
      <button disabled={locked || waypoints.length >= 7} onClick={() => insertAfter(waypoints.length - 2)}>+ Add waypoint</button>
    </div>
    {notice && <p className="quality-note" role="status">{notice}</p>}
    <p className="design-footnote">Save a target to reuse it. Generation uses the full playable library, distinct recordings and minimum total raw-RTP distance.
      It does not evaluate musical transitions or perceptual confidence.</p>
  </section>;
}
