// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Recording, SceneData } from './types';

const record = (id: string, R: number, mood: 'peaceful' | 'happy'): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented', title: `Invented ${id}`,
  duration_seconds: 60, raw_rtp: { R, T: 3, P: 3 }, historical_rtp: { R, T: 3, P: 3 }, playback_status: 'available',
  mood: { id: mood, label: mood === 'happy' ? 'Happy' : 'Peaceful', intensity: 5, method: 'invented' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } } });
const records = [record('a', 3, 'peaceful'), record('b', 1, 'happy'), record('c', 2, 'peaceful')];
const scene: SceneData = { schema_id: 'bg.explorer-scene.v1', complete: true, revision: 'r1', count: 3, records, imports_enabled: false, intensity_available: true,
  scope: { comparison_space: '0'.repeat(64), mood_bundle_sha256: '1'.repeat(64) }, mapping: { id: 'invented', version: '1' },
  categories: [{ id: 'peaceful', label: 'Peaceful' }, { id: 'happy', label: 'Happy' }] };
const nearest: string[] = [];

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  for (const name of ['show', 'showModal']) Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function () { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const value = url.endsWith('/scene') ? scene : url.endsWith('/playlists') ? { playlists: [] } : url.endsWith('/recipes') ? { recipes: [] } :
      url.endsWith('/nearest') ? (nearest.push(body.recording_id), { neighbors: records.filter(r => r.recording_id !== body.recording_id)
        .map(r => ({ recording_id: r.recording_id, geometric_rtp_distance: Math.abs(r.raw_rtp.R - records.find(x => x.recording_id === body.recording_id)!.raw_rtp.R) })) }) :
      url.endsWith('/query') ? { revision: 'r1', recording_ids: records.filter(r => body.moods?.some((m: { mood_id: string }) => m.mood_id === r.mood.id) ?? true).map(r => r.recording_id) } :
      { jobs: [], paused: false };
    return { ok: true, json: async () => value };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); nearest.length = 0; });

async function start() {
  const { default: App } = await import('./App');
  render(<App/>);
  await screen.findByRole('list', { name: 'Recordings' });
  return within(screen.getByRole('list', { name: 'Recordings' }));
}

test('neighbors stay anchored while following one, and Back returns to the earlier neighborhood', async () => {
  const list = await start();
  fireEvent.click(list.getAllByRole('button', { name: /Invented a/ })[0]);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Geometric neighbors' })));
  const panel = () => screen.getByRole('region', { name: 'Geometric neighbors' });
  fireEvent.click(within(panel()).getByRole('button', { name: /Invented c/ }));
  expect(panel().textContent).toContain('Neighbors of Invented a');
  expect(within(panel()).getByRole('button', { name: /^Invented c/ }).getAttribute('aria-current')).toBe('true');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Re-centre on Invented c' })));
  expect(panel().textContent).toContain('Neighbors of Invented c');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '← Back to neighbors of Invented a' })));
  expect(panel().textContent).toContain('Neighbors of Invented a'); expect(nearest).toEqual(['a'.repeat(64), 'c'.repeat(64), 'a'.repeat(64)]);
});

test('adding stays in the field with undo, and unsaved playlists guard against closing', async () => {
  const list = await start();
  fireEvent.click(screen.getByRole('button', { name: 'Add Invented b to playlist' }));
  expect(document.querySelector('.projection-view svg')!.getAttribute('aria-label')).toMatch(/Continuous R–T projection/);
  expect(screen.getByText('Added 1 recording to “Untitled playlist”')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Playlist · 1/ })).toBeTruthy();
  const leaving = new Event('beforeunload', { cancelable: true }); dispatchEvent(leaving); expect(leaving.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Playlist' })).toBeTruthy());
  const after = new Event('beforeunload', { cancelable: true }); dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
  expect(screen.queryByRole('button', { name: /Add 3 results/ })).toBeNull(); expect(list.getAllByRole('listitem')).toHaveLength(3);
});

test('the mood key filters live, chips remove one condition, and sorting reorders the list', async () => {
  const list = await start();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Happy/ })));
  await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(2));
  const chip = screen.getByRole('button', { name: 'Remove filter: Moods: Peaceful' });
  expect(screen.getByRole('button', { name: /Add 2 results to playlist/ })).toBeTruthy();
  await act(async () => fireEvent.click(chip));
  await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(3));
  fireEvent.change(screen.getByLabelText('Sort recordings'), { target: { value: 'R' } });
  expect([...document.querySelectorAll('[data-select-recording] strong')].map(b => b.textContent)).toEqual(['Invented b', 'Invented c', 'Invented a']);
});
