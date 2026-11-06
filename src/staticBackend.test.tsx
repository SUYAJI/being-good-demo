// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJSON, postJSON, setTransport, APIError } from './api';
import { audioURL, handle, nearest, query, type AtlasFile } from './staticBackend';
import type { Recording, SceneData } from './types';

const record = (id: string, raw: [number, number, number], mood: string, intensity: number | null): Recording => ({
  recording_id: id.repeat(64), prediction_id: `invented-${id}`, title: `Invented ${id} — Fixture Artist`, duration_seconds: 90,
  raw_rtp: { R: raw[0], T: raw[1], P: raw[2] },
  historical_rtp: { R: Math.min(5, Math.max(1, Math.round(raw[0] * 2) / 2)), T: Math.min(5, Math.max(1, Math.round(raw[1] * 2) / 2)), P: Math.min(5, Math.max(1, Math.round(raw[2] * 2) / 2)) },
  mood: { id: mood, label: mood[0].toUpperCase() + mood.slice(1), intensity, method: 'invented' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } },
  playback_status: 'available', credit: { artist: 'Fixture Artist', source: 'Invented source', source_url: 'https://example.invalid/a', license_name: 'Invented licence', license_url: '', genre: 'Fixture', tags: [] },
});
const records = [record('a', [3, 3, 3], 'peaceful', 4), record('b', [5.4, 1, 2], 'happy', 8), record('c', [3, 4, 3], 'peaceful', 9), record('d', [3, 2, 3], 'sad', null)];
const scope = { comparison_space: '0'.repeat(64), mood_bundle_sha256: '1'.repeat(64) };
const scene: SceneData = { schema_id: 'bg.explorer-scene.v1', complete: true, revision: 'f'.repeat(64), count: records.length, records, scope,
  mapping: { id: 'invented', version: '1' }, imports_enabled: false, intensity_available: true,
  categories: ['peaceful', 'happy', 'sad'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })) };
const atlas: AtlasFile = { scope, method: 'invented', slices: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 2),
  Array.from({ length: 81 }, (_, c) => ({ ticks: [2 + c % 9, 2 + Math.floor(c / 9), i + 2] as [number, number, number], mood_id: 'peaceful', label: 'Peaceful', intensity: 5 }))])) };
const ask = (body: object) => ({ scope, revision: scene.revision, ...body });

