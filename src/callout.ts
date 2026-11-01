/** Screen-space placement for the selected-recording tag. Only the label moves; plotted positions never change. */
export type CalloutPlacement = { x: number; y: number; anchorX: number; anchorY: number; startX: number; startY: number };
type Point = { x: number; y: number };

const directions = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]] as const;

/**
 * Tries eight directions at three leader lengths and keeps the tag rectangle that covers the fewest
 * other recordings, path numbers and markers, never the selected point itself, and stays inside the view.
 */
export function placeCallout(point: Point, obstacles: Point[], size: { width: number; height: number },
  tag: { width: number; height: number }, ring = 13): CalloutPlacement {
  let best: (CalloutPlacement & { score: number }) | null = null;
  for (const distance of [30, 56, 84]) for (const [dx, dy] of directions) {
    const length = Math.hypot(dx, dy), anchorX = point.x + dx / length * distance, anchorY = point.y + dy / length * distance;
    const x = dx < 0 ? anchorX - tag.width : dx > 0 ? anchorX : anchorX - tag.width / 2;
    const y = dy < 0 ? anchorY - tag.height : dy > 0 ? anchorY : anchorY - tag.height / 2;
    let score = 0;
    for (const o of obstacles) if (o.x > x - 9 && o.x < x + tag.width + 9 && o.y > y - 9 && o.y < y + tag.height + 9) score += 1;
    if (point.x > x - 14 && point.x < x + tag.width + 14 && point.y > y - 14 && point.y < y + tag.height + 14) score += 5;
    if (x < 8 || x + tag.width > size.width - 8 || y < 8 || y + tag.height > size.height - 8) score += 50;
    score += distance / 400 + (dy > 0 ? .02 : 0);
    if (!best || score < best.score) best = { score, x, y, anchorX, anchorY,
      startX: point.x + dx / length * ring, startY: point.y + dy / length * ring };
  }
  const { score: _score, ...placement } = best!;
  return placement;
}

/** Monospace tag width estimate (IBM Plex Mono 12px plus LED and padding), used before the tag is measured. */
export const calloutSize = (text: string) => ({ width: text.length * 7.3 + 34, height: 24 });
