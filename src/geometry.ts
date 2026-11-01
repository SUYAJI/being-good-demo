import type { RTP } from './types';

/** R→X, P→Y, T→Z, one equal scale. No clipping or display jitter. */
export function worldPosition(raw: RTP): [number, number, number] {
  return [raw.R - 3, raw.P - 3, raw.T - 3];
}

/** Fit camera-plane bounds with one scale for both axes, leaving room for glyphs. */
export function orthographicFit(points: { x: number; y: number }[], aspect: number) {
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
  return { x: (left + right) / 2, y: (bottom + top) / 2,
    height: Math.max(2.5, top - bottom, (right - left) / Math.max(.1, aspect)) * 1.22 };
}

export function screenHits<T extends { id: string; x: number; y: number; visible: boolean }>(
  projected: T[], x: number, y: number, radius = 14,
): T[] {
  return projected.filter(p => p.visible && Math.hypot(p.x - x, p.y - y) <= radius)
    .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y) || a.id.localeCompare(b.id));
}
