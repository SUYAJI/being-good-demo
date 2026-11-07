import { colorOf, moodColors, timeLabel, type Recording } from '../types';
import type { StageCommand } from './StageRenderer';

const views: [StageCommand, string, string][] = [['frame', 'Frame', 'Frame the playlist, or the whole collection'], ['top', 'Top', 'Look straight down: Rhythm across, Texture up the page'],
  ['left', '↶', 'Rotate left'], ['right', '↷', 'Rotate right'], ['reset', 'Reset', 'Reset the view']];

/** Overlays on the stage: what it is showing, the reveal status, a key to the marks, camera keys and the chosen recording. */
export function StageHud({ caption, status, onSkip, legend, onCommand, card, moods, explore }: {
  caption: string; status: { text: string; searching: boolean } | null; onSkip: () => void;
  legend: { shape: boolean; journey: string | null; count: number; tethers: boolean };
  onCommand: (name: StageCommand) => void;
  card: { record: Recording; slot: number | null; playing: boolean; actions: { label: string; run: () => void; primary?: boolean; aria?: string }[]; onClose: () => void } | null;
  moods: { id: string; label: string }[]; explore?: () => void;
}) {
  return <div className="stage-hud">
    <div className="stage-top">
      <p className="stage-caption">{caption}</p>
      <div className="stage-status-host" role="status">{status && <div className={`stage-status${status.searching ? ' is-searching' : ''}`}>
        {status.searching && <i className="led on" aria-hidden="true"/>}<span>{status.text}</span>
        {status.searching && <button className="key key-small" onClick={onSkip}>Skip</button>}</div>}</div>
    </div>
    {card && <section className="stage-card" aria-label={`Selected recording: ${card.record.title}`}>
      <header><span className="mono muted">{card.slot != null ? `PLAYLIST · ${String(card.slot + 1).padStart(2, '0')}` : 'RECORDING'}</span>
        <button className="key key-small" aria-label="Close" onClick={card.onClose}>×</button></header>
      <strong>{card.record.title}</strong>
      <span className="stage-card-mood"><i style={{ background: colorOf(card.record) }}/>{card.record.mood.label} · {timeLabel(card.record.duration_seconds)}</span>
      <span className="stage-card-rtp mono"><b className="axis-R">R {card.record.raw_rtp.R.toFixed(2)}</b><b className="axis-T">T {card.record.raw_rtp.T.toFixed(2)}</b><b className="axis-P">P {card.record.raw_rtp.P.toFixed(2)}</b></span>
      <div className="stage-card-actions">{card.actions.map(action => <button key={action.label} className={`key key-small${action.primary ? ' key-dark' : ''}`} aria-label={action.aria}
        onClick={action.run}>{action.label}</button>)}</div>
    </section>}
    <div className="stage-legend" role="note" aria-label={legend.journey ? 'Playlist path legend' : 'Key to the space'}>
      <span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="#3155ee" stroke="#141619" strokeOpacity=".4"/></svg>Recording at its R · T · P</span>
      <span><svg width="14" height="18" aria-hidden="true"><line x1="7" y1="2" x2="7" y2="16" stroke="#141619" strokeOpacity=".5"/><ellipse cx="7" cy="16" rx="5" ry="1.6" fill="#141619" opacity=".2"/></svg>Height is Pitch</span>
      {legend.shape && <span><svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="#141619" strokeWidth="1.6" strokeDasharray="4 3"/></svg>Your shape</span>}
      {legend.tethers && <span><svg width="22" height="12" aria-hidden="true"><circle cx="4" cy="6" r="3" fill="none" stroke="#141619"/><line x1="7" y1="6" x2="21" y2="6" stroke="#141619" strokeOpacity=".6"/></svg>Point on the shape → its recording</span>}
      {legend.journey && <span className="legend-path"><svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="#E2471B" strokeWidth="3"/></svg>
        PATH · {legend.journey} · {legend.count}</span>}
      <span className="legend-moods">{moods.map(m => <i key={m.id} title={m.label} style={{ background: moodColors[m.id] ?? '#889999' }}/>)}<span>colour = mood</span></span>
    </div>
    <div className="stage-keys" role="group" aria-label="View of the space">
      {views.map(([name, glyph, label]) => <button key={name} className="key key-small" aria-label={label} title={label} onClick={() => onCommand(name)}>{glyph}</button>)}
      {explore && <button className="key key-small" onClick={explore} title="Open the 2D projections, filters, mood atlas and recording details">Explorer →</button>}
    </div>
  </div>;
}
