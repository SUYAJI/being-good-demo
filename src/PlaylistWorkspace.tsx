import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { postJSON, readJSON } from './api';
import { colorOf, timeLabel, type Recording, type RTP } from './types';
import { emptyPlaylist, moveEntry, playlistPayload, predictorWarnings, type PlaybackPosition, type Playlist, type PlaylistEntry, type QueueEntry } from './playlists';
import { PlaylistTrajectory } from './PlaylistTrajectory';
import { compareSequence, regenerateUnlocked, rtpDistance, type Generation } from './trajectoryDesign';
import type { Created } from './PlaylistDesigner';
import { undoKey, useHistory } from './history';

export type PlaylistHandle = { add: (records: Recording[]) => string[] | null; remove: (entryIds: string[]) => void; create: (created: Created) => void };
export type WorkspaceSummary = { name: string; entries: PlaylistEntry[]; dirty: boolean; targetDirty: boolean; saved: boolean };
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
    <p className="replacements-title"><strong>Try a different recording at {index + 1}</strong><span className="fine-print">Closest first to {target ? 'this point on your shape' : current ? `“${current.title}”` : 'the start of the list'}.</span></p>
    <ol>{ranked.slice(0, limit).map(({ record, distance }) => <li key={record.recording_id}>
      <span><strong>{record.title}</strong><small><i style={{ background: colorOf(record) }}/>{record.mood.label}{inPlaylist.has(record.recording_id) && ' · already in playlist'}</small></span>
      <button aria-label={`Audition ${record.title}`} onClick={() => onListen(record)}>Listen</button>
      <button aria-label={`Use ${record.title} at position ${index + 1}`} onClick={() => onUse(record)}>Use</button></li>)}</ol>
    {ranked.length > limit && <button onClick={() => setLimit(value => value + 8)}>Show more</button>}
  </section>;
}

