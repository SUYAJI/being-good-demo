// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { moveEntry, trajectory, type Playlist, type PlaylistEntry } from './playlists';
import { PlaylistWorkspace, type PlaylistHandle } from './PlaylistWorkspace';
import { PlaylistTrajectory } from './PlaylistTrajectory';
import { ListeningDock, type PlayerHandle } from './ListeningDock';
import type { Recording } from './types';

const record = (letter: string, R = 2): Recording => ({ recording_id: letter.repeat(64), prediction_id: 'synthetic',
  title: `Synthetic ${letter}`, duration_seconds: 120, raw_rtp: { R, T: 3, P: 4 }, historical_rtp: { R: 2, T: 3, P: 4 },
  mood: { id: 'invented', label: 'Invented', intensity: null, method: 'test' }, playback_status: 'available',
  quality: { outside_saved_range_counts: { R: R < 1 ? 1 : 0, T: 0, P: 0 } } });
const entry = (id: string, letter = id): PlaylistEntry => ({ entry_id: id, recording_id: letter.repeat(64), title: `Saved ${letter}` });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('reordering preserves stable occurrence identities and duplicate recordings', () => {
  const entries = [entry('first', 'a'), entry('second', 'b'), entry('repeat', 'a')];
  const reordered = moveEntry(entries, 2, 0);
  expect(reordered.map(row => row.entry_id)).toEqual(['repeat', 'first', 'second']);
  expect(entries[0].entry_id).toBe('first');
  expect(moveEntry(entries, 0, -1)).toBe(entries);
});

test('trajectory retains negative and large raw outputs, reserves readable 1–5 space, and breaks missing slots', () => {
  const records = new Map([['a'.repeat(64), record('a', -1.25)], ['b'.repeat(64), record('b', 1e9)]]);
  const chart = trajectory([entry('a'), entry('missing', 'c'), entry('b')], records);
  expect(chart.min).toBe(-1.25); expect(chart.max).toBe(1e9);
  expect(chart.y(1) - chart.y(5)).toBeGreaterThan(90);
  expect(chart.y(-1.25)).toBeGreaterThan(chart.y(1)); expect(chart.y(1e9)).toBeLessThan(chart.y(5));
  expect(chart.paths[0].d.match(/M/g)).toHaveLength(2); expect(chart.paths[0].d).not.toContain('L');
  expect(chart.x(2)).toBeGreaterThan(chart.x(0));
  expect(trajectory([], records).paths[0].d).toBe('');
  expect(trajectory([entry('a')], records, 900).width).toBe(900);
  const long = trajectory(Array.from({ length: 120 }, (_, index) => entry(String(index), 'a')), records, 900);
  expect(long.width).toBeGreaterThan(6000); expect(long.items).toHaveLength(120);
});

test('chart selects by keyboard, exposes exact values/warnings and recomputes ordered series', () => {
  const a = record('a', -1.25), b = record('b'); const entries = [entry('a'), entry('b')];
  const records = new Map([[a.recording_id, a], [b.recording_id, b]]), select = vi.fn();
  const view = render(<PlaylistTrajectory entries={entries} records={records} selected="a" onSelect={select}/>);
  expect(view.container.querySelector('[data-axis="R"]')?.getAttribute('data-value')).toBe('-1.25');
  expect(screen.getByText(/Input-range warning/)).toBeTruthy();
  const original = view.container.querySelector('[data-series="R"]')?.getAttribute('d');
  fireEvent.keyDown(screen.getByRole('button', { name: /1. Synthetic a/ }), { key: 'ArrowRight' });
  expect(select).toHaveBeenCalledWith(entries[1]);
  view.rerender(<PlaylistTrajectory entries={[...entries].reverse()} records={records} selected="b" onSelect={select}/>);
  expect(view.container.querySelector('[data-series="R"]')?.getAttribute('d')).not.toBe(original);
});

