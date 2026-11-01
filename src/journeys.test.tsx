// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TrajectoryDesigner } from './TrajectoryDesigner';
import { PlaylistWorkspace } from './PlaylistWorkspace';
import { journeyTarget, type Recipe, type TargetSnapshot } from './journeys';
import type { Recording } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const shape = [{ R: 1, T: 3, P: 3 }, { R: 5, T: 3, P: 3 }];
const target = journeyTarget(shape, 3);
const saved: Recipe = { id: 'first', name: 'Saved journey', revision: 1, target, created: 1, updated: 1 };
const props = { records: [], disabled: false, expanded: true, onExpand: vi.fn(), onGenerate: vi.fn(), comparing: false };

test('targets save, reopen, rename, duplicate and delete without changing playlist snapshots', async () => {
  let recipes: Recipe[] = [], serial = 0;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method) return { ok: true, json: async () => ({ recipes }) };
    const body = JSON.parse(String(init.body)); requests.push(url);
    const id = url === '/api/v1/recipes' ? `recipe-${++serial}` : url.split('/')[4];
    if (url.endsWith('/delete')) { recipes = recipes.filter(r => r.id !== id); return { ok: true, json: async () => ({ deleted: true }) }; }
    const result = { ...body, id, revision: body.revision + 1, created: 1, updated: 2 };
    recipes = [result, ...recipes.filter(r => r.id !== id)]; return { ok: true, json: async () => result };
  }));
  render(<TrajectoryDesigner {...props}/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save target' }).hasAttribute('disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('Target name'), { target: { value: 'First journey' } });
  fireEvent.change(screen.getByLabelText('Waypoint 2 Rhythm'), { target: { value: '4.5' } });
  fireEvent.change(screen.getByLabelText('Generated sequence length'), { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
  await screen.findByText('Target saved in this browser');
  expect(recipes[0].target.requested_count).toBe(9); expect(recipes[0].target.waypoints[1].R).toBe(4.5);
  fireEvent.click(screen.getByRole('button', { name: 'New target' }));
  fireEvent.change(screen.getByLabelText('Open saved target'), { target: { value: 'recipe-1' } });
  expect((screen.getByLabelText('Generated sequence length') as HTMLSelectElement).value).toBe('9');
  fireEvent.change(screen.getByLabelText('Target name'), { target: { value: 'Renamed journey' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
  await screen.findByText('Saved · r2'); expect(recipes[0].id).toBe('recipe-1');
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate target' }));
  await screen.findByText('Target duplicated in this browser');
  expect(recipes).toHaveLength(2); expect(recipes[0].id).toBe('recipe-2'); expect(recipes[0].target).toEqual(recipes[1].target);
  fireEvent.click(screen.getByRole('button', { name: 'Delete target' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete target' }));
  await screen.findByText(/Target deleted/); expect(recipes.map(r => r.id)).toEqual(['recipe-1']);
  expect(requests.every(url => url.startsWith('/api/v1/recipes'))).toBe(true);
});

test('conflicting save preserves edits until explicit reload/discard; dirty target opening can be cancelled', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method ?
    { ok: false, status: 409, json: async () => ({ error: { code: 'recipe_changed' } }) } :
    { ok: true, json: async () => ({ recipes: [saved] }) }));
  render(<TrajectoryDesigner {...props}/>);
  await screen.findByRole('option', { name: 'Saved journey · r1' });
  fireEvent.change(screen.getByLabelText('Open saved target'), { target: { value: saved.id } });
  fireEvent.change(screen.getByLabelText('Waypoint 1 Rhythm'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('changed in another window');
  expect((screen.getByLabelText('Waypoint 1 Rhythm') as HTMLInputElement).value).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: 'New target' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel target action' }));
  expect((screen.getByLabelText('Waypoint 1 Rhythm') as HTMLInputElement).value).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: 'Reload targets' }));
  await screen.findByRole('button', { name: 'Discard target and open' });
  fireEvent.click(screen.getByRole('button', { name: 'Discard target and open' }));
  expect((screen.getByLabelText('Waypoint 1 Rhythm') as HTMLInputElement).value).toBe('1');
});

test('generation records a saved recipe revision only for its unchanged shape', async () => {
  const records = [1, 3, 5].map((R, i) => ({ recording_id: String(i), raw_rtp: { R, T: 3, P: 3 }, playback_status: 'available' } as Recording));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ recipes: [saved] }) })));
  const generate = vi.fn(); render(<TrajectoryDesigner {...props} records={records} onGenerate={generate}/>);
  await screen.findByRole('option', { name: 'Saved journey · r1' });
  fireEvent.change(screen.getByLabelText('Open saved target'), { target: { value: saved.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate new playlist' }));
  const snapshot = generate.mock.calls[0][1];
  expect(snapshot.recipe).toEqual({ id: saved.id, name: saved.name, revision: 1 });
  fireEvent.change(screen.getByLabelText('Waypoint 1 Rhythm'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate new playlist' }));
  expect(generate.mock.calls[1][1].recipe).toBeNull();
  expect(snapshot.waypoints[0].R).toBe(1); expect(generate.mock.calls[1][1].waypoints[0].R).toBe(2);
});

test('reopened target snapshot recalculates fit after order and current prediction changes, with missing slots', async () => {
  const records = [1, 3, 5].map((R, i) => ({ recording_id: String(i).repeat(64), title: `Synthetic ${i}`, raw_rtp: { R, T: 3, P: 3 },
    historical_rtp: { R, T: 3, P: 3 }, playback_status: 'available', mood: { label: 'Synthetic' },
    duration_seconds: 10, quality: { outside_saved_range_counts: {} } } as Recording));
  const snapshot: TargetSnapshot = { ...target, recipe: { id: 'deleted', name: 'Deleted source recipe', revision: 1 } };
  const playlist = { id: 'sequence', name: 'Snapshot example', revision: 2, target: snapshot,
    entries: records.map((r, i) => ({ entry_id: `slot-${i}`, recording_id: r.recording_id, title: r.title })) };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/recipes') ? { recipes: [] } : { playlists: [playlist] } })));
  const view = render(<PlaylistWorkspace records={records} onSelect={vi.fn()} onListen={vi.fn()} onPlay={vi.fn()}/>);
  await screen.findByRole('option', { name: 'Snapshot example · 3' });
  fireEvent.change(screen.getByLabelText('Open saved playlist'), { target: { value: playlist.id } });
  const mean = () => Number(view.container.querySelector('[data-mean-distance]')!.getAttribute('data-mean-distance'));
  expect(mean()).toBe(0); expect(screen.getByText(/Deleted source recipe/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Move playlist track 1 down' }));
  expect(mean()).toBeCloseTo(4 / 3);
  const updated = [{ ...records[1], raw_rtp: { R: -1, T: 3, P: 3 } }, records[2]];
  view.rerender(<PlaylistWorkspace records={updated} onSelect={vi.fn()} onListen={vi.fn()} onPlay={vi.fn()}/>);
  expect(mean()).toBe(1); expect(screen.getByText(/2 \/ 3 positions measured/)).toBeTruthy();
  expect(screen.getByText('Missing from this catalog')).toBeTruthy();
  expect(view.container.querySelector('[data-target-series]')).toBeTruthy();
});
