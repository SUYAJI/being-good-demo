import type { Recording, RTP } from './types';

export const axes = ['R', 'T', 'P'] as const;
/** Measurement fills: cobalt, copper and violet, kept apart from the mood palette. */
export const rtpSeries = [{ axis: 'R', name: 'Rhythm', color: '#2E86D1', dash: undefined },
  { axis: 'T', name: 'Texture', color: '#B96F31', dash: '7 3' },
  { axis: 'P', name: 'Pitch', color: '#8B63E6', dash: '2 3' }] as const;
export type Generation = { waypoints: RTP[]; recordings: Recording[]; targets: RTP[];
  requested: number; eligible: number; meanDistance: number | null; notices: string[] };

export const defaultWaypoints = (): RTP[] => [
  { R: 2, T: 2, P: 2.5 }, { R: 4, T: 3.5, P: 3 }, { R: 2.5, T: 2.5, P: 4 },
];
export const rtpDistance = (a: RTP, b: RTP) => Math.hypot(a.R - b.R, a.T - b.T, a.P - b.P);

/** Waypoints and slots are evenly spaced by recording order, not audio duration. */
export function interpolateTargets(waypoints: RTP[], count: number): RTP[] {
  if (waypoints.length < 2 || waypoints.length > 7 || waypoints.some(point => axes.some(axis =>
    !Number.isFinite(point[axis]) || point[axis] < 1 || point[axis] > 5))) {
    throw new RangeError('Use 2–7 target waypoints with R, T and P between 1 and 5.');
  }
  if (!Number.isInteger(count) || count < 0 || count > 500) throw new RangeError('Use 0–500 comparison positions.');
  return Array.from({ length: count }, (_, index) => {
    const position = (count === 1 ? .5 : index / (count - 1)) * (waypoints.length - 1);
    const left = Math.min(waypoints.length - 2, Math.floor(position)), fraction = position - left;
    return Object.fromEntries(axes.map(axis => [axis,
      waypoints[left][axis] + fraction * (waypoints[left + 1][axis] - waypoints[left][axis])])) as RTP;
  });
}

/** Rectangular Hungarian assignment: one distinct column per slot, O(slots² × candidates).
 * Costs are Euclidean raw-RTP distances; there is no transition or confidence term.
 * Ascending identity columns and strict comparisons make equal-cost choices repeatable.
 */
function assign(cost: number[][]): number[] {
  const rows = cost.length, columns = cost[0].length;
  const rowPotential = Array(rows + 1).fill(0), columnPotential = Array(columns + 1).fill(0);
  const matchedRow = Array(columns + 1).fill(0), previous = Array(columns + 1).fill(0);
  for (let row = 1; row <= rows; row++) {
    matchedRow[0] = row;
    const slack = Array(columns + 1).fill(Infinity), visited = Array(columns + 1).fill(false);
    let column = 0;
    do {
      visited[column] = true;
      const activeRow = matchedRow[column];
      let delta = Infinity, next = 0;
      for (let candidate = 1; candidate <= columns; candidate++) {
        if (visited[candidate]) continue;
        const reduced = cost[activeRow - 1][candidate - 1] - rowPotential[activeRow] - columnPotential[candidate];
        if (reduced < slack[candidate]) { slack[candidate] = reduced; previous[candidate] = column; }
        if (slack[candidate] < delta) { delta = slack[candidate]; next = candidate; }
      }
      for (let candidate = 0; candidate <= columns; candidate++) {
        if (visited[candidate]) { rowPotential[matchedRow[candidate]] += delta; columnPotential[candidate] -= delta; }
        else slack[candidate] -= delta;
      }
      column = next;
    } while (matchedRow[column] !== 0);
    do {
      const prior = previous[column]; matchedRow[column] = matchedRow[prior]; column = prior;
    } while (column !== 0);
  }
  const result = Array(rows).fill(-1);
  for (let column = 1; column <= columns; column++) if (matchedRow[column]) result[matchedRow[column] - 1] = column - 1;
  return result;
}

