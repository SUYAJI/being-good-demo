import { expect, test } from 'vitest';
import { orthographicFit, screenHits, worldPosition } from './geometry';

test('raw R,T,P retain equal units and out-of-domain coordinates', () => {
  expect(worldPosition({ R: 7.25, T: -1.5, P: 2.3 })).toEqual([4.25, -.7000000000000002, -4.5]);
  const a = worldPosition({ R: 1, T: 2, P: 3 });
  const b = worldPosition({ R: 4, T: 6, P: 3 });
  expect(Math.hypot(...a.map((value, index) => value - b[index]))).toBe(5);
});

test('screen picking excludes hidden points and resolves overlaps deterministically', () => {
  const points = [
    { id: 'b', x: 10, y: 12, visible: true }, { id: 'a', x: 10, y: 8, visible: true },
    { id: 'hidden', x: 10, y: 10, visible: false }, { id: 'far', x: 40, y: 10, visible: true },
  ];
  expect(screenHits(points, 10, 10).map(point => point.id)).toEqual(['a', 'b']);
});

test('orthographic fit contains actual projected outliers at wide and narrow aspect ratios', () => {
  const points = [{ x: -4.5, y: 1 }, { x: 2, y: -2 }, { x: 1, y: 3 }];
  for (const aspect of [2, .55]) {
    const fit = orthographicFit(points, aspect);
    for (const point of points) {
      expect(Math.abs(point.x - fit.x)).toBeLessThan(fit.height * aspect / 2);
      expect(Math.abs(point.y - fit.y)).toBeLessThan(fit.height / 2);
    }
    expect(fit.height).toBeLessThan(Math.hypot(6.5, 5) * 1.6 / Math.min(1, aspect));
  }
});
