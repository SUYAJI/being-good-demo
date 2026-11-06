import { colorOf, timeLabel, type Recording, type RTP } from './types';
import type { PlaybackPosition } from './playlists';

export type Neighbor = { recording_id: string; geometric_rtp_distance: number };
/** Neighbors stay anchored to the recording they were measured from until another anchor is chosen. */
export type Neighborhood = { anchor: string; neighbors: Neighbor[] };
export type ListenAction = 'listen' | 'pause' | 'resume';

/** The primary key says what clicking does to the real player: only the loaded recording can be paused or resumed. */
export function listenAction(record: Recording, playback: PlaybackPosition | null): ListenAction {
  if (playback?.recording_id !== record.recording_id) return 'listen';
  return playback.playing ? 'pause' : playback.finished ? 'listen' : 'resume';
}

const axes = [['R', 'Rhythm'], ['T', 'Texture'], ['P', 'Pitch']] as const;
/** Gauge track: raw 1–5 over 76 px, drawn to 5.2 at most; values outside the frame are named beside the meter. */
const gaugeY = (value: number) => 80 - (Math.max(1, Math.min(5.2, value)) - 1) / 4 * 76;

function RawMeter({ raw, historical }: { raw: RTP; historical: RTP }) {
  return <section className="raw-meter" aria-label="Raw RTP position">
    <div className="readout-head"><span className="label-caps">POSITION</span><span className="mono">1–5</span></div>
    <div className="gauges">{axes.map(([axis, name]) => <div key={axis} className={`gauge axis-${axis}`} data-axis={axis}
      aria-label={`${name} raw ${raw[axis].toFixed(2)}, historical half-point ${historical[axis].toFixed(1)}`} role="img">
      <svg width="20" height="84" viewBox="0 0 20 84" aria-hidden="true">
        <rect className="gauge-track" x="4" y="4" width="10" height="76"/>
        <rect className="gauge-fill" x="4" y={gaugeY(raw[axis])} width="10" height={80 - gaugeY(raw[axis])}/>
        <path d="M4 23 h10 M4 42 h10 M4 61 h10" stroke="#FFFFFF" strokeWidth="1.5"/>
        <path d={`M1 ${gaugeY(historical[axis])} h16`} stroke="#141619" strokeWidth="2"/><path d={`M17 ${gaugeY(historical[axis])} l3 -3 v6 z`} fill="#141619"/>
      </svg>
      <div className="gauge-copy"><span className="gauge-name">{axis} · {name.toUpperCase()}</span><strong className="gauge-raw">{raw[axis].toFixed(2)}</strong>
        <span className="gauge-hist">mood cell {historical[axis].toFixed(1)}</span></div>
    </div>)}</div>
    <div className="readout-foot mono"><span>bar = measured · ▸ = mood cell</span></div>
  </section>;
}

/** Ten circles across 0–10; the last fills only to the fractional part, and the number is always shown. */
export function IntensityCircles({ value }: { value: number | null }) {
  if (value == null) return <span className="intensity-value mono">Unavailable</span>;
  return <span className="intensity-scale" role="img" aria-label={`Geometric intensity ${value.toFixed(1)} on a continuous 0 to 10 scale`}>
    <span className="intensity-circles" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => {
      const fill = Math.max(0, Math.min(1, value - index)), percent = Math.round(fill * 100);
      return <i key={index} data-fill={fill} style={{ background: fill >= 1 ? 'var(--signal)' : fill <= 0 ? 'var(--line)' : `linear-gradient(90deg, var(--signal) ${percent}%, var(--line) ${percent}%)` }}/>;
    })}</span><span className="intensity-value mono" aria-hidden="true">{value.toFixed(1)} <span>/ 10</span></span></span>;
}

