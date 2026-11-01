// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { ListeningDock, shortcutAllowed, type PlayerHandle } from './ListeningDock';
import { useHistory } from './history';
import type { Recording } from './types';
import type { WaveformData } from './waveform';

const record = (id: string): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented-run',
  title: `Invented ${id}`, duration_seconds: 120, raw_rtp: { R: 2, T: 3, P: 4 },
  historical_rtp: { R: 2, T: 3, P: 4 }, mood: { id: 'invented', label: 'Invented mood', intensity: null, method: 'test' },
  quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } }, playback_status: 'available' });
afterEach(() => { cleanup(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* unavailable */ } });

function mediaMocks() {
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  vi.spyOn(HTMLMediaElement.prototype, 'currentSrc', 'get').mockImplementation(function(this: HTMLMediaElement) {
    return this.getAttribute('src') ? new URL(this.getAttribute('src')!, location.origin).href : '';
  });
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function(this: HTMLMediaElement) { return paused.get(this) ?? true; });
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(120);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event('pause')); });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function(this: HTMLMediaElement) {
    paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve();
  });
}
const waveform = (suggestion: number | null): WaveformData => ({ peaks: [.1, .9, .4, .2], duration: 120, sampleRate: 22050, suggestion });

test('auditioning sets the playlist aside and Return resumes the same occurrence and time', async () => {
  mediaMocks(); const ref = createRef<PlayerHandle>(), [a, b, c] = ['a', 'b', 'c'].map(record);
  const view = render(<ListeningDock ref={ref} analyze={async () => waveform(null)}/>), audio = view.container.querySelector('audio')!;
  await act(async () => ref.current!.playPlaylist('Invented queue', [{ entry_id: '1', recording: a }, { entry_id: '2', recording: b }], 1));
  expect(audio.src).toContain(b.recording_id); expect(screen.getByText(/2 \/ 2 · captured order/)).toBeTruthy();
  audio.currentTime = 30;
  await act(async () => ref.current!.listen(c));
  expect(screen.queryByRole('button', { name: 'Next playlist track' })).toBeNull();
  expect(screen.getByText(/set aside at 2 \/ 2, 0:30/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Return to playlist' })));
  expect(audio.src).toContain(b.recording_id);
  fireEvent.loadedMetadata(audio); expect(audio.currentTime).toBe(30);
  expect(screen.getByText(/2 \/ 2 · captured order/)).toBeTruthy();
});

test('the waveform draws real peaks, clicking seeks, and the title locates the recording', async () => {
  mediaMocks(); const ref = createRef<PlayerHandle>(), locate = vi.fn(), a = record('a');
  const analyze = vi.fn(async () => waveform(null));
  const view = render(<ListeningDock ref={ref} analyze={analyze} onLocate={locate}/>), audio = view.container.querySelector('audio')!;
  await act(async () => ref.current!.listen(a));
  fireEvent.loadedMetadata(audio);
  expect(analyze).toHaveBeenCalledWith(a.recording_id, expect.any(AbortSignal));
  const surface = view.container.querySelector<HTMLDivElement>('.waveform')!;
  expect(surface.querySelector('.waveform-base')!.getAttribute('d')!.match(/M/g)).toHaveLength(4);
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 400, top: 0, height: 52 } as DOMRect);
  fireEvent.pointerDown(surface, { clientX: 300, button: 0, pointerId: 1 });
  expect(audio.currentTime).toBe(60);
  expect(screen.getByText('No quiet introduction found')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: `Show ${a.title} in Explorer` }));
  expect(locate).toHaveBeenCalledWith(a);
});

