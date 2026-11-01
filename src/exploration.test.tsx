// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectionView } from './ProjectionView';
import { FilterPanel, clearFilters, filterPayload, toggleMood } from './FilterPanel';
import { AtlasSlice } from './AtlasSlice';
import type { AtlasData, Recording } from './types';

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.setAttribute('open', ''); } });
Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: function () { this.setAttribute('open', ''); } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open'); } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const record = (id: string): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented-run', title: `Invented ${id}`,
  duration_seconds: 120, raw_rtp: { R: 6.25, T: -1.5, P: 3 }, historical_rtp: { R: 5, T: 1, P: 3 },
  mood: { id: 'peaceful', label: 'Peaceful', intensity: 4.5, method: 'invented' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } }, playback_status: 'available' });
const reply = (value: unknown) => ({ ok: true, json: async () => value });

test('2D keyboard selection preserves out-of-frame coordinates without playing audio', () => {
  const select = vi.fn(), play = vi.spyOn(HTMLMediaElement.prototype, 'play');
  const records = [record('a'), record('b')];
  const view = render(<ProjectionView records={records} visibleIds={records.map(r => r.recording_id)} selected={null} axes="RT" onSelect={select}/>);
  const a = screen.getByRole('button', { name: 'Invented a, Peaceful' });
  fireEvent.keyDown(a, { key: 'ArrowRight' });
  expect(select).toHaveBeenLastCalledWith('b'.repeat(64)); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Invented b, Peaceful' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(play).not.toHaveBeenCalled(); expect(a.getAttribute('data-raw-position')).toBe('6.25,-1.5,3');
  view.rerender(<ProjectionView records={records} visibleIds={[records[0].recording_id]} selected={records[1].recording_id} axes="RT" onSelect={select}/>);
  expect(screen.queryByRole('button', { name: 'Invented b, Peaceful' })).toBeNull();
});

test('mood and region controls apply live: empty selection, inclusive floor and unclamped bounds', () => {
  vi.useFakeTimers(); const apply = vi.fn(), close = vi.fn();
  render(<FilterPanel open onClose={close} value={clearFilters()} onApply={apply} categories={[{ id: 'peaceful', label: 'Peaceful' }, { id: 'happy', label: 'Happy' }]} intensity/>);
  fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
  expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ moods: [] }));
  fireEvent.change(screen.getByLabelText('Minimum geometric intensity'), { target: { value: '4.5' } });
  fireEvent.change(screen.getByLabelText('Rhythm minimum'), { target: { value: '-2' } });
  fireEvent.change(screen.getByLabelText('Rhythm maximum'), { target: { value: '6.25' } });
  act(() => { vi.advanceTimersByTime(400); });
  const value = apply.mock.calls.at(-1)![0];
  expect(filterPayload(value, [{ id: 'peaceful' }], true)).toEqual({ moods: [], bounds: [[-2, 6.25], [-1e308, 1e308], [-1e308, 1e308]] });
  expect(value.minimum).toBe(4.5); expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Only Happy' }));
  expect(apply.mock.calls.at(-1)![0].moods).toEqual(['happy']);
  fireEvent.click(screen.getByRole('button', { name: 'Done' })); expect(close).toHaveBeenCalledOnce();
});

test('invalid region is reported and never replaces active filters', () => {
  vi.useFakeTimers(); const apply = vi.fn();
  render(<FilterPanel open onClose={() => {}} value={clearFilters()} onApply={apply} categories={[]} intensity={false}/>);
  fireEvent.change(screen.getByLabelText('Pitch minimum'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('Pitch maximum'), { target: { value: '2' } });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByRole('alert').textContent).toContain('minimum'); expect(apply).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Minimum geometric intensity') as HTMLInputElement).disabled).toBe(true);
});

test('mood toggling keeps null for every category and supports isolating one', () => {
  const categories = [{ id: 'a' }, { id: 'b' }];
  const hidden = toggleMood(clearFilters(), 'a', categories);
  expect(hidden.moods).toEqual(['b']); expect(toggleMood(hidden, 'a', categories).moods).toBeNull();
  expect(toggleMood(clearFilters(), 'b', categories, true).moods).toEqual(['b']);
});

test('atlas displays only the 81 returned discrete cells with keyboard interpretation', async () => {
  const scope = { comparison_space: '0'.repeat(64), mood_bundle_sha256: '1'.repeat(64) };
  const data: AtlasData = { scope, reference: true, pitch_tick: 6, cells: Array.from({ length: 81 }, (_, i) => ({
    ticks: [2 + i % 9, 2 + Math.floor(i / 9), 6], mood_id: 'peaceful', label: 'Peaceful', intensity: i / 10 + 1,
  })) };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(data)));
  await act(async () => { render(<AtlasSlice scope={scope}/>); });
  expect(screen.getAllByRole('gridcell')).toHaveLength(81);
  const current = screen.getByRole('gridcell', { selected: true }); fireEvent.keyDown(current, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('gridcell', { selected: true }));
  expect(screen.getByRole('status').textContent).toContain('Geometric intensity');
  expect(screen.getByText(/Cells do not classify/)).toBeTruthy();
});

