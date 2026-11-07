import { useEffect, useMemo, useState } from 'react';
import { colorOf, type Recording, type RTP } from './types';
import { journeyTarget, type TargetSnapshot } from './journeys';
import type { Generation } from './trajectoryDesign';
import { ShapeEditor, waypointLabel } from './ShapeEditor';
import { useMoods } from './moodLookup';
import { moodStarts, planJourney, presetWaypoints, presets, reach, startPoint, type PresetId, type StartChoice } from './journeyDesign';
import { RecordingPicker } from './RecordingPicker';
import { rtpSeries } from './trajectoryDesign';
import type { DesignerReport } from './stage/stageView';

export type Step = 'start' | 'shape' | 'playlist';
export type Suggestion = { start: StartChoice; preset: PresetId; endId: string | null; length: number; name?: string };
export type Created = { result: Generation; target: TargetSnapshot; name: string; locks: string[] };

const lengths = [5, 6, 8, 10, 12];
const steps: { id: Step; name: string }[] = [{ id: 'start', name: 'Start' }, { id: 'shape', name: 'Shape' }, { id: 'playlist', name: 'Playlist' }];

/** The guided path: choose a start, choose how the playlist moves, then listen and refine in the playlist below. */
/** A small drawing of a shape's Rhythm, Texture and Pitch over the playlist, from the same waypoints the generator uses. */
export function ShapeGlyph({ waypoints, width = 64, height = 30 }: { waypoints: RTP[]; width?: number; height?: number }) {
  if (waypoints.length < 2) return null;
  const values = waypoints.flatMap(p => [p.R, p.T, p.P]), low = Math.min(...values) - .15, high = Math.max(...values) + .15;
  const x = (i: number) => 3 + i * (width - 6) / (waypoints.length - 1), y = (v: number) => height - 3 - (v - low) / Math.max(.5, high - low) * (height - 6);
  return <svg className="shape-glyph" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {rtpSeries.map(s => <polyline key={s.axis} points={waypoints.map((p, i) => `${x(i)},${y(p[s.axis])}`).join(' ')} stroke={s.color} strokeDasharray={s.dash}/>)}</svg>;
}

