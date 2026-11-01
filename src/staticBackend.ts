/** Read-only static stand-in for the local Explorer server.
 *
 * Recordings, predictions and mood interpretations are published JSON prepared offline by the original
 * pipeline; nothing here infers RTP. Filters and neighbors repeat the server's arithmetic over those published
 * values. Playlists and journey targets live only in this browser's storage and never change the dataset.
 */
import type { AtlasData, RTP, SceneData } from './types';

export class BackendError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

export type Credit = { artist: string; source: string; source_url: string; license_name: string; license_url: string; genre: string; tags: string[] };
export type AtlasFile = { scope: SceneData['scope']; method: string; slices: Record<string, AtlasData['cells']> };
export type DataFiles = { scene: SceneData; atlas: AtlasFile };

const base = () => new URL(import.meta.env.BASE_URL ?? './', document.baseURI);
export const dataURL = (name: string) => new URL(`data/${name}`, base()).href;
export const audioURL = (recordingId: string) => new URL(`audio/${recordingId}.mp3`, base()).href;

let files: Promise<DataFiles> | undefined;
async function readFile<T>(name: string): Promise<T> {
  const response = await fetch(dataURL(name));
  if (!response.ok) throw new BackendError('data_unavailable', response.status);
  return response.json();
}
export function loadData(): Promise<DataFiles> {
  files ??= Promise.all([readFile<SceneData>('scene.json'), readFile<AtlasFile>('atlas.json')])
    .then(([scene, atlas]) => ({ scene, atlas }))
    .catch(error => { files = undefined; throw error; });
  return files;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isUUID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const validName = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 100 && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const sameScope = (scene: SceneData, body: { scope?: unknown; revision?: unknown }) =>
  JSON.stringify(body.scope) === JSON.stringify(scene.scope) && body.revision === scene.revision;

type MoodBranch = { mood_id: string; minimum_intensity?: number | null };
type Query = { scope: unknown; revision: unknown; moods?: MoodBranch[] | null; bounds?: number[][] | null; ticks?: number[] | null };

/** Same semantics as the library query: inclusive raw bounds, exact historical ticks, union of mood branches. */
export function query(scene: SceneData, body: Query) {
  if (!sameScope(scene, body)) throw new BackendError('scene_changed', 409);
  const { bounds, ticks, moods } = body;
  if (bounds != null && (bounds.length !== 3 || bounds.some(pair => pair.length !== 2 || !finite(pair[0]) || !finite(pair[1]) || pair[0] > pair[1])))
    throw new BackendError('invalid_query', 422);
  if (ticks != null && (ticks.length !== 3 || ticks.some(t => !Number.isInteger(t) || t < 2 || t > 10))) throw new BackendError('invalid_query', 422);
  if (moods != null && (moods.length > 8 || moods.some(m => typeof m.mood_id !== 'string' || (m.minimum_intensity != null && (!finite(m.minimum_intensity) || m.minimum_intensity < 1 || m.minimum_intensity > 10)))))
    throw new BackendError('invalid_query', 422);
  if (moods?.some(m => m.minimum_intensity != null) && !scene.intensity_available) throw new BackendError('invalid_query', 422);
  const axes = ['R', 'T', 'P'] as const;
  const ids = scene.records.filter(record => {
    if (bounds && axes.some((axis, i) => record.raw_rtp[axis] < bounds[i][0] || record.raw_rtp[axis] > bounds[i][1])) return false;
    if (ticks && axes.some((axis, i) => Math.round(record.historical_rtp[axis] * 2) !== ticks[i])) return false;
    if (moods == null) return true;
    return moods.some(m => record.mood.id === m.mood_id && (m.minimum_intensity == null || (record.mood.intensity != null && record.mood.intensity >= m.minimum_intensity)));
  }).map(record => record.recording_id).sort();
  return { scope: scene.scope, revision: scene.revision, recording_ids: ids, count: ids.length };
}

const distance = (a: RTP, b: RTP) => Math.hypot(a.R - b.R, a.T - b.T, a.P - b.P);
/** Euclidean raw RTP distance, ties broken by recording identity, as in the library. */
export function nearest(scene: SceneData, body: { scope: unknown; revision: unknown; recording_id?: unknown; limit?: unknown }) {
  if (!sameScope(scene, body)) throw new BackendError('scene_changed', 409);
  const limit = body.limit ?? 12;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new BackendError('invalid_query', 422);
  const anchor = scene.records.find(record => record.recording_id === body.recording_id);
  if (!anchor) throw new BackendError('not_found', 404);
  const neighbors = scene.records.filter(record => record.recording_id !== anchor.recording_id)
    .map(record => ({ recording_id: record.recording_id, geometric_rtp_distance: distance(record.raw_rtp, anchor.raw_rtp) }))
    .sort((a, b) => a.geometric_rtp_distance - b.geometric_rtp_distance || (a.recording_id < b.recording_id ? -1 : 1))
    .slice(0, limit);
  return { scope: scene.scope, revision: scene.revision, metric: 'euclidean-raw-rtp', neighbors };
}

export function atlasSlice(scene: SceneData, atlas: AtlasFile, pitchTick: number): AtlasData & { method: string } {
  const cells = atlas.slices[String(pitchTick)];
  if (!Number.isInteger(pitchTick) || !cells) throw new BackendError('invalid_slice', 422);
  if (atlas.scope.mood_bundle_sha256 !== scene.scope.mood_bundle_sha256) throw new BackendError('scene_changed', 409);
  return { scope: scene.scope, reference: true, pitch_tick: pitchTick, method: atlas.method, cells };
}

/** A tiny revisioned document store in localStorage, mirroring the server's playlist and target rules. */
type Stored = { id: string; name: string; revision: number; created: number; updated: number; [key: string]: unknown };
const memory = new Map<string, string>();
function storage(): Pick<Storage, 'getItem' | 'setItem'> {
  try { const probe = '__bg_probe__'; localStorage.setItem(probe, '1'); localStorage.removeItem(probe); return localStorage; }
  catch { return { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); } }; }
}
const storageKey = (kind: string) => `being-good-demo.${kind}.v1`;
function readStore(kind: string): Stored[] {
  try { const value = JSON.parse(storage().getItem(storageKey(kind)) ?? '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function writeStore(kind: string, rows: Stored[]) {
  try { storage().setItem(storageKey(kind), JSON.stringify(rows)); }
  catch { throw new BackendError('playlist_storage_full', 409); }
}
const ordered = (rows: Stored[]) => [...rows].sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1));

