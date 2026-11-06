// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PlaylistWorkspace } from './PlaylistWorkspace';
import { ProjectionView } from './ProjectionView';
import { AtlasSlice } from './AtlasSlice';
import { OverlapPicker } from './OverlapPicker';
import { RecordingList, sortRecords } from './App';
import { journeyTarget, type TargetSnapshot } from './journeys';
import type { Playlist } from './playlists';
import type { AtlasData, Recording } from './types';

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.setAttribute('open', ''); } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const record = (id: string, R: number, T = 3, extra: Partial<Recording> = {}): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented', title: `Synthetic ${id}`,
  duration_seconds: 60, raw_rtp: { R, T, P: 3 }, historical_rtp: { R: Math.round(R * 2) / 2, T: Math.round(T * 2) / 2, P: 3 }, playback_status: 'available',
  mood: { id: 'peaceful', label: 'Peaceful', intensity: R, method: 'invented' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } }, ...extra });
const reply = (value: unknown) => ({ ok: true, json: async () => value });
const five = [1, 2, 3, 4, 5].map(R => record(String.fromCharCode(96 + R), R));

function savedPlaylist(entries: Recording[], target: TargetSnapshot | null): Playlist {
  return { id: 'saved', name: 'Synthetic sequence', revision: 1, target, entries: entries.map((r, i) => ({ entry_id: `slot-${i}`, recording_id: r.recording_id, title: r.title })) };
}
async function openWorkspace(playlist: Playlist, onPlay = vi.fn(), posts: string[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/recipes')) return reply({ recipes: [] });
    if (init?.method === 'POST') { posts.push(url); const body = JSON.parse(String(init.body)); return reply({ ...body, id: 'saved', revision: body.revision + 1,
      entries: body.entries.map((e: { entry_id: string; recording_id: string }) => ({ ...e, title: five.find(r => r.recording_id === e.recording_id)!.title })) }); }
    return reply({ playlists: [playlist] });
  }));
  const view = render(<PlaylistWorkspace records={five} onSelect={vi.fn()} onListen={vi.fn()} onPlay={onPlay}/>);
  await screen.findByRole('option', { name: `${playlist.name} · ${playlist.entries.length}` });
  fireEvent.change(screen.getByLabelText('Open saved playlist'), { target: { value: playlist.id } });
  const order = () => [...screen.getByRole('list', { name: 'Playlist recordings' }).children].map(row => row.getAttribute('data-recording-id'));
  return { view, order };
}