export function PlaylistDesigner({ records, categories, selectedId, suggestion, hasPlaylist, step, onStep, onSelect, onCreate, onExplore, onSuggestionUsed, onStage, onPeek }: {
  records: Recording[]; categories: { id: string; label: string }[]; selectedId: string | null; suggestion: Suggestion | null; hasPlaylist: boolean;
  step: Step; onStep: (step: Step) => void; onSelect: (id: string) => void; onCreate: (created: Created) => void; onExplore: () => void; onSuggestionUsed?: () => void;
  /** What the stage should show for the current choices: the start, the shape, the step. */
  onStage?: (report: DesignerReport) => void; onPeek?: (id: string | null) => void;
}) {
  const [start, setStart] = useState<StartChoice>({ kind: 'any' });
  const [preset, setPreset] = useState<PresetId>('build');
  const [endId, setEndId] = useState<string | null>(null);
  const [length, setLength] = useState(8);
  const [custom, setCustom] = useState<RTP[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const [peekMood, setPeekMood] = useState<string | null>(null);
  const byId = useMemo(() => new Map(records.map(r => [r.recording_id, r])), [records]);
  const moods = useMemo(() => moodStarts(records, categories), [records, categories]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const startRecord = start.kind === 'recording' ? byId.get(start.id) ?? null : null;
  const endRecord = endId ? byId.get(endId) ?? null : null;
  const origin = startPoint(start, records, categories);
  const waypoints = useMemo(() => custom ?? (origin ? presetWaypoints(preset, origin, endRecord?.raw_rtp ?? null) : []), [custom, origin, preset, endRecord]);
  const waypointMoods = useMoods(waypoints);
  const distances = useMemo(() => reach(records, waypoints), [records, waypoints]);
  const stretch = distances.filter(d => d > .6).length;
  // Report by content, not array identity, so the stage follows the choices without re-render loops.
  const reportKey = JSON.stringify({ step, origin, moodId: start.kind === 'mood' ? start.id : null, peekMood: step === 'start' ? peekMood : null,
    startId: start.kind === 'recording' ? start.id : null, endId: preset === 'between' && !custom ? endId : null, waypoints: waypoints.length > 1 ? waypoints : null });
  useEffect(() => { onStage?.(JSON.parse(reportKey)); }, [reportKey, onStage]);
  const startName = start.kind === 'mood' ? moods.find(m => m.id === start.id)?.label ?? 'a mood' : start.kind === 'recording' ? startRecord?.title ?? 'a recording' : 'anywhere';

  // A suggestion from the welcome stage fills the designer in and creates the playlist at once.
  useEffect(() => {
    if (!suggestion || !records.length) return;
    setStart(suggestion.start); setPreset(suggestion.preset); setEndId(suggestion.endId); setLength(suggestion.length); setCustom(null);
    const point = startPoint(suggestion.start, records, categories), end = suggestion.endId ? byId.get(suggestion.endId) : null;
    onSuggestionUsed?.();
    if (!point) return;
    create(presetWaypoints(suggestion.preset, point, end?.raw_rtp ?? null), suggestion.length, suggestion.start.kind === 'recording' ? suggestion.start.id : null,
      suggestion.preset === 'between' ? suggestion.endId : null, suggestion.name ?? describe(suggestion.preset, suggestion.start));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion, records.length]);

  function describe(presetId: PresetId, choice: StartChoice) {
    const name = presets.find(p => p.id === presetId)!.name;
    if (presetId === 'between') return 'Between two recordings';
    if (choice.kind === 'mood') return `${name} from ${moods.find(m => m.id === choice.id)?.label ?? 'a mood'}`;
    if (choice.kind === 'recording') return `${name} from ${byId.get(choice.id)?.title ?? 'a recording'}`.slice(0, 100);
    return name;
  }
  function create(points: RTP[], count: number, firstId: string | null, lastId: string | null, name: string) {
    if (points.length < 2) { setNotice('Choose where the playlist should start first.'); return; }
    const result = planJourney(records, { waypoints: points, length: count, firstId, lastId });
    if (!result.recordings.length) { setNotice(result.notices.join(' ') || 'No recordings could be found for this shape.'); return; }
    setNotice('');
    onCreate({ result, target: { ...journeyTarget(points, count), recipe: null }, name, locks: [firstId, lastId].filter((id): id is string => !!id) });
    onStep('playlist');
  }
  const choose = (update: () => void) => { update(); setCustom(null); };
  const stepIndex = steps.findIndex(s => s.id === step);
  return <section className="playlist-designer" aria-label="Playlist Designer">
    <header className="designer-head">
      <div><span className="eyebrow">PLAYLIST DESIGNER</span>
        <ol className="designer-steps" aria-label="Steps">{steps.map((item, index) => <li key={item.id}>
          <button className={`designer-step${step === item.id ? ' is-current' : ''}${index < stepIndex ? ' is-done' : ''}`} aria-current={step === item.id ? 'step' : undefined}
            disabled={item.id === 'playlist' && !hasPlaylist} onClick={() => onStep(item.id)}><span className="mono">{index + 1}</span>{item.name}</button></li>)}</ol></div>
      <button className="key key-small" onClick={onExplore}>Explore instead</button>
    </header>
    {step === 'start' && <div className="designer-body">
      <h2>Where should your playlist begin?</h2>
      <p className="designer-lead">Every recording here has a position in Rhythm, Texture and Pitch. Your playlist starts at one of them and moves from there.</p>
      <fieldset className="start-options"><legend className="label-caps">A mood</legend>
        <div className="mood-starts">{moods.map(mood => <button key={mood.id} className={`mood-start${start.kind === 'mood' && start.id === mood.id ? ' is-chosen' : ''}`}
          aria-pressed={start.kind === 'mood' && start.id === mood.id} onClick={() => choose(() => setStart({ kind: 'mood', id: mood.id }))}
          onMouseEnter={() => setPeekMood(mood.id)} onMouseLeave={() => setPeekMood(null)} onFocus={() => setPeekMood(mood.id)} onBlur={() => setPeekMood(null)}>
          <i style={{ background: records.find(r => r.mood.id === mood.id) ? colorOf(records.find(r => r.mood.id === mood.id)!) : '#889999' }}/>{mood.label}<span className="mono muted">{mood.count}</span></button>)}</div>
        <p className="fine-print">Moods with fewer than five recordings are not offered as starting points.</p>
      </fieldset>
      <fieldset className="start-options"><legend className="label-caps">A recording</legend>
        {startRecord && <button className="start-choice is-chosen" aria-pressed="true" onClick={() => onSelect(startRecord.recording_id)}>
          <i style={{ background: colorOf(startRecord) }}/><span><strong>{startRecord.title}</strong><small>{startRecord.mood.label} · the playlist starts here</small></span></button>}
        {selected && selected.playback_status === 'available' && selected.recording_id !== startRecord?.recording_id &&
          <button className="start-choice" aria-pressed="false" onClick={() => choose(() => setStart({ kind: 'recording', id: selected.recording_id }))}>
          <i style={{ background: colorOf(selected) }}/><span><strong>{selected.title}</strong><small>{selected.mood.label} · selected · start here</small></span></button>}
        <RecordingPicker records={records} label="Find a recording to start from" onPeek={onPeek} exclude={startRecord ? [startRecord.recording_id] : []}
          onPick={id => { choose(() => setStart({ kind: 'recording', id })); onSelect(id); }}/>
        <p className="fine-print">Or click any recording in the space.</p>
      </fieldset>
      <fieldset className="start-options"><legend className="label-caps">Or</legend>
        <button className={`start-choice${start.kind === 'any' ? ' is-chosen' : ''}`} aria-pressed={start.kind === 'any'} onClick={() => choose(() => setStart({ kind: 'any' }))}>
          <span><strong>Anywhere</strong><small>Start from the middle of the collection.</small></span></button>
      </fieldset>
      <div className="designer-actions"><button className="primary key" onClick={() => onStep('shape')}>Choose a shape →</button>
        <span className="fine-print">Starting from {startName}.</span></div>
    </div>}
    {step === 'shape' && <div className="designer-body">
      <h2>How should it move?</h2>
      <p className="designer-lead">Starting from {startName}. Pick a shape, or draw your own.</p>
      <div className="preset-list" role="radiogroup" aria-label="Shape">{presets.map(item => <button key={item.id} role="radio" aria-checked={!custom && preset === item.id}
        className={`preset${!custom && preset === item.id ? ' is-chosen' : ''}`} onClick={() => choose(() => setPreset(item.id))}>
        <span className="preset-head"><strong>{item.name}</strong>{origin && <ShapeGlyph waypoints={presetWaypoints(item.id, origin, item.id === 'between' ? endRecord?.raw_rtp ?? null : null)}/>}</span>
        <span>{item.description}</span></button>)}</div>
      {preset === 'between' && !custom && <div className="end-choice">
        {endRecord ? <p>Ends at <strong>{endRecord.title}</strong> <button className="key key-small" onClick={() => { setEndId(null); }}>Change</button></p> :
          <p className="designer-hint">Choose the recording it should end at: find it below or click it in the space.</p>}
        {selected && selected.playback_status === 'available' && selected.recording_id !== endId && (start.kind !== 'recording' || start.id !== selected.recording_id) &&
          <button className="key key-small" onClick={() => setEndId(selected.recording_id)}>End at “{selected.title}”</button>}
        {!endRecord && <RecordingPicker records={records} label="Find the recording to end at" onPeek={onPeek}
          exclude={start.kind === 'recording' ? [start.id] : []} onPick={id => { setEndId(id); onSelect(id); }}/>}
      </div>}
      <div className="length-row" role="group" aria-label="Playlist length"><span className="label-caps">Length</span>
        <div className="segmented">{lengths.map(value => <button key={value} aria-pressed={length === value} onClick={() => setLength(value)}>{value}</button>)}</div>
        <span className="fine-print">recordings</span></div>
      {waypoints.length > 1 && <div className="shape-preview" aria-label="Where the shape passes">
        <span className="label-caps">Passes through</span>
        <ol>{waypoints.map((point, index) => <li key={index}><span className="mono muted">{waypointLabel(index, waypoints.length)}</span>
          <strong>{waypointMoods[index] ?? '…'}</strong><span className="mono">R {point.R.toFixed(1)} · T {point.T.toFixed(1)} · P {point.P.toFixed(1)}</span></li>)}</ol>
        {stretch > 0 && <p className="fine-print">The collection thins out around {stretch === 1 ? 'one point' : `${stretch} points`} of this shape, so some recordings will sit a little off it.</p>}
      </div>}
      <details className="shape-custom" open={editing} onToggle={event => setEditing((event.target as HTMLDetailsElement).open)}>
        <summary>{custom ? 'Your own shape' : 'Draw your own shape'}</summary>
        {waypoints.length > 1 && <ShapeEditor waypoints={waypoints} moods={waypointMoods} onChange={points => setCustom(points)}/>}
        {custom && <button className="key key-small" onClick={() => setCustom(null)}>Back to “{presets.find(p => p.id === preset)!.name}”</button>}
        {waypoints.length > 1 && !custom && <button className="key key-small" onClick={() => setCustom([...waypoints.slice(0, -1), waypoints.at(-1)!, { ...waypoints.at(-1)! }].slice(0, 7))} disabled={waypoints.length >= 7}>+ Add a waypoint</button>}
      </details>
      {notice && <p className="playlist-error" role="alert">{notice}</p>}
      <div className="designer-actions"><button className="key" onClick={() => onStep('start')}>← Start</button>
        <button className="primary key" disabled={waypoints.length < 2 || (preset === 'between' && !custom && !endRecord)}
          onClick={() => create(waypoints, length, start.kind === 'recording' ? start.id : null, preset === 'between' && !custom ? endId : null, custom ? `Shaped from ${startName}`.slice(0, 100) : describe(preset, start))}>Create playlist</button></div>
    </div>}
  </section>;
}
