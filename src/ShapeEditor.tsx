import { useLayoutEffect, useRef, useState } from 'react';
import type { RTP } from './types';
import { axes, rtpSeries } from './trajectoryDesign';

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

export const waypointLabel = (index: number, count: number) => index === 0 ? 'Start' : index === count - 1 ? 'End' : `Waypoint ${index + 1}`;

/** The hand-drawn shape: drag handles on three curves or type values. Waypoints are evenly spaced by playlist order. */
export function ShapeEditor({ waypoints, disabled = false, moods, onChange }: {
  waypoints: RTP[]; disabled?: boolean; moods?: (string | null)[]; onChange: (waypoints: RTP[], label: string, coalesce?: string) => void;
}) {
  const [dragAxis, setDragAxis] = useState<'all' | keyof RTP>('all'), [focused, setFocused] = useState<number | null>(null);
  const [width, setWidth] = useState(560), host = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ point: number; axis: keyof RTP } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (element.clientWidth) setWidth(element.clientWidth); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const series = (key: keyof RTP) => rtpSeries.find(s => s.axis === key)!.name;
  const update = (point: number, axis: keyof RTP, value: number) =>
    onChange(waypoints.map((item, index) => index === point ? { ...item, [axis]: value } : item), `${series(axis)} at ${waypointLabel(point, waypoints.length).toLowerCase()}`, `waypoint-${point}-${axis}`);
  const insertAfter = (index: number) => {
    const before = waypoints[index], after = waypoints[index + 1];
    const point = Object.fromEntries(axes.map(axis => [axis, Math.round((before[axis] + after[axis]) * 5) / 10])) as RTP;
    onChange([...waypoints.slice(0, index + 1), point, ...waypoints.slice(index + 1)], 'add a waypoint');
  };
  const x = (index: number) => 52 + index * (width - 80) / (waypoints.length - 1);
  const y = (value: number) => 26 + (5 - value) * 40;
  const ordered = dragAxis === 'all' ? rtpSeries : [...rtpSeries.filter(s => s.axis !== dragAxis), rtpSeries.find(s => s.axis === dragAxis)!];
  return <div className="shape-editor">
    <div className="drag-axis" role="group" aria-label="Handles to drag"><span>Drag</span>{([{ axis: 'all', name: 'All' }, ...rtpSeries] as const).map(s =>
      <button key={s.axis} type="button" aria-pressed={dragAxis === s.axis} onClick={() => setDragAxis(s.axis)}>{s.name}</button>)}
      <span className="fine-print">Pick one quality when the handles overlap.</span></div>
    <div className="trajectory-legend design-legend" role="group" aria-label="Graph key">{rtpSeries.map(s => <span key={s.axis}><svg width="26" height="8" aria-hidden="true">
      <line x1="0" x2="26" y1="4" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dash}/></svg>{s.name}</span>)}</div>
    <div className="design-graph" ref={host}><svg width="100%" height="220" viewBox={`0 0 ${width} 220`} role="img" aria-label="Desired Rhythm, Texture and Pitch curves, from 1 to 5">
      {[1, 2, 3, 4, 5].map(tick => <g key={tick}><line x1={44} x2={width - 24} y1={y(tick)} y2={y(tick)}/><text x={30} y={y(tick) + 4}>{tick}</text></g>)}
      {focused != null && focused < waypoints.length && <rect className="waypoint-focus" x={x(focused) - 16} y={16} width={32} height={180}/>}
      {ordered.map(series => { const active = dragAxis === 'all' || dragAxis === series.axis; return <g key={series.axis} opacity={active ? 1 : .35}>
        <path data-design-series={series.axis} d={waypoints.map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(point[series.axis])}`).join(' ')}
          fill="none" stroke={series.color} strokeWidth={2.5} strokeDasharray={series.dash}/>
        {waypoints.map((point, index) => <circle key={index} cx={x(index)} cy={y(point[series.axis])} r={9} fill={series.color} stroke="white" strokeWidth={2}
          aria-hidden="true" data-waypoint={index} data-target-axis={series.axis} className="target-handle" pointerEvents={active ? undefined : 'none'}
          onPointerDown={event => { if (disabled) return; setFocused(index); dragging.current = { point: index, axis: series.axis }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!dragging.current || disabled) return;
            const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
            const value = Math.max(1, Math.min(5, Math.round((5 - ((event.clientY - bounds.top) * 220 / bounds.height - 26) / 40) * 10) / 10));
            update(dragging.current.point, dragging.current.axis, value);
          }} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}/>)}</g>; })}
      {waypoints.map((_, index) => <text key={index} x={x(index)} y={211} textAnchor="middle">{index === 0 ? 'Start' : index === waypoints.length - 1 ? 'End' : index + 1}</text>)}
    </svg></div>
    <table className="waypoint-table"><caption className="sr-only">Waypoint values</caption>
      <thead><tr><th scope="col">Waypoint</th>{rtpSeries.map(s => <th scope="col" key={s.axis} style={{ color: s.color }}>{s.name}</th>)}{moods && <th scope="col">Mood</th>}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{waypoints.map((point, index) => <tr key={index} className={focused === index ? 'is-focused' : undefined}><th scope="row">{waypointLabel(index, waypoints.length)}</th>
        {rtpSeries.map(s => <td key={s.axis}><WaypointInput label={`${waypointLabel(index, waypoints.length)} ${s.name}`} value={point[s.axis]} disabled={disabled}
          onFocus={() => setFocused(index)} onCommit={value => update(index, s.axis, value)}/></td>)}
        {moods && <td className="waypoint-mood">{moods[index] ?? '—'}</td>}
        <td className="waypoint-actions">{index < waypoints.length - 1 && <button type="button" disabled={disabled || waypoints.length >= 7} aria-label={`Insert waypoint after ${waypointLabel(index, waypoints.length)}`} onClick={() => insertAfter(index)}>+ Insert after</button>}
          {index > 0 && index < waypoints.length - 1 && <button type="button" disabled={disabled} aria-label={`Remove waypoint ${index + 1}`}
            onClick={() => onChange(waypoints.filter((_, i) => i !== index), `remove waypoint ${index + 1}`)}>Remove</button>}</td></tr>)}</tbody></table>
  </div>;
}
