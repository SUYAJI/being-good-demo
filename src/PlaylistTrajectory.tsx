import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Recording, RTP } from './types';
import { predictorWarnings, trajectory, type PlaybackPosition, type PlaylistEntry } from './playlists';
import { rtpDistance, rtpSeries } from './trajectoryDesign';

const series = rtpSeries;

export function PlaylistTrajectory({ entries, records, selected, onSelect, playback, targets }: {
  entries: PlaylistEntry[]; records: Map<string, Recording>; selected: string | null; onSelect: (entry: PlaylistEntry) => void;
  playback?: PlaybackPosition | null;
  targets?: RTP[];
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(520);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth) setAvailableWidth(Math.floor(element.clientWidth));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [entries.length > 0]);
  const chart = useMemo(() => trajectory(entries, records, availableWidth), [entries, records, availableWidth]);
  const [hover, setHover] = useState<string | null>(null);
  const [compareAxis, setCompareAxis] = useState<'all' | keyof RTP>('R');
  const visibleSeries = series.filter(s => !targets || compareAxis === 'all' || compareAxis === s.axis);
  const selectedIndex = entries.findIndex(entry => entry.entry_id === selected);
  const playingIndex = entries.findIndex(entry => entry.entry_id === playback?.entry_id && entry.recording_id === playback.recording_id);
  const detailIndex = Math.max(0, entries.findIndex(entry => entry.entry_id === (hover ?? selected)));
  const detail = entries[detailIndex], record = detail && chart.items[detailIndex];
  const groups = useRef<(SVGGElement | null)[]>([]);
  const ticks = [...(chart.min < 1 ? [chart.min] : []), 1, 2, 3, 4, 5, ...(chart.max > 5 ? [chart.max] : [])];
  return <section className="trajectory" aria-label="Playlist perceptual trajectory">
    <div className="trajectory-heading"><span className="eyebrow">YOUR PLAYLIST’S PATH</span>
      <div className="trajectory-legend">{series.map(s => <span key={s.axis}><svg width="26" height="8" aria-hidden="true"><line x1="0" x2="26" y1="4" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dash}/></svg>{s.name}</span>)}</div></div>
    {targets && <div className="comparison-controls" aria-label="Comparison series"><span>Show</span>{([{ axis: 'all', name: 'All three' }, ...series] as const).map(s =>
      <button key={s.axis} aria-pressed={compareAxis === s.axis} onClick={() => setCompareAxis(s.axis)}>{s.name}</button>)}<p>○ dashed: the shape you asked for · ● solid: the recordings</p></div>}
    {entries.length === 0 ? <div className="trajectory-empty">Add a few recordings and their path through Rhythm, Texture and Pitch appears here.</div> : <>
      <div ref={viewport} className="trajectory-scroll" tabIndex={0} aria-label="Ordered trajectory chart; scroll horizontally for longer playlists">
        <svg width={chart.width} height={350} role="group" aria-label="Whole-recording continuous RTP by playlist position">
          <title>Whole-recording predictions. Connecting lines guide the sequence; they do not measure changes inside songs.</title>
          {chart.compressed && <>
            {chart.max > 5 && <rect x={58} y={chart.top} width={chart.width - 82} height={chart.y(5) - chart.top} fill="#f1ece3"/>}
            {chart.min < 1 && <rect x={58} y={chart.y(1)} width={chart.width - 82} height={chart.top + chart.height - chart.y(1)} fill="#f1ece3"/>}
          </>}
          {ticks.map(tick => <g key={tick} className="trajectory-grid"><line x1={58} x2={chart.width - 24} y1={chart.y(tick)} y2={chart.y(tick)}/>
            <text x={48} y={chart.y(tick) + 4} textAnchor="end">{Number.isInteger(tick) ? tick : tick.toPrecision(3)}</text></g>)}
          {chart.compressed && <text className="compressed-label" x={chart.width - 28} y={chart.max > 5 ? 48 : chart.y(1) + 25} textAnchor="end">compressed · raw values</text>}
          {selectedIndex >= 0 && <rect className="trajectory-selection" x={chart.x(selectedIndex) - 20} y={12} width={40} height={310}/>}
          {playingIndex >= 0 && <g className="trajectory-playback" data-playing-entry={playback?.entry_id}>
            <line x1={chart.x(playingIndex)} x2={chart.x(playingIndex)} y1={12} y2={322}/>
            <text x={chart.x(playingIndex)} y={15} textAnchor="middle">{playback?.playing ? '▶' : 'Ⅱ'}</text>
          </g>}
          {targets && visibleSeries.map(s => <g key={s.axis} className="desired-series"><path data-target-series={s.axis}
            d={targets.map((target, index) => `${index ? 'L' : 'M'}${chart.x(index)},${chart.y(target[s.axis])}`).join(' ')}
            fill="none" stroke={s.color} strokeWidth={1.5} strokeDasharray="9 6" opacity={.65}/>
            {targets.map((target, index) => <circle key={index} data-target-value={target[s.axis]} data-target-axis={s.axis}
              cx={chart.x(index)} cy={chart.y(target[s.axis])} r={5} fill="white" stroke={s.color} strokeWidth={1.5}>
              <title>Desired {s.name} {target[s.axis]} at position {index + 1}</title></circle>)}</g>)}
          {chart.paths.filter(path => visibleSeries.some(s => s.axis === path.axis)).map(path => {
            const s = series.find(s => s.axis === path.axis)!;
            return <path key={path.axis} data-series={path.axis} d={path.d} fill="none" stroke={s.color} strokeWidth={2.5} strokeDasharray={s.dash}/>;
          })}
          {entries.map((entry, index) => {
            const value = chart.items[index];
            return <g key={entry.entry_id} ref={element => { groups.current[index] = element; }} role="button"
              tabIndex={index === Math.max(0, selectedIndex) ? 0 : -1} aria-pressed={selected === entry.entry_id}
              aria-label={`${index + 1}. ${value?.title ?? entry.title}${value ? `, R ${value.raw_rtp.R}, T ${value.raw_rtp.T}, P ${value.raw_rtp.P}` : ', unavailable in catalog'}`}
              data-entry-id={entry.entry_id} onMouseEnter={() => setHover(entry.entry_id)} onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(entry.entry_id)} onBlur={() => setHover(null)} onClick={() => onSelect(entry)}
              onKeyDown={event => {
                let next = index;
                if (event.key === 'ArrowRight') next = Math.min(entries.length - 1, index + 1);
                else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = entries.length - 1;
                else if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault(); onSelect(entries[next]); groups.current[next]?.focus();
                groups.current[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
              }}>
              <rect className="trajectory-hit" x={chart.x(index) - 20} y={10} width={40} height={314} fill="transparent"/>
              {value ? visibleSeries.map(s => <circle key={s.axis} data-axis={s.axis} data-value={value.raw_rtp[s.axis]}
                cx={chart.x(index)} cy={chart.y(value.raw_rtp[s.axis])} r={selected === entry.entry_id ? 7 : 5}
                fill={s.color} stroke="white" strokeWidth={1.5}/>) : <text x={chart.x(index)} y={170} textAnchor="middle">?</text>}
              {(entries.length <= 20 || index % 5 === 0 || index === selectedIndex || index === entries.length - 1) &&
                <text x={chart.x(index)} y={337} textAnchor="middle">{index + 1}</text>}
              <title>{value ? `${value.title}\nR ${value.raw_rtp.R} / T ${value.raw_rtp.T} / P ${value.raw_rtp.P}\n${predictorWarnings(value)}` : `${entry.title}: unavailable; no substitute prediction`}</title>
            </g>;
          })}
        </svg>
      </div>
      <div className="trajectory-detail" aria-live="polite"><strong>{detailIndex + 1}. {record?.title ?? detail?.title}</strong>
        {record ? <><span>R {record.raw_rtp.R.toFixed(2)} · T {record.raw_rtp.T.toFixed(2)} · P {record.raw_rtp.P.toFixed(2)}</span>
          {targets?.[detailIndex] && <span className="target-detail">Your shape here: R {targets[detailIndex].R.toFixed(1)} · T {targets[detailIndex].T.toFixed(1)} · P {targets[detailIndex].P.toFixed(1)}
            {' · '}{rtpDistance(record.raw_rtp, targets[detailIndex]).toFixed(2)} off</span>}
          {predictorWarnings(record) && <span className="quality-note">Input-range warning · {predictorWarnings(record)}</span>}</> : <span>Missing from this catalog · gap kept in the path</span>}</div>
    </>}
    <p className="trajectory-caption">Left to right: playlist order · Up and down: Rhythm, Texture and Pitch from 1 to 5. Shaded column: selected · dashed line: {playback?.playing ? 'playing' : 'playback position'}.
      {chart.compressed && ' Shaded outer bands use a compressed scale; the 1–5 frame is emphasized and values are unchanged.'}
      {' '}Each point is a whole recording; the lines only join them in order.</p>
  </section>;
}