test('workspace adds, moves, removes and saves occurrence order, then reopens persisted content', async () => {
  let saved: Playlist[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (_url.endsWith('/recipes')) return { ok: true, json: async () => ({ recipes: [] }) };
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      const document = { ...payload, id: 'saved-id', revision: payload.revision + 1,
        entries: payload.entries.map((e: PlaylistEntry) => ({ ...e, title: `Saved ${e.recording_id[0]}` })) };
      saved = [document]; return { ok: true, json: async () => document };
    }
    return { ok: true, json: async () => ({ playlists: saved }) };
  }));
  const ref = createRef<PlaylistHandle>(), listen = vi.fn();
  render(<PlaylistWorkspace ref={ref} records={[record('a'), record('b')]} onSelect={vi.fn()} onListen={listen} onPlay={vi.fn()}/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save playlist' }).hasAttribute('disabled')).toBe(false));
  act(() => ref.current!.add([record('a'), record('b'), record('a')]));
  fireEvent.change(screen.getByLabelText('Playlist name'), { target: { value: 'Synthetic ordering' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move playlist track 3 up' }));
  expect(document.activeElement?.closest('li')).toBe(screen.getByRole('list', { name: 'Playlist recordings' }).children[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Remove playlist track 3' }));
  fireEvent.click(screen.getByRole('button', { name: 'Listen to playlist track 1' }));
  expect(listen).toHaveBeenCalledWith(record('a'));
  fireEvent.click(screen.getByRole('button', { name: 'Save playlist' }));
  await screen.findByText('Saved in this browser');
  expect(saved[0].entries.map(e => e.recording_id)).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
  expect(new Set(saved[0].entries.map(e => e.entry_id)).size).toBe(2);
  fireEvent.click(screen.getByRole('button', { name: 'New playlist' }));
  fireEvent.change(screen.getByLabelText('Open saved playlist'), { target: { value: 'saved-id' } });
  expect(within(screen.getByRole('list', { name: 'Playlist recordings' })).getAllByRole('listitem')).toHaveLength(2);
});

test('missing saved entries keep their positions and cannot be auditioned', async () => {
  const playlist = { id: 'saved', name: 'Missing sample', revision: 1, entries: [entry('missing', 'c')] };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ playlists: [playlist], recipes: [] }) })));
  render(<PlaylistWorkspace records={[]} onSelect={vi.fn()} onListen={vi.fn()} onPlay={vi.fn()}/>);
  await screen.findByRole('option', { name: 'Missing sample · 1' });
  fireEvent.change(screen.getByLabelText('Open saved playlist'), { target: { value: 'saved' } });
  expect(screen.getByRole('button', { name: 'Listen to playlist track 1' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Missing from this catalog')).toBeTruthy();
});

test('explicit playlist transport advances duplicate occurrences and ignores later queue edits', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'currentSrc', 'get').mockImplementation(function(this: HTMLMediaElement) { return this.src; });
  vi.spyOn(HTMLMediaElement.prototype, 'ended', 'get').mockReturnValue(true);
  const ref = createRef<PlayerHandle>(), a = record('a'), b = record('b'), playback = vi.fn();
  const view = render(<ListeningDock ref={ref} onPlaybackChange={playback}/>), audio = view.container.querySelector('audio')!;
  const queue = [{ entry_id: '1', recording: a }, { entry_id: '2', recording: a }, { entry_id: '3', recording: b }];
  await act(async () => ref.current!.playPlaylist('Synthetic queue', queue));
  queue.reverse(); audio.currentTime = 50;
  await act(async () => fireEvent.ended(audio));
  expect(audio.src).toContain(a.recording_id); expect(audio.currentTime).toBe(0);
  expect(playback).toHaveBeenLastCalledWith({ recording_id: a.recording_id, entry_id: '2', playing: false, finished: false });
  expect(screen.getByText(/2 \/ 3$/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Next playlist track' })));
  expect(audio.src).toContain(b.recording_id);
  expect(playback).toHaveBeenLastCalledWith({ recording_id: b.recording_id, entry_id: '3', playing: false, finished: false });
  await act(async () => ref.current!.listen(a));
  expect(screen.queryByRole('button', { name: 'Next playlist track' })).toBeNull();
  expect(playback).toHaveBeenLastCalledWith({ recording_id: a.recording_id, entry_id: null, playing: false, finished: false });
});

test('selected and captured playing occurrences remain distinct through drag reordering', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ playlists: [], recipes: [] }) })));
  const ref = createRef<PlaylistHandle>(), a = record('a');
  const view = render(<PlaylistWorkspace ref={ref} records={[a]} onSelect={vi.fn()} onListen={vi.fn()} onPlay={vi.fn()}/>);
  await screen.findByRole('option', { name: 'Nothing saved yet' });
  act(() => ref.current!.add([a, a]));
  const list = screen.getByRole('list', { name: 'Playlist recordings' });
  const firstId = list.children[0].getAttribute('data-entry-id')!;
  view.rerender(<PlaylistWorkspace ref={ref} records={[a]} onSelect={vi.fn()} onListen={vi.fn()} onPlay={vi.fn()}
    playback={{ recording_id: a.recording_id, entry_id: firstId, playing: true }}/>);
  const rows = [...list.children];
  const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
  fireEvent.dragStart(rows[1], { dataTransfer });
  fireEvent.dragOver(rows[0], { dataTransfer });
  expect(rows[0].classList.contains('is-drop-target')).toBe(true);
  expect(rows[1].classList.contains('is-dragging')).toBe(true);
  fireEvent.drop(rows[0], { dataTransfer });
  expect(list.children[1].getAttribute('data-entry-id')).toBe(firstId);
  expect(list.children[1].getAttribute('aria-current')).toBe('true');
  expect(list.children[0].classList.contains('is-selected')).toBe(true);
  expect(view.container.querySelector('[data-playing-entry]')?.getAttribute('data-playing-entry')).toBe(firstId);
  expect(view.container.querySelector('.is-drop-target')).toBeNull();
  expect(screen.getByText(/Moved to position 1/)).toBeTruthy();
});
