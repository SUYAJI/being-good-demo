import { expect, test } from 'vitest';
import { peakEnvelope, suggestedStart } from './waveform';
import { generateSequence, regenerateUnlocked } from './trajectoryDesign';
import type { Recording } from './types';

const rate = 1000;
const signal = (seconds: number, amplitude: number) => Float32Array.from({ length: seconds * rate }, (_, i) => amplitude * Math.sin(i / 3));
const join = (...parts: Float32Array[]) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; parts.forEach(p => { out.set(p, at); at += p.length; }); return out; };

test('waveform peaks are the largest absolute sample across all channels in each bin', () => {
  const left = new Float32Array([0, .2, -.9, .1]), right = new Float32Array([.5, -.1, .3, 0]);
  const peaks = peakEnvelope([left, right], 2);
  expect(peaks).toHaveLength(2); expect(peaks[0]).toBeCloseTo(.5); expect(peaks[1]).toBeCloseTo(.9);
  expect(peakEnvelope([new Float32Array([.3, -.4])], 600)).toHaveLength(2);
  expect(peakEnvelope([], 10)).toEqual([]);
});

test('suggested start skips a quiet introduction and is withheld when there is none', () => {
  const start = suggestedStart([join(signal(8, .02), signal(40, .8))], rate);
  expect(start).not.toBeNull(); expect(start!).toBeGreaterThanOrEqual(7.5); expect(start!).toBeLessThanOrEqual(9);
  expect(suggestedStart([signal(30, .8)], rate)).toBeNull();
  // Reaching typical loudness with under 10 s left is not a useful audition start.
  expect(suggestedStart([join(signal(40, .02), signal(6, .8), signal(30, .02))], rate)).toBeNull();
  expect(suggestedStart([signal(2, .5)], rate)).toBeNull();
});

const record = (id: string, R: number, playable = true) => ({ recording_id: id, title: id, raw_rtp: { R, T: 3, P: 3 },
  playback_status: playable ? 'available' : 'unavailable' } as Recording);
const records = [1, 2, 3, 4, 5].map(R => record(`r${R}`, R));
const shape = [{ R: 1, T: 3, P: 3 }, { R: 5, T: 3, P: 3 }];

test('regenerating with nothing locked reproduces full generation', () => {
  const full = generateSequence(records, shape, 3).recordings.map(r => r.recording_id);
  const refill = regenerateUnlocked(records, shape, [undefined, undefined, undefined], [false, false, false]);
  expect(refill.recordings!.map(r => r!.recording_id)).toEqual(full);
});

test('locked positions stay fixed and are never repeated by the refill', () => {
  const current = [records[4], records[1], records[0]];
  const refill = regenerateUnlocked(records, shape, current, [true, false, false]);
  expect(refill.recordings!.map(r => r!.recording_id)).toEqual(['r5', 'r3', 'r4']);
  expect(new Set(refill.recordings!.map(r => r!.recording_id)).size).toBe(3);
});

test('refill respects candidate availability and leaves the playlist unchanged when short', () => {
  const few = [records[0], records[1], record('gone', 5, false)];
  const short = regenerateUnlocked(few, shape, [few[0], few[1], few[0]], [true, false, false]);
  expect(short.recordings).toBeNull(); expect(short.notices.join(' ')).toMatch(/Only 1 distinct playable recordings are free for 2 unlocked positions/);
  const refill = regenerateUnlocked([...few, records[3]], shape, [few[0], undefined, undefined], [true, false, false]);
  expect(refill.recordings!.map(r => r!.recording_id)).not.toContain('gone');
  expect(regenerateUnlocked(records, shape, [records[0]], [true]).recordings).toBeNull();
});
