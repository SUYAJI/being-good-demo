// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Recording } from './types';
import { corridorEmphasis, nearestTo, stageFrame, stagePosition } from './stage/frame';
import { rankReplacements, stageView } from './stage/stageView';
import { interpolateTargets } from './trajectoryDesign';

const calls = vi.hoisted(() => ({ created: 0, disposed: 0, lost: 0, renders: 0 }));
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas'); info = { memory: { geometries: 3, textures: 0 } };
    constructor() { calls.created++; if ((globalThis as { noWebGL?: boolean }).noWebGL) throw new Error('WebGL unavailable'); }
    setClearColor() {} setPixelRatio() {} setSize() {} render() { calls.renders++; } dispose() { calls.disposed++; } forceContextLoss() { calls.lost++; }
  } };
});

const record = (id: string, R: number, T: number, P: number, mood = 'peaceful'): Recording => ({ recording_id: id.repeat(64), prediction_id: 'invented', title: `Invented ${id}`,
  duration_seconds: 60, raw_rtp: { R, T, P }, historical_rtp: { R: Math.round(R * 2) / 2, T: Math.round(T * 2) / 2, P: Math.round(P * 2) / 2 }, playback_status: 'available',
  mood: { id: mood, label: mood, intensity: 5, method: 'invented' }, quality: { outside_saved_range_counts: { R: 0, T: 0, P: 0 } } });
const records = [record('a', 1.9, 1.4, 1.1), record('b', 2.5, 2.2, 2.8), record('c', 3, 2.9, 3), record('d', 3.6, 3.4, 3.2, 'happy'), record('e', 4.1, 3.9, 3.4, 'happy')];

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (globalThis as { noWebGL?: boolean }).noWebGL; Object.assign(calls, { created: 0, disposed: 0, lost: 0, renders: 0 }); });

test('the stage frames the music in half-points and keeps raw positions on one equal scale', () => {
  const frame = stageFrame(records);
  expect(frame).toEqual({ R: [1.5, 4.5], T: [1, 4.5], P: [0.5, 4] });
  const [a, e] = [stagePosition(records[0].raw_rtp, frame), stagePosition(records[4].raw_rtp, frame)];
  // Distances in the stage equal raw RTP distances: nothing is stretched, clipped or nudged.
  expect(Math.hypot(a[0] - e[0], a[1] - e[1], a[2] - e[2])).toBeCloseTo(Math.hypot(4.1 - 1.9, 3.9 - 1.4, 3.4 - 1.1), 10);
  expect(a[0] - e[0]).toBeCloseTo(1.9 - 4.1); expect(a[1] - e[1]).toBeCloseTo(1.1 - 3.4); expect(a[2] - e[2]).toBeCloseTo(1.4 - 3.9);
});

test('emphasis along a shape is full near it and fades with distance; nearest candidates rank as the generator measures', () => {
  const values = corridorEmphasis(records, [records[1].raw_rtp, records[3].raw_rtp]);
  expect(values[1]).toBe(1); expect(values[2]).toBe(1); expect(values[3]).toBe(1);
  expect(values[0]).toBeCloseTo(.3); expect(values[4]).toBeLessThan(1);
  expect(nearestTo(records, records[2].raw_rtp, 2)).toEqual([2, 3]);
});

test('each moment of the designer maps to what the space shows', () => {
  const designer = { step: 'start' as const, origin: { R: 3, T: 3, P: 3 }, moodId: 'happy', peekMood: null, startId: null, endId: null, waypoints: null };
  const start = stageView({ records, welcome: false, preview: null, designer, entries: [], target: null, selectedEntry: null });
  expect(start.emphasis).toEqual([.26, .26, .26, 1, 1]); expect(start.marker).toEqual({ R: 3, T: 3, P: 3 });
  const waypoints = [records[0].raw_rtp, records[4].raw_rtp];
  const shape = stageView({ records, welcome: false, preview: null, designer: { ...designer, step: 'shape', waypoints }, entries: [], target: null, selectedEntry: null });
  expect(shape.intended).toEqual(waypoints); expect(shape.journey).toBeNull();
  const entries = records.slice(0, 3).map((r, i) => ({ entry_id: `e${i}`, recording_id: r.recording_id, title: r.title }));
  const target = { schema_id: 'bg.trajectory-target.v1' as const, interpolation: 'linear-even-order-v1' as const, waypoints, requested_count: 3, recipe: null };
  const playlist = stageView({ records, welcome: false, preview: null, designer: { ...designer, step: 'playlist' }, entries, target, selectedEntry: 'e1' });
  expect(playlist.journey!.ids).toEqual(entries.map(e => e.recording_id));
  expect(playlist.journey!.targets).toEqual(interpolateTargets(waypoints, 3));
  // Members are bright; alternatives for the chosen position are offered; the rest recede.
  expect(playlist.emphasis!.slice(0, 3)).toEqual([1, 1, 1]); expect(playlist.emphasis![3]).toBe(.82);
  expect(rankReplacements(records, entries[1].recording_id, playlist.journey!.targets![1])[0].record.recording_id).toBe(records[2].recording_id);
  const welcome = stageView({ records, welcome: true, preview: { waypoints, ids: [records[0].recording_id, records[4].recording_id] }, designer: null, entries: [], target: null, selectedEntry: null });
  expect(welcome.journey!.style).toBe('preview'); expect(welcome.emphasis).toEqual([1, .26, .26, .26, 1]);
});

function environment() {
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
}

test('the stage releases its renderer, context, canvas and overlays when it leaves', async () => {
  environment();
  const { JourneyStage } = await import('./stage/JourneyStage');
  const props = { records, selected: null, onSelect: () => {}, emphasis: null, intended: null, marker: null, journey: null, revealKey: 0, playback: null, clock: () => null,
    insets: { left: 0, right: 0 }, label: 'space', reduced: true, fallback: <p>2D field</p> };
  const view = render(<JourneyStage {...props}/>);
  expect(calls.created).toBe(1);
  expect(view.container.querySelector('canvas')).toBeTruthy(); expect(view.container.querySelectorAll('.stage-axis')).toHaveLength(3);
  act(() => view.rerender(<JourneyStage {...props} journey={{ key: 'k', ids: [records[0].recording_id, records[2].recording_id, null], targets: null, waypoints: null, style: 'journey' }}/>));
  expect([...view.container.querySelectorAll('.stage-number')].map(e => e.textContent)).toEqual(['01', '02']);
  view.unmount();
  expect(calls.disposed).toBe(1); expect(calls.lost).toBe(1);
  expect(document.querySelector('canvas')).toBeNull(); expect(document.querySelector('.stage-layer')).toBeNull();
});

test('without WebGL the stage shows the same data in the 2D field', async () => {
  environment(); (globalThis as { noWebGL?: boolean }).noWebGL = true;
  const { JourneyStage } = await import('./stage/JourneyStage');
  const view = render(<JourneyStage records={records} selected={null} onSelect={() => {}} emphasis={null} intended={null} marker={null} journey={null} revealKey={0}
    playback={null} clock={() => null} insets={{ left: 0, right: 0 }} label="space" reduced fallback={<p>2D field</p>}/>);
  expect(view.getByText('2D field')).toBeTruthy(); expect(view.container.querySelector('canvas')).toBeNull();
});
