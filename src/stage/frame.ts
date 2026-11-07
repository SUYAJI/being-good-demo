import type { Recording, RTP } from '../types';

/** The region of RTP space the stage draws: the music's extent, widened slightly and rounded out to half-points. */
export type StageFrame = { R: [number, number]; T: [number, number]; P: [number, number] };
const axes = ['R', 'T', 'P'] as const;

export function stageFrame(records: Recording[]): StageFrame {
  const range = (axis: keyof RTP): [number, number] => {
    const values = records.map(r => r.raw_rtp[axis]).filter(Number.isFinite);
    if (!values.length) return [1, 5];
    return [Math.floor((Math.min(...values) - .15) * 2) / 2, Math.ceil((Math.max(...values) + .15) * 2) / 2];
  };
  return { R: range('R'), T: range('T'), P: range('P') };
}

export const frameCenter = (frame: StageFrame): RTP => ({ R: (frame.R[0] + frame.R[1]) / 2, T: (frame.T[0] + frame.T[1]) / 2, P: (frame.P[0] + frame.P[1]) / 2 });

/** Stage coordinates: R→x, P→y (up), T→z, one equal scale on every axis, centred on the frame. Nothing is clipped or moved. */
export function stagePosition(point: RTP, frame: StageFrame): [number, number, number] {
  const center = frameCenter(frame);
  return [point.R - center.R, point.P - center.P, point.T - center.T];
}

/** Recording emphasis along a shape: full within `near` RTP units of the drawn polyline, fading to `floor` by `far`. */
export function corridorEmphasis(records: Recording[], waypoints: RTP[], near = .3, far = .9, floor = .3): number[] {
  if (waypoints.length < 2) return records.map(() => 1);
  return records.map(record => {
    const d = Math.min(...waypoints.slice(1).map((point, index) => segmentDistance(record.raw_rtp, waypoints[index], point)));
    if (d <= near) return 1;
    if (d >= far) return floor;
    const t = (d - near) / (far - near);
    return 1 - (1 - floor) * t * t * (3 - 2 * t);
  });
}

export function segmentDistance(p: RTP, a: RTP, b: RTP) {
  const ab = axes.map(axis => b[axis] - a[axis]), ap = axes.map(axis => p[axis] - a[axis]);
  const length = ab.reduce((sum, v) => sum + v * v, 0);
  const t = length ? Math.max(0, Math.min(1, ab.reduce((sum, v, i) => sum + v * ap[i], 0) / length)) : 0;
  return Math.hypot(...axes.map((axis, i) => p[axis] - (a[axis] + ab[i] * t)));
}

/** The nearest recordings to a point by raw Euclidean RTP distance (identity breaks ties), as the generator measures them. */
export function nearestTo(records: Recording[], point: RTP, count: number): number[] {
  return records.map((record, index) => ({ index, d: Math.hypot(record.raw_rtp.R - point.R, record.raw_rtp.T - point.T, record.raw_rtp.P - point.P), id: record.recording_id }))
    .filter(item => records[item.index].playback_status === 'available')
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1)).slice(0, count).map(item => item.index);
}