test('locked positions survive regeneration; unlocked ones refill without repeats and undo restores them', async () => {
  const target = { ...journeyTarget([{ R: 1, T: 3, P: 3 }, { R: 5, T: 3, P: 3 }], 3), recipe: null };
  const { order } = await openWorkspace(savedPlaylist([five[4], five[1], five[0]], target));
  fireEvent.click(screen.getByRole('button', { name: 'Lock position 1' }));
  expect(screen.getByRole('button', { name: 'Remove playlist track 1' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Try different recordings' }));
  expect(order()).toEqual([five[4], five[2], five[3]].map(r => r.recording_id));
  expect(screen.getByText(/Swapped 2 recordings · 1 kept recording stayed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Undo playlist edit' }));
  expect(order()).toEqual([five[4], five[1], five[0]].map(r => r.recording_id));
});

test('Play from here starts at that occurrence; replacements rank by distance to the desired slot', async () => {
  const play = vi.fn(), target = { ...journeyTarget([{ R: 1, T: 3, P: 3 }, { R: 5, T: 3, P: 3 }], 3), recipe: null };
  await openWorkspace(savedPlaylist([five[0], five[4], five[2]], target), play);
  fireEvent.click(screen.getByRole('button', { name: 'Play from here: playlist from track 2' }));
  expect(play.mock.calls[0][2]).toBe(1); expect(play.mock.calls[0][1]).toHaveLength(3);
  fireEvent.click(screen.getAllByRole('button', { name: /Synthetic e/ })[0]);
  const candidates = within(screen.getByRole('region', { name: 'Replacements for position 2' })).getAllByRole('listitem');
  // Position 2 of 3 desires R = 3, so the nearest candidates are c (0), then b and d (1).
  expect(candidates[0].textContent).toMatch(/Synthetic c.*already in playlist/);
  expect(candidates.slice(1, 3).map(item => item.querySelector('strong')!.textContent)).toEqual(['Synthetic b', 'Synthetic d']);
});

test('undo after saving keeps the saved identity, so the next save updates rather than duplicates', async () => {
  const posts: string[] = [];
  await openWorkspace(savedPlaylist([five[0], five[1]], null), vi.fn(), posts);
  fireEvent.click(screen.getByRole('button', { name: 'Remove playlist track 2' }));
  expect(screen.getByText(/Removed “Synthetic b” · Undo restores it/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save playlist' })); await screen.findByText('Saved in this browser');
  fireEvent.click(screen.getByRole('button', { name: 'Undo playlist edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save playlist' })); await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts).toEqual(['/api/v1/playlists/saved', '/api/v1/playlists/saved']);
});

test('a 2D region becomes outward-rounded bounds on the plotted axes and names the unplotted axis', () => {
  Object.defineProperty(SVGSVGElement.prototype, 'createSVGPoint', { configurable: true, value: () => ({ x: 0, y: 0, matrixTransform(this: { x: number; y: number }) { return { x: this.x, y: this.y }; } }) });
  Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', { configurable: true, value: () => ({ a: 1, inverse() { return this; } }) });
  const records = [record('a', 3, 3), record('b', 5, 5)], filter = vi.fn(), add = vi.fn();
  const view = render(<ProjectionView records={records} visibleIds={records.map(r => r.recording_id)} selected={null} axes="RT" onSelect={vi.fn()}
    bounds={[['', ''], ['', ''], ['2', '']]} onFilterRegion={filter} onAddRegion={add}/>);
  expect(screen.getByText('Pitch not shown here · filtered ≥ 2')).toBeTruthy();
  const svg = view.container.querySelector('svg')!;
  fireEvent.pointerDown(svg, { clientX: 190, clientY: 158, button: 0, pointerId: 1 });
  fireEvent.pointerMove(svg, { clientX: 436, clientY: 403, pointerId: 1 });
  fireEvent.pointerUp(svg, { clientX: 436, clientY: 403, pointerId: 1 });
  const panel = screen.getByRole('group', { name: 'Selected region' });
  expect(panel.textContent).toContain('1 of the 2 recordings');
  fireEvent.click(screen.getByRole('button', { name: 'Show only this region' }));
  const region = filter.mock.calls[0][0];
  expect(Object.keys(region).sort()).toEqual(['R', 'T']);
  expect(region.R[0]).toBeLessThanOrEqual(2); expect(region.R[1]).toBeGreaterThanOrEqual(4);
  [...region.R, ...region.T].forEach((value: number) => expect(Math.round(value * 100) / 100).toBe(value));
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Synthetic a, Peaceful' }));
  expect(view.container.querySelector('.point-readout')!.textContent).toContain('P 3.00 (not plotted)');
});

test('the atlas opens at a recording’s historical slice and counts recordings per cell', async () => {
  const scope = { comparison_space: '0'.repeat(64), mood_bundle_sha256: '1'.repeat(64) };
  const fetch = vi.fn(async (url: string) => reply({ scope, reference: true, pitch_tick: Number(url.split('=')[1]), cells: Array.from({ length: 81 }, (_, i) => ({
    ticks: [2 + i % 9, 2 + Math.floor(i / 9), Number(url.split('=')[1])], mood_id: 'peaceful', label: 'Peaceful', intensity: null })) } as AtlasData));
  vi.stubGlobal('fetch', fetch);
  const select = vi.fn(), records = [record('a', 4.5, 1), record('b', 4.5, 1)];
  await act(async () => { render(<AtlasSlice scope={scope} focus={{ rtp: { R: 4.5, T: 1, P: 3 }, title: 'Synthetic a' }} records={records} onSelect={select}/>); });
  expect(fetch.mock.calls[0][0]).toContain('pitch_tick=6');
  const chosen = screen.getByRole('gridcell', { selected: true });
  expect(chosen.getAttribute('aria-label')).toBe('R 4.5, T 1, P 3: Peaceful; intensity unavailable; 2 recordings; selected recording');
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic b' })); expect(select).toHaveBeenCalledWith(records[1].recording_id);
});

test('overlap chooser lists mood and position and moves with arrow keys', () => {
  const records = [record('a', 2), record('b', 2)], choose = vi.fn();
  render(<OverlapPicker ids={records.map(r => r.recording_id)} records={records} at={{ x: 0, y: 0 }} onChoose={choose} onClose={vi.fn()}/>);
  const first = screen.getByRole('button', { name: /Synthetic a/ });
  expect(document.activeElement).toBe(first); expect(first.textContent).toContain('Peaceful · R 2.00 · T 3.00 · P 3.00');
  fireEvent.keyDown(first, { key: 'ArrowDown' }); expect(document.activeElement).toBe(screen.getByRole('button', { name: /Synthetic b/ }));
  fireEvent.click(document.activeElement!); expect(choose).toHaveBeenCalledWith(records[1].recording_id);
});

test('sorting is stable, keeps missing values last, and the list scrolls the selection into view', () => {
  const records = [record('a', 3), record('b', 1, 3, { mood: { id: 'x', label: 'X', intensity: null, method: 'm' } }), record('c', 2)];
  expect(sortRecords(records, 'R', false).map(r => r.title)).toEqual(['Synthetic b', 'Synthetic c', 'Synthetic a']);
  expect(sortRecords(records, 'intensity', true).map(r => r.title)).toEqual(['Synthetic a', 'Synthetic c', 'Synthetic b']);
  expect(sortRecords(records, 'distance', false, { R: 3, T: 3, P: 3 }).map(r => r.title)).toEqual(['Synthetic a', 'Synthetic c', 'Synthetic b']);
  const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const view = render(<RecordingList records={records} selected={null} onSelect={vi.fn()} playing={records[2].recording_id}/>);
  view.rerender(<RecordingList records={records} selected={records[2].recording_id} onSelect={vi.fn()} playing={records[2].recording_id}/>);
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' }); expect(screen.getByLabelText('Now playing')).toBeTruthy();
});