/** Playable, distinct recordings with finite distances to every waypoint, in identity order. */
function eligible(records: Recording[], waypoints: RTP[]) {
  const identities = new Set<string>();
  const playable = records.filter(record => record.playback_status === 'available');
  const candidates = [...playable].sort((a, b) => a.recording_id < b.recording_id ? -1 : a.recording_id > b.recording_id ? 1 : 0)
    .filter(record => {
      if (identities.has(record.recording_id)) return false;
      identities.add(record.recording_id);
      return axes.every(axis => Number.isFinite(record.raw_rtp[axis])) &&
        waypoints.every(target => Number.isFinite(rtpDistance(record.raw_rtp, target)));
    });
  const notices: string[] = [];
  if (records.length > playable.length) notices.push(`${records.length - playable.length} unavailable recordings excluded.`);
  if (candidates.length < identities.size) notices.push('Recordings with non-finite geometric distances excluded. Raw predictions were not changed.');
  return { candidates, notices };
}

export function generateSequence(records: Recording[], waypoints: RTP[], requested: number): Generation {
  if (!Number.isInteger(requested) || requested < 3 || requested > 12) throw new RangeError('Generate 3–12 recordings.');
  interpolateTargets(waypoints, requested);
  const { candidates, notices } = eligible(records, waypoints);
  const targets = interpolateTargets(waypoints, Math.min(requested, candidates.length));
  const costs = targets.map(target => candidates.map(record => rtpDistance(record.raw_rtp, target)));
  const recordings = targets.length ? assign(costs).map(index => candidates[index]) : [];
  const meanDistance = targets.length ? recordings.reduce((sum, record, index) =>
    sum + rtpDistance(record.raw_rtp, targets[index]) / targets.length, 0) : null;
  if (candidates.length < requested) notices.push(candidates.length ?
    `Only ${candidates.length} distinct playable recordings: generated ${recordings.length} positions ${recordings.length === 1 ? 'at the target midpoint' : 'across the full target'}.` :
    'No playable recordings with usable RTP coordinates are available.');
  return { waypoints: waypoints.map(point => ({ ...point })), recordings, targets, requested,
    eligible: candidates.length, meanDistance, notices };
}

/** Refill only unlocked positions against the same evenly spaced targets.
 * Locked recordings stay in place and are removed from the candidate pool, so the refill never repeats them;
 * refilled positions are distinct playable recordings chosen with the same minimum-total-distance assignment.
 */
export function regenerateUnlocked(records: Recording[], waypoints: RTP[], current: (Recording | undefined)[], locked: boolean[]) {
  const targets = interpolateTargets(waypoints, current.length);
  const kept = new Set(current.flatMap((record, index) => locked[index] && record ? [record.recording_id] : []));
  const pool = eligible(records, waypoints), candidates = pool.candidates.filter(record => !kept.has(record.recording_id));
  const slots = current.flatMap((_, index) => locked[index] ? [] : [index]);
  if (!slots.length) return { recordings: null, targets, notices: ['Every position is locked; nothing to regenerate.'], eligible: candidates.length };
  if (candidates.length < slots.length) return { recordings: null, targets, eligible: candidates.length,
    notices: [`Only ${candidates.length} distinct playable recordings are free for ${slots.length} unlocked positions. Unlock fewer positions or add recordings.`] };
  const chosen = assign(slots.map(slot => candidates.map(record => rtpDistance(record.raw_rtp, targets[slot]))));
  const recordings = current.slice();
  slots.forEach((slot, row) => { recordings[slot] = candidates[chosen[row]]; });
  return { recordings, targets, notices: pool.notices, eligible: candidates.length };
}

export function compareSequence(actual: (Recording | undefined)[], waypoints: RTP[]) {
  const targets = interpolateTargets(waypoints, actual.length);
  const distances = actual.map((record, index) => record ? rtpDistance(record.raw_rtp, targets[index]) : null);
  const measured = distances.filter((value): value is number => value !== null && Number.isFinite(value));
  return { targets, distances, measured: measured.length,
    mean: measured.length ? measured.reduce((sum, value) => sum + value / measured.length, 0) : null };
}
