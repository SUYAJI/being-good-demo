// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Recording, SceneData } from './types';
import { planJourney, presetWaypoints, suggestedJourneys, moodStarts } from './journeyDesign';

const record = (id: string, R: number, T: number, mood: 'peaceful' | 'happy' | 'manic'): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented', title: `Invented ${id}`,
  duration_seconds: 60, raw_rtp: { R, T, P: 3 }, historical_rtp: { R: Math.round(R * 2) / 2, T: Math.round(T * 2) / 2, P: 3 }, playback_status: 'available',
  mood: { id: mood, label: mood[0].toUpperCase() + mood.slice(1), intensity: 5, method: 'invented' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } } });
const records = [record('a', 1.5, 1.5, 'peaceful'), record('b', 2, 1.8, 'peaceful'), record('c', 2.4, 2.2, 'peaceful'), record('d', 2.8, 2.6, 'peaceful'), record('e', 3.2, 3, 'peaceful'),
  record('f', 3.6, 3.3, 'happy'), record('g', 4, 3.6, 'happy'), record('h', 4.4, 4, 'manic')];
const categories = [{ id: 'peaceful', label: 'Peaceful' }, { id: 'happy', label: 'Happy' }, { id: 'manic', label: 'Manic' }];
const scene: SceneData = { schema_id: 'bg.explorer-scene.v1', complete: true, revision: 'r1', count: records.length, records, imports_enabled: false, intensity_available: true,
  scope: { comparison_space: '0'.repeat(64), mood_bundle_sha256: '1'.repeat(64) }, mapping: { id: 'invented', version: '1' }, categories };

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  for (const name of ['show', 'showModal']) Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function () { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
  let playlists: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/scene')) return { ok: true, json: async () => scene };
    if (url.endsWith('/playlists') && !init?.method) return { ok: true, json: async () => ({ playlists }) };
    if (url.endsWith('/playlists')) { const saved = { ...body, id: '11111111-1111-4111-8111-111111111111', revision: 1, updated: 1 }; playlists = [saved]; return { ok: true, json: async () => saved }; }
    if (url.includes('/mood-atlas')) return { ok: true, json: async () => ({ cells: [] }) };
    if (url.endsWith('/nearest')) return { ok: true, json: async () => ({ neighbors: [] }) };
    return { ok: true, json: async () => ({ revision: 'r1', recording_ids: records.map(r => r.recording_id) }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.setItem('being-good-demo.stage', 'app'); sessionStorage.removeItem('being-good-demo.mode'); });

test('mood starts need five recordings, presets stay inside 1–5, and the planned journey begins and ends on the chosen recordings', () => {
  expect(moodStarts(records, categories).map(m => m.id)).toEqual(['peaceful']);
  const start = { R: 4.6, T: 4.8, P: 4.9 };
  for (const point of presetWaypoints('build', start, null)) for (const value of Object.values(point)) { expect(value).toBeGreaterThanOrEqual(1); expect(value).toBeLessThanOrEqual(5); }
  const plan = planJourney(records, { waypoints: presetWaypoints('between', records[7].raw_rtp, records[0].raw_rtp), length: 5, firstId: records[7].recording_id, lastId: records[0].recording_id });
  expect(plan.recordings[0].recording_id).toBe(records[7].recording_id); expect(plan.recordings.at(-1)!.recording_id).toBe(records[0].recording_id);
  expect(new Set(plan.recordings.map(r => r.recording_id)).size).toBe(5);
  const suggestions = suggestedJourneys(records, categories);
  expect(suggestions[0].id).toBe('calm-to-lively'); expect(suggestions[0].description).toContain('Invented a'); expect(suggestions[0].description).toContain('Invented h');
});

test('a fresh visit shows the start-up mark, then the welcome; Skip and the primary action lead into the Playlist Designer', async () => {
  sessionStorage.removeItem('being-good-demo.stage');
  const { default: App } = await import('./App');
  render(<App/>);
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  expect(await screen.findByRole('heading', { name: 'Playlists that follow a shape.' })).toBeTruthy();
  await screen.findByText(/8 recordings from ccMixter/);
  fireEvent.click(screen.getByRole('button', { name: 'Create a playlist' }));
  expect(screen.getByRole('region', { name: 'Playlist Designer' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Where should your playlist begin?' })).toBeTruthy();
  expect(sessionStorage.getItem('being-good-demo.stage')).toBe('app');
  // The wordmark returns to the welcome without losing the collection.
  fireEvent.click(screen.getByRole('link', { name: 'Being Good: back to the welcome' }));
  expect(screen.getByRole('heading', { name: 'Playlists that follow a shape.' })).toBeTruthy();
});

test('start from a mood, pick a shape, create, swap a recording, save, and the path shows in the field', async () => {
  const { default: App } = await import('./App');
  render(<App/>);
  await screen.findByRole('list', { name: 'Recordings' });
  fireEvent.click(screen.getByRole('button', { name: 'Playlist Designer' }));
  fireEvent.click(within(screen.getByRole('region', { name: 'Playlist Designer' })).getByRole('button', { name: /^Peaceful/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose a shape →' }));
  expect(screen.getByText(/Starting from Peaceful/)).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: /Rise and settle/ }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Playlist length' })).getByRole('button', { name: '5' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create playlist' }));
  const tracks = () => within(screen.getByRole('list', { name: 'Playlist recordings' })).getAllByRole('listitem');
  expect(tracks()).toHaveLength(5);
  expect((screen.getByLabelText('Playlist name') as HTMLInputElement).value).toBe('Rise and settle from Peaceful');
  expect(screen.getByRole('button', { name: /^Playlist Designer · 5/ })).toBeTruthy();
  expect(screen.getByRole('note', { name: 'Playlist path legend' }).textContent).toContain('Rise and settle from Peaceful · 5');
  // Keep one recording and try different ones for the rest.
  fireEvent.click(screen.getByRole('button', { name: 'Lock position 1' }));
  const first = tracks()[0].textContent;
  fireEvent.click(screen.getByRole('button', { name: 'Try different recordings' }));
  expect(tracks()[0].textContent).toBe(first);
  // Change the shape and come back without losing the playlist.
  fireEvent.click(screen.getByRole('button', { name: 'Change the shape' }));
  expect(screen.getByRole('heading', { name: 'How should it move?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^3 ?Playlist$/ }));
  expect(tracks()).toHaveLength(5);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save playlist' })));
  await screen.findByText('Saved in this browser');
  expect(screen.getByText(/is saved in this browser\./)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Make another' }));
  expect(screen.getByRole('heading', { name: 'Where should your playlist begin?' })).toBeTruthy();
});

test('a journey between two recordings starts from the selected recording and ends at the chosen one', async () => {
  const { default: App } = await import('./App');
  render(<App/>);
  const list = within(await screen.findByRole('list', { name: 'Recordings' }));
  fireEvent.click(list.getAllByRole('button', { name: /Invented h/ })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Playlist Designer' }));
  fireEvent.click(screen.getByRole('button', { name: /Invented h.*selected in the Explorer/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose a shape →' }));
  fireEvent.click(screen.getByRole('radio', { name: /Between two recordings/ }));
  expect(screen.getByRole('button', { name: 'Create playlist' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(list.getAllByRole('button', { name: /Invented a/ })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'End at “Invented a”' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create playlist' }));
  const titles = within(screen.getByRole('list', { name: 'Playlist recordings' })).getAllByRole('listitem').map(item => item.querySelector('strong')!.textContent);
  expect(titles[0]).toContain('Invented h'); expect(titles.at(-1)).toContain('Invented a');
  expect(titles[0]).toContain('Kept'); expect(titles.at(-1)).toContain('Kept');
});

test('the field opens zoomed to the music, with the full scale one key away', async () => {
  const { default: App } = await import('./App');
  render(<App/>);
  await screen.findByRole('list', { name: 'Recordings' });
  expect(screen.getByText(/Zoomed to the music/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show the full 1 to 5 scale' }));
  expect(screen.getByText('Full 1–5 scale')).toBeTruthy();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show the full 1 to 5 scale' }).getAttribute('aria-pressed')).toBe('true'));
});
