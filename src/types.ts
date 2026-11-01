export type RTP = { R: number; T: number; P: number };
export type Recording = {
  recording_id: string; prediction_id: string; title: string; duration_seconds: number;
  raw_rtp: RTP; historical_rtp: RTP;
  mood: { id: string; label: string; intensity: number | null; method: string };
  quality: { outside_saved_range_counts: RTP };
  playback_status: 'available' | 'unavailable';
  /** Published source and credit for the demonstration; display metadata, never an analysis input. */
  credit?: { artist: string; source: string; source_url: string; license_name: string; license_url: string; genre: string; tags: string[] };
};
export type SceneData = {
  schema_id: string; complete: boolean; revision: string; count: number;
  scope: { comparison_space: string; mood_bundle_sha256: string };
  mapping: { id: string; version: string }; records: Recording[];
  categories?: { id: string; label: string }[];
  intensity_available?: boolean; imports_enabled?: boolean;
};

export type AtlasData = { scope: SceneData['scope']; reference: boolean; pitch_tick: number;
  cells: { ticks: [number, number, number]; mood_id: string; label: string; intensity: number | null }[] };
export type IndexingJob = { id: string; title: string; state: 'uploading' | 'queued' | 'running' | 'interrupted' | 'succeeded' | 'reused' | 'failed' | 'cancelled';
  recording_id: string | null; prediction_id: string | null; error_code: string | null; elapsed_seconds: number; cache_reused: boolean };
export type JobList = { jobs: IndexingJob[]; paused: boolean };

export const moodColors: Record<string, string> = {
  sad: '#ef334e', peaceful: '#3155ee', excited: '#e8c900', happy: '#00adbf', manic: '#d619c8',
  // Compound colors are contemporary display choices, not recovered historical values.
  'cautious-excited': '#b5bc00', 'cautious-peaceful': '#069c72', 'cautious-sad': '#678e32',
};
export const colorOf = (record: Recording) => moodColors[record.mood.id] ?? '#c5c5c5';
export const timeLabel = (seconds: number) => {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