export const PlaylistWorkspace = forwardRef<PlaylistHandle, {
  records: Recording[]; onSelect: (id: string) => void; onListen: (record: Recording) => void;
  onPlay: (name: string, entries: QueueEntry[], start?: number) => void;
  playback?: PlaybackPosition | null; compact?: boolean; onOpenFull?: () => void; onChange?: (summary: WorkspaceSummary) => void; onReshape?: () => void; onSaved?: () => void;
}>(function PlaylistWorkspace({ records, onSelect, onListen, onPlay, playback, compact = false, onOpenFull, onChange, onReshape, onSaved }, ref) {
  const [saved, setSaved] = useState<Playlist[]>([]);
  const history = useHistory(initialWork), work = history.value, draft = work.draft, generation = work.generation;
  const [baseline, setBaseline] = useState<string | null>(() => payloadKey(emptyPlaylist()));
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState<{ type: 'open'; playlist: Playlist; generation?: Generation; locks?: string[] } | { type: 'delete' } | null>(null);
  const key = payloadKey(draft), dirty = baseline === null || key !== baseline, untouched = work.origin !== null && key === work.origin;
  useEffect(() => { onChange?.({ name: draft.name, entries: draft.entries, dirty, targetDirty: false, saved: !!draft.id && !dirty }); }, [draft.name, draft.entries, dirty, draft.id, onChange]);
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
    create: created => generated(created.result, created.target, created.name, created.locks),
  }));
  function select(entry: PlaylistEntry) {
    setSelected(entry.entry_id);
    onSelect(entry.recording_id);
  }
  function open(playlist: Playlist, generated?: Generation, keepHistory = false, lockIds: string[] = []) {
    const opened = { ...playlist, entries: [...playlist.entries] };
    const locked = opened.entries.filter(entry => lockIds.includes(entry.recording_id)).map(entry => entry.entry_id);
    const next: Work = { draft: opened, generation: generated ?? null, locks: locked, origin: generated ? payloadKey(opened) : null };
    // Replacing an untouched generated draft is one undoable step, so the previous generation is never lost.
    if (keepHistory) history.commit(() => next, 'regenerate playlist'); else history.reset(next);
    setBaseline(generated ? null : payloadKey(opened)); setSelected(generated ? opened.entries[0]?.entry_id ?? null : null);
    if ((generated || playlist.target) && opened.entries[0]) onSelect(opened.entries[0].recording_id);
    setPending(null); setFailure(''); setNotice(generated ? (keepHistory ? 'New playlist created · the previous one is one Undo away · not saved yet' : 'Playlist created · not saved yet') : playlist.id ?
      'Saved playlist opened' : 'New playlist');
  }
  function requestOpen(playlist: Playlist, generated?: Generation, lockIds: string[] = []) {
    // Only an untouched generated draft is replaced without asking, and only by another generation.
    if (generated && untouched) open(playlist, generated, true, lockIds);
    else if (dirty) setPending({ type: 'open', playlist, generation: generated, locks: lockIds }); else open(playlist, generated, false, lockIds);
  }
  function generated(result: Generation, target: Playlist['target'], name: string, lockIds: string[] = []) {
    requestOpen({ ...emptyPlaylist(), name, target, entries: result.recordings.map(record => ({
      entry_id: crypto.randomUUID(), recording_id: record.recording_id, title: record.title,
    })) }, result, lockIds);
  }
  async function save() {
    setBusy(true); setFailure('');
    try {
      const result = await postJSON<Playlist>(draft.id ? `playlists/${draft.id}` : 'playlists', playlistPayload(draft));
      setSaved(previous => [result, ...previous.filter(playlist => playlist.id !== result.id)]);
      // Undo after saving keeps the saved identity and revision, so it can never create a duplicate.
      history.rebase(current => ({ ...current, draft: { ...current.draft, id: result.id, revision: result.revision }, origin: null }));
      history.replace(current => ({ ...current, draft: result }));
      setBaseline(payloadKey(result)); setNotice('Saved in this browser'); onSaved?.();
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
    setNotice(`Swapped ${plural(fixed.filter(value => !value).length, 'recording')} · ${plural(locks.size, 'kept recording')} stayed · unsaved changes`); setFailure('');
  }
  const selectedIndex = draft.entries.findIndex(entry => entry.entry_id === selected);
  const selectedEntry = draft.entries[selectedIndex];
  return <section className={`playlist-workspace${dirty ? ' is-dirty' : ''}${compact ? ' is-compact' : ''}`} aria-label="Playlist workspace" onKeyDown={event => {
    const action = undoKey(event); if (!action || busy) return;
    event.preventDefault(); history[action](); setNotice(action === 'undo' ? 'Undone' : 'Redone');
  }}>
    <div className="playlist-modes"><span className="eyebrow">YOUR PLAYLIST</span>
      {compact && onOpenFull && <button onClick={onOpenFull}>Full workspace</button>}</div>
    <div className="playlist-library"><label>Saved playlists<select aria-label="Open saved playlist" disabled={busy || !loaded}
      value={draft.id ?? ''} onChange={event => { const value = saved.find(playlist => playlist.id === event.target.value); if (value) requestOpen(value); }}>
      <option value="">{saved.length ? 'Open a saved playlist…' : 'Nothing saved yet'}</option>{saved.map(playlist => <option key={playlist.id} value={playlist.id!}>{playlist.name} · {playlist.entries.length}</option>)}
    </select></label>{!compact && <button disabled={busy} onClick={() => requestOpen(emptyPlaylist())}>New playlist</button>}</div>
    <div className="playlist-titlebar"><label className="playlist-name"><span className="sr-only">Playlist name</span><input aria-label="Playlist name" maxLength={100}
      disabled={busy} value={draft.name} onChange={event => { const name = event.target.value; edit(playlist => ({ ...playlist, name }), 'rename playlist', 'Unsaved changes', 'name'); }}/></label>
      <button className="playlist-save" disabled={busy || !loaded || !draft.name.trim() || (!dirty && !!draft.id)} onClick={save}>{busy ? 'Saving…' : 'Save playlist'}</button>
      <button disabled={busy || !history.undoLabel} aria-label="Undo playlist edit" title={history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : undefined} onClick={() => { history.undo(); setNotice('Undone'); }}>↶</button>
      <button disabled={busy || !history.redoLabel} aria-label="Redo playlist edit" title={history.redoLabel ? `Redo ${history.redoLabel} (Ctrl+Shift+Z)` : undefined} onClick={() => { history.redo(); setNotice('Redone'); }}>↷</button>
      {!compact && <button disabled={busy || (!draft.id && !dirty)} onClick={() => setPending({ type: 'delete' })}>Delete</button>}</div>
    {pending && <div className="playlist-confirm" role="group" aria-label="Confirm playlist action">
      <span>{pending.type === 'delete' ? `Delete “${draft.name}”? Recordings stay in the library.` : 'This playlist has unsaved changes.'}</span>
      {pending.type === 'open' ? <><button disabled={busy} onClick={async () => { if (await save()) open(pending.playlist, pending.generation, false, pending.locks); }}>Save and open</button>
        <button disabled={busy} onClick={() => open(pending.playlist, pending.generation, false, pending.locks)}>Discard and open</button></> :
        <button disabled={busy} onClick={removePlaylist}>Delete playlist</button>}
      <button disabled={busy} onClick={() => setPending(null)}>Cancel</button></div>}
    <div className="playlist-status" data-state={busy ? 'saving' : dirty ? 'dirty' : draft.id ? 'saved' : 'new'}><span role="status">{notice || (loaded ? 'Add recordings with + in the collection, or create a playlist in the Playlist Designer.' : 'Opening saved playlists…')}</span>
      <span>{draft.entries.length} recordings · {timeLabel(playable.reduce((sum, entry) => sum + entry.recording.duration_seconds, 0))}</span></div>
    {failure && <p className="playlist-error" role="alert">{failure}</p>}
    {comparison && draft.target && <div className="generation-fit" ref={fitHeading} aria-label="How the playlist follows your shape">
      <div><span className="eyebrow">FOLLOWING YOUR SHAPE</span><strong data-mean-distance={comparison.mean ?? ''}>{comparison.mean === null ? '—' : comparison.mean < .35 ? 'Closely' : comparison.mean < .7 ? 'Loosely' : 'Roughly'}
        <small>{comparison.mean === null ? '' : `${comparison.mean.toFixed(2)} RTP units off on average`}</small></strong></div>
      {generation && generation.meanDistance !== null && generation.meanDistance > .7 && <p className="coverage-note">This collection thins out along parts of your shape, so some recordings sit a little off it.</p>}
      <div className="regenerate-row"><button disabled={busy || locks.size === draft.entries.length} onClick={regenerate}>Try different recordings</button>
        {onReshape && <button onClick={onReshape}>Change the shape</button>}
        <span className="fine-print">{locks.size ? `${plural(locks.size, 'recording')} kept in place. ` : 'Keep any recording to hold it in place. '}The rest are swapped for other recordings near the same points.</span></div>
      <details className="fit-details"><summary>Details</summary><p className="fine-print">{comparison.measured} of {draft.entries.length} positions measured against {draft.target.waypoints.length} waypoints
        {generation && <>; {generation.eligible} playable candidates; mean distance when created {generation.meanDistance?.toFixed(3)}</>}.
        Distance is Euclidean in raw Rhythm, Texture and Pitch. It measures geometry, not how the transitions sound.{generation?.notices.length ? ` ${generation.notices.join(' ')}` : ''}</p></details>
    </div>}
    <div className="playlist-composition">
      {!compact && <PlaylistTrajectory entries={draft.entries} records={byId} selected={selected} onSelect={select} playback={playback} targets={comparison?.targets}/>}
      <section className="playlist-order" aria-label="Sequence editor">
      <div className="playlist-sequence-heading"><h2>Listening order</h2><button className="primary" disabled={!playable.length} onClick={() => onPlay(draft.name, playable)}>▶ Play playlist</button></div>
      {!compact && <p className="playlist-help">Drag to reorder, or use the arrows. Select a recording to swap it for another. Listen plays one recording on its own; Play from here plays the playlist from that point. Ctrl+Z undoes edits.</p>}
      {playable.length < draft.entries.length && <p className="quality-note">Recordings without audio stay in the order and are skipped by Play playlist.</p>}
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
            }}><strong>{locked && <span className="lock-mark">Kept · </span>}{record?.title ?? entry.title}</strong><span>{record ? <><i style={{ background: colorOf(record) }}/>{record.mood.label} · {timeLabel(record.duration_seconds)}{record.playback_status === 'unavailable' && ' · audio unavailable'}</> : 'Missing from this catalog'}</span>
            {isPlaying && <span className="playlist-playing-label">{playback.playing ? '▶ Playing' : 'Ⅱ Paused'}</span>}
            {comparison && record && <span className="playlist-slot-fit" data-slot-distance={comparison.distances[index]}>R {record.raw_rtp.R.toFixed(1)} · T {record.raw_rtp.T.toFixed(1)} · P {record.raw_rtp.P.toFixed(1)}
              {comparison.distances[index] != null && comparison.distances[index]! > .7 && ' · a little off the shape'}</span>}
            {warning && <span className="quality-note">Input-range warning · {warning}</span>}</button>
          <div className="playlist-track-actions"><span className="track-action-group"><button disabled={!record || record.playback_status === 'unavailable'} aria-label={`Listen to playlist track ${index + 1}`}
            title="Listen to this recording on its own" onClick={() => record && onListen(record)}>Listen</button>
            <button className="play-from-here" disabled={queueIndex < 0} aria-label={`Play from here: playlist from track ${index + 1}`} title="Play the playlist in order from this track"
              onClick={() => onPlay(draft.name, playable, queueIndex)}><span aria-hidden="true">▶</span> Play from here</button></span>
            <span className="track-action-group"><button aria-pressed={locked} aria-label={`Lock position ${index + 1}`} title={locked ? 'Kept: stays when you try different recordings' : 'Keep this recording when trying different ones'} onClick={() => {
              history.commit(current => ({ ...current, locks: locked ? current.locks.filter(id => id !== entry.entry_id) : [...current.locks, entry.entry_id] }), `${locked ? 'unlock' : 'lock'} position ${index + 1}`);
              setNotice(locked ? `Position ${index + 1} can change again` : `Position ${index + 1} kept`);
            }}>{locked ? 'Kept' : 'Keep'}</button>
            <button aria-label={`Move playlist track ${index + 1} up`} disabled={busy || index === 0} onClick={() => move(entry.entry_id, index - 1)}>↑</button>
            <button aria-label={`Move playlist track ${index + 1} down`} disabled={busy || index === draft.entries.length - 1} onClick={() => move(entry.entry_id, index + 1)}>↓</button>
            <button aria-label={`Remove playlist track ${index + 1}`} disabled={busy || locked} title={locked ? 'Unlock to remove' : undefined} onClick={() => {
              edit(playlist => ({ ...playlist, entries: playlist.entries.filter(item => item.entry_id !== entry.entry_id) }), `remove “${record?.title ?? entry.title}”`,
                `Removed “${record?.title ?? entry.title}” · Undo restores it · unsaved changes`);
              if (selected === entry.entry_id) setSelected(null);
            }}>×</button></span></div>
        </li>;
      })}</ol>
      {selectedEntry && (locks.has(selectedEntry.entry_id) ? <p className="fine-print">Position {selectedIndex + 1} is kept in place. Release it to swap the recording.</p> :
        <Replacements key={selectedEntry.entry_id} index={selectedIndex} entry={selectedEntry} records={records} target={comparison?.targets[selectedIndex] ?? null}
          inPlaylist={inPlaylist} onListen={onListen} onUse={record => replace(selectedIndex, selectedEntry, record)}/>)}
      {draft.entries.length === 0 && <p className="playlist-empty">Nothing here yet. Create a playlist with the Designer above, or add recordings with + in the collection.</p>}
    </section>
    </div>
  </section>;
});
