import type { Recording } from './types';
import type { TargetSnapshot } from './journeys';

export type PlaylistEntry = { entry_id: string; recording_id: string; title: string };
export type Playlist = { id: string | null; name: string; revision: number; entries: PlaylistEntry[]; updated?: number; target?: TargetSnapshot | null };
export type QueueEntry = { entry_id: string; recording: Recording };
/** The loaded recording's real state: playing, or paused (finished = paused at the end). */
export type PlaybackPosition = { recording_id: string; entry_id: string | null; playing: boolean; finished?: boolean };

export function moveEntry(entries: PlaylistEntry[], from: number, to: number): PlaylistEntry[] {
  if (from < 0 || from >= entries.length || to < 0 || to >= entries.length || from === to) return entries;
  const next = [...entries], [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

export const emptyPlaylist = (): Playlist => ({ id: null, name: 'Untitled playlist', revision: 0, entries: [] });
export const playlistPayload = (playlist: Playlist) => ({ name: playlist.name, revision: playlist.revision,
  entries: playlist.entries.map(({ entry_id, recording_id }) => ({ entry_id, recording_id })), target: playlist.target ?? null });

/** Preserve sequence slots and gaps; never substitute historical/clamped predictions. */
export function trajectory(entries: PlaylistEntry[], records: Map<string, Recording>, availableWidth = 520) {
  const items = entries.map(entry => records.get(entry.recording_id));
  const values = items.flatMap(record => record ? Object.values(record.raw_rtp) : []);
  const min = Math.min(1, ...values), max = Math.max(5, ...values);
  const top = 26, height = 280, width = Math.max(520, availableWidth, entries.length * 72 + 104);
  const upper = max > 5 ? 42 : 0, lower = min < 1 ? 42 : 0;
  const central = height - upper - lower;
  // Explicit outer bands preserve ordering and show exact values without shrinking 1–5.
  const y = (value: number) => value > 5 ? top + upper * (1 - Math.log1p(value - 5) / Math.log1p(max - 5)) :
    value < 1 ? top + upper + central + lower * Math.log1p(1 - value) / Math.log1p(1 - min) :
      top + upper + (5 - value) / 4 * central;
  const x = (index: number) => entries.length <= 1 ? width / 2 : 62 + index * (width - 100) / (entries.length - 1);
  const paths = (['R', 'T', 'P'] as const).map(axis => {
    let gap = true;
    return { axis, d: items.map((record, index) => {
      if (!record) { gap = true; return ''; }
      const command = gap ? 'M' : 'L'; gap = false;
      return `${command}${x(index)},${y(record.raw_rtp[axis])}`;
    }).join(' ') };
  });
  return { items, min, max, width, height, top, x, y, paths, compressed: min < 1 || max > 5 };
}

export const predictorWarnings = (record: Recording) => Object.entries(record.quality.outside_saved_range_counts)
  .filter(([, count]) => count > 0).map(([axis, count]) => `${axis}: ${count} input${count === 1 ? '' : 's'} outside saved range`).join('; ');