beforeEach(() => {
  localStorage.clear(); setTransport(handle);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const value = url.endsWith('data/scene.json') ? scene : url.endsWith('data/atlas.json') ? atlas : null;
    return value ? { ok: true, json: async () => value } : { ok: false, status: 404, json: async () => ({}) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('queries use inclusive raw bounds, exact historical ticks and a union of mood branches with an intensity floor', () => {
  expect(query(scene, ask({ bounds: [[3, 3], [-1e308, 1e308], [-1e308, 1e308]] })).recording_ids).toEqual(['a', 'c', 'd'].map(id => id.repeat(64)));
  expect(query(scene, ask({ bounds: [[5.1, 1e308], [-1e308, 1e308], [-1e308, 1e308]] })).recording_ids).toEqual(['b'.repeat(64)]);
  expect(query(scene, ask({ ticks: [10, 2, 4] })).recording_ids).toEqual(['b'.repeat(64)]);
  expect(query(scene, ask({ moods: [{ mood_id: 'peaceful', minimum_intensity: 5 }, { mood_id: 'sad', minimum_intensity: null }] })).recording_ids)
    .toEqual(['c', 'd'].map(id => id.repeat(64)));
  expect(query(scene, ask({ moods: [] })).recording_ids).toEqual([]);
  expect(() => query(scene, ask({ bounds: [[4, 3], [0, 1], [0, 1]] }))).toThrow('invalid_query');
  expect(() => query(scene, { scope, revision: 'stale', moods: null })).toThrow('scene_changed');
});

test('neighbors rank by Euclidean raw distance with identity tie-breaks and exclude the anchor', () => {
  const result = nearest(scene, ask({ recording_id: 'a'.repeat(64), limit: 3 }));
  expect(result.neighbors.map(n => n.recording_id)).toEqual(['c', 'd', 'b'].map(id => id.repeat(64)));
  expect(result.neighbors[0].geometric_rtp_distance).toBe(1);
  expect(result.neighbors[2].geometric_rtp_distance).toBeCloseTo(Math.hypot(2.4, 2, 1), 12);
  expect(() => nearest(scene, ask({ recording_id: 'z'.repeat(64) }))).toThrow('not_found');
});

test('atlas slices and the scene come from published files; imports are unavailable', async () => {
  const slice = await readJSON<{ cells: unknown[]; pitch_tick: number; reference: boolean }>('mood-atlas?pitch_tick=7');
  expect(slice).toMatchObject({ pitch_tick: 7, reference: true }); expect(slice.cells).toHaveLength(81);
  await expect(readJSON('mood-atlas?pitch_tick=11')).rejects.toMatchObject({ code: 'invalid_slice' });
  await expect(readJSON('jobs')).rejects.toBeInstanceOf(APIError);
  expect((await readJSON<SceneData>('scene')).count).toBe(4);
  expect(audioURL('a'.repeat(64))).toMatch(/\/audio\/a{64}\.mp3$/);
});

test('browser-local playlists keep revisions, refuse stale saves and unknown recordings, and never touch the scene', async () => {
  const entry = (id: string, n: number) => ({ entry_id: `00000000-0000-4000-8000-00000000000${n}`, recording_id: id.repeat(64) });
  const saved = await postJSON<{ id: string; revision: number; entries: { title: string }[] }>('playlists', { name: ' Evening ', revision: 0, entries: [entry('a', 1), entry('b', 2)], target: null });
  expect(saved.revision).toBe(1); expect(saved.entries.map(e => e.title)).toEqual(['Invented a — Fixture Artist', 'Invented b — Fixture Artist']);
  const updated = await postJSON<{ revision: number; name: string }>(`playlists/${saved.id}`, { name: 'Evening', revision: 1, entries: [entry('b', 2)] });
  expect(updated.revision).toBe(2);
  await expect(postJSON(`playlists/${saved.id}`, { name: 'Evening', revision: 1, entries: [] })).rejects.toMatchObject({ code: 'playlist_changed', status: 409 });
  await expect(postJSON('playlists', { name: 'Bad', revision: 0, entries: [entry('e', 3)] })).rejects.toMatchObject({ code: 'recording_not_in_catalog' });
  expect((await readJSON<{ playlists: { name: string }[] }>('playlists')).playlists.map(p => p.name)).toEqual(['Evening']);
  await postJSON(`playlists/${saved.id}/delete`, { revision: 2 });
  expect((await readJSON<{ playlists: unknown[] }>('playlists')).playlists).toEqual([]);
  expect((await readJSON<SceneData>('scene')).records).toHaveLength(4);
});

test('journey targets validate their schema and keep their own revisions', async () => {
  const target = { schema_id: 'bg.trajectory-target.v1', interpolation: 'linear-even-order-v1', waypoints: [{ R: 1, T: 1, P: 1 }, { R: 5, T: 5, P: 5 }], requested_count: 4 };
  const recipe = await postJSON<{ id: string; revision: number }>('recipes', { name: 'Rise', revision: 0, target });
  expect(recipe.revision).toBe(1);
  await expect(postJSON('recipes', { name: 'Bad', revision: 0, target: { ...target, requested_count: 20 } })).rejects.toMatchObject({ code: 'invalid_target' });
  await expect(postJSON(`recipes/${recipe.id}/delete`, { revision: 3 })).rejects.toMatchObject({ code: 'recipe_changed' });
});

test('the read-only Explorer loads published data, offers About with credits and has no import control', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
  for (const name of ['show', 'showModal']) Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function () { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  const { default: App } = await import('./App');
  render(<App/>);
  const list = within(await screen.findByRole('list', { name: 'Recordings' }));
  expect(list.getAllByRole('listitem')).toHaveLength(4);
  expect(screen.getByText(/^4 RECORDINGS$/)).toBeTruthy();
  expect(screen.queryByText(/ADD MP3/)).toBeNull();
  fireEvent.click(list.getAllByRole('button', { name: /Invented b/ })[0]);
  expect(screen.getByRole('link', { name: /Invented source/ }).getAttribute('href')).toBe('https://example.invalid/a');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'How it works' })));
  const about = screen.getByRole('dialog', { name: 'How it works' });
  expect(about.textContent).toContain('analyzed by the original Being Good engine');
  expect(about.textContent).toContain('Nothing is analyzed, invented or simulated in the browser');
  await act(async () => fireEvent.click(within(about).getByRole('button', { name: 'Recordings and credits' })));
  const credits = screen.getByRole('dialog', { name: 'Recordings and credits' });
  expect(within(credits).getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);
});
