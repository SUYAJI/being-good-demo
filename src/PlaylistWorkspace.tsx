import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { postJSON, readJSON } from './api';
import { colorOf, timeLabel, type Recording, type RTP } from './types';
import { emptyPlaylist, moveEntry, playlistPayload, predictorWarnings, type PlaybackPosition, type Playlist, type PlaylistEntry, type QueueEntry } from './playlists';
import { PlaylistTrajectory } from './PlaylistTrajectory';
import { TrajectoryDesigner } from './TrajectoryDesigner';
import { compareSequence, regenerateUnlocked, rtpDistance, type Generation } from './trajectoryDesign';
import type { TargetSnapshot } from './journeys';
import { undoKey, useHistory } from './history';

export type PlaylistHandle = { add: (records: Recording[]) => string[] | null; remove: (entryIds: string[]) => void };
export type WorkspaceSummary = { name: string; entries: PlaylistEntry[]; dirty: boolean; targetDirty: boolean };
/** Locks are entry identities for this editing session; they are not saved with the playlist. */
type Work = { draft: Playlist; generation: Generation | null; locks: string[]; origin: string | null };
const payloadKey = (playlist: Playlist) => JSON.stringify(playlistPayload(playlist));
const initialWork = (): Work => ({ draft: emptyPlaylist(), generation: null, locks: [], origin: null });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Candidates for one position, nearest first to its desired RTP (or to the current recording without a target). */
function Replacements({ index, entry, records, target, inPlaylist, onUse, onListen }: {
  index: number; entry: PlaylistEntry; records: Recording[]; target: RTP | null; inPlaylist: Set<string>;
  onUse: (record: Recording) => void; onListen: (record: Recording) => void;
}) {
  const [limit, setLimit] = useState(8);
  const current = records.find(record => record.recording_id === entry.recording_id);
  const reference = target ?? current?.raw_rtp ?? null;
  const ranked = useMemo(() => records.filter(record => record.playback_status === 'available' && record.recording_id !== entry.recording_id)
    .map(record => ({ record, distance: reference ? rtpDistance(record.raw_rtp, reference) : null }))
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.record.title.localeCompare(b.record.title)), [records, entry.recording_id, reference]);
  return <section className="replacements" aria-label={`Replacements for position ${index + 1}`}>
    <p className="fine-print">Replace position {index + 1} · nearest first to {target ? 'the desired RTP at this position' : current ? `“${current.title}”` : 'nothing (sorted by title)'} · Euclidean raw-RTP distance</p>
    <ol>{ranked.slice(0, limit).map(({ record, distance }) => <li key={record.recording_id}>
      <span><strong>{record.title}</strong><small><i style={{ background: colorOf(record) }}/>{record.mood.label}{distance != null && ` · ${distance.toFixed(3)} RTP units`}{inPlaylist.has(record.recording_id) && ' · already in playlist'}</small></span>
      <button aria-label={`Audition ${record.title}`} onClick={() => onListen(record)}>Listen</button>
      <button aria-label={`Use ${record.title} at position ${index + 1}`} onClick={() => onUse(record)}>Use</button></li>)}</ol>
    {ranked.length > limit && <button onClick={() => setLimit(value => value + 8)}>Show more candidates</button>}
  </section>;
}

