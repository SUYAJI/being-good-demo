import type { Recording, RTP } from '../types';
import type { PlaylistEntry } from '../playlists';
import type { TargetSnapshot } from '../journeys';
import { interpolateTargets, rtpDistance } from '../trajectoryDesign';
import { corridorEmphasis } from './frame';
import type { StageJourney } from './StageRenderer';

export type DesignerReport = { step: 'start' | 'shape' | 'playlist'; origin: RTP | null; moodId: string | null; peekMood: string | null;
  startId: string | null; endId: string | null; waypoints: RTP[] | null };
export type PreviewJourney = { waypoints: RTP[]; ids: string[] };
export type StageView = { emphasis: number[] | null; intended: RTP[] | null; marker: RTP | null; journey: StageJourney | null; caption: string };

const DIM = .26;

/** Candidates for one playlist position, nearest first to its point on the shape (or to the current recording). Same ranking the replacement list shows. */
export function rankReplacements(records: Recording[], currentId: string, reference: RTP | null) {
  return records.filter(record => record.playback_status === 'available' && record.recording_id !== currentId)
    .map(record => ({ record, distance: reference ? rtpDistance(record.raw_rtp, reference) : null }))
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.record.title.localeCompare(b.record.title));
}

/** What the stage shows for each moment of the guided experience. Everything is drawn from real positions and the listener's own choices. */
export function stageView({ records, welcome, preview, designer, entries, target, selectedEntry }: {
  records: Recording[]; welcome: boolean; preview: PreviewJourney | null; designer: DesignerReport | null;
  entries: PlaylistEntry[]; target: TargetSnapshot | null | undefined; selectedEntry: string | null;
}): StageView {
  const none: StageView = { emphasis: null, intended: null, marker: null, journey: null, caption: `${records.length} recordings, each at its measured Rhythm, Texture and Pitch` };
  if (welcome) {
    if (!preview) return none;
    const members = new Set(preview.ids);
    return { emphasis: records.map(r => members.has(r.recording_id) ? 1 : DIM), intended: preview.waypoints, marker: null,
      journey: { key: preview.ids.join(','), ids: preview.ids, targets: null, waypoints: null, style: 'preview' }, caption: 'A suggested journey: the dashed line is its shape, the orange line its recordings in order' };
  }
  if (!designer) return none;
  if (designer.step === 'start') {
    const mood = designer.peekMood ?? designer.moodId;
    if (mood) return { ...none, emphasis: records.map(r => r.mood.id === mood ? 1 : DIM), marker: designer.peekMood ? null : designer.origin,
      caption: designer.peekMood ? `${records.filter(r => r.mood.id === mood).length} recordings in this mood` : 'The playlist starts at the centre of this mood (the ringed point)' };
    if (designer.startId) return { ...none, caption: 'The playlist starts at the ringed recording' };
    return { ...none, marker: designer.origin, caption: 'Starting anywhere: the middle of the collection (the ringed point)' };
  }
  if (designer.step === 'shape') {
    const waypoints = designer.waypoints && designer.waypoints.length > 1 ? designer.waypoints : null;
    return { ...none, intended: waypoints, emphasis: waypoints ? corridorEmphasis(records, waypoints) : null,
      caption: waypoints ? 'Your shape through the space. Recordings near it stay bright; these are the ones it can pick from' : none.caption };
  }
  if (!entries.length) return { ...none, caption: 'Create a playlist to see it here' };
  const targets = target && target.waypoints.length > 1 ? interpolateTargets(target.waypoints, entries.length) : null;
  const members = new Set(entries.map(entry => entry.recording_id));
  const selectedIndex = entries.findIndex(entry => entry.entry_id === selectedEntry), selected = entries[selectedIndex];
  const reference = selected ? targets?.[selectedIndex] ?? records.find(r => r.recording_id === selected.recording_id)?.raw_rtp ?? null : null;
  const candidates = new Set(selected ? rankReplacements(records, selected.recording_id, reference).slice(0, 8).map(item => item.record.recording_id) : []);
  return {
    emphasis: records.map(r => members.has(r.recording_id) ? 1 : candidates.has(r.recording_id) ? .82 : DIM), intended: null, marker: null,
    journey: { key: entries.map(entry => `${entry.entry_id}:${entry.recording_id}`).join(',') + (target ? `|${JSON.stringify(target.waypoints)}` : ''),
      ids: entries.map(entry => records.some(r => r.recording_id === entry.recording_id) ? entry.recording_id : null), targets, waypoints: target?.waypoints ?? null, style: 'journey' },
    caption: candidates.size ? `Position ${selectedIndex + 1}: the brighter recordings nearby are the closest alternatives` :
      targets ? 'Orange: your playlist in order. Dashed: your shape. Thin lines join each point on the shape to the recording chosen for it' : 'Orange: your playlist in listening order',
  };
}
