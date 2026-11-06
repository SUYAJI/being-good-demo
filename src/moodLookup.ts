import { useEffect, useState } from 'react';
import { readJSON } from './api';
import type { AtlasData, RTP } from './types';

/** Published mood lookup cells, one slice per Pitch half-point, read on demand and kept for the session. */
const slices = new Map<number, Promise<AtlasData['cells'] | null>>();
const tick = (value: number) => Math.max(2, Math.min(10, Math.round(value * 2)));

function slice(pitchTick: number) {
  if (!slices.has(pitchTick)) slices.set(pitchTick, readJSON<AtlasData>(`mood-atlas?pitch_tick=${pitchTick}`).then(data => data.cells).catch(() => null));
  return slices.get(pitchTick)!;
}

/** The historical mood label at a position, from the same half-point lookup the recordings use. Null when unavailable. */
export async function moodAt(point: RTP): Promise<string | null> {
  const cells = await slice(tick(point.P));
  const r = tick(point.R), t = tick(point.T), p = tick(point.P);
  return cells?.find(cell => cell.ticks[0] === r && cell.ticks[1] === t && cell.ticks[2] === p)?.label ?? null;
}

/** Mood labels for a list of points, resolving as slices arrive. */
export function useMoods(points: RTP[]): (string | null)[] {
  const key = points.map(point => `${tick(point.R)},${tick(point.T)},${tick(point.P)}`).join(';');
  const [moods, setMoods] = useState<{ key: string; labels: (string | null)[] }>({ key: '', labels: [] });
  useEffect(() => {
    let alive = true;
    Promise.all(points.map(moodAt)).then(labels => { if (alive) setMoods({ key, labels }); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return moods.key === key ? moods.labels : points.map(() => null);
}
