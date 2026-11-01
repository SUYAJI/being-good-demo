import type { SceneData } from './types';
import { BackendError, handle } from './staticBackend';
export { audioURL } from './staticBackend';

const messages: Record<string, string> = {
  invalid_playlist: 'Check the playlist name and entries. Names allow 100 characters; playlists allow 500 recordings.',
  playlist_changed: 'This playlist changed in another window. Use Reload saved to review it before saving again.',
  playlist_not_found: 'This saved playlist was deleted in another window. Use Reload saved.',
  playlist_limit: 'There are already 100 saved playlists. Delete one before creating another.',
  playlist_storage_full: 'This browser’s playlist storage is full or unavailable. Delete an unused playlist or target before saving more.',
  recording_not_in_catalog: 'A new playlist entry is no longer in this catalog. Reopen the library and try again.',
  invalid_recipe: 'Use a target name of 1–100 characters without control characters.',
  invalid_target: 'Use 2–7 waypoints with R/T/P values from 1 to 5 and a sequence length of 3–12.',
  recipe_changed: 'This target changed in another window. Use Reload targets to review it before saving again.',
  recipe_not_found: 'This target was deleted in another window. Use Reload targets or Duplicate target to keep your edits.',
  recipe_limit: 'There are already 100 saved targets. Delete one before creating another.',
  imports_not_configured: 'This read-only demonstration cannot add recordings.',
  data_unavailable: 'The published recording data could not be loaded. Check your connection and reload.',
};
export class APIError extends Error {
  constructor(public code: string, public status: number) { super(messages[code] ?? 'This request could not be completed. Try again.'); }
}

type Transport = (path: string, init?: RequestInit) => Promise<unknown>;
let transport: Transport = handle;
/** Interface tests replay the original local-server contract through a stubbed fetch; the demonstration never does. */
export function setTransport(next: Transport) { transport = next; }

/** The demonstration has no server: former API paths resolve against published data and browser storage. */
export async function readJSON<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try { return await transport(path, init) as T; }
  catch (error) { throw error instanceof BackendError ? new APIError(error.code, error.status) : error; }
}

export const postJSON = <T,>(path: string, body: unknown, signal?: AbortSignal) => readJSON<T>(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});

let pending: Promise<SceneData> | undefined;
export function bootstrap(): Promise<SceneData> {
  if (!pending) pending = (async () => {
    const scene = await readJSON<SceneData>('scene');
    if (scene.schema_id !== 'bg.explorer-scene.v1' || !scene.complete || scene.records.length !== scene.count)
      throw new Error('A complete recording scene is unavailable.');
    return scene;
  })().catch(error => { pending = undefined; throw error; });
  return pending;
}
