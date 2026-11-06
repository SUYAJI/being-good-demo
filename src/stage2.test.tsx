// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { placeCallout } from './callout';
import { listenAction, RecordingCard, IntensityCircles } from './RecordingCard';
import { ProjectionView } from './ProjectionView';
import type { Recording, SceneData } from './types';

const record = (id: string, R: number, T = 3, P = 3): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented', title: `Invented ${id}`,
  duration_seconds: 60, raw_rtp: { R, T, P }, historical_rtp: { R: Math.round(R * 2) / 2, T: 3, P: 3 }, playback_status: 'available',
  mood: { id: 'peaceful', label: 'Peaceful', intensity: 5.6, method: 'invented' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } } });
const records = [record('a', 3), record('b', 1.2), record('c', 2.1)];
const scene: SceneData = { schema_id: 'bg.explorer-scene.v1', complete: true, revision: 'r1', count: 3, records, imports_enabled: false, intensity_available: true,
  scope: { comparison_space: '0'.repeat(64), mood_bundle_sha256: '1'.repeat(64) }, mapping: { id: 'invented', version: '1' },
  categories: [{ id: 'peaceful', label: 'Peaceful' }] };

function mediaMocks() {
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  vi.spyOn(HTMLMediaElement.prototype, 'currentSrc', 'get').mockImplementation(function(this: HTMLMediaElement) {
    return this.getAttribute('src') ? new URL(this.getAttribute('src')!, location.origin).href : '';
  });
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function(this: HTMLMediaElement) { return paused.get(this) ?? true; });
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(60);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event('pause')); });
  return vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function(this: HTMLMediaElement) {
    paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve();
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  for (const name of ['show', 'showModal']) Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function () { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const value = url.endsWith('/scene') ? scene : url.endsWith('/playlists') ? { playlists: [] } : url.endsWith('/recipes') ? { recipes: [] } : { jobs: [], paused: false };
    return { ok: true, json: async () => value, arrayBuffer: async () => { throw new Error('no audio in tests'); } };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function start() {
  const { default: App } = await import('./App');
  render(<App/>);
  await screen.findByRole('list', { name: 'Recordings' });
  return within(screen.getByRole('list', { name: 'Recordings' }));
}

test('the callout leaves the selected point and its neighbours uncovered and stays inside the view', () => {
  const point = { x: 200, y: 200 }, size = { width: 400, height: 400 }, tag = { width: 120, height: 24 };
  // Neighbours crowd the upper left and lower right; the free quadrants are upper right and lower left.
  const crowd = [{ x: 150, y: 160 }, { x: 120, y: 150 }, { x: 160, y: 140 }, { x: 250, y: 240 }, { x: 280, y: 250 }, { x: 260, y: 270 }];
  const place = placeCallout(point, crowd, size, tag);
  const inside = (p: { x: number; y: number }) => p.x > place.x - 9 && p.x < place.x + tag.width + 9 && p.y > place.y - 9 && p.y < place.y + tag.height + 9;
  expect(crowd.filter(inside)).toHaveLength(0); expect(inside(point)).toBe(false);
  expect(place.x).toBeGreaterThanOrEqual(8); expect(place.x + tag.width).toBeLessThanOrEqual(392);
  // At the right edge the tag turns back into the view rather than leaving it.
  const edge = placeCallout({ x: 390, y: 200 }, [], size, tag);
  expect(edge.x + tag.width).toBeLessThanOrEqual(392); expect(edge.x).toBeGreaterThanOrEqual(8);
});

test('the primary key names what clicking will do to the real player', () => {
  const a = records[0];
  expect(listenAction(a, null)).toBe('listen');
  expect(listenAction(a, { recording_id: a.recording_id, entry_id: null, playing: true })).toBe('pause');
  expect(listenAction(a, { recording_id: a.recording_id, entry_id: null, playing: false })).toBe('resume');
  expect(listenAction(a, { recording_id: a.recording_id, entry_id: null, playing: false, finished: true })).toBe('listen');
  expect(listenAction(a, { recording_id: records[1].recording_id, entry_id: null, playing: true })).toBe('listen');
  const handlers = { onListen: vi.fn(), onPause: vi.fn(), onResume: vi.fn() };
  const props = { index: 0, total: 3, inView: records, records, onSelect: vi.fn(), outside: false, onAdd: vi.fn(), neighborhood: null, previousAnchor: null,
    onNeighbors: vi.fn(), onBack: vi.fn(), onHide: vi.fn(), onAtlas: vi.fn(), ...handlers };
  const view = render(<RecordingCard record={a} playback={{ recording_id: a.recording_id, entry_id: null, playing: true }} {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Pause Invented a' })); expect(handlers.onPause).toHaveBeenCalledOnce();
  view.rerender(<RecordingCard record={a} playback={{ recording_id: a.recording_id, entry_id: null, playing: false }} {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Resume Invented a' })); expect(handlers.onResume).toHaveBeenCalledOnce();
  view.rerender(<RecordingCard record={a} playback={{ recording_id: records[1].recording_id, entry_id: null, playing: true }} {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Listen to Invented a' })); expect(handlers.onListen).toHaveBeenCalledWith(a);
  expect(handlers.onPause).toHaveBeenCalledOnce(); expect(handlers.onResume).toHaveBeenCalledOnce();
});

test('meters show exact raw values and historical half-points; intensity fills only the fraction', () => {
  const a = { ...records[0], raw_rtp: { R: 1.91, T: 3.94, P: 1.62 }, historical_rtp: { R: 2, T: 4, P: 1.5 } };
  render(<RecordingCard record={a} playback={null} index={6} total={36} inView={[]} records={[a]} onSelect={vi.fn()} outside={false} onAdd={vi.fn()} neighborhood={null}
    previousAnchor={null} onNeighbors={vi.fn()} onBack={vi.fn()} onHide={vi.fn()} onAtlas={vi.fn()} onListen={vi.fn()} onPause={vi.fn()} onResume={vi.fn()}/>);
  expect(screen.getByRole('img', { name: 'Rhythm raw 1.91, historical half-point 2.0' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Pitch raw 1.62, historical half-point 1.5' })).toBeTruthy();
  expect(screen.getByText('cell 2.0 / 4.0 / 1.5')).toBeTruthy();
  const circles = [...screen.getByRole('img', { name: 'Geometric intensity 5.6 on a continuous 0 to 10 scale' }).querySelectorAll('i')].map(i => Number(i.dataset.fill));
  expect(circles.slice(0, 5)).toEqual([1, 1, 1, 1, 1]); expect(circles[5]).toBeCloseTo(.6); expect(circles.slice(6)).toEqual([0, 0, 0, 0]);
  cleanup(); render(<IntensityCircles value={null}/>); expect(screen.getByText('Unavailable')).toBeTruthy();
});

test('inspector and dock share one playback state: Listen, Pause, Resume, and Listen for another recording', async () => {
  mediaMocks(); const list = await start();
  fireEvent.click(list.getAllByRole('button', { name: /Invented a/ })[0]);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Listen to Invented a' })));
  expect(screen.getByRole('button', { name: 'Pause Invented a' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pause playback' })).toBeTruthy();
  // Pausing from the dock changes the inspector key to Resume.
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pause playback' })));
  expect(screen.getByRole('button', { name: 'Resume Invented a' })).toBeTruthy();
  // Resuming from the inspector plays the same source again, and the dock follows.
  const audio = document.querySelector('audio')!, source = audio.src;
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume Invented a' })));
  expect(audio.src).toBe(source); expect(audio.paused).toBe(false);
  expect(screen.getByRole('button', { name: 'Pause playback' })).toBeTruthy();
  // While listening, choosing another recording moves the listening along with the selection.
  await act(async () => fireEvent.click(list.getAllByRole('button', { name: /Invented c/ })[0]));
  expect(audio.src).toContain('c'.repeat(64)); expect(screen.getByRole('button', { name: 'Pause Invented c' })).toBeTruthy();
  // Paused, selection alone never switches the source; Listen does.
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pause playback' })));
  const paused = audio.src;
  fireEvent.click(list.getAllByRole('button', { name: /Invented a/ })[0]);
  expect(screen.getByRole('button', { name: 'Listen to Invented a' })).toBeTruthy(); expect(audio.src).toBe(paused);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Listen to Invented a' })));
  expect(audio.src).toBe(source); expect(screen.getByRole('button', { name: 'Pause Invented a' })).toBeTruthy();
});

test('the playlist path appears only with a playlist and PATH on, and explains what numbers and lines mean', async () => {
  await start();
  const path = () => screen.getByRole('button', { name: 'Playlist path' });
  expect(path().hasAttribute('disabled')).toBe(true); expect(screen.queryByRole('note', { name: 'Playlist path legend' })).toBeNull();
  expect(document.getElementById(path().getAttribute('aria-describedby')!)!.textContent).toMatch(/once a playlist has recordings/);
  fireEvent.click(screen.getByRole('button', { name: 'Add Invented b to playlist' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Invented a to playlist' }));
  const legend = screen.getByRole('note', { name: 'Playlist path legend' });
  expect(legend.textContent).toMatch(/Numbers are playlist positions; lines join the recordings in order/);
  expect(legend.textContent).toMatch(/join the recordings in order/);
  expect(document.getElementById(path().getAttribute('aria-describedby')!)!.textContent).toMatch(/lines join the recordings in order/);
  expect([...document.querySelectorAll('.projection-view .path-number')].map(n => n.textContent)).toEqual(['1', '2']);
  expect(document.querySelectorAll('.projection-path line')).toHaveLength(1);
  fireEvent.click(path());
  expect(path().getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('note', { name: 'Playlist path legend' })).toBeNull(); expect(document.querySelectorAll('.path-number')).toHaveLength(0);
});

test('a repeated recording keeps every playlist number at its one unmoved position', () => {
  const view = render(<ProjectionView records={records} visibleIds={records.map(r => r.recording_id)} selected={records[0].recording_id} axes="RT" onSelect={vi.fn()}
    path={[records[0].recording_id, records[2].recording_id, records[0].recording_id]}/>);
  expect([...view.container.querySelectorAll('.path-number')].map(n => n.textContent).sort()).toEqual(['1 · 3', '2']);
  const point = view.container.querySelector(`[data-recording-id="${records[0].recording_id}"] .projection-point`)!;
  expect(view.container.querySelector('.field-callout')!.textContent).toContain('01  Invented a');
  expect(point.getAttribute('cx')).toBe(view.container.querySelector('.projection-selected')!.getAttribute('cx'));
});
