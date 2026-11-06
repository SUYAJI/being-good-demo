import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIError, bootstrap, postJSON, readJSON } from './api';
import { colorOf, moodColors, timeLabel, type SceneData, type Recording, type RTP } from './types';
import { SpatialScene, type SceneHandle, type CameraCommand, type CameraState } from './SpatialScene';
import { ListeningDock, type PlayerHandle } from './ListeningDock';
import { ProjectionView, boundText, type Projection, type Region } from './ProjectionView';
import { AtlasSlice } from './AtlasSlice';
import { FilterPanel, clearFilters, filterPayload, filtersActive, toggleMood } from './FilterPanel';
import { AboutPanel, CreditsPanel } from './AboutPanel';
import { PlaylistWorkspace, type PlaylistHandle, type WorkspaceSummary } from './PlaylistWorkspace';
import { RecordingCard, type Neighborhood } from './RecordingCard';
import { PlaylistDesigner, type Created, type Step, type Suggestion } from './PlaylistDesigner';
import { Intro, Welcome } from './Welcome';
import { rtpDistance } from './trajectoryDesign';
import type { PlaybackPosition } from './playlists';

export type SortKey = 'collection' | 'title' | 'mood' | 'R' | 'T' | 'P' | 'intensity' | 'duration' | 'distance';
const sortNames: Record<Exclude<SortKey, 'distance' | 'intensity'>, string> = { collection: 'Collection order', title: 'Title', mood: 'Mood', R: 'Rhythm', T: 'Texture',
  P: 'Pitch', duration: 'Duration' };
const axisNames = ['Rhythm', 'Texture', 'Pitch'], axisKeys = ['R', 'T', 'P'] as const;

/** Stable sort; recordings without a value (no intensity) stay last in either direction. */
export function sortRecords(records: Recording[], key: SortKey, descending: boolean, anchor?: RTP | null): Recording[] {
  if (key === 'collection') return descending ? [...records].reverse() : records;
  const value = (r: Recording): number | string | null => key === 'title' ? r.title : key === 'mood' ? r.mood.label :
    key === 'intensity' ? r.mood.intensity : key === 'duration' ? r.duration_seconds : key === 'distance' ? (anchor ? rtpDistance(r.raw_rtp, anchor) : null) : r.raw_rtp[key];
  return records.map((record, index) => ({ record, index, value: value(record) })).sort((a, b) => {
    if (a.value === null || b.value === null) return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
    const order = typeof a.value === 'string' ? a.value.localeCompare(b.value as string) : a.value - (b.value as number);
    return (descending ? -order : order) || a.index - b.index;
  }).map(item => item.record);
}

