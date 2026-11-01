import { useEffect, useRef, useState } from 'react';
import { readJSON } from './api';
import { moodColors, type AtlasData, type Recording, type RTP, type SceneData } from './types';

/** `focus` is a historical half-point coordinate; the slice opens at its Pitch with its cell chosen. */
export function AtlasSlice({ scope, focus, records = [], onSelect }: {
  scope: SceneData['scope']; focus?: { rtp: RTP; title: string } | null; records?: Recording[]; onSelect?: (id: string) => void;
}) {
  const tick = (value: number) => Math.round(value * 2);
  const [pitch, setPitch] = useState(focus ? tick(focus.rtp.P) : 6), [data, setData] = useState<AtlasData | null>(null);
  const [chosen, setChosen] = useState(40), [error, setError] = useState('');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setData(null);
    readJSON<AtlasData>(`mood-atlas?pitch_tick=${pitch}`, { signal: controller.signal }).then(value => {
      if (value.reference !== true || value.cells.length !== 81 || value.scope.mood_bundle_sha256 !== scope.mood_bundle_sha256) throw new Error('The historical slice is unavailable.');
      if (!controller.signal.aborted) setData(value);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [pitch, scope.mood_bundle_sha256]);
  const cells = data ? [...data.cells].sort((a, b) => b.ticks[1] - a.ticks[1] || a.ticks[0] - b.ticks[0]) : [];
  const focusIndex = focus && pitch === tick(focus.rtp.P) ? cells.findIndex(c => c.ticks[0] === tick(focus.rtp.R) && c.ticks[1] === tick(focus.rtp.T)) : -1;
  useEffect(() => { if (data && focusIndex >= 0) setChosen(focusIndex); }, [data, focusIndex]);
  // Recordings are counted by their historical half-point position, the same lookup that assigns their mood.
  const at = (ticks: [number, number, number]) => records.filter(r => tick(r.historical_rtp.R) === ticks[0] && tick(r.historical_rtp.T) === ticks[1] && tick(r.historical_rtp.P) === ticks[2]);
  const cell = cells[chosen], here = cell ? at(cell.ticks) : [];
  return <section className="atlas-view" aria-label="Historical mood atlas">
    <div className="atlas-heading"><div><h2>Historical mood atlas</h2><p>Discrete lookup cells · not recordings{focus ? ` · outlined: ${focus.title}` : ''}</p></div>
      <label>Pitch slice <select aria-label="Atlas pitch slice" value={pitch} onChange={e => setPitch(Number(e.target.value))}>
        {Array.from({ length: 9 }, (_, i) => i + 2).map(tick => <option key={tick} value={tick}>P = {tick / 2}</option>)}
      </select></label></div>
    {error && <p role="alert">{error}</p>}{!data && !error && <p role="status">Loading the exact historical slice…</p>}
    {data && <><div className="atlas-grid" role="grid" aria-label="Rhythm increases left to right; Texture increases bottom to top">
      {Array.from({ length: 9 }, (_, row) => <div role="row" key={row}>{cells.slice(row * 9, row * 9 + 9).map((c, column) => {
        const index = row * 9 + column, count = at(c.ticks).length; return <button key={c.ticks.join(',')} role="gridcell" aria-selected={chosen === index}
          ref={element => { refs.current[index] = element; }} tabIndex={chosen === index ? 0 : -1} className={index === focusIndex ? 'atlas-focus' : undefined}
          style={{ background: `${moodColors[c.mood_id] ?? '#889999'}35`, borderColor: moodColors[c.mood_id] ?? '#889999' }}
          aria-label={`R ${c.ticks[0] / 2}, T ${c.ticks[1] / 2}, P ${pitch / 2}: ${c.label}; intensity ${c.intensity ?? 'unavailable'}; ${count} recording${count === 1 ? '' : 's'}${index === focusIndex ? '; selected recording' : ''}`}
          onClick={() => setChosen(index)} onKeyDown={e => {
            const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 }[e.key];
            if (step !== undefined) { e.preventDefault(); const next = Math.max(0, Math.min(80, index + step)); setChosen(next); refs.current[next]?.focus(); }
          }}><span>{c.ticks[0] / 2}</span><small>{c.ticks[1] / 2}</small>{count > 0 && <b className="atlas-count" aria-hidden="true">{count}</b>}</button>;
      })}</div>)}
    </div><p className="atlas-axis">Rhythm R → <span>Texture T ↑</span></p>
    {cell && <div className="atlas-reading" role="status"><p><strong>{cell.label}</strong> · R {cell.ticks[0] / 2} / T {cell.ticks[1] / 2} / P {pitch / 2}
      <br/>Geometric intensity {cell.intensity == null ? 'unavailable' : `${cell.intensity.toFixed(2)} / 10`}</p>
      <p className="fine-print">{here.length ? `${here.length} recording${here.length === 1 ? '' : 's'} at this historical position:` : 'No recordings at this historical position.'}</p>
      {here.length > 0 && <ul className="atlas-recordings">{here.map(r => <li key={r.recording_id}>{onSelect ? <button onClick={() => onSelect(r.recording_id)}>{r.title}</button> : r.title}</li>)}</ul>}</div>}
    <p className="fine-print">Exact half-point assignments from the selected historical map. Cells do not classify the space between them. Counts use each recording’s historical (rounded) position.</p></>}
  </section>;
}