export const PlaylistWorkspace = forwardRef<PlaylistHandle, {
  records: Recording[]; onSelect: (id: string) => void; onListen: (record: Recording) => void;
  onPlay: (name: string, entries: QueueEntry[], start?: number) => void;
  playback?: PlaybackPosition | null; compact?: boolean; onOpenFull?: () => void; onChange?: (summary: WorkspaceSummary) => void;
}>(function PlaylistWorkspace({ records, onSelect, onListen, onPlay, playback, compact = false, onOpenFull, onChange }, ref) {
  const [saved, setSaved] = useState<Playlist[]>([]);
  const history = useHistory(initialWork), work = history.value, draft = work.draft, generation = work.generation;
  const [baseline, setBaseline] = useState<string | null>(() => payloadKey(emptyPlaylist()));
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState<{ type: 'open'; playlist: Playlist; generation?: Generation } | { type: 'delete' } | null>(null);
  const [designer, setDesigner] = useState(false), [designOpen, setDesignOpen] = useState(true), [targetDirty, setTargetDirty] = useState(false);
  const key = payloadKey(draft), dirty = baseline === null || key !== baseline, untouched = work.origin !== null && key === work.origin;
  useEffect(() => { onChange?.({ name: draft.name, entries: draft.entries, dirty, targetDirty }); }, [draft.name, draft.entries, dirty, targetDirty, onChange]);
  const fitHeading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!draft.target || !fitHeading.current) return;
    const host = fitHeading.current.closest<HTMLElement>('.playlist-host');
    if (host) host.scrollTop += fitHeading.current.getBoundingClientRect().top - host.getBoundingClientRect().top;
  }, [draft.id, draft.target]);
  const dragging = useRef<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null), [dropTarget, setDropTarget] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusAfterMove.current) rows.current.get(focusAfterMove.current)?.focus();
    focusAfterMove.current = null;
  }, [draft.entries]);
  const byId = useMemo(() => new Map(records.map(record => [record.recording_id, record])), [records]);
  const comparison = useMemo(() => draft.target ? compareSequence(draft.entries.map(entry => byId.get(entry.recording_id)), draft.target.waypoints) : null,
    [draft.target, draft.entries, byId]);
  const playable = draft.entries.flatMap(entry => {
    const recording = byId.get(entry.recording_id);
    return recording?.playback_status === 'available' ? [{ entry_id: entry.entry_id, recording }] : [];
  });
  const locks = new Set(work.locks.filter(id => draft.entries.some(entry => entry.entry_id === id)));
  const inPlaylist = new Set(draft.entries.map(entry => entry.recording_id));
  useEffect(() => {
    const controller = new AbortController();
    readJSON<{ playlists: Playlist[] }>('playlists', { signal: controller.signal }).then(result => {
      setSaved(result.playlists); setLoaded(true);
    }).catch(error => { if (!controller.signal.aborted) { setFailure(error.message); setLoaded(true); } });
    return () => controller.abort();
  }, []);
  const edit = (update: (playlist: Playlist) => Playlist, label: string, message = 'Unsaved changes', coalesce?: string) => {
    history.commit(current => ({ ...current, draft: update(current.draft) }), label, coalesce); setNotice(message); setFailure('');
  };
  useImperativeHandle(ref, () => ({
    add: additions => {
      if (busy) { setNotice('Save in progress. Add recordings again when it finishes.'); return null; }
      if (draft.entries.length + additions.length > 500) { setFailure('A playlist can hold up to 500 recordings.'); return null; }
      const entries = additions.map(record => ({ entry_id: crypto.randomUUID(), recording_id: record.recording_id, title: record.title }));
      if (!entries.length) return [];
      edit(playlist => ({ ...playlist, entries: [...playlist.entries, ...entries] }), `add ${plural(entries.length, 'recording')}`,
        `${plural(entries.length, 'recording')} added · unsaved changes`);
      setSelected(entries[0].entry_id); onSelect(entries[0].recording_id);
      return entries.map(entry => entry.entry_id);
    },
    remove: ids => edit(playlist => ({ ...playlist, entries: playlist.entries.filter(entry => !ids.includes(entry.entry_id)) }),
      `remove ${plural(ids.length, 'recording')}`, `${plural(ids.length, 'addition')} undone · unsaved changes`),
  }));
  function select(entry: PlaylistEntry) {
    setSelected(entry.entry_id);
    onSelect(entry.recording_id);
  }
  function open(playlist: Playlist, generated?: Generation, keepHistory = false) {
    const opened = { ...playlist, entries: [...playlist.entries] };
    const next: Work = { draft: opened, generation: generated ?? null, locks: [], origin: generated ? payloadKey(opened) : null };
    // Replacing an untouched generated draft is one undoable step, so the previous generation is never lost.
    if (keepHistory) history.commit(() => next, 'regenerate playlist'); else history.reset(next);
    setBaseline(generated ? null : payloadKey(opened)); setSelected(generated ? opened.entries[0]?.entry_id ?? null : null);
    if ((generated || playlist.target) && opened.entries[0]) onSelect(opened.entries[0].recording_id);
    setPending(null); setFailure(''); setNotice(generated ? (keepHistory ? 'Regenerated · previous draft replaced (Undo restores it) · unsaved changes' : 'Generated new draft · unsaved changes') : playlist.id ?
      playlist.target ? 'Saved playlist opened · target comparison restored' : 'Saved manual playlist opened' : 'New playlist');
  }
  function requestOpen(playlist: Playlist, generated?: Generation) {
    // Only an untouched generated draft is replaced without asking, and only by another generation.
    if (generated && untouched) open(playlist, generated, true);
    else if (dirty) setPending({ type: 'open', playlist, generation: generated }); else open(playlist, generated);
  }
  function generated(result: Generation, target: TargetSnapshot, name: string) {
    requestOpen({ ...emptyPlaylist(), name, target, entries: result.recordings.map(record => ({
      entry_id: crypto.randomUUID(), recording_id: record.recording_id, title: record.title,
    })) }, result);
  }
  async function save() {
    setBusy(true); setFailure('');
    try {
      const result = await postJSON<Playlist>(draft.id ? `playlists/${draft.id}` : 'playlists', playlistPayload(draft));
      setSaved(previous => [result, ...previous.filter(playlist => playlist.id !== result.id)]);
      // Undo after saving keeps the saved identity and revision, so it can never create a duplicate.
      history.rebase(current => ({ ...current, draft: { ...current.draft, id: result.id, revision: result.revision }, origin: null }));
      history.replace(current => ({ ...current, draft: result }));
      setBaseline(payloadKey(result)); setNotice('Saved in this browser');
      return result;
    } catch (error) { setFailure((error as Error).message); return null; }
    finally { setBusy(false); }
  }
  async function removePlaylist() {
    if (!draft.id) { open(emptyPlaylist()); return; }
    setBusy(true); setFailure('');
    try {
      await postJSON(`playlists/${draft.id}/delete`, { revision: draft.revision });
      setSaved(previous => previous.filter(playlist => playlist.id !== draft.id)); open(emptyPlaylist()); setNotice('Playlist deleted');
    } catch (error) { setFailure((error as Error).message); }
    finally { setBusy(false); }
  }
  function move(entryId: string, to: number) {
    const from = draft.entries.findIndex(entry => entry.entry_id === entryId);
    const entries = moveEntry(draft.entries, from, to);
    if (entries === draft.entries) return;
    focusAfterMove.current = entryId;
    edit(playlist => ({ ...playlist, entries: moveEntry(playlist.entries, from, to) }), `move to position ${to + 1}`, `Moved to position ${to + 1} · unsaved changes`);
  }
  function replace(index: number, entry: PlaylistEntry, record: Recording) {
    edit(playlist => ({ ...playlist, entries: playlist.entries.map(item => item.entry_id === entry.entry_id ? { ...item, recording_id: record.recording_id, title: record.title } : item) }),
      `replace position ${index + 1}`, 'Recording replaced · unsaved changes · captured playback unchanged');
    onSelect(record.recording_id);
  }
  function regenerate() {
    if (!draft.target) return;
    const current = draft.entries.map(entry => byId.get(entry.recording_id)), fixed = draft.entries.map(entry => locks.has(entry.entry_id));
    const result = regenerateUnlocked(records, draft.target.waypoints, current, fixed);
    if (!result.recordings) { setNotice(result.notices.join(' ')); return; }
    const chosen = result.recordings, distances = chosen.flatMap((record, index) => record ? [rtpDistance(record.raw_rtp, result.targets[index])] : []);
    const meanDistance = distances.length ? distances.reduce((sum, value) => sum + value / distances.length, 0) : null;
    history.commit(work => ({ ...work, generation: { waypoints: draft.target!.waypoints, recordings: chosen.filter((r): r is Recording => !!r), targets: result.targets,
      requested: draft.entries.length, eligible: result.eligible, meanDistance, notices: result.notices },
    draft: { ...work.draft, entries: work.draft.entries.map((entry, index) => fixed[index] || !chosen[index] ? entry : { ...entry, recording_id: chosen[index]!.recording_id, title: chosen[index]!.title }) } }),
    'regenerate unlocked positions');
    setNotice(`Regenerated ${plural(fixed.filter(value => !value).length, 'unlocked position')} · ${plural(locks.size, 'locked position')} kept · unsaved changes`); setFailure('');
  }
  async function reload() {
    setBusy(true); setFailure('');
    try {
      const result = await readJSON<{ playlists: Playlist[] }>('playlists'); setSaved(result.playlists);
      const current = result.playlists.find(playlist => playlist.id === draft.id);
      if (current) requestOpen(current); else if (draft.id) requestOpen(emptyPlaylist());
      else setNotice('Saved playlists refreshed');
    } catch (error) { setFailure((error as Error).message); }
    finally { setBusy(false); }
  }
  const selectedIndex = draft.entries.findIndex(entry => entry.entry_id === selected);
  const selectedEntry = draft.entries[selectedIndex];
  return <section className={`playlist-workspace${dirty ? ' is-dirty' : ''}${compact ? ' is-compact' : ''}`} aria-label="Playlist workspace" onKeyDown={event => {
    const action = undoKey(event); if (!action || busy) return;
    event.preventDefault(); history[action](); setNotice(action === 'undo' ? 'Undone' : 'Redone');
  }}>
    <div className="playlist-modes"><span className="eyebrow">PLAYLIST · ORDERED RECORDINGS</span>
      {compact ? <button onClick={onOpenFull}>Full workspace</button> :
        <button aria-expanded={designer} onClick={() => setDesigner(value => !value)}>{designer ? 'Hide target designer' : 'Target designer'}</button>}</div>
    <div className="playlist-library"><label>Saved playlists<select aria-label="Open saved playlist" disabled={busy || !loaded}
      value={draft.id ?? ''} onChange={event => { const value = saved.find(playlist => playlist.id === event.target.value); if (value) requestOpen(value); }}>
      <option value="">Choose a saved playlist…</option>{saved.map(playlist => <option key={playlist.id} value={playlist.id!}>{playlist.name} · {playlist.entries.length}</option>)}
    </select></label>{!compact && <><button disabled={busy} onClick={() => requestOpen(emptyPlaylist())}>New playlist</button>
      <button disabled={busy} onClick={reload}>Reload saved</button></>}</div>
    <div hidden={!designer || compact}><TrajectoryDesigner records={records} disabled={busy || !loaded || !!pending} expanded={designOpen}
      onExpand={setDesignOpen} onGenerate={generated} comparing={!!draft.target} onDirtyChange={setTargetDirty}/></div>
    <div className="playlist-titlebar"><label className="playlist-name"><span className="sr-only">Playlist name</span><input aria-label="Playlist name" maxLength={100}
      disabled={busy} value={draft.name} onChange={event => { const name = event.target.value; edit(playlist => ({ ...playlist, name }), 'rename playlist', 'Unsaved changes', 'name'); }}/></label>
      <button className="playlist-save" disabled={busy || !loaded || !draft.name.trim() || (!dirty && !!draft.id)} onClick={save}>{busy ? 'Saving…' : 'Save playlist'}</button>
      <button disabled={busy || !history.undoLabel} aria-label="Undo playlist edit" title={history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : undefined} onClick={() => { history.undo(); setNotice('Undone'); }}>↶</button>
      <button disabled={busy || !history.redoLabel} aria-label="Redo playlist edit" title={history.redoLabel ? `Redo ${history.redoLabel} (Ctrl+Shift+Z)` : undefined} onClick={() => { history.redo(); setNotice('Redone'); }}>↷</button>
      {!compact && <button disabled={busy || (!draft.id && !dirty)} onClick={() => setPending({ type: 'delete' })}>Delete</button>}</div>
    {pending && <div className="playlist-confirm" role="group" aria-label="Confirm playlist action">
      <span>{pending.type === 'delete' ? `Delete “${draft.name}”? Recordings stay in the library.` : 'This playlist has unsaved changes.'}</span>
      {pending.type === 'open' ? <><button disabled={busy} onClick={async () => { if (await save()) open(pending.playlist, pending.generation); }}>Save and open</button>
        <button disabled={busy} onClick={() => open(pending.playlist, pending.generation)}>Discard and open</button></> :
        <button disabled={busy} onClick={removePlaylist}>Delete playlist</button>}
      <button disabled={busy} onClick={() => setPending(null)}>Cancel</button></div>}
    <div className="playlist-status" data-state={busy ? 'saving' : dirty ? 'dirty' : draft.id ? 'saved' : 'new'}><span role="status">{notice || (loaded ? 'Add recordings with + in the collection, the selected recording, or a 2D region.' : 'Opening saved playlists…')}</span>
      <span>{draft.entries.length} recordings · {timeLabel(playable.reduce((sum, entry) => sum + entry.recording.duration_seconds, 0))}{untouched ? ' · untouched generated draft' : ''}</span></div>
    {failure && <p className="playlist-error" role="alert">{failure}</p>}
    {comparison && draft.target && <div className="generation-fit" ref={fitHeading} aria-label="Target fit diagnostics">
      <div><span className="eyebrow">CURRENT GEOMETRIC FIT</span><strong data-mean-distance={comparison.mean ?? ''}>{comparison.mean === null ? '—' : comparison.mean.toFixed(3)} <small>RTP units · mean distance</small></strong></div>
      <p>{comparison.measured} / {draft.entries.length} positions measured · Target requested {draft.target.requested_count} recordings.
        {generation && <> Generated fit {generation.meanDistance?.toFixed(3)} · {generation.eligible} playable candidates.
          {generation.meanDistance !== null && generation.meanDistance > 1 && <span className="coverage-note"> Limited collection coverage: the best generated mean distance exceeds 1 RTP unit.</span>}
          {generation.notices.join(' ') && <span className="coverage-note"> {generation.notices.join(' ')}</span>}</>}</p>
      <div className="regenerate-row"><button disabled={busy || locks.size === draft.entries.length} onClick={regenerate}>Regenerate unlocked positions</button>
        <span className="fine-print">{locks.size ? `${plural(locks.size, 'position')} locked. ` : 'Lock positions to keep them. '}Refills the others from the whole playable library with distinct recordings; locks last for this session.</span>
        {!compact && !designer && <button onClick={() => setDesigner(true)}>Edit target</button>}</div>
      <p>{draft.target.recipe ? `Target copy from saved target “${draft.target.recipe.name}” · revision ${draft.target.recipe.revision}.` : 'Target copy not linked to a saved target.'}
        {' '}This playlist keeps its own copy on save and reopen; length edits resample it by recording order. Editing or deleting the saved target never changes it.
        Geometric fit uses current predictions and does not measure confidence or musical transitions.</p>
    </div>}
    <div className="playlist-composition">
      {!compact && <PlaylistTrajectory entries={draft.entries} records={byId} selected={selected} onSelect={select} playback={playback} targets={comparison?.targets}/>}
      <section className="playlist-order" aria-label="Sequence editor">
      <div className="playlist-sequence-heading"><h2>Listening order</h2><button disabled={!playable.length} onClick={() => onPlay(draft.name, playable)}>▶ Play playlist</button></div>
      {!compact && <p className="playlist-help">Drag tracks to reorder, use ↑ / ↓, or focus a track and press Alt + Arrow. Select to inspect. Listen auditions that recording alone and sets playlist playback aside; ▶ Play from here plays the playlist in order from that track. Ctrl+Z undoes edits.</p>}
      {playable.length < draft.entries.length && <p className="quality-note">Unavailable recordings stay in the saved order and are skipped by Play playlist.</p>}
      <ol className="playlist-tracks" aria-label="Playlist recordings">{draft.entries.map((entry, index) => {
        const record = byId.get(entry.recording_id), warning = record ? predictorWarnings(record) : '', locked = locks.has(entry.entry_id);
        const isPlaying = playback?.entry_id === entry.entry_id && playback.recording_id === entry.recording_id;
        const queueIndex = playable.findIndex(item => item.entry_id === entry.entry_id);
        return <li key={entry.entry_id} data-entry-id={entry.entry_id} data-recording-id={entry.recording_id} aria-current={isPlaying ? 'true' : undefined}
          className={[selected === entry.entry_id && 'is-selected', isPlaying && 'is-playing', locked && 'is-locked', dragged === entry.entry_id && 'is-dragging', dropTarget === entry.entry_id && dragged !== entry.entry_id && 'is-drop-target'].filter(Boolean).join(' ')}
          draggable={!busy} onDragStart={event => { dragging.current = entry.entry_id; setDragged(entry.entry_id); select(entry); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', entry.entry_id); }}
          onDragEnd={() => { dragging.current = null; setDragged(null); setDropTarget(null); }} onDragOver={event => { if (!busy && dragging.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(entry.entry_id); } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
          onDrop={event => { event.preventDefault(); if (!busy && dragging.current) move(dragging.current, index); dragging.current = null; setDragged(null); setDropTarget(null); }}>
          <span className="playlist-grip" aria-hidden="true">⠿</span><span className="track-number">{String(index + 1).padStart(2, '0')}</span>
          <button className="playlist-track-select" ref={element => { if (element) rows.current.set(entry.entry_id, element); else rows.current.delete(entry.entry_id); }}
            aria-pressed={selected === entry.entry_id} onClick={() => select(entry)} onKeyDown={event => {
              if (!busy && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(entry.entry_id, index + (event.key === 'ArrowUp' ? -1 : 1)); }
            }}><strong>{locked && <span className="lock-mark">Locked · </span>}{record?.title ?? entry.title}</strong><span>{record ? <><i style={{ background: colorOf(record) }}/>{record.mood.label} · {timeLabel(record.duration_seconds)}{record.playback_status === 'unavailable' && ' · audio unavailable'}</> : 'Missing from this catalog'}</span>
            {isPlaying && <span className="playlist-playing-label">{playback.playing ? '▶ Playing' : 'Ⅱ Paused'} · captured queue position</span>}
            {comparison && record && <span className="playlist-slot-fit" data-slot-distance={comparison.distances[index]}>R {record.raw_rtp.R.toFixed(2)} · T {record.raw_rtp.T.toFixed(2)} · P {record.raw_rtp.P.toFixed(2)}
              {' · '}distance {comparison.distances[index]?.toFixed(3)} RTP units</span>}
            {warning && <span className="quality-note">Input-range warning · {warning}</span>}</button>
          <div className="playlist-track-actions"><span className="track-action-group"><button disabled={!record || record.playback_status === 'unavailable'} aria-label={`Listen to playlist track ${index + 1}`}
            title="Listen to this recording alone; playlist playback is set aside" onClick={() => record && onListen(record)}>Listen</button>
            <button className="play-from-here" disabled={queueIndex < 0} aria-label={`Play from here: playlist from track ${index + 1}`} title="Play the playlist in order from this track"
              onClick={() => onPlay(draft.name, playable, queueIndex)}><span aria-hidden="true">▶</span> Play from here</button></span>
            <span className="track-action-group"><button aria-pressed={locked} aria-label={`Lock position ${index + 1}`} title={locked ? 'Locked: kept when regenerating' : 'Lock this position when regenerating'} onClick={() => {
              history.commit(current => ({ ...current, locks: locked ? current.locks.filter(id => id !== entry.entry_id) : [...current.locks, entry.entry_id] }), `${locked ? 'unlock' : 'lock'} position ${index + 1}`);
              setNotice(locked ? `Position ${index + 1} unlocked` : `Position ${index + 1} locked for regeneration`);
            }}>{locked ? 'Locked' : 'Lock'}</button>
            <button aria-label={`Move playlist track ${index + 1} up`} disabled={busy || index === 0} onClick={() => move(entry.entry_id, index - 1)}>↑</button>
            <button aria-label={`Move playlist track ${index + 1} down`} disabled={busy || index === draft.entries.length - 1} onClick={() => move(entry.entry_id, index + 1)}>↓</button>
            <button aria-label={`Remove playlist track ${index + 1}`} disabled={busy || locked} title={locked ? 'Unlock to remove' : undefined} onClick={() => {
              edit(playlist => ({ ...playlist, entries: playlist.entries.filter(item => item.entry_id !== entry.entry_id) }), `remove “${record?.title ?? entry.title}”`,
                `Removed “${record?.title ?? entry.title}” · Undo restores it · unsaved changes`);
              if (selected === entry.entry_id) setSelected(null);
            }}>×</button></span></div>
        </li>;
      })}</ol>
      {selectedEntry && (locks.has(selectedEntry.entry_id) ? <p className="fine-print">Position {selectedIndex + 1} is locked. Unlock it to replace the recording.</p> :
        <Replacements key={selectedEntry.entry_id} index={selectedIndex} entry={selectedEntry} records={records} target={comparison?.targets[selectedIndex] ?? null}
          inPlaylist={inPlaylist} onListen={onListen} onUse={record => replace(selectedIndex, selectedEntry, record)}/>)}
      {draft.entries.length === 0 && <p className="playlist-empty">Your library is on the left. Use + beside a recording, add search or filter results, or drag a region in a 2D view.</p>}
    </section>
    </div>
  </section>;
});