function validTarget(value: unknown, snapshot: boolean): boolean {
  if (value === null && snapshot) return true;
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>, keys = ['schema_id', 'interpolation', 'waypoints', 'requested_count', ...(snapshot ? ['recipe'] : [])];
  if (Object.keys(target).sort().join() !== keys.sort().join() || target.schema_id !== 'bg.trajectory-target.v1' || target.interpolation !== 'linear-even-order-v1'
    || !Number.isInteger(target.requested_count) || (target.requested_count as number) < 3 || (target.requested_count as number) > 12
    || !Array.isArray(target.waypoints) || target.waypoints.length < 2 || target.waypoints.length > 7) return false;
  if (target.waypoints.some(p => typeof p !== 'object' || p === null || Object.keys(p).sort().join() !== 'P,R,T'
    || Object.values(p).some(n => !finite(n) || n < 1 || n > 5))) return false;
  if (snapshot && target.recipe != null) {
    const recipe = target.recipe as Record<string, unknown>;
    if (Object.keys(recipe).sort().join() !== 'id,name,revision' || !Number.isInteger(recipe.revision) || (recipe.revision as number) < 1 || !isUUID(recipe.id) || !validName(recipe.name)) return false;
  }
  return true;
}

const playlistDocument = (row: Stored) => ({ id: row.id, name: row.name, revision: row.revision, entries: row.entries, updated: row.updated, target: row.target ?? null });
const recipeDocument = (row: Stored) => ({ id: row.id, name: row.name, revision: row.revision, target: row.target, created: row.created, updated: row.updated });

export function listPlaylists() { return { playlists: ordered(readStore('playlists')).map(playlistDocument) }; }
export function listRecipes() { return { recipes: ordered(readStore('recipes')).map(recipeDocument) }; }

function saveDocument(kind: 'playlists' | 'recipes', id: string | null, revision: unknown, build: (previous: Stored | undefined) => Partial<Stored>) {
  const fail = kind === 'playlists' ? 'invalid_playlist' : 'invalid_recipe';
  if (id !== null && !isUUID(id)) throw new BackendError(fail, 422);
  if (!Number.isInteger(revision) || (revision as number) < 0) throw new BackendError(fail, 422);
  const rows = readStore(kind), previous = id === null ? undefined : rows.find(row => row.id === id);
  if (id !== null && !previous) throw new BackendError(kind === 'playlists' ? 'playlist_not_found' : 'recipe_not_found', 404);
  if (revision !== (previous?.revision ?? 0)) throw new BackendError(kind === 'playlists' ? 'playlist_changed' : 'recipe_changed', 409);
  if (!previous && rows.length >= 100) throw new BackendError(kind === 'playlists' ? 'playlist_limit' : 'recipe_limit', 409);
  const now = Date.now() / 1000, fields = build(previous);
  const row: Stored = previous ? { ...previous, ...fields, revision: previous.revision + 1, updated: now } :
    { id: crypto.randomUUID(), revision: 1, created: now, updated: now, name: '', ...fields } as Stored;
  writeStore(kind, previous ? rows.map(r => r.id === row.id ? row : r) : [...rows, row]);
  return row;
}

