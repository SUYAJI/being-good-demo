/** Listener-facing journey design on top of the trajectory generator.
 *
 * A journey is a shape through Rhythm, Texture and Pitch. The listener picks where it starts (a mood, a recording,
 * or anywhere), how it moves (a preset or a hand-drawn shape) and how long it is. Everything here is arithmetic
 * over the published raw positions; nothing is analyzed or invented.
 */
import type { Recording, RTP } from './types';
import { axes, generateSequence, rtpDistance, type Generation } from './trajectoryDesign';

export type StartChoice = { kind: 'any' } | { kind: 'mood'; id: string } | { kind: 'recording'; id: string };
export type PresetId = 'build' | 'rise-settle' | 'wind-down' | 'drift' | 'between';
export type Preset = { id: PresetId; name: string; description: string; shape: (start: RTP, end?: RTP | null) => RTP[] };

const clamp = (value: number) => Math.round(Math.max(1, Math.min(5, value)) * 10) / 10;
const shift = (point: RTP, R: number, T: number, P: number): RTP => ({ R: clamp(point.R + R), T: clamp(point.T + T), P: clamp(point.P + P) });
const midpoint = (a: RTP, b: RTP): RTP => ({ R: clamp((a.R + b.R) / 2), T: clamp((a.T + b.T) / 2), P: clamp((a.P + b.P) / 2) });

/** Offsets are in RTP units, sized to the spread of the published collection so presets stay where music exists. */
export const presets: Preset[] = [
  { id: 'build', name: 'Build', description: 'Starts where you begin and grows livelier: more rhythm, a fuller texture.',
    shape: start => [start, shift(start, .5, .4, .1), shift(start, 1, .7, .2)] },
  { id: 'rise-settle', name: 'Rise and settle', description: 'Gathers energy through the middle, then comes back down to rest.',
    shape: start => [start, shift(start, 1, .7, .2), shift(start, .1, 0, 0)] },
  { id: 'wind-down', name: 'Wind down', description: 'Eases off from the start: less rhythm, a sparser texture.',
    shape: start => [start, shift(start, -.5, -.4, -.1), shift(start, -1, -.8, -.2)] },
  { id: 'drift', name: 'Drift', description: 'Stays close to where it starts and wanders a little.',
    shape: start => [start, shift(start, .3, -.3, .2), shift(start, -.3, .3, -.2), shift(start, .1, .1, .1)] },
  { id: 'between', name: 'Between two recordings', description: 'Travels from the first recording to the one you choose at the end.',
    shape: (start, end) => end ? [start, midpoint(start, end), end] : [start, shift(start, .5, .3, .1)] },
];
export const presetById = (id: PresetId) => presets.find(preset => preset.id === id)!;

export const centroid = (records: Recording[]): RTP | null => records.length ? {
  R: records.reduce((sum, r) => sum + r.raw_rtp.R, 0) / records.length,
  T: records.reduce((sum, r) => sum + r.raw_rtp.T, 0) / records.length,
  P: records.reduce((sum, r) => sum + r.raw_rtp.P, 0) / records.length,
} : null;

/** Moods offered as starting points: only those with enough recordings to begin a playlist from. */
export const minimumMoodCount = 5;
export function moodStarts(records: Recording[], categories: { id: string; label: string }[]) {
  return categories.map(category => {
    const members = records.filter(r => r.mood.id === category.id && r.playback_status === 'available');
    return { id: category.id, label: category.label, count: members.length, center: centroid(members) };
  }).filter((mood): mood is typeof mood & { center: RTP } => mood.count >= minimumMoodCount && mood.center !== null)
    .sort((a, b) => b.count - a.count);
}

export function startPoint(choice: StartChoice, records: Recording[], categories: { id: string; label: string }[]): RTP | null {
  if (choice.kind === 'recording') return records.find(r => r.recording_id === choice.id)?.raw_rtp ?? null;
  if (choice.kind === 'mood') return moodStarts(records, categories).find(mood => mood.id === choice.id)?.center ?? null;
  const playable = records.filter(r => r.playback_status === 'available');
  return centroid(playable);
}

const roundPoint = (point: RTP): RTP => ({ R: clamp(point.R), T: clamp(point.T), P: clamp(point.P) });

export function presetWaypoints(preset: PresetId, start: RTP, end: RTP | null): RTP[] {
  return presetById(preset).shape(roundPoint(start), end ? roundPoint(end) : null);
}

