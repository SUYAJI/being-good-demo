import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { colorOf, timeLabel, type Recording } from './types';
import type { PlaybackPosition, QueueEntry } from './playlists';
import { analyzeRecording, type WaveformData } from './waveform';
import { audioURL } from './staticBackend';

/** listen switches the source; pause and resume act on the loaded recording only. */
export type PlayerHandle = { listen: (recording: Recording) => void; playPlaylist: (name: string, entries: QueueEntry[], start?: number) => void;
  pause: () => void; resume: () => void };
type Sequence = { name: string; entries: QueueEntry[]; index: number };
const preference = 'bg.audition-start';

/** Shortcuts never act while typing, inside an open panel, or when Space belongs to a focused control. */
export function shortcutAllowed(event: KeyboardEvent) {
  const target = event.target as Element | null;
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !target?.closest) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], dialog[open]')) return false;
  return !(event.key === ' ' && target.closest('button, a[href], summary, [role=button], [role=gridcell], [tabindex]:not(canvas)'));
}

function Waveform({ data, status, position, duration, start, onSeek }: {
  data: WaveformData | null; status: 'idle' | 'loading' | 'ready' | 'failed'; position: number; duration: number;
  start: number | null; onSeek: (seconds: number) => void;
}) {
  const clip = useId(), dragging = useRef(false), count = data?.peaks.length || 1;
  const fraction = duration ? Math.min(1, position / duration) : 0;
  const seekAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (duration && bounds.width) onSeek(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration);
  };
  const bars = data?.peaks.map((peak, index) => { const h = Math.max(.6, peak * 46); return `M${index} ${50 - h}h.7v${2 * h}h-.7z`; }).join('') ?? '';
  const mark = (seconds: number | null) => seconds != null && duration ? seconds / duration * count : null;
  return <div className={`waveform${duration ? '' : ' is-empty'}`} data-state={status} onPointerDown={event => {
    if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); seekAt(event);
  }} onPointerMove={event => { if (dragging.current) seekAt(event); }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
    <svg viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
      <defs><clipPath id={clip}><rect x={0} y={0} width={fraction * count} height={100}/></clipPath></defs>
      {/* Without decoded peaks only a flat progress line is drawn: no waveform is invented. */}
      {data ? <><path className="waveform-base" d={bars}/><path className="waveform-played" d={bars} clipPath={`url(#${clip})`}/></> :
        <><rect className="waveform-base" x={0} y={49} width={count} height={2}/><rect className="waveform-played" x={0} y={49} width={fraction * count} height={2}/></>}
      {mark(start) != null && <line className="waveform-start" x1={mark(start)!} x2={mark(start)!} y1={0} y2={100}/>}
      {duration > 0 && <line className="waveform-playhead" x1={fraction * count} x2={fraction * count} y1={0} y2={100}/>}
    </svg>
    <label className="sr-only" htmlFor="seek">Playback position</label>
    <input id="seek" type="range" min={0} max={duration || 1} step={.1} value={Math.min(position, duration || 1)} disabled={!duration}
      onChange={event => onSeek(Number(event.target.value))}/>
    {status === 'loading' && <span className="waveform-note">Reading waveform from the audio…</span>}
    {status === 'failed' && <span className="waveform-note">Waveform unavailable · seeking still works</span>}
  </div>;
}

const PauseGlyph = () => <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><rect x="1" y="1" width="4" height="14"/><rect x="9" y="1" width="4" height="14"/></svg>;
const PlayGlyph = () => <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M2 1 L13 8 L2 15 Z"/></svg>;

