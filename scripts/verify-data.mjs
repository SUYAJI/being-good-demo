// Checks the published dataset before every build: counts, uniqueness, internal consistency of the
// stored predictions, one playback file per recording, and no private paths or engine assets.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const publicDir = join(root, 'public');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const scene = JSON.parse(readFileSync(join(publicDir, 'data', 'scene.json'), 'utf8'));
const atlas = JSON.parse(readFileSync(join(publicDir, 'data', 'atlas.json'), 'utf8'));
const expected = Number(process.env.EXPECTED_RECORDINGS ?? readFileSync(join(root, 'EXPECTED_RECORDINGS'), 'utf8').trim());

check(scene.schema_id === 'bg.explorer-scene.v1' && scene.complete === true, 'scene schema or completeness');
check(scene.records.length === scene.count && scene.count === expected, `count ${scene.records.length}/${scene.count}, expected ${expected}`);
const ids = new Set(scene.records.map(r => r.recording_id)), predictions = new Set(scene.records.map(r => r.prediction_id));
check(ids.size === scene.count && predictions.size === scene.count, 'duplicate recording or prediction identities');
check(new Set(scene.records.map(r => r.title)).size === scene.count, 'duplicate titles');

// Same output convention as the engine: clip to 1–5, then round half points with ties to even.
const tiesToEven = x => { const f = Math.floor(x), d = x - f; return d > .5 ? f + 1 : d < .5 ? f : (f % 2 === 0 ? f : f + 1); };
const historical = v => tiesToEven(Math.min(5, Math.max(1, v)) * 2) / 2;
const cells = new Map(Object.values(atlas.slices).flat().map(c => [c.ticks.join(','), c]));
check(Object.keys(atlas.slices).length === 9 && cells.size === 729, 'atlas must hold 9 slices of 81 cells');
check(atlas.scope.mood_bundle_sha256 === scene.scope.mood_bundle_sha256, 'atlas and scene mood maps differ');
const audio = new Set(readdirSync(join(publicDir, 'audio')).filter(name => extname(name) === '.mp3'));
for (const r of scene.records) {
  const name = r.title;
  check(/^[0-9a-f]{64}$/.test(r.recording_id) && /^[0-9a-f]{32,64}$/.test(r.prediction_id), `${name}: identity format`);
  for (const axis of 'RTP') {
    check(Number.isFinite(r.raw_rtp[axis]), `${name}: raw ${axis} not finite`);
    check(r.historical_rtp[axis] === historical(r.raw_rtp[axis]), `${name}: historical ${axis} disagrees with raw`);
  }
  const ticks = 'RTP'.split('').map(a => Math.round(r.historical_rtp[a] * 2)).join(',');
  const cell = cells.get(ticks);
  check(cell && cell.mood_id === r.mood.id && cell.intensity === r.mood.intensity, `${name}: mood disagrees with the atlas cell ${ticks}`);
  check(r.credit && r.credit.artist && r.credit.source, `${name}: missing credit`);
  check(audio.has(`${r.recording_id}.mp3`), `${name}: missing playback file`);
  check(r.playback_status === 'available', `${name}: playback unavailable`);
}
check(audio.size === scene.count, `${audio.size} playback files for ${scene.count} recordings`);

// No private paths, engine assets or databases anywhere in the published tree.
const forbidden = /[A-Za-z]:\\\\|[A-Za-z]:\\|\\Users\\|\/Users\/|being-good-private|\.private\.|streaming_extractor|sqlite|model_bundle|bg\.rtp-model-bundle|bg\.mood-map\.v1/i;
const allowedBinary = new Set(['.mp3', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2']);
const walk = dir => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
for (const path of walk(publicDir)) {
  const extension = extname(path).toLowerCase();
  if (allowedBinary.has(extension)) continue;
  check(['.json', '.csv', '.md', '.txt'].includes(extension), `unexpected published file type: ${path}`);
  check(!forbidden.test(readFileSync(path, 'utf8')), `private path or asset reference in ${path}`);
}

if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
const digest = createHash('sha256').update(readFileSync(join(publicDir, 'data', 'scene.json'))).digest('hex').slice(0, 16);
console.log(`verified ${scene.count} recordings, ${audio.size} playback files, 729 atlas cells (scene ${digest})`);
