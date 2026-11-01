// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { PlaylistWorkspace, type PlaylistHandle } from './PlaylistWorkspace';
import type { Playlist, PlaylistEntry, QueueEntry } from './playlists';
import type { Recording } from './types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const record = (id: string, R: number): Recording => ({ recording_id: id.repeat(64), title: `Invented ${id}`, prediction_id: 'invented',
  raw_rtp: { R, T: 3, P: 3 }, historical_rtp: { R: 3, T: 3, P: 3 }, duration_seconds: 60, playback_status: 'available',
  mood: { id: 'invented', label: 'Invented', intensity: null, method: 'test' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } } });
const records = [record('a', 1), record('b', 3), record('c', 5), record('d', 4)];
const entry = (id: string, r = records[0]): PlaylistEntry => ({ entry_id: id, recording_id: r.recording_id, title: r.title });

test('generation creates a protected new draft; replacement, order, playback and ordinary save remain independent', async () => {
  let saved: Playlist[] = [{ id: 'existing', name: 'Existing sequence', revision: 1, entries: [entry('old')] }];
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/recipes')) return { ok: true, json: async () => ({ recipes: [] }) };
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push({ url, body });
      const result: Playlist = { ...body, id: 'generated', revision: 1, entries: body.entries.map((e: PlaylistEntry) => ({ ...e, title: records.find(r => r.recording_id === e.recording_id)!.title })) };
      saved = [...saved, result]; return { ok: true, json: async () => result };
    }
    return { ok: true, json: async () => ({ playlists: saved }) };
  }));
  const ref = createRef<PlaylistHandle>(), play = vi.fn(), select = vi.fn();
  const props = { records, onSelect: select, onListen: vi.fn(), onPlay: play };
  const view = render(<PlaylistWorkspace ref={ref} {...props}/>);
  await screen.findByRole('option', { name: 'Existing sequence · 1' });
  fireEvent.change(screen.getByLabelText('Open saved playlist'), { target: { value: 'existing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Target designer' }));
  fireEvent.change(screen.getByLabelText('Generated sequence length'), { target: { value: '3' } });
  const shape = view.container.querySelector('[data-design-series=R]')!.getAttribute('d');
  fireEvent.change(screen.getByLabelText('Waypoint 1 Rhythm'), { target: { value: '2.5' } });
  expect(view.container.querySelector('[data-design-series=R]')!.getAttribute('d')).not.toBe(shape);
  fireEvent.click(screen.getByRole('button', { name: 'Generate new playlist' }));
  expect(posts).toEqual([]); expect(saved[0].entries).toEqual([entry('old')]);
  const list = screen.getByRole('list', { name: 'Playlist recordings' });
  expect(list.children).toHaveLength(3);
  expect((screen.getByLabelText('Playlist name') as HTMLInputElement).value).toBe('Untitled target');
  const order = () => [...list.children].map(row => row.getAttribute('data-entry-id'));
  const ids = order();
  // An untouched generated draft is replaced without a prompt, as one undoable step.
  fireEvent.click(screen.getByRole('button', { name: 'Generate new playlist' }));
  expect(screen.queryByRole('group', { name: 'Confirm playlist action' })).toBeNull();
  expect(order()).not.toEqual(ids); expect(screen.getByText(/previous draft replaced/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Undo playlist edit' }));
  expect(order()).toEqual(ids);
  // Once edited, the draft is protected again.
  fireEvent.click(screen.getByRole('button', { name: 'Move playlist track 1 down' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate new playlist' }));
  expect(screen.getByRole('group', { name: 'Confirm playlist action' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Undo playlist edit' }));
  expect(order()).toEqual(ids);
  const target = () => view.container.querySelector('[data-target-series=R]')!.getAttribute('d');
  const actual = () => view.container.querySelector('[data-series=R]')!.getAttribute('d');
  const originalTarget = target(), originalActual = actual();
  fireEvent.click(screen.getByRole('button', { name: '▶ Play playlist' }));
  const queue: QueueEntry[] = play.mock.calls[0][1], captured = queue[0];
  view.rerender(<PlaylistWorkspace ref={ref} {...props} playback={{ entry_id: captured.entry_id, recording_id: captured.recording.recording_id, playing: true }}/>);
  expect(list.children[0].getAttribute('aria-current')).toBe('true');
  const replacement = records.find(r => r.recording_id !== captured.recording.recording_id)!;
  fireEvent.click(list.children[0].querySelector('.playlist-track-select')!);
  expect(screen.getByRole('region', { name: 'Replacements for position 1' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: `Use ${replacement.title} at position 1` }));
  expect(list.children[0].getAttribute('data-entry-id')).toBe(captured.entry_id);
  expect(list.children[0].hasAttribute('aria-current')).toBe(false);
  expect(view.container.querySelector('[data-playing-entry]')).toBeNull();
  expect(queue[0].recording.recording_id).toBe(captured.recording.recording_id);
  expect(play).toHaveBeenCalledTimes(1); expect(target()).toBe(originalTarget); expect(actual()).not.toBe(originalActual);
  fireEvent.click(screen.getByRole('button', { name: 'Move playlist track 1 down' }));
  expect(list.children[1].getAttribute('data-entry-id')).toBe(captured.entry_id); expect(target()).toBe(originalTarget);
  fireEvent.click(screen.getByRole('button', { name: 'Remove playlist track 3' }));
  act(() => ref.current!.add([records[3]])); expect(list.children).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Save playlist' }));
  await screen.findByText('Saved in this browser');
  expect(posts[0].url).toBe('/api/v1/playlists'); expect(saved[0].entries).toEqual([entry('old')]);
  const savedOrder = saved[1].entries.map(e => e.recording_id);
  fireEvent.click(screen.getByRole('button', { name: 'New playlist' }));
  fireEvent.change(screen.getByLabelText('Open saved playlist'), { target: { value: 'generated' } });
  await waitFor(() => expect(list.children).toHaveLength(3));
  expect(saved[1].entries.map(e => e.recording_id)).toEqual(savedOrder);
  expect(view.container.querySelector('[data-target-series]')).toBeTruthy();
  expect(screen.getByText(/target comparison restored/)).toBeTruthy();
});

test('waypoint editing is immediate and generation never silently discards a manual draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ playlists: [], recipes: [] }) })));
  const ref = createRef<PlaylistHandle>();
  const view = render(<PlaylistWorkspace ref={ref} records={records} onSelect={vi.fn()} onListen={vi.fn()} onPlay={vi.fn()}/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save playlist' }).hasAttribute('disabled')).toBe(false));
  act(() => ref.current!.add([records[0]]));
  fireEvent.click(screen.getByRole('button', { name: 'Target designer' }));
  fireEvent.click(screen.getByRole('button', { name: '+ Add waypoint' }));
  expect(screen.getAllByRole('spinbutton')).toHaveLength(12);
  fireEvent.click(screen.getByRole('button', { name: 'Remove waypoint 3' }));
  expect(screen.getAllByRole('spinbutton')).toHaveLength(9);
  fireEvent.click(screen.getByRole('button', { name: 'Generate new playlist' }));
  expect(screen.getByRole('list', { name: 'Playlist recordings' }).children).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Discard and open' }));
  expect(screen.getByRole('list', { name: 'Playlist recordings' }).children).toHaveLength(4);
  expect(view.container.querySelector('[data-target-series]')).toBeTruthy();
  expect(screen.getByText(/Only 4 distinct playable recordings/)).toBeTruthy();
});