export type JourneyPlan = { waypoints: RTP[]; length: number; firstId: string | null; lastId: string | null };

/** Generate with the existing assignment, then pin the chosen first and last recordings so the journey really starts and ends there. */
export function planJourney(records: Recording[], plan: JourneyPlan): Generation {
  const result = generateSequence(records, plan.waypoints, plan.length);
  const recordings = [...result.recordings];
  const pin = (id: string | null, slot: number) => {
    if (!id || !recordings.length) return;
    const record = records.find(r => r.recording_id === id && r.playback_status === 'available');
    if (!record) return;
    const at = recordings.findIndex(r => r.recording_id === id);
    const index = slot < 0 ? recordings.length + slot : slot;
    if (at === index) return;
    if (at >= 0) [recordings[at], recordings[index]] = [recordings[index], recordings[at]];
    else recordings[index] = record;
  };
  pin(plan.firstId, 0); pin(plan.lastId, -1);
  const meanDistance = result.targets.length ? recordings.reduce((sum, record, index) =>
    sum + rtpDistance(record.raw_rtp, result.targets[index]) / result.targets.length, 0) : null;
  return { ...result, recordings, meanDistance };
}

/** The whole collection's reach along each axis, so a shape can be judged against real music before generating. */
export function coverage(records: Recording[]) {
  const playable = records.filter(r => r.playback_status === 'available');
  return Object.fromEntries(axes.map(axis => [axis, playable.length ? [Math.min(...playable.map(r => r.raw_rtp[axis])), Math.max(...playable.map(r => r.raw_rtp[axis]))] : [1, 5]])) as Record<keyof RTP, [number, number]>;
}

/** How far each waypoint is from the nearest playable recording: the honest measure of whether the collection can follow the shape. */
export function reach(records: Recording[], waypoints: RTP[]) {
  const playable = records.filter(r => r.playback_status === 'available');
  return waypoints.map(point => playable.length ? Math.min(...playable.map(r => rtpDistance(r.raw_rtp, point))) : Infinity);
}

/** Suggested journeys built from the recordings that exist: the most contrasting pair, and the two largest moods. */
export function suggestedJourneys(records: Recording[], categories: { id: string; label: string }[]) {
  const playable = records.filter(r => r.playback_status === 'available');
  if (playable.length < 6) return [];
  const moods = moodStarts(records, categories);
  const calmest = [...playable].sort((a, b) => (a.raw_rtp.R + a.raw_rtp.T) - (b.raw_rtp.R + b.raw_rtp.T))[0];
  const liveliest = [...playable].sort((a, b) => (b.raw_rtp.R + b.raw_rtp.T) - (a.raw_rtp.R + a.raw_rtp.T))[0];
  const suggestions: { id: string; name: string; description: string; start: StartChoice; preset: PresetId; endId: string | null; length: number }[] = [
    { id: 'calm-to-lively', name: 'Calm to lively', description: `From “${calmest.title}” to “${liveliest.title}”, the two ends of this collection.`,
      start: { kind: 'recording', id: calmest.recording_id }, preset: 'between', endId: liveliest.recording_id, length: 8 },
  ];
  if (moods[0]) suggestions.push({ id: 'rise-settle', name: 'Rise and settle', description: `Begins in ${moods[0].label.toLowerCase()} music, gathers energy, then settles again.`,
    start: { kind: 'mood', id: moods[0].id }, preset: 'rise-settle', endId: null, length: 8 });
  const lively = moods.find(mood => mood.center.R + mood.center.T === Math.max(...moods.map(m => m.center.R + m.center.T)));
  if (lively && lively !== moods[0]) suggestions.push({ id: 'wind-down', name: 'Wind down', description: `Starts in ${lively.label.toLowerCase()} music and eases off.`,
    start: { kind: 'mood', id: lively.id }, preset: 'wind-down', endId: null, length: 6 });
  return suggestions;
}

/** Recordings that illustrate each axis: the lowest and highest playable value, for the How it works explanation. */
export function axisExamples(records: Recording[]) {
  const playable = records.filter(r => r.playback_status === 'available');
  return axes.map(axis => {
    const sorted = [...playable].sort((a, b) => a.raw_rtp[axis] - b.raw_rtp[axis]);
    return { axis, low: sorted[0] ?? null, high: sorted.at(-1) ?? null };
  });
}