test('suggested and personal audition starts apply only when chosen', async () => {
  mediaMocks(); const ref = createRef<PlayerHandle>(), [a, b] = ['a', 'b'].map(record);
  const view = render(<ListeningDock ref={ref} analyze={async () => waveform(12)}/>), audio = view.container.querySelector('audio')!;
  await act(async () => ref.current!.listen(a)); fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(0); expect(screen.getByText('Suggested 0:12')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /Start auditions at the suggested or my start/ }));
  await act(async () => ref.current!.listen(b)); fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(12); expect(screen.getByText(/Started at the suggested point/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set my start here' }));
  await act(async () => ref.current!.listen(a)); fireEvent.loadedMetadata(audio);
  await act(async () => ref.current!.listen(b)); fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(50);
  fireEvent.click(screen.getByRole('button', { name: 'Clear my start' }));
  expect(screen.getByText('Suggested 0:12')).toBeTruthy();
});

test('playback keys work outside forms and never inside text entry', async () => {
  mediaMocks(); const ref = createRef<PlayerHandle>();
  const view = render(<div><input aria-label="Typing"/><ListeningDock ref={ref} analyze={async () => waveform(null)}/></div>), audio = view.container.querySelector('audio')!;
  await act(async () => ref.current!.listen(record('a'))); fireEvent.loadedMetadata(audio);
  fireEvent.keyDown(document.body, { key: ' ' }); expect(audio.paused).toBe(true);
  await act(async () => fireEvent.keyDown(document.body, { key: 'k' })); expect(audio.paused).toBe(false);
  fireEvent.keyDown(document.body, { key: 'l' }); expect(audio.currentTime).toBe(10);
  fireEvent.keyDown(screen.getByLabelText('Typing'), { key: ' ' }); expect(audio.paused).toBe(false);
  fireEvent.keyDown(screen.getByLabelText('Typing'), { key: 'j' }); expect(audio.currentTime).toBe(10);
  const button = document.createElement('button'); document.body.append(button);
  expect(shortcutAllowed(new KeyboardEvent('keydown', { key: ' ' }))).toBe(false);
  const onButton = new KeyboardEvent('keydown', { key: ' ', bubbles: true }); Object.defineProperty(onButton, 'target', { value: button });
  expect(shortcutAllowed(onButton)).toBe(false); button.remove();
});

test('history coalesces typing, undoes and redoes, and rebases saved identity into the past', () => {
  const { result } = renderHook(() => useHistory(() => ({ id: null as string | null, value: 0 })));
  act(() => result.current.commit(s => ({ ...s, value: 1 }), 'one'));
  act(() => result.current.commit(s => ({ ...s, value: 2 }), 'typing', 'name'));
  act(() => result.current.commit(s => ({ ...s, value: 3 }), 'typing', 'name'));
  expect(result.current.undoLabel).toBe('typing');
  act(() => result.current.undo()); expect(result.current.value.value).toBe(1);
  act(() => result.current.rebase(s => ({ ...s, id: 'saved' })));
  act(() => result.current.undo()); expect(result.current.value).toEqual({ id: 'saved', value: 0 });
  act(() => result.current.redo()); act(() => result.current.redo()); expect(result.current.value).toEqual({ id: 'saved', value: 3 });
  expect(result.current.redoLabel).toBeNull();
});

test('outside the current view the dock reports playing, paused and finished accurately', async () => {
  mediaMocks(); const ref = createRef<PlayerHandle>(), a = record('a');
  const view = render(<ListeningDock ref={ref} visibleIds={[]} analyze={async () => waveform(null)}/>), audio = view.container.querySelector('audio')!;
  await act(async () => ref.current!.listen(a));
  fireEvent.loadedMetadata(audio);
  expect(screen.getByText('Outside current view · still playing')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pause playback' })));
  expect(screen.getByText('Outside current view · paused')).toBeTruthy();
  expect(screen.queryByText(/still playing|continues/)).toBeNull();
  audio.currentTime = 120; fireEvent.timeUpdate(audio);
  expect(screen.getByText('Outside current view · finished')).toBeTruthy();
  expect(screen.getByText('FINISHED')).toBeTruthy();
  view.rerender(<ListeningDock ref={ref} visibleIds={[a.recording_id]} analyze={async () => waveform(null)}/>);
  expect(screen.queryByText(/Outside current view/)).toBeNull();
});