/** Rows show the recording's collection number (its place in the library), which stays the same under sorting and filtering. */
export function RecordingList({ records, selected, onSelect, onAdd, playing, paused = false, numbers }: { records: Recording[]; selected: string | null; onSelect: (id: string) => void;
  onAdd?: (record: Recording) => void; playing?: string | null; paused?: boolean; numbers?: Map<string, number> }) {
  const list = useRef<HTMLOListElement>(null);
  // Selecting in the field, the neighbors or the dock brings the recording into view here.
  useEffect(() => { if (selected) list.current?.querySelector<HTMLElement>(`[data-recording-id="${selected}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [selected, records]);
  return <ol ref={list} className="recording-list" aria-label="Recordings">{records.map((record, index) =>
    <li key={record.recording_id} className={onAdd ? 'can-add' : ''}><button data-select-recording data-recording-id={record.recording_id} aria-pressed={selected === record.recording_id}
      className={selected === record.recording_id ? 'selected' : ''} onClick={() => onSelect(record.recording_id)}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        const next = (index + offset + records.length) % records.length;
        const buttons = event.currentTarget.closest('ol')?.querySelectorAll<HTMLButtonElement>('button[data-select-recording]');
        buttons?.[next].focus(); onSelect(records[next].recording_id);
      }}>
      <span className="track-number">{String((numbers?.get(record.recording_id) ?? index) + 1).padStart(2, '0')}</span>
      <span className="track-copy"><strong>{playing === record.recording_id && (paused ? <span className="track-playing is-paused" aria-label="Paused">Ⅱ </span> :
        <span className="track-playing" aria-label="Now playing">▶ </span>)}{record.title}</strong><span><i style={{ background: colorOf(record) }}/>{record.mood.label}</span></span>
      <span className="track-duration">{timeLabel(record.duration_seconds)}</span>
    </button>{onAdd && <button className="add-to-playlist key" aria-label={`Add ${record.title} to playlist`} onClick={() => onAdd(record)}>+</button>}</li>)}</ol>;
}

type Toast = { message: string; actions: { label: string; run: () => void }[] };

/** Layout breakpoint (window width, so browser zoom applies naturally): the collection collapses to a rail. */
const compactQuery = '(min-width: 761px) and (max-width: 1279px)';
function useMedia(query: string) {
  const read = () => typeof matchMedia === 'function' && matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const list = matchMedia(query), change = () => setMatches(list.matches);
    change(); list.addEventListener?.('change', change); return () => list.removeEventListener?.('change', change);
  }, [query]);
  return matches;
}
type Layout = 'field' | 'beside';
type Stage = 'intro' | 'welcome' | 'app';
type Mode = 'explore' | 'design';
const stageKey = 'being-good-demo.stage', modeKey = 'being-good-demo.mode';
const remembered = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const remember = (key: string, value: string) => { try { sessionStorage.setItem(key, value); } catch { /* This tab only. */ } };

export default function App() {
  const [data, setData] = useState<SceneData | null>(null);
  const [error, setError] = useState('');
  // Returning within the same browser session goes straight back to work; a fresh visit opens with the mark and the welcome.
  const [stage, setStage] = useState<Stage>(() => remembered(stageKey) === 'app' ? 'app' : 'intro');
  const [mode, setMode] = useState<Mode>(() => remembered(modeKey) === 'design' ? 'design' : 'explore');
  const [step, setStep] = useState<Step>('start');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [shape, setShape] = useState<RTP[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(clearFilters);
  const [filterOpen, setFilterOpen] = useState(false), [aboutOpen, setAboutOpen] = useState(false), [creditsOpen, setCreditsOpen] = useState(false);
  const [matching, setMatching] = useState<string[] | null>(null), [updating, setUpdating] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [view, setView] = useState<'3D' | Projection | 'atlas'>('RT');
  const [frame, setFrame] = useState<'music' | 'full'>('music');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean; anchor: string | null }>({ key: 'collection', descending: false, anchor: null });
  const [neighborhood, setNeighborhood] = useState<Neighborhood | null>(null), [trail, setTrail] = useState<string[]>([]);
  const [atlasFocus, setAtlasFocus] = useState<{ rtp: RTP; title: string; key: number } | null>(null);
  const [showExcluded, setShowExcluded] = useState(false), [showPath, setShowPath] = useState(true);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>({ name: 'Untitled playlist', entries: [], dirty: false, targetDirty: false, saved: false });
  const [toast, setToast] = useState<Toast | null>(null);
  const nearestRequest = useRef<AbortController | null>(null), neighborhoodRef = useRef(neighborhood); neighborhoodRef.current = neighborhood;
  const scene = useRef<SceneHandle>(null); const player = useRef<PlayerHandle>(null);
  const playlist = useRef<PlaylistHandle>(null), toastHost = useRef<HTMLDivElement>(null);
  const camera = useRef<CameraState | null>(null);
  const [playback, setPlayback] = useState<PlaybackPosition | null>(null);
  const compact = useMedia(compactQuery), [drawer, setDrawer] = useState(false);
  useEffect(() => { if (!compact) setDrawer(false); }, [compact]);
  useEffect(() => { if (stage === 'app') remember(stageKey, 'app'); }, [stage]);
  useEffect(() => { remember(modeKey, mode); }, [mode]);
  const layout: Layout = mode === 'explore' ? 'field' : 'beside';
  const refresh = useCallback(async () => {
    const value = await readJSON<SceneData>('scene');
    setData(previous => previous?.revision === value.revision ? previous : value);
  }, []);
  useEffect(() => { let alive = true;
    bootstrap().then(value => { if (alive) setData(value); }).catch(exception => { if (alive) setError(exception.message); });
    return () => { alive = false; };
  }, []);
  const categories = useMemo(() => data?.categories ?? Object.keys(moodColors).map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })), [data]);
  useEffect(() => {
    if (!data || !filtersActive(filters)) { setMatching(null); setUpdating(false); return; }
    const controller = new AbortController(); setUpdating(true); setQueryError('');
    postJSON<{ revision: string; recording_ids: string[] }>('query', {
      scope: data.scope, revision: data.revision, ...filterPayload(filters, categories, data.intensity_available ?? true),
    }, controller.signal).then(result => {
      if (!controller.signal.aborted && result.revision === data.revision) { setMatching(result.recording_ids); setUpdating(false); }
    }).catch(async e => {
      if (controller.signal.aborted) return;
      if (e instanceof APIError && e.status === 409) {
        try { await refresh(); } catch (failure) { setQueryError((failure as Error).message); }
      } else setQueryError(e.message);
      setUpdating(false);
    });
    return () => controller.abort();
  }, [data, filters, categories, refresh]);
  // Neighbors follow their anchor, not the selection; new publications re-measure the same anchor.
  const loadNeighbors = useCallback(async (anchor: string) => {
    if (!data) return;
    nearestRequest.current?.abort(); const controller = new AbortController(); nearestRequest.current = controller;
    try {
      const result = await postJSON<{ neighbors: Neighborhood['neighbors'] }>('nearest', { scope: data.scope, revision: data.revision, recording_id: anchor, limit: 12 }, controller.signal);
      if (!controller.signal.aborted) setNeighborhood({ anchor, neighbors: result.neighbors });
    } catch (e) { if (!controller.signal.aborted) setQueryError((e as Error).message); }
  }, [data]);
  useEffect(() => { if (neighborhoodRef.current) void loadNeighbors(neighborhoodRef.current.anchor); }, [loadNeighbors]);
  useEffect(() => () => nearestRequest.current?.abort(), []);
  const showNeighbors = (anchor: string) => {
    const current = neighborhoodRef.current;
    if (current?.anchor === anchor) return;
    if (current) setTrail(previous => [...previous, current.anchor].slice(-20));
    void loadNeighbors(anchor);
  };
  const narrowed = filtersActive(filters) || !!search.trim();
  const record = data?.records.find(item => item.recording_id === selected);
  const filtered = useMemo(() => (data?.records ?? []).filter(r => (!filtersActive(filters) || matching === null || matching.includes(r.recording_id)) &&
    `${r.title} ${r.mood.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [data, filters, matching, search]);
  const visibleIds = useMemo(() => filtered.map(r => r.recording_id), [filtered]);
  const anchor = data?.records.find(r => r.recording_id === sort.anchor);
  const shown = useMemo(() => sortRecords(filtered, sort.key, sort.descending, anchor?.raw_rtp), [filtered, sort.key, sort.descending, anchor]);
  const pathIds = useMemo(() => showPath ? workspace.entries.map(entry => entry.recording_id) : [], [showPath, workspace.entries]);
  const numbers = useMemo(() => new Map((data?.records ?? []).map((r, index) => [r.recording_id, index])), [data]);
  const highlighted = useMemo(() => neighborhood ? [neighborhood.anchor, ...neighborhood.neighbors.map(n => n.recording_id)] : [], [neighborhood]);
  const reset = () => { setFilters(clearFilters()); setSearch(''); setQueryError(''); };
  const command = (name: CameraCommand) => scene.current?.command(name);
  const notify = (value: Toast) => setToast(value);
  useEffect(() => {
    if (!toast) return;
    const timer = setInterval(() => { if (!toastHost.current?.contains(document.activeElement)) setToast(null); }, 10000);
    return () => clearInterval(timer);
  }, [toast]);
  const playing = playback?.recording_id ?? null, paused = !!playback && !playback.playing;
  /** Choosing a recording while listening (not while a playlist plays) moves the listening along with it. */
  const select = (id: string) => {
    setSelected(id);
    if (playback?.playing && playback.entry_id === null && id !== playback.recording_id) {
      const next = data?.records.find(r => r.recording_id === id);
      if (next?.playback_status === 'available') player.current?.listen(next);
    }
  };
  const openDesigner = (next: Step = 'start') => { setMode('design'); setStep(next); setStage('app'); };
  const openExplorer = () => { setMode('explore'); setStage('app'); };
  const addToPlaylist = (records: Recording[]) => {
    const ids = playlist.current?.add(records);
    if (!ids?.length) return;
    notify({ message: `Added ${ids.length} recording${ids.length === 1 ? '' : 's'} to “${workspace.name}”`, actions: [
      { label: 'Undo', run: () => playlist.current?.remove(ids) },
      ...(layout === 'field' ? [{ label: 'Show playlist', run: () => openDesigner('playlist') }] : [])] });
  };
  const created = (value: Created) => { playlist.current?.create(value); setShowPath(true); };
  const saved = () => notify({ message: `“${workspace.name}” is saved in this browser.`, actions: [
    { label: 'Make another', run: () => openDesigner('start') }, { label: 'Explore the music', run: openExplorer }] });
  const filterRegion = (region: Region) => setFilters(current => ({ ...current,
    bounds: current.bounds.map((pair, index) => { const value = region[axisKeys[index]]; return value ? [String(value[0]), String(value[1])] : pair; }) }));
  const showAtlas = (item: Recording) => { setAtlasFocus({ rtp: item.historical_rtp, title: item.title, key: Date.now() }); setView('atlas'); };
  const locate = (item: Recording) => {
    setSelected(item.recording_id); setStage('app');
    if (!visibleIds.includes(item.recording_id)) notify({ message: `“${item.title}” is hidden by the current filters or search.`,
      actions: [{ label: 'Show it (clears filters and search)', run: reset }] });
    else if (view === '3D') setTimeout(() => scene.current?.command('center'));
  };
  const chips = [
    ...(filters.moods !== null ? [{ label: filters.moods.length ? `Moods: ${filters.moods.map(id => categories.find(c => c.id === id)?.label ?? id).join(', ')}` : 'No moods selected',
      remove: () => setFilters(current => ({ ...current, moods: null })) }] : []),
    ...(filters.minimum > 1 ? [{ label: `Intensity ≥ ${filters.minimum.toFixed(1)}`, remove: () => setFilters(current => ({ ...current, minimum: 1 })) }] : []),
    ...filters.bounds.flatMap((pair, index) => pair.some(Boolean) ? [{ label: `${axisNames[index]} ${boundText(pair)}`,
      remove: () => setFilters(current => ({ ...current, bounds: current.bounds.map((value, i) => i === index ? ['', ''] as [string, string] : value) })) }] : []),
    ...(search.trim() ? [{ label: `Search “${search.trim()}”`, remove: () => setSearch('') }] : []),
  ];
  const unsaved = workspace.dirty || workspace.targetDirty;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    addEventListener('beforeunload', warn); return () => removeEventListener('beforeunload', warn);
  }, [unsaved]);
  // The demonstration has no import path; a dropped file is explained rather than silently ignored.
  useEffect(() => {
    const files = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files');
    const over = (event: DragEvent) => { if (files(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => { if (!files(event)) return; event.preventDefault(); setToast({ message: 'This demonstration cannot add recordings.', actions: [] }); };
    addEventListener('dragover', over); addEventListener('drop', drop);
    return () => { removeEventListener('dragover', over); removeEventListener('drop', drop); };
  }, []);
  const sceneProps = { records: data?.records ?? [], visibleIds, selected, onSelect: select, playing, paused, showExcluded, path: pathIds };
  const thumbnails = useMemo(() => previewDots(data?.records ?? []), [data]);
  const showThumbs = !compact && layout === 'field';
  const selectedIndex = record ? data!.records.indexOf(record) : -1;
  const inView = useMemo(() => filtered, [filtered]);
  const openDrawer = (focus?: 'search' | 'sort') => {
    setDrawer(true);
    if (focus) setTimeout(() => document.getElementById(focus === 'search' ? 'search' : 'sort')?.focus());
  };
  const pathTitle = workspace.entries.length ? 'Your playlist’s path: numbers are playlist positions and lines join the recordings in order.'
    : 'Your playlist’s path appears here once a playlist has recordings.';
  const cameraKeys = <CameraKeys selected={!!selected} onCommand={command}/>;
  const entryCount = workspace.entries.length;
  const designerLabel = `Playlist Designer${entryCount ? ` · ${entryCount}` : ''}`;
  if (stage === 'intro') return <Intro onDone={() => setStage('welcome')}/>;
  return <div className={`app-shell stage-${stage}${compact ? ' is-compact' : ''}`}>
    <a className="skip-link" href="#main">Skip to main content</a>
    <header className="topbar"><a className="wordmark" href="#" aria-label="Being Good: back to the welcome" onClick={event => { event.preventDefault(); setStage('welcome'); }}>
      <span>being good<span className="wordmark-dot">.</span></span><span className="wordmark-sub">EXPLORER</span></a>
      {stage === 'app' && <div className="layout-controls segmented" role="group" aria-label="Mode">
        <button aria-pressed={mode === 'explore'} onClick={openExplorer}><i className={`led${mode === 'explore' ? ' on' : ''}`} aria-hidden="true"/>Explore</button>
        <button aria-pressed={mode === 'design'} onClick={() => openDesigner(entryCount ? 'playlist' : step)}><i className={`led${mode === 'design' ? ' on' : ''}`} aria-hidden="true"/>{designerLabel}
          {workspace.dirty && <span className="unsaved-mark" aria-hidden="true"> ●</span>}{workspace.dirty && <span className="sr-only">, unsaved changes</span>}</button></div>}
      <div className="header-actions"><span className="local-status" title="Every recording was analyzed offline by the original Being Good engine. Nothing here changes those results."><i className="led ok" aria-hidden="true"/>{data ? `${data.count} RECORDINGS` : ''}</span>
        <button className="key" onClick={() => setAboutOpen(true)}>How it works</button></div></header>
    {stage === 'welcome' && <main id="main" className="welcome-main"><Welcome records={data?.records ?? []} categories={categories} onCreate={() => openDesigner('start')} onExplore={openExplorer}
      onSuggest={value => { setSuggestion({ ...value }); openDesigner('playlist'); }} onAbout={() => setAboutOpen(true)}/>
      {error && <p role="alert" className="launch-error welcome-error">{error}</p>}</main>}
    {stage === 'app' && <main id="main" className={`workspace layout-${layout}`}>
      {compact && <nav className="collection-rail" aria-label="Collection (collapsed)">
        <div className="rail-key"><button className="key" aria-label={`${drawer ? 'Close' : 'Open'} collection, ${data?.count ?? 0} recordings`} aria-expanded={drawer} aria-controls="recordings" onClick={() => setDrawer(value => !value)}>
          <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true"><path d="M0 1 h16 M0 6 h16 M0 11 h16" stroke="currentColor" strokeWidth="1.6"/></svg><span className="mono">{data ? shown.length : '–'}</span></button><span aria-hidden="true">LIST</span></div>
        <div className="rail-key"><button className="key" aria-label="Search recordings" onClick={() => openDrawer('search')}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M10.5 10.5 L15 15" stroke="currentColor" strokeWidth="1.6"/></svg></button><span aria-hidden="true">FIND</span></div>
        <div className="rail-key"><button className="key" aria-label={`Mood & RTP filters, ${filtersActive(filters) ? `${chips.length} active` : 'none active'}`} aria-expanded={filterOpen} disabled={!data} onClick={() => setFilterOpen(true)}>
          <i className={`led${filtersActive(filters) ? ' on' : ''}`} aria-hidden="true"/><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 2 h12 l-4.5 5 v5 l-3 -1.5 v-3.5 z" fill="none" stroke="currentColor" strokeWidth="1.4"/></svg></button><span aria-hidden="true">FILTER</span></div>
        <div className="rail-key"><button className="key" aria-label="Sort recordings" onClick={() => openDrawer('sort')}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 1 v12 M1 10 l3 3 l3 -3 M10 13 v-12 M7 4 l3 -3 l3 3" fill="none" stroke="currentColor" strokeWidth="1.4"/></svg></button><span aria-hidden="true">SORT</span></div>
        <div className="rail-spacer"/>
        {record && <button className={`key rail-selected${playing === record.recording_id ? ' is-loaded' : ''}`} title={`Selected${playing === record.recording_id ? paused ? ' · paused' : ' · now playing' : ''}`}
          aria-label={`Show ${record.title} in the collection${playing === record.recording_id ? paused ? ', paused' : ', now playing' : ''}`} onClick={() => openDrawer()}>
          {playing === record.recording_id && <span className="rail-play" aria-hidden="true">{paused ? 'Ⅱ' : '▶'}</span>}<span className="mono">{String(selectedIndex + 1).padStart(2, '0')}</span></button>}
      </nav>}
      <section className={`collection-panel${compact ? ` is-drawer${drawer ? ' is-open' : ''}` : ''}`} id="recordings" aria-label="Collection" tabIndex={-1}
        onKeyDown={event => { if (compact && event.key === 'Escape') { setDrawer(false); } }}>
        <div className="collection-head">
          <div className="collection-heading"><span className="panel-title">COLLECTION</span><span className="mono muted" aria-live="polite">{data ? `${shown.length} / ${data.count}` : '—'}</span>
            {compact && <button className="key key-small" onClick={() => setDrawer(false)} aria-label="Close collection">×</button>}</div>
          <div className="collection-tools"><label className="sr-only" htmlFor="search">Search recordings</label><input id="search" type="search" placeholder="Search titles" value={search} onChange={e => setSearch(e.target.value)}/>
            <div className="collection-keys"><button className="key filter-key" onClick={() => setFilterOpen(true)} disabled={!data} aria-expanded={filterOpen} aria-label={`Mood & RTP filters${filtersActive(filters) ? ' · active' : ''}`}>
              <i className={`led${filtersActive(filters) ? ' on' : ''}`} aria-hidden="true"/>Moods{filtersActive(filters) && <span className="mono"> · {chips.length - (search.trim() ? 1 : 0)}</span>}</button>
              <div className="sort-control"><label><span className="sr-only">Sort</span><select id="sort" className="key" aria-label="Sort recordings" value={sort.key} disabled={!data} onChange={event => {
                const key = event.target.value as SortKey; setSort(current => ({ ...current, key, anchor: key === 'distance' ? selected : current.anchor }));
              }}>{(Object.keys(sortNames) as (keyof typeof sortNames)[]).map(key => <option key={key} value={key}>Sort: {sortNames[key]}</option>)}
                <option value="distance" disabled={!selected && !anchor}>Sort: {anchor ? `nearest to “${anchor.title}”` : 'nearest to selected'}</option></select></label>
                <button className="key sort-direction" aria-label={sort.descending ? 'Sort descending; switch to ascending' : 'Sort ascending; switch to descending'} onClick={() => setSort(current => ({ ...current, descending: !current.descending }))}>{sort.descending ? '↓' : '↑'}</button></div></div>
            {sort.key === 'distance' && selected && selected !== sort.anchor && <button className="sort-anchor key key-small" onClick={() => setSort(current => ({ ...current, anchor: selected }))}>Measure from selected</button>}</div>
          {data && chips.length > 0 && <div className="active-filters" role="group" aria-label="Active filters">
            {chips.map(chip => <button key={chip.label} className="filter-chip" aria-label={`Remove filter: ${chip.label}`} onClick={chip.remove}>{chip.label} <span aria-hidden="true">×</span></button>)}
            <button className="key key-small" onClick={reset}>Clear all</button></div>}
          {data && narrowed && <button className="add-results key key-small" disabled={!shown.length} onClick={() => addToPlaylist(shown)}>+ Add {shown.length} results to playlist</button>}
        </div>
        {updating && <p role="status" className="fine-print collection-note">Updating filters…</p>}
        {queryError && <p role="alert" className="launch-error">{queryError}</p>}
        {data && <RecordingList records={shown} selected={selected} onSelect={select} onAdd={item => addToPlaylist([item])} playing={playing} paused={paused}
          numbers={numbers}/>}
        {data && shown.length === 0 && data.count > 0 && !updating && <div className="empty-view" role="status"><p>No recordings match this view.</p><button className="key" onClick={reset}>Clear filters and search</button></div>}
        {data?.count === 0 && <p className="collection-note">No recordings are published yet.</p>}
        {!data && !error && <p role="status" className="collection-note">Opening the collection…</p>}
        {error && <p role="alert" className="launch-error">{error}</p>}
      </section>
      <section className={`field-panel layout-${layout}`} aria-label="Perceptual environment">
        {<div className="field-toolbar">
          {!compact && <span className="panel-title">RTP FIELD</span>}
          <div className="view-controls segmented" role="group" aria-label="Field view">{(['RT', 'RP', 'TP', '3D', 'atlas'] as const).map(mode =>
            <button key={mode} aria-pressed={view === mode} aria-label={mode === 'atlas' ? 'Mood atlas' : mode === '3D' ? '3D field' : `2D ${mode[0]}–${mode[1]}`}
              onClick={() => setView(mode)}><i className={`led${view === mode ? ' on' : ''}`} aria-hidden="true"/>
              {showThumbs && mode !== 'atlas' && <ViewPreview dots={thumbnails[mode]} active={view === mode}/>}
              <span aria-hidden="true">{mode === 'atlas' ? 'ATLAS' : mode === '3D' ? '3D' : `${mode[0]}–${mode[1]}`}</span></button>)}</div>
          {compact && view === '3D' && cameraKeys}
          <div className="toolbar-spacer"/>
          {view !== 'atlas' && <div className="field-options" role="group" aria-label="Field context">
            {view !== '3D' && <button className="key key-small" aria-pressed={frame === 'full'} aria-label="Show the full 1 to 5 scale" title={frame === 'full' ? 'Showing the whole 1–5 scale. Click to zoom back to the music.' : 'Zoomed to where the music is. Click to show the whole 1–5 scale.'}
              onClick={() => setFrame(value => value === 'full' ? 'music' : 'full')}><i className={`led${frame === 'full' ? ' on' : ''}`} aria-hidden="true"/>FULL SCALE</button>}
            {narrowed && <button className="key key-small" aria-pressed={showExcluded} aria-label="Show hidden recordings faintly"
              title="Show recordings hidden by filters or search as faint hollow circles. They cannot be selected."
              onClick={() => setShowExcluded(value => !value)}><i className={`led${showExcluded ? ' on' : ''}`} aria-hidden="true"/>HIDDEN</button>}
            <button className="key key-small" aria-pressed={showPath && workspace.entries.length > 0} disabled={!workspace.entries.length} aria-label="Playlist path"
              aria-describedby="path-description" title={pathTitle} onClick={() => setShowPath(value => !value)}><i className={`led${pathIds.length ? ' on' : ''}`} aria-hidden="true"/>PATH</button>
            <span id="path-description" className="sr-only">{pathTitle}</span></div>}
        </div>}
        <div className={`field-viewport layout-${layout}`}>
          {data && <div className="field-stage">
            {view === '3D' && <SpatialScene ref={scene} {...sceneProps} camera={camera} onUnavailable={() => setView('RT')}/>}
            {['RT', 'RP', 'TP'].includes(view) && <ProjectionView {...sceneProps} axes={view as Projection} bounds={filters.bounds} frame={frame} highlighted={highlighted} targetPath={shape ?? undefined}
              onFilterRegion={filterRegion} onAddRegion={ids => addToPlaylist(data.records.filter(r => ids.includes(r.recording_id)))}/>}
            {view === 'atlas' && <AtlasSlice key={atlasFocus?.key ?? 0} scope={data.scope} focus={atlasFocus} records={data.records} onSelect={select}/>}
          </div>}
        </div>
        {view !== 'atlas' && <div className="field-strip">
          {pathIds.length > 0 && <p className="path-legend" role="note" aria-label="Playlist path legend">
            <span className="label-caps"><svg width="30" height="12" viewBox="0 0 30 12" aria-hidden="true"><line x1="5" y1="6" x2="25" y2="6"/><rect x=".5" y="1.5" width="9" height="9"/><rect x="20.5" y="1.5" width="9" height="9"/></svg>
              PATH · {workspace.name} · {pathIds.length}</span>
            <span>Numbers are playlist positions; lines join the recordings in order.</span></p>}
          <div className="mood-key" role="group" aria-label="Mood key: click to hide or show a mood, Alt-click to show only that mood">
            <span className="label-caps muted">MOOD</span>{categories.map(({ id, label }) => {
            const included = filters.moods === null || filters.moods.includes(id), count = data?.records.filter(r => r.mood.id === id).length ?? 0;
            return <button key={id} aria-pressed={included} title="Click to hide or show · Alt-click to show only this mood"
              onClick={event => setFilters(current => toggleMood(current, id, categories, event.altKey))}><i style={{ background: moodColors[id] ?? '#889999' }}/>{label}<span className="mood-count mono">{count}</span></button>; })}</div>
          {!compact && <div className="strip-bottom">
            <p className="field-caption mono">{view === '3D' ? `${shown.length} RECORDINGS · DRAG TO ORBIT · ARROWS PAN · COLOUR = MOOD` :
              `${shown.length} RECORDINGS · CLICK A DOT TO SELECT · DRAG ON EMPTY SPACE TO CHOOSE A REGION`}</p>
            {view === '3D' && cameraKeys}</div>}
        </div>}
      </section>
      <aside className={`right-column layout-${layout}`} aria-label={mode === 'explore' ? 'Selected recording' : 'Playlist Designer'}>
        {mode === 'explore' && <RecordingCard record={record} index={selectedIndex} total={data?.count ?? 0} inView={inView} playback={playback}
          onListen={item => player.current?.listen(item)} onPause={() => player.current?.pause()} onResume={() => player.current?.resume()}
          records={data?.records ?? []} onSelect={select}
          outside={!!selected && !visibleIds.includes(selected)} onAdd={item => addToPlaylist([item])} neighborhood={neighborhood} previousAnchor={trail.at(-1) ?? null}
          onNeighbors={showNeighbors} onBack={() => { const previous = trail.at(-1); if (!previous) return; setTrail(t => t.slice(0, -1)); void loadNeighbors(previous); }}
          onHide={() => { setNeighborhood(null); setTrail([]); }} onAtlas={showAtlas}/>}
        {mode === 'design' && data && <div className="designer-column">
          <PlaylistDesigner records={data.records} categories={categories} selectedId={selected} suggestion={suggestion} hasPlaylist={entryCount > 0}
            step={step} onStep={setStep} onSelect={id => { const item = data.records.find(r => r.recording_id === id); if (item) locate(item); }} onCreate={created} onExplore={openExplorer} onSuggestionUsed={() => setSuggestion(null)} onShape={setShape}/>
        </div>}
        {data && <div className="playlist-host" hidden={mode !== 'design' || step !== 'playlist'}><PlaylistWorkspace ref={playlist} records={data.records} onSelect={setSelected} playback={playback}
          onChange={setWorkspace} onReshape={() => setStep('shape')} onSaved={saved}
          onListen={item => player.current?.listen(item)} onPlay={(name, entries, start) => player.current?.playPlaylist(name, entries, start)}/></div>}
      </aside>
    </main>}
    <ListeningDock ref={player} visibleIds={visibleIds} onPlaybackChange={setPlayback} onLocate={locate}/>
    <FilterPanel open={filterOpen} onClose={() => setFilterOpen(false)} value={filters} onApply={setFilters} categories={categories} intensity={data?.intensity_available ?? false}
      matching={narrowed ? shown.length : null} total={data?.count}/>
    <AboutPanel open={aboutOpen} onClose={() => setAboutOpen(false)} records={data?.records ?? []} onCredits={() => setCreditsOpen(true)}
      onListen={item => { locate(item); openExplorer(); player.current?.listen(item); }}/>
    <CreditsPanel open={creditsOpen} onClose={() => setCreditsOpen(false)} records={data?.records ?? []} onSelect={id => { const item = data?.records.find(r => r.recording_id === id); if (item) { locate(item); openExplorer(); } }}/>
    {toast && <div ref={toastHost} className="toast" role="status">{toast.message}{toast.actions.map(action =>
      <button key={action.label} className="key key-small" onClick={() => { action.run(); setToast(null); }}>{action.label}</button>)}<button className="key key-small" aria-label="Dismiss message" onClick={() => setToast(null)}>✕</button></div>}
    <div className="selection-announcement sr-only" aria-live="polite">{record ? `Selected ${record.title}, ${record.mood.label}` : ''}</div>
  </div>;
}

type Dot = { x: number; y: number };
/** Miniature previews plot the same raw coordinates as the field (at most 240, evenly sampled), never decoration. */
function previewDots(records: Recording[]): Record<'3D' | Projection, Dot[]> {
  const step = Math.max(1, Math.ceil(records.length / 240)), sample = records.filter((_, index) => index % step === 0);
  const flat = (a: 'R' | 'T' | 'P', b: 'R' | 'T' | 'P') => sample.map(r => ({ x: 3 + (Math.max(.6, Math.min(5.6, r.raw_rtp[a])) - .6) / 5 * 28,
    y: 21 - (Math.max(.6, Math.min(5.6, r.raw_rtp[b])) - .6) / 5 * 18 }));
  return { '3D': sample.map(r => { const u = (r.raw_rtp.R - 1) / 4, v = (r.raw_rtp.T - 1) / 4, z = (r.raw_rtp.P - 1) / 4;
    return { x: Math.max(1, Math.min(33, 17 + (u - v) * 11)), y: Math.max(1, Math.min(23, 13 + (u + v) * 4 - z * 9)) }; }),
  RT: flat('R', 'T'), RP: flat('R', 'P'), TP: flat('T', 'P') };
}

function ViewPreview({ dots, active }: { dots: Dot[]; active: boolean }) {
  return <svg className={`view-preview${active ? ' is-active' : ''}`} width="34" height="24" viewBox="0 0 34 24" aria-hidden="true">
    <rect x=".5" y=".5" width="33" height="23"/>{dots.map((dot, index) => <circle key={index} cx={dot.x} cy={dot.y} r="1.2"/>)}</svg>;
}

const cameraList: [CameraCommand, string, string, string][] = [['fit', '⤢', 'FIT', 'Fit recordings'], ['center', '◎', 'CENTER', 'Center selected'],
  ['left', '↶', 'ROT L', 'Rotate view left'], ['right', '↷', 'ROT R', 'Rotate view right'], ['out', '−', 'ZOOM', 'Zoom out'], ['in', '+', 'ZOOM', 'Zoom in'],
  ['top', '▭', 'TOP', 'Top view'], ['front', '▯', 'FRONT', 'Front view'], ['side', '◫', 'SIDE', 'Side view'], ['reset', '⟲', 'RESET', 'Reset view']];

/** Six camera keys in a row; the fixed views and reset wait in a small menu. */
function CameraKeys({ selected, onCommand }: { selected: boolean; onCommand: (name: CameraCommand) => void }) {
  const key = ([name, glyph, , aria]: typeof cameraList[number]) => <div key={name} className="camera-key">
    <button className="key" aria-label={aria} title={aria} disabled={name === 'center' && !selected} onClick={() => onCommand(name)}>{glyph}</button></div>;
  return <div className="camera-controls is-compact" role="group" aria-label="Camera controls"><span className="label-caps muted" aria-hidden="true">CAMERA</span>
    {cameraList.slice(0, 6).map(key)}
    <details className="camera-more"><summary className="key" aria-label="More camera views" title="Top, front, side and reset">⋯</summary>
      <div className="camera-menu">{cameraList.slice(6).map(([name, glyph, , aria]) => <button key={name} className="key key-small" onClick={event => {
        onCommand(name); (event.currentTarget.closest('details') as HTMLDetailsElement).open = false; }}>{glyph} {aria}</button>)}</div></details></div>;
}
