// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { RecordingList } from './App';
import { ListeningDock, type PlayerHandle } from './ListeningDock';
import type { Recording } from './types';

const record = (id: string): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented-run',
  title: `Invented ${id}`, duration_seconds: 120, raw_rtp: { R: 2, T: 3, P: 4 },
  historical_rtp: { R: 2, T: 3, P: 4 }, mood: { id: 'invented', label: 'Invented mood', intensity: null, method: 'test' },
  quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } }, playback_status: 'available' });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('keyboard and click select the corresponding recording without starting media', () => {
  const select = vi.fn(); const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
  render(<RecordingList records={[record('a'), record('b')]} selected={null} onSelect={select}/>);
  const first = screen.getByRole('button', { name: /Invented a/ });
  fireEvent.click(first); expect(select).toHaveBeenLastCalledWith('a'.repeat(64));
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(select).toHaveBeenLastCalledWith('b'.repeat(64));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /Invented b/ }));
  expect(play).not.toHaveBeenCalled();
});

function mediaMocks() {
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  vi.spyOn(HTMLMediaElement.prototype, 'currentSrc', 'get').mockImplementation(function(this: HTMLMediaElement) {
    return this.getAttribute('src') ? new URL(this.getAttribute('src')!, location.origin).href : '';
  });
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function(this: HTMLMediaElement) { return paused.get(this) ?? true; });
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(120);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event('pause')); });
  return vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function(this: HTMLMediaElement) {
    paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve();
  });
}

test('one audio element persists, pauses, seeks, changes volume and switches only on Listen', async () => {
  mediaMocks(); const ref = createRef<PlayerHandle>();
  const view = render(<ListeningDock ref={ref}/>); const audio = view.container.querySelector('audio')!;
  await act(async () => ref.current!.listen(record('a')));
  const original = audio.src;
  view.rerender(<ListeningDock ref={ref}/>);
  expect(view.container.querySelector('audio')).toBe(audio); expect(audio.src).toBe(original);
  fireEvent.loadedMetadata(audio);
  fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: '45' } });
  expect(audio.currentTime).toBe(45);
  fireEvent.change(screen.getByLabelText('VOLUME'), { target: { value: '.3' } });
  expect(audio.volume).toBe(.3);
  fireEvent.click(screen.getByRole('button', { name: 'Pause playback' })); expect(audio.paused).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resume playback' })));
  expect(audio.paused).toBe(false);
  await act(async () => ref.current!.listen(record('b')));
  expect(audio.src).not.toBe(original); expect(audio.src).toContain('b'.repeat(64));
  expect(view.container.querySelectorAll('audio')).toHaveLength(1);
});

test('a late rejected play promise cannot replace the new source with an error', async () => {
  const play = mediaMocks(); let reject!: (reason: Error) => void;
  play.mockImplementationOnce(() => new Promise((_, failure) => { reject = failure; }));
  const ref = createRef<PlayerHandle>(); render(<ListeningDock ref={ref}/>);
  act(() => ref.current!.listen(record('a')));
  await act(async () => ref.current!.listen(record('b')));
  await act(async () => reject(new Error('old request interrupted')));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a stale ended event does not mark an actively playing new source as stopped', async () => {
  mediaMocks(); const ref = createRef<PlayerHandle>(); const view = render(<ListeningDock ref={ref}/>);
  await act(async () => ref.current!.listen(record('a')));
  await act(async () => ref.current!.listen(record('b')));
  fireEvent.ended(view.container.querySelector('audio')!);
  expect(screen.getByRole('button', { name: 'Pause playback' })).toBeTruthy();
});