export function savePlaylist(scene: SceneData, id: string | null, body: Record<string, unknown>) {
  const keys = Object.keys(body ?? {}).sort().join();
  if (keys !== 'entries,name,revision' && keys !== 'entries,name,revision,target') throw new BackendError('invalid_playlist', 422);
  const { name, entries } = body;
  if (!validName(name) || !Array.isArray(entries) || entries.length > 500) throw new BackendError('invalid_playlist', 422);
  if ('target' in body && !validTarget(body.target, true)) throw new BackendError('invalid_target', 422);
  const records = new Map(scene.records.map(record => [record.recording_id, record]));
  return playlistDocument(saveDocument('playlists', id, body.revision, previous => {
    const old = new Map(((previous?.entries ?? []) as { entry_id: string; recording_id: string; title: string }[]).map(e => [e.entry_id, e]));
    const seen = new Set<string>();
    const saved = entries.map((entry: Record<string, unknown>) => {
      if (typeof entry !== 'object' || entry === null || Object.keys(entry).sort().join() !== 'entry_id,recording_id' || !isUUID(entry.entry_id)
        || seen.has(entry.entry_id) || typeof entry.recording_id !== 'string' || !/^[0-9a-f]{64}$/.test(entry.recording_id)) throw new BackendError('invalid_playlist', 422);
      seen.add(entry.entry_id);
      const current = records.get(entry.recording_id), prior = old.get(entry.entry_id);
      if (!current && prior?.recording_id !== entry.recording_id) throw new BackendError('recording_not_in_catalog', 422);
      return { entry_id: entry.entry_id, recording_id: entry.recording_id, title: current ? current.title : prior!.title };
    });
    // Like the server, an omitted target keeps an existing intention rather than erasing it.
    return { name: (name as string).trim(), entries: saved, target: 'target' in body ? body.target : previous?.target ?? null };
  }));
}

export function saveRecipe(id: string | null, body: Record<string, unknown>) {
  if (Object.keys(body ?? {}).sort().join() !== 'name,revision,target' || !validName(body.name)) throw new BackendError('invalid_recipe', 422);
  if (!validTarget(body.target, false)) throw new BackendError('invalid_target', 422);
  return recipeDocument(saveDocument('recipes', id, body.revision, () => ({ name: (body.name as string).trim(), target: body.target })));
}

export function deleteDocument(kind: 'playlists' | 'recipes', id: string, body: Record<string, unknown>) {
  const fail = kind === 'playlists' ? 'invalid_playlist' : 'invalid_recipe';
  if (!isUUID(id) || Object.keys(body ?? {}).join() !== 'revision' || !Number.isInteger(body.revision) || (body.revision as number) < 1) throw new BackendError(fail, 422);
  const rows = readStore(kind), row = rows.find(r => r.id === id);
  if (!row) throw new BackendError(kind === 'playlists' ? 'playlist_not_found' : 'recipe_not_found', 404);
  if (row.revision !== body.revision) throw new BackendError(kind === 'playlists' ? 'playlist_changed' : 'recipe_changed', 409);
  writeStore(kind, rows.filter(r => r.id !== id));
  return { deleted: true };
}

/** Route the Explorer's former API paths to published data or browser-local storage. */
export async function handle(path: string, init?: RequestInit): Promise<unknown> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const [route, search = ''] = path.split('?');
  const parts = route.split('/');
  if (route === 'session') return { ready: true };
  const { scene, atlas } = await loadData();
  if (method === 'GET' && route === 'scene') return scene;
  if (method === 'GET' && route === 'context') return { schema_id: 'bg.explorer-context.v1', scope: scene.scope, revision: scene.revision, count: scene.count,
    mapping: scene.mapping, categories: scene.categories, intensity_available: scene.intensity_available, imports_enabled: false };
  if (method === 'GET' && route === 'mood-atlas') return atlasSlice(scene, atlas, Number(new URLSearchParams(search).get('pitch_tick') ?? 6));
  if (method === 'POST' && route === 'query') return query(scene, body);
  if (method === 'POST' && route === 'nearest') return nearest(scene, body);
  if (parts[0] === 'playlists' || parts[0] === 'recipes') {
    const kind = parts[0] as 'playlists' | 'recipes';
    if (method === 'GET' && parts.length === 1) return kind === 'playlists' ? listPlaylists() : listRecipes();
    if (method === 'POST' && parts.length === 3 && parts[2] === 'delete') return deleteDocument(kind, parts[1], body);
    if (method === 'POST' && parts.length <= 2) return kind === 'playlists' ? savePlaylist(scene, parts[1] ?? null, body) : saveRecipe(parts[1] ?? null, body);
  }
  if (['jobs', 'queue', 'imports'].includes(parts[0])) throw new BackendError('imports_not_configured', 409);
  throw new BackendError('not_found', 404);
}
