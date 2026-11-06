import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { colorOf, type Recording } from './types';
import { screenHits } from './geometry';
import { OverlapPicker, pickerPosition } from './OverlapPicker';
import { calloutSize, placeCallout } from './callout';

export type Projection = 'RT' | 'RP' | 'TP';
type Axis = 'R' | 'T' | 'P';
/** Inclusive raw-RTP bounds for the two plotted axes, rounded outward to two decimals. */
export type Region = Partial<Record<Axis, [number, number]>>;
const names: Record<Axis, string> = { R: 'Rhythm', T: 'Texture', P: 'Pitch' };
const axisIndex: Record<Axis, number> = { R: 0, T: 1, P: 2 };
const noPath: string[] = [];

export function boundText([low, high]: [string, string]) {
  return low && high ? `${low}–${high}` : low ? `≥ ${low}` : high ? `≤ ${high}` : '';
}

export function ProjectionView({ records, visibleIds, selected, axes, onSelect, playing = null, paused = false, showExcluded = false, path = noPath, bounds, onFilterRegion, onAddRegion, frame = 'full', highlighted = noPath, targetPath }: {
  records: Recording[]; visibleIds: string[]; selected: string | null; axes: Projection; onSelect: (id: string) => void;
  playing?: string | null; paused?: boolean; showExcluded?: boolean; path?: string[]; bounds?: [string, string][];
  onFilterRegion?: (region: Region) => void; onAddRegion?: (ids: string[]) => void;
  /** `music` frames the recordings that exist, with the 1–5 frame drawn where it falls; `full` shows the whole 1–5 scale. */
  frame?: 'music' | 'full'; highlighted?: string[];
  /** A shape being designed: drawn as a dashed route with hollow waypoints, in the same coordinates as the recordings. */
  targetPath?: { R: number; T: number; P: number }[];
}) {
  const buttons = useRef<(SVGGElement | null)[]>([]);
  const host = useRef<HTMLDivElement>(null), regionPanel = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 600, height: 600 });
  const [brush, setBrush] = useState<{ x0: number; y0: number; x1: number; y1: number; done: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth && element.clientHeight) setSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setOverlap(null); setBrush(null); }, [visibleIds, axes]);
  useEffect(() => { if (brush?.done) regionPanel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [brush?.done]);
  const [xAxis, yAxis] = axes.split('') as Axis[];
  const hidden = (['R', 'T', 'P'] as const).find(axis => axis !== xAxis && axis !== yAxis)!;
  // Extents use the complete snapshot, so filtering never moves displayed points.
  const extent = (axis: Axis) => {
    const values = records.map(r => r.raw_rtp[axis]);
    if (frame === 'music' && values.length) { const lo = Math.min(...values), hi = Math.max(...values), pad = Math.max(.25, (hi - lo) * .12); return [lo - pad, hi + pad]; }
    return [Math.min(1, ...values), Math.max(5, ...values)];
  };
  const [xmin, xmax] = extent(xAxis), [ymin, ymax] = extent(yAxis);
  const unit = Math.min(Math.max(1, size.width - 100) / (xmax - xmin), Math.max(1, size.height - 110) / (ymax - ymin));
  const center = { x: (size.width + 26) / 2, y: (size.height - 40) / 2 };
  const project = (r: Recording) => ({ id: r.recording_id, x: center.x + (r.raw_rtp[xAxis] - (xmin + xmax) / 2) * unit,
    y: center.y - (r.raw_rtp[yAxis] - (ymin + ymax) / 2) * unit, visible: true });
  const valueAt = (x: number, y: number) => ({ x: (x - center.x) / unit + (xmin + xmax) / 2, y: (center.y - y) / unit + (ymin + ymax) / 2 });
  const included = useMemo(() => new Set(visibleIds), [visibleIds]);
  const shown = records.filter(r => included.has(r.recording_id));
  const svgPoint = (event: React.PointerEvent | React.MouseEvent) => {
    const svg = (event.currentTarget as Element).closest('svg')!; const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const matrix = svg.getScreenCTM()!; return { point: point.matrixTransform(matrix.inverse()), scale: Math.abs(matrix.a) };
  };
  const closeChooser = (id: string | null = selected) => {
    setOverlap(null); buttons.current[Math.max(0, shown.findIndex(r => r.recording_id === id))]?.focus();
  };
  const choose = (event: React.MouseEvent<SVGGElement>, record: Recording) => {
    const { point: p, scale } = svgPoint(event);
    const hits = screenHits(shown.map(project), p.x, p.y, 14 / scale);
    if (hits.length > 1) setOverlap({ ids: hits.map(hit => hit.id), ...pickerPosition(p.x, p.y, size.width, size.height) });
    else { onSelect(record.recording_id); setOverlap(null); }
  };
  // A drag on empty space draws a region in the two plotted dimensions.
  const region = useMemo(() => {
    if (!brush) return null;
    const a = valueAt(Math.min(brush.x0, brush.x1), Math.max(brush.y0, brush.y1)), b = valueAt(Math.max(brush.x0, brush.x1), Math.min(brush.y0, brush.y1));
    const value: Region = { [xAxis]: [Math.floor(a.x * 100) / 100, Math.ceil(b.x * 100) / 100], [yAxis]: [Math.floor(a.y * 100) / 100, Math.ceil(b.y * 100) / 100] };
    const inside = shown.filter(r => [xAxis, yAxis].every(axis => r.raw_rtp[axis] >= value[axis]![0] && r.raw_rtp[axis] <= value[axis]![1]));
    return { value, inside };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brush, shown.length, xAxis, yAxis, unit]);
  const hovered = shown.find(record => record.recording_id === hover);
  const hoverPosition = hovered && project(hovered);
  const hoverCluster = hoverPosition ? screenHits(shown.map(project), hoverPosition.x, hoverPosition.y).length - 1 : 0;
  const playingRecord = shown.find(record => record.recording_id === playing);
  const byId = useMemo(() => new Map(records.map(r => [r.recording_id, r])), [records]);
  const pathPoints = path.map(id => byId.get(id)).map(r => r && project(r));
  const pathNumbers = new Map<string, { x: number; y: number; text: string[] }>();
  pathPoints.forEach((p, index) => { if (!p) return; const key = `${p.x},${p.y}`;
    pathNumbers.set(key, { x: p.x, y: p.y, text: [...pathNumbers.get(key)?.text ?? [], String(index + 1)] }); });
  const hiddenBound = bounds ? boundText(bounds[axisIndex[hidden]]) : '';
  const brushRect = brush && { x: Math.min(brush.x0, brush.x1), y: Math.min(brush.y0, brush.y1), width: Math.abs(brush.x1 - brush.x0), height: Math.abs(brush.y1 - brush.y0) };
  const half = Array.from({ length: Math.max(0, Math.ceil(Math.max(xmax, ymax) * 2) - Math.floor(Math.min(xmin, ymin) * 2) + 1) }, (_, i) => Math.floor(Math.min(xmin, ymin) * 2) / 2 + i / 2)
    .filter(tick => (tick >= xmin && tick <= xmax) || (tick >= ymin && tick <= ymax));
  const sx = (value: number) => center.x + (value - (xmin + xmax) / 2) * unit, sy = (value: number) => center.y - (value - (ymin + ymax) / 2) * unit;
  const numberOf = (id: string) => String(records.findIndex(r => r.recording_id === id) + 1).padStart(2, '0');
  const selectedRecord = shown.find(record => record.recording_id === selected);
  const pathLabels = [...pathNumbers.values()].map(item => ({ ...item, lx: item.x + 12, ly: item.y + 14 }));
  // The tag avoids other recordings, faint excluded context and path numbers; the point itself never moves.
  const callout = selectedRecord && (() => {
    const p = project(selectedRecord), text = `${numberOf(selectedRecord.recording_id)}  ${selectedRecord.title}`;
    const obstacles = [...shown.filter(r => r.recording_id !== selectedRecord.recording_id).map(project),
      ...(showExcluded ? records.filter(r => !included.has(r.recording_id)).map(project) : []), ...pathLabels.map(item => ({ x: item.lx, y: item.ly }))];
    return { text, place: placeCallout(p, obstacles, size, calloutSize(text)) };
  })();
  return <div className="projection-view" ref={host}>
    <svg viewBox={`0 0 ${size.width} ${size.height}`} aria-label={`Continuous ${xAxis}–${yAxis} projection. Circles are analyzed recordings.`}
      onPointerDown={event => {
        if (!onFilterRegion || event.button !== 0 || (event.target as Element).closest('g[role=button]')) return;
        const { point } = svgPoint(event); (event.currentTarget as SVGSVGElement).setPointerCapture?.(event.pointerId);
        setOverlap(null); setBrush({ x0: point.x, y0: point.y, x1: point.x, y1: point.y, done: false });
      }}
      onPointerMove={event => { if (!brush || brush.done) return; const { point } = svgPoint(event); setBrush({ ...brush, x1: point.x, y1: point.y }); }}
      onPointerUp={() => { if (!brush || brush.done) return; setBrush(Math.hypot(brush.x1 - brush.x0, brush.y1 - brush.y0) < 6 ? null : { ...brush, done: true }); }}>
      <title>Equal-unit continuous RTP projection</title>
      <rect className="projection-frame" x={sx(1)} y={sy(5)} width={sx(5) - sx(1)} height={sy(1) - sy(5)}/>
      {half.map(tick => {
        const x = sx(tick), y = sy(tick), major = Number.isInteger(tick);
        return <g key={tick} className={`projection-grid${major ? ' is-major' : ''}`}><line x1={x} x2={x} y1={35} y2={size.height - 65}/><line y1={y} y2={y} x1={50} x2={size.width - 24}/>
          {major && <>{tick >= xmin && tick <= xmax && <text className="projection-tick" x={x} y={size.height - 46} textAnchor="middle">{tick}</text>}{tick >= ymin && tick <= ymax && <text className="projection-tick" x={36} y={y + 4} textAnchor="end">{tick}</text>}</>}</g>;
      })}
      <text className={`projection-axis axis-${xAxis}`} x={center.x} y={size.height - 16} textAnchor="middle">{xAxis} · {names[xAxis].toUpperCase()} →</text>
      <text className={`projection-axis axis-${yAxis}`} x={50} y={20}>↑ {yAxis} · {names[yAxis].toUpperCase()}</text>
      {size.width >= 520 && <text className="projection-note" x={size.width - 24} y={20} textAnchor="end">{frame === 'music' ? 'Zoomed to the music · shaded area is the full 1–5 range' : 'Full 1–5 scale'}</text>}
      {size.width >= 520 && <text className="projection-hidden-axis" x={size.width - 24} y={38} textAnchor="end">{names[hidden]} not shown here{hiddenBound ? ` · filtered ${hiddenBound}` : ''}</text>}
      {(xmin < 1 || xmax > 5 || ymin < 1 || ymax > 5) && <text className="projection-outlier-note" x={50} y={size.height - 70}>Out-of-frame values retained</text>}
      {showExcluded && records.filter(r => !included.has(r.recording_id)).map(record => { const p = project(record);
        return <circle key={record.recording_id} className="projection-ghost" cx={p.x} cy={p.y} r={3.5} pointerEvents="none"/>; })}
      {pathPoints.length > 1 && <g className="projection-path" pointerEvents="none">{pathPoints.map((p, index) => {
        const next = pathPoints[index + 1]; return p && next && <line key={index} x1={p.x} y1={p.y} x2={next.x} y2={next.y}/>; })}</g>}
      {shown.map((record, index) => { const p = project(record); return <g key={record.recording_id} role="button" tabIndex={0}
        ref={element => { buttons.current[index] = element; }} aria-label={`${record.title}, ${record.mood.label}`}
        aria-pressed={selected === record.recording_id} data-recording-id={record.recording_id}
        data-raw-position={`${record.raw_rtp.R},${record.raw_rtp.T},${record.raw_rtp.P}`}
        onMouseEnter={() => setHover(record.recording_id)} onMouseLeave={() => setHover(null)}
        onClick={event => choose(event, record)} onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(record.recording_id); }
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault(); const next = (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + shown.length) % shown.length;
            buttons.current[next]?.focus(); onSelect(shown[next].recording_id);
          }
        }}>
        <title>{record.title} · {record.mood.label}</title><circle cx={p.x} cy={p.y} r={12} fill="transparent"/>
        <circle className="projection-point" cx={p.x} cy={p.y} r={6} fill={colorOf(record)}/>
        {selected === record.recording_id && <circle className="projection-selected" cx={p.x} cy={p.y} r={11}/>}
        {highlighted.includes(record.recording_id) && selected !== record.recording_id && <circle className="projection-neighbor" cx={p.x} cy={p.y} r={10}/>}
        {hover === record.recording_id && selected !== record.recording_id && <circle className="projection-hover" cx={p.x} cy={p.y} r={10}/>}
      </g>; })}
      {playingRecord && (() => { const p = project(playingRecord); return <g className={`projection-playing${paused ? ' is-paused' : ''}`} data-playing-recording={playingRecord.recording_id} pointerEvents="none">
        <circle cx={p.x} cy={p.y} r={16}/></g>; })()}
      {callout && <g className="callout-leader" pointerEvents="none"><line x1={callout.place.startX} y1={callout.place.startY} x2={callout.place.anchorX} y2={callout.place.anchorY}/>
        <circle cx={callout.place.anchorX} cy={callout.place.anchorY} r={2.5}/></g>}
      {targetPath && targetPath.length > 1 && <g className="projection-target" pointerEvents="none" aria-hidden="true">
        <polyline points={targetPath.map(point => `${sx(point[xAxis])},${sy(point[yAxis])}`).join(' ')}/>
        {targetPath.map((point, index) => <g key={index}><circle cx={sx(point[xAxis])} cy={sy(point[yAxis])} r={8}/>
          <text x={sx(point[xAxis])} y={sy(point[yAxis]) - 13} textAnchor="middle">{index === 0 ? 'START' : index === targetPath.length - 1 ? 'END' : index + 1}</text></g>)}</g>}
      {brushRect && <rect className="projection-brush" {...brushRect} pointerEvents="none"/>}
    </svg>
    {pathLabels.map(({ lx, ly, text }) => <span key={`${lx},${ly}`} className="path-number" aria-hidden="true" style={{ left: lx, top: ly }}>{text.join(' · ')}</span>)}
    {callout && <span className={`field-callout${playing === selected ? ' is-playing' : ''}`} data-callout-for={selected!} style={{ left: callout.place.x, top: callout.place.y }}>
      <i aria-hidden="true"/>{callout.text}</span>}
    {hovered && hoverPosition && <div className="point-readout" role="presentation" style={{ left: Math.min(hoverPosition.x + 16, size.width - 260), top: Math.max(8, hoverPosition.y - 82) }}>
      <strong>{hovered.title}</strong>
      <span className="mono">{xAxis} {hovered.raw_rtp[xAxis].toFixed(2)} · {yAxis} {hovered.raw_rtp[yAxis].toFixed(2)} · {hidden} {hovered.raw_rtp[hidden].toFixed(2)} (not plotted)</span>
      <span><i style={{ background: colorOf(hovered) }}/>{hovered.mood.label}</span>
      {hoverCluster > 0 && <span>+{hoverCluster} more here · click to choose</span>}</div>}
    {overlap && overlap.ids.length > 1 && <OverlapPicker ids={overlap.ids} records={records} at={overlap} onClose={() => closeChooser()}
      onChoose={id => { onSelect(id); closeChooser(id); }}/>}
    {brush?.done && region && brushRect && <div ref={regionPanel} className="region-panel" role="group" aria-label="Selected region"
      style={{ left: Math.max(8, Math.min(brushRect.x + brushRect.width + 10, size.width - 330)), top: Math.max(8, Math.min(brushRect.y, size.height - 250)) }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setBrush(null); } }}>
      <p><strong>{names[xAxis]} {region.value[xAxis]![0].toFixed(2)}–{region.value[xAxis]![1].toFixed(2)} · {names[yAxis]} {region.value[yAxis]![0].toFixed(2)}–{region.value[yAxis]![1].toFixed(2)}</strong></p>
      <p className="fine-print">{region.inside.length} of the {shown.length} recordings in this view fall inside.</p>
      <div className="region-actions"><button className="primary" onClick={() => { onFilterRegion?.(region.value); setBrush(null); }}>Show only this region</button>
        {onAddRegion && <button disabled={!region.inside.length} onClick={() => { onAddRegion(region.inside.map(r => r.recording_id)); setBrush(null); }}>Add {region.inside.length} to playlist</button>}
        <button onClick={() => setBrush(null)}>Cancel</button></div></div>}
  </div>;
}