export const ListeningDock = forwardRef<PlayerHandle, { visibleIds?: string[]; onPlaybackChange?: (position: PlaybackPosition | null) => void;
  onLocate?: (recording: Recording) => void; analyze?: (recordingId: string, signal: AbortSignal) => Promise<WaveformData> }>(function ListeningDock({ visibleIds, onPlaybackChange, onLocate, analyze = analyzeRecording }, ref) {
  const audio = useRef<HTMLAudioElement>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const active = useRef<string | null>(null);
  const generation = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(.7);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const sequenceRef = useRef(sequence);
  function updateSequence(value: typeof sequence) { sequenceRef.current = value; setSequence(value); }
  // Auditioning one recording sets the playlist aside instead of discarding its place.
  const [suspended, setSuspended] = useState<(Sequence & { time: number }) | null>(null);
  const [waveform, setWaveform] = useState<{ id: string; data: WaveformData | null; status: 'loading' | 'ready' | 'failed' } | null>(null);
  const [starts, setStarts] = useState<Record<string, number>>({});
  const [autoStart, setAutoStart] = useState(() => { try { return localStorage.getItem(preference) === 'on'; } catch { return false; } });
  const pendingSeek = useRef<number | null>(null), awaitingSuggestion = useRef<string | null>(null), userSeeked = useRef(false);
  const entryId = sequence?.entries[sequence.index].entry_id ?? null;
  const finished = !playing && duration > 0 && position >= duration - .25;
  useEffect(() => {
    onPlaybackChange?.(recording ? { recording_id: recording.recording_id, entry_id: entryId, playing, finished } : null);
  }, [recording, entryId, playing, finished, onPlaybackChange]);
  useEffect(() => {
    if (!recording) return;
    const id = recording.recording_id, controller = new AbortController();
    setWaveform({ id, data: null, status: 'loading' });
    analyze(id, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setWaveform({ id, data, status: 'ready' });
      const element = audio.current;
      if (awaitingSuggestion.current === id && data.suggestion != null && element && !userSeeked.current && element.currentTime < 5) {
        element.currentTime = data.suggestion; setPosition(data.suggestion); setNotice(`Started at the suggested point, ${timeLabel(data.suggestion)}`);
      }
      if (awaitingSuggestion.current === id) awaitingSuggestion.current = null;
    }).catch(() => { if (!controller.signal.aborted) setWaveform({ id, data: null, status: 'failed' }); });
    return () => controller.abort();
  }, [recording, analyze]);

  function start(next: Recording, restart = false, options: { audition?: boolean; at?: number } = {}) {
    const element = audio.current!;
    generation.current++;
    userSeeked.current = false; awaitingSuggestion.current = null; pendingSeek.current = null; setNotice('');
    const preferred = options.audition && autoStart ? starts[next.recording_id] ?? null : null;
    const at = options.at ?? preferred;
    if (active.current !== next.recording_id) {
      element.pause(); active.current = next.recording_id;
      setRecording(next); setPosition(0); setDuration(0);
      element.src = audioURL(next.recording_id);
      element.load();
      pendingSeek.current = at;
    } else if (restart || at != null) {
      element.currentTime = at ?? 0; setPosition(at ?? 0);
    }
    if (options.audition && autoStart && preferred == null && (active.current !== next.recording_id || element.currentTime < 5)) awaitingSuggestion.current = next.recording_id;
    if (options.audition && autoStart && preferred == null && waveform?.id === next.recording_id && waveform.data?.suggestion != null && element.currentTime < 5) {
      element.currentTime = waveform.data.suggestion; setPosition(waveform.data.suggestion); awaitingSuggestion.current = null;
    }
    setError(''); element.volume = volume;
    const attempt = generation.current;
    // Call within the activation gesture, without awaiting a network exchange.
    element.play().catch(() => {
      if (attempt === generation.current) { setPlaying(false); setError('Audio could not play. Check the recording or try Listen again.'); }
    });
  }
  function step(offset: number) {
    const queue = sequenceRef.current;
    if (!queue || queue.index + offset < 0 || queue.index + offset >= queue.entries.length) return;
    const next = { ...queue, index: queue.index + offset }; updateSequence(next);
    start(next.entries[next.index].recording, true);
  }
  function seek(seconds: number) {
    const element = audio.current; if (!element || !duration) return;
    const value = Math.max(0, Math.min(duration, seconds)); element.currentTime = value; setPosition(value);
    userSeeked.current = true; awaitingSuggestion.current = null;
  }
  const pause = () => { if (playing) { generation.current++; audio.current?.pause(); } };
  const resume = () => { if (!playing && recording) start(recording); };
  const toggle = () => { if (playing) pause(); else resume(); };
  useImperativeHandle(ref, () => ({
    listen: next => {
      const queue = sequenceRef.current;
      if (queue) setSuspended({ ...queue, time: audio.current?.currentTime ?? 0 });
      updateSequence(null); start(next, false, { audition: true });
    },
    playPlaylist: (name, entries, first = 0) => {
      if (!entries.length) return;
      const index = Math.max(0, Math.min(entries.length - 1, first));
      // Capture this order explicitly. Browsing/editing never alters current playback.
      setSuspended(null); updateSequence({ name, entries: [...entries], index }); start(entries[index].recording, true);
    },
    pause, resume,
  }));
  const returnToPlaylist = () => {
    if (!suspended) return;
    const { time, ...queue } = suspended; setSuspended(null); updateSequence(queue);
    start(queue.entries[queue.index].recording, false, { at: time });
  };
  const currentEvent = () => !!active.current && audio.current?.currentSrc === audioURL(active.current);
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = event => {
    if (!recording || !shortcutAllowed(event)) return;
    const key = event.key;
    if (key === ' ' || (key === 'k' || key === 'K') && !event.shiftKey) toggle();
    else if ((key === 'j' || key === 'l') && !event.shiftKey) seek(position + (key === 'j' ? -10 : 10));
    else if (key === 'N' && event.shiftKey && sequence) step(1);
    else if (key === 'P' && event.shiftKey && sequence) step(-1);
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener);
  }, []);
  const ready = waveform && recording && waveform.id === recording.recording_id ? waveform : null;
  const suggestion = ready?.data?.suggestion ?? null, chosen = recording ? starts[recording.recording_id] ?? null : null;
  const outside = recording && !error && visibleIds && !visibleIds.includes(recording.recording_id);
  const keyLabel = !recording ? 'PLAY' : playing ? 'PAUSE' : finished ? 'PLAY' : 'RESUME';

  return <footer className={`listening-dock${recording ? ' is-loaded' : ' is-idle'}${playing ? ' is-playing' : ''}`} aria-label="Listening dock">
    <audio ref={audio} preload="metadata"
      onPlay={() => { if (currentEvent()) setPlaying(!audio.current!.paused); }}
      onPause={() => { if (currentEvent()) setPlaying(!audio.current!.paused); }}
      onEnded={() => {
        if (!currentEvent() || !audio.current?.ended) return;
        const queue = sequenceRef.current;
        if (queue && queue.index < queue.entries.length - 1) step(1); else setPlaying(false);
      }}
      onTimeUpdate={() => { if (currentEvent()) setPosition(audio.current!.currentTime); }}
      onLoadedMetadata={() => {
        if (!currentEvent()) return;
        const length = Number.isFinite(audio.current!.duration) ? audio.current!.duration : 0; setDuration(length);
        if (pendingSeek.current != null) { const value = Math.min(pendingSeek.current, length || pendingSeek.current); audio.current!.currentTime = value; setPosition(value); pendingSeek.current = null; }
      }}
      onError={() => { if (currentEvent() && audio.current?.error) { setPlaying(false); setError('This recording is unavailable for playback.'); } }} />
    <div className="dock-transport">
      <div className="dock-key"><button className="transport key key-dark" aria-label={playing ? 'Pause playback' : 'Resume playback'} aria-keyshortcuts="Space K" disabled={!recording} onClick={toggle}>
        {playing ? <PauseGlyph/> : <PlayGlyph/>}</button><span aria-hidden="true">{keyLabel}</span></div>
      {sequence && <div className="playlist-transport">
        <div className="dock-key"><button className="key" aria-label="Previous playlist track" aria-keyshortcuts="Shift+P" disabled={sequence.index === 0} onClick={() => step(-1)}>
          <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><rect x="1" y="1" width="2" height="10"/><path d="M13 1 L4 6 L13 11 Z"/></svg></button><span aria-hidden="true">PREV</span></div>
        <div className="dock-key"><button className="key" aria-label="Next playlist track" aria-keyshortcuts="Shift+N" disabled={sequence.index === sequence.entries.length - 1} onClick={() => step(1)}>
          <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M1 1 L10 6 L1 11 Z"/><rect x="11" y="1" width="2" height="10"/></svg></button><span aria-hidden="true">NEXT</span></div>
      </div>}
    </div>
    <div className="dock-display">
      <div className="now-playing">
        <span className="dock-eyebrow">{recording ? <>{playing && <span aria-hidden="true">▶ </span>}{sequence && playing ? 'PLAYLIST' : playing ? 'NOW LISTENING' : finished ? 'FINISHED' : 'PAUSED'}</> : 'DOCK · IDLE'}</span>
        {recording ? <button className="now-playing-title" onClick={() => onLocate?.(recording)} aria-label={`Show ${recording.title} in Explorer`} title="Show in Explorer">
          <strong>{recording.title}</strong></button> : <strong className="dock-idle-title">Nothing loaded</strong>}
        {recording ? <span className="playing-mood"><i style={{ background: colorOf(recording) }}/>{recording.mood.label} · {timeLabel(recording.duration_seconds)}
          {outside && <span className="fine-print">Outside current view · {playing ? 'still playing' : finished ? 'finished' : 'paused'}</span>}</span> :
          <span className="playing-mood">Select a recording, then Listen</span>}
        {sequence && <span className="queue-context" title="Playing the order as it was when you pressed Play; edits do not interrupt playback.">
          {sequence.name} · {sequence.index + 1} / {sequence.entries.length}</span>}
        {suspended && !sequence && <span className="queue-context">Listening on its own · {suspended.name} paused at {suspended.index + 1} / {suspended.entries.length}, {timeLabel(suspended.time)}
          {' '}<button className="return-to-playlist key key-small" onClick={returnToPlaylist}>Return to playlist</button></span>}
      </div>
      {recording ? <div className="seek-control">
        <Waveform data={ready?.data ?? null} status={ready?.status ?? 'idle'} position={position} duration={duration} start={chosen ?? suggestion} onSeek={seek}/>
        <div className="time-pair"><span className="time-now">{timeLabel(position)}</span>
          <div className="audition-start">
            {chosen != null ? <><span className="start-mark"><span aria-hidden="true">┆ </span>My start {timeLabel(chosen)}</span><button className="key key-small" aria-label="Go to my start" onClick={() => seek(chosen)}>Go</button>
              <button className="key key-small" onClick={() => setStarts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== recording.recording_id)))}>Clear my start</button></> :
              suggestion != null ? <><span className="start-mark"><span aria-hidden="true">┆ </span>Suggested {timeLabel(suggestion)}</span><button className="key key-small" aria-label="Go to suggested start" onClick={() => seek(suggestion)}>Go</button></> :
              ready?.status === 'ready' && <span>No quiet introduction found</span>}
            <label className="key key-small led-key" title="Start auditions at the suggested or my start"><input type="checkbox" className="sr-only" aria-label="Start auditions at the suggested or my start" checked={autoStart} onChange={event => {
              setAutoStart(event.target.checked); try { localStorage.setItem(preference, event.target.checked ? 'on' : 'off'); } catch { /* Preference stays for this tab. */ }
            }}/><i className={`led${autoStart ? ' on' : ''}`} aria-hidden="true"/>AUTO-START</label>
            <button className="key key-small" aria-label="Set my start here" disabled={!duration} onClick={() => setStarts(previous => ({ ...previous, [recording.recording_id]: Math.round(position * 10) / 10 }))}>SET MY START</button>
            <details><summary>How starts work</summary><div className="audition-help"><p>The waveform shows the peak sample level of the actual decoded audio (all channels, decoded at 22.05 kHz).
              A suggested start is the first point from which the next 3 seconds reach the recording’s median 3-second RMS loudness, so it skips quiet introductions with a short lead-in.
              It does not identify sections, mood or RTP. Your own start replaces the suggestion for this session only. AUTO-START applies it when you press Listen.</p>
              <p>Keys: Space or K play/pause · J / L back / forward 10 s · Shift+N / Shift+P next / previous playlist track.</p></div></details>
            {notice && <span className="dock-notice" role="status">{notice}</span>}
          </div>
          <span>{timeLabel(duration)}</span></div>
      </div> : <div className="dock-idle"><div className="dock-idle-well">NO RECORDING LOADED · NO WAVEFORM</div><span className="mono">–:–– / –:––</span></div>}
    </div>
    <div className="volume-control"><input id="volume" type="range" min={0} max={1} step={.01} value={volume}
      onChange={event => { const value = Number(event.target.value); setVolume(value); audio.current!.volume = value; }}/><label htmlFor="volume">VOLUME</label>
    </div>
    {error && <p className="player-error" role="alert">{error}</p>}
  </footer>;
});