function Distribution({ records, total }: { records: Recording[]; total: number }) {
  const x = (value: number) => (Math.max(.6, Math.min(5.6, value)) - .6) / 5 * 300;
  return <section className="distribution" aria-label="Raw distribution of recordings in view">
    <div className="readout-head"><span className="label-caps">IN VIEW</span><span className="mono">{records.length} / {total}</span></div>
    <div className="distribution-body">{axes.map(([axis, name]) => <div key={axis} className={`distribution-row axis-${axis}`}>
      <span className="mono axis-letter">{axis}</span>
      <svg viewBox="0 0 300 26" width="100%" height="26" preserveAspectRatio="none" role="img" aria-label={`Distribution of raw ${name} for recordings in view`}>
        <line x1="0" y1="22" x2="300" y2="22" stroke="#C9C4B8"/>
        {records.map(record => <line key={record.recording_id} className="distribution-tick" x1={x(record.raw_rtp[axis])} x2={x(record.raw_rtp[axis])} y1="3" y2="20"/>)}</svg></div>)}
      <div className="distribution-scale mono" aria-hidden="true"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div></div>
  </section>;
}

export function RecordingCard({ record, index, total, inView, onListen, onPause, onResume, playback, records, onSelect, outside, onAdd, neighborhood, previousAnchor, onNeighbors, onBack, onHide, onAtlas }: {
  record: Recording | undefined; index: number; total: number; inView: Recording[];
  onListen: (record: Recording) => void; onPause: () => void; onResume: () => void; playback: PlaybackPosition | null;
  records: Recording[]; onSelect: (id: string) => void;
  outside: boolean; onAdd: (record: Recording) => void; neighborhood: Neighborhood | null; previousAnchor: string | null;
  onNeighbors: (id: string) => void; onBack: () => void; onHide: () => void; onAtlas: (record: Recording) => void;
}) {
  if (!record) return <aside className="recording-card invitation" aria-label="Recording details">
    <div><span className="panel-title">PICK A RECORDING</span><p>Click a dot in the field or a title in the collection. Listen plays it, and nearby music is one step away.</p></div>
    {inView.length > 0 && <Distribution records={inView} total={total}/>}
    <div className="reading-notes"><span className="label-caps">READING THE FIELD</span><span>Where a dot sits is its Rhythm, Texture and Pitch.</span>
      <span>Its colour is the mood read from that position.</span><span>Dots that sit close share measured qualities, which is a good reason to try them together.</span></div>
  </aside>;
  const raw = record.raw_rtp, byId = new Map(records.map(r => [r.recording_id, r]));
  const title = (id: string) => byId.get(id)?.title ?? 'Unavailable recording';
  const outsideFrame = Object.values(raw).some(value => value < 1 || value > 5);
  const anchored = neighborhood?.anchor === record.recording_id;
  const action = listenAction(record, playback), loaded = playback?.recording_id === record.recording_id;
  const status = loaded ? playback!.playing ? '· ▶ PLAYING' : playback!.finished ? '· FINISHED' : '· Ⅱ PAUSED' : '';
  const unavailable = record.playback_status === 'unavailable' && action === 'listen';
  return <aside className="recording-card" aria-label="Recording details">
    <div className="inspector-head">
      <span className="label-caps muted">SELECTED · {String(index + 1).padStart(2, '0')}/{total} {status && <span className="now-status">{status}</span>}</span>
      <h2>{record.title}</h2>
      <div className="card-mood"><i style={{ background: colorOf(record) }}/><span>{record.mood.label}</span><span className="dot-sep" aria-hidden="true">·</span><span className="mono">{timeLabel(record.duration_seconds)}</span></div>
      {record.credit && <p className="card-credit">{record.credit.artist} · {record.credit.source_url ? <a href={record.credit.source_url} target="_blank" rel="noreferrer">{record.credit.source} ↗</a> : record.credit.source}
        {record.credit.genre && <span className="mono muted"> · {record.credit.genre}</span>}</p>}
    </div>
    {outside && <p className="fine-print">Selected recording is outside the current view.</p>}
    <div className="inspector-actions">
      <button className={`listen-button key key-dark is-${action}`} data-action={action} disabled={unavailable}
        aria-label={action === 'pause' ? `Pause ${record.title}` : action === 'resume' ? `Resume ${record.title}` : `Listen to ${record.title}`}
        onClick={() => action === 'pause' ? onPause() : action === 'resume' ? onResume() : onListen(record)}>
        {action === 'pause' ? <svg width="12" height="14" viewBox="0 0 14 16" aria-hidden="true"><rect x="1" y="1" width="4" height="14"/><rect x="9" y="1" width="4" height="14"/></svg> :
          <span className="listen-led" aria-hidden="true"/>}{action === 'pause' ? 'PAUSE' : action === 'resume' ? 'RESUME' : 'LISTEN'}</button>
      <button className="card-add-playlist key" onClick={() => onAdd(record)} aria-label="+ Add to playlist">+ PLAYLIST</button>
    </div>
    {record.playback_status === 'unavailable' && <p className="fine-print">The original recording is currently unavailable.</p>}
    <RawMeter raw={raw} historical={record.historical_rtp}/>
    {outsideFrame && <p className="fine-print">This recording sits outside the 1–5 frame; the meter stops at its edge and the exact value is shown.</p>}
    <section className="mood-intensity" aria-label="Historical mood and intensity">
      <span className="label-caps">MOOD</span><span className="label-caps intensity-label">INTENSITY</span>
      <span className="historical"><span className="historical-mood"><i style={{ background: colorOf(record) }}/>{record.mood.label}</span>
        <span className="mono muted">cell {record.historical_rtp.R.toFixed(1)} / {record.historical_rtp.T.toFixed(1)} / {record.historical_rtp.P.toFixed(1)}</span></span>
      <IntensityCircles value={record.mood.intensity}/>
    </section>
    <section className="neighbors-block" aria-label="Nearest recordings">
      <div className="neighbors-head"><span className="label-caps">NEARBY MUSIC</span>
        <button className="key key-small" onClick={() => onAtlas(record)} aria-label={`Show in the mood atlas at Pitch ${record.historical_rtp.P.toFixed(1)}`} title="See this position in the mood atlas">ATLAS →</button></div>
      {!anchored && <button className="nearby-button key" aria-pressed={false} onClick={() => onNeighbors(record.recording_id)}>Explore nearby music</button>}
      {neighborhood && <section className="neighbor-panel" aria-label="Geometric neighbors">
        <p className="neighbor-anchor">Nearest to <strong>{title(neighborhood.anchor)}</strong> <span className="mono muted">· marked in the field</span></p>
        <div className="neighbor-actions">{previousAnchor && <button className="key key-small" onClick={onBack}>← Back to {title(previousAnchor)}</button>}
          {!anchored && <button className="key key-small" onClick={() => onNeighbors(record.recording_id)}>Nearby {record.title}</button>}
          {!anchored && <button className="key key-small" onClick={() => onSelect(neighborhood.anchor)}>Select {title(neighborhood.anchor)}</button>}
          <button className="key key-small" onClick={onHide}>Hide</button></div>
        {neighborhood.neighbors.length === 0 && <p>No other recordings in this collection.</p>}
        <ol>{neighborhood.neighbors.map(n => { const other = byId.get(n.recording_id);
          return <li key={n.recording_id}><button aria-current={n.recording_id === record.recording_id ? 'true' : undefined} onClick={() => onSelect(n.recording_id)}>
            <i aria-hidden="true" style={{ background: other ? colorOf(other) : '#C9C4B8' }}/><span>{title(n.recording_id)}</span><strong className="mono">{n.geometric_rtp_distance.toFixed(3)}</strong></button></li>; })}</ol>
        <p className="fine-print">Numbers are the distance in Rhythm, Texture and Pitch, whatever filters are on. Close means similar measurements, not a promise that they sound alike.</p>
      </section>}
    </section>
    <details><summary>About this position</summary><p>The measured position comes from the original fitted Rhythm, Texture and Pitch model. The mood is read from the historical half-point lookup cell. Intensity describes where the recording sits inside that mood region.</p>
      <p>Exact R / T / P:<br/>{raw.R} / {raw.T} / {raw.P}</p><p>Proximity and intensity describe geometry, not how similar two recordings sound or how confident the model is.</p>
    </details>
  </aside>;
}
