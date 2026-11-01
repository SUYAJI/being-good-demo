// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { SpatialScene, type SceneHandle } from './SpatialScene';
import type { Recording } from './types';

const calls = vi.hoisted(() => ({ created: 0, positions: [] as number[][] }));
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas'); info = { memory: { geometries: 7, textures: 2 } };
    constructor() { calls.created++; }
    setPixelRatio() {} setSize() {} dispose() {} forceContextLoss() {}
    render(_scene: unknown, camera: { position: { toArray: () => number[] } }) { calls.positions.push(camera.position.toArray()); }
  } };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); calls.created = 0; calls.positions = []; });

function environment() {
  const pending: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { pending.push(callback); return pending.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ beginPath() {}, arc() {}, stroke() {}, fill() {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  return () => { const frames = pending.splice(0); act(() => frames.forEach(callback => callback(performance.now()))); };
}

test('controls remove their document capture listeners before the canvas detaches', () => {
  environment(); const added = vi.spyOn(document, 'addEventListener'), removed = vi.spyOn(document, 'removeEventListener');
  const view = render(<section><SpatialScene records={[]} selected={null} onSelect={() => {}}/></section>);
  const listener = added.mock.calls.find(([name, , options]) => name === 'keydown' && typeof options === 'object' && options?.capture)?.[1];
  expect(listener).toBeTruthy(); view.rerender(<section><p>2D projection</p></section>);
  expect(removed.mock.calls.some(([name, callback]) => name === 'keydown' && callback === listener)).toBe(true);
});

test('filtering reuses buffers and publication preserves the current camera', () => {
  const flush = environment(), ref = createRef<SceneHandle>();
  const record: Recording = { recording_id: 'a'.repeat(64), prediction_id: 'invented', title: 'Invented', duration_seconds: 1,
    raw_rtp: { R: 2, T: 3, P: 4 }, historical_rtp: { R: 2, T: 3, P: 4 }, mood: { id: 'invented', label: 'Invented', intensity: null, method: 'test' },
    quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } }, playback_status: 'unavailable' };
  const records = [record], view = render(<SpatialScene ref={ref} records={records} visibleIds={[record.recording_id]} selected={null} onSelect={() => {}}/>); flush();
  const canvas = view.container.querySelector('canvas');
  act(() => ref.current!.command('left')); flush(); const position = calls.positions.at(-1);
  view.rerender(<SpatialScene ref={ref} records={records} visibleIds={[]} selected={null} onSelect={() => {}}/>); flush();
  expect(view.container.querySelector('canvas')).toBe(canvas); expect(calls.created).toBe(1);
  view.rerender(<SpatialScene ref={ref} records={[record, { ...record, recording_id: 'b'.repeat(64) }]} selected={null} onSelect={() => {}}/>); flush();
  expect(calls.created).toBe(2); expect(calls.positions.at(-1)).toEqual(position);
});
