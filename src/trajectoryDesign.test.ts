import { expect, test } from 'vitest';
import { compareSequence, generateSequence, interpolateTargets, rtpDistance } from './trajectoryDesign';
import type { Recording, RTP } from './types';

const point = (R: number, T = 3, P = 3): RTP => ({ R, T, P });
const record = (id: string, R: number, available = true): Recording => ({ recording_id: id, prediction_id: 'synthetic', title: `Invented ${id}`,
  raw_rtp: point(R), historical_rtp: point(3), duration_seconds: 60, playback_status: available ? 'available' : 'unavailable',
  mood: { id: 'invented', label: 'Invented', intensity: null, method: 'test' }, quality: { outside_saved_range_counts: point(0, 0, 0) } });

test('piecewise interpolation includes endpoints, intermediate points and equal order spacing', () => {
  const waypoints = [point(1, 2, 3), point(5, 4, 1), point(3, 1, 5)];
  expect(interpolateTargets(waypoints, 5)).toEqual([waypoints[0], point(3, 3, 2), waypoints[1], point(4, 2.5, 3), waypoints[2]]);
  expect(interpolateTargets(waypoints, 1)).toEqual([waypoints[1]]);
  expect(interpolateTargets(waypoints, 0)).toEqual([]);
  expect(() => interpolateTargets([point(0), point(3)], 3)).toThrow(/between 1 and 5/);
  expect(() => interpolateTargets([point(NaN), point(3)], 3)).toThrow();
  expect(() => interpolateTargets([point(2)], 3)).toThrow();
  expect(() => interpolateTargets(waypoints, 501)).toThrow();
});

test('assignment considers the whole sequence and improves on a greedy early choice', () => {
  const result = generateSequence([record('a', 1), record('b', 3.2), record('c', 5)], [point(2), point(1), point(5)], 3);
  expect(result.recordings.map(record => record.recording_id)).toEqual(['b', 'a', 'c']);
  expect(result.meanDistance).toBeCloseTo(1.2 / 3);
  expect(new Set(result.recordings.map(record => record.recording_id)).size).toBe(3);
});

test('exact assignment matches independently enumerated small cases', () => {
  const candidates = [record('a', .75), record('b', 1.5), record('c', 3.5), record('d', 5.25)];
  for (const values of [[1, 2, 5], [3, 3, 3], [5, 2, 1], [1.25, 4.75, 2.5]]) {
    const targets = values.map(value => point(value));
    const totals: number[] = [];
    for (const a of candidates) for (const b of candidates) for (const c of candidates) {
      if (new Set([a, b, c]).size === 3) totals.push([a, b, c].reduce((sum, record, i) => sum + rtpDistance(record.raw_rtp, targets[i]), 0));
    }
    expect(generateSequence(candidates, targets, 3).meanDistance! * 3).toBeCloseTo(Math.min(...totals));
  }
});

test('ties are repeatable across input order and identities remain distinct', () => {
  const records = [record('c', 3), record('a', 3), record('b', 3)].map(item => ({ ...item, title: 'Invented shared title' }));
  const targets = [point(3), point(3)];
  const ids = (items: Recording[]) => generateSequence(items, targets, 3).recordings.map(record => record.recording_id);
  expect(ids(records)).toEqual(['a', 'b', 'c']);
  expect(ids([...records].reverse())).toEqual(ids(records));
  expect(ids([...records, records[0]])).toEqual(ids(records));
});

test('eligibility, shortages and generation bounds are explicit', () => {
  const result = generateSequence([record('a', 2), record('b', 5, false), record('a', 2)], [point(1), point(5)], 12);
  expect(result.recordings).toHaveLength(1); expect(result.targets).toEqual([point(3)]);
  expect(result.notices.join(' ')).toMatch(/unavailable.*midpoint/);
  expect(generateSequence([], [point(1), point(5)], 3).meanDistance).toBeNull();
  expect(generateSequence([record('a', NaN)], [point(1), point(5)], 3).recordings).toEqual([]);
  expect(() => generateSequence([], [point(1), point(5)], 2)).toThrow();
  expect(() => generateSequence([], [point(1), point(5)], 13)).toThrow();
  expect(generateSequence(Array.from({ length: 15 }, (_, i) => record(String(i), i / 3)), [point(1), point(5)], 12).recordings).toHaveLength(12);
});

test('raw out-of-domain predictions drive costs without clamping or historical substitution', () => {
  const result = generateSequence([record('a', -1.25), record('b', 3), record('c', 6.25)], [point(1), point(3), point(5)], 3);
  expect(result.recordings.map(record => record.raw_rtp.R)).toEqual([-1.25, 3, 6.25]);
  expect(result.meanDistance).toBeCloseTo((2.25 + 1.25) / 3);
});

test('fit diagnostics track reordered/replaced positions and preserve gaps', () => {
  const target = [point(1), point(5)];
  expect(rtpDistance(point(1, 1, 1), point(2, 3, 3))).toBe(3);
  const fit = compareSequence([record('a', 1), undefined, record('b', 4)], target);
  expect(fit.targets).toEqual([point(1), point(3), point(5)]);
  expect(fit.distances).toEqual([0, null, 1]); expect(fit.mean).toBe(.5); expect(fit.measured).toBe(2);
  expect(compareSequence([record('b', 4), record('a', 1)], target).mean).toBe(3.5);
  expect(compareSequence([], target).mean).toBeNull();
});
