# Being Good Explorer — demonstration

An interactive version of the Being Good Explorer, hosted on GitHub Pages.

Being Good places music in a shared space of three perceptual scores: Rhythm,
Texture and Pitch (RTP). Each axis runs from 1 to 5. The Explorer opens with a
welcome and a **Playlist Designer**: choose where a playlist begins (a mood, a
recording, or anywhere), choose how it moves (a preset shape, a journey between
two recordings, or a hand-drawn shape), and the Explorer picks real recordings
along that path. You can then listen, keep or swap recordings, reorder, and save
the playlist in your browser. **Explore** mode keeps the open-ended tools: the
2D projections (zoomed to the music by default, with the full 1–5 scale one key
away), the 3D field, nearby music, the mood atlas, filters and the listening
dock. **How it works** explains RTP with real examples; recording credits have
their own view.

Nothing is analyzed in the browser: every position comes from the original
pipeline, and the designer is arithmetic over those published values.

## What is real here

- **Recordings.** Each one is a real recording from
  [ccMixter](https://ccmixter.org), credited by title, artist, source page and
  license. The full list is in [`public/data/recordings.csv`](public/data/recordings.csv)
  and in the site's About panel.
- **Analysis.** Every RTP position was computed offline by the original Being
  Good pipeline: the pinned historical acoustic extractor and the original fitted
  predictors, run on each original file. The published values are the stored
  results, unchanged. Continuous raw RTP and the historical half-point position
  are kept as separate values, and the mood comes from the historical mood map.
- **Audio.** Playback files are full-length 96 kbps MP3 copies decoded from the
  same originals that were analyzed. The export checked each copy against its
  original by duration and loudness envelope.

Nothing is analyzed in the browser. This repository contains no models,
extractor, mood-map bundle, database or private configuration. Those stay with
the private engine.

## What differs from the local Explorer

| Local Explorer | This demonstration |
|---|---|
| Loopback server with a private library | Static JSON prepared offline |
| Add MP3 imports and analysis | Not available |
| Playlists saved in a private database | Saved only in this browser (localStorage) |
| Filters and neighbors computed by the server | Same arithmetic in the browser over the published values |
| Mood atlas from the private mood map | The same 729 published lookup cells |

## Development

Requires Node 24.15 or later in the 24.x line, and pnpm.

```powershell
pnpm install --frozen-lockfile
pnpm verify     # checks the published dataset and looks for private paths
pnpm test
pnpm build
pnpm exec vite preview
```

[`scripts/verify-data.mjs`](scripts/verify-data.mjs) checks the recording count
(from [`EXPECTED_RECORDINGS`](EXPECTED_RECORDINGS)), unique identities, that
historical positions and moods agree with the raw values and atlas, that every
recording has one playback file, and that nothing in `public/` names private
paths or engine assets. The Pages workflow runs it, the tests and the build
before every deployment.

## Updating the recordings

The dataset is produced by a private export step next to the private engine. It
reads stored results through the Explorer's own scene loader, writes
`public/data/` and `public/audio/`, and never runs inference itself. To add
recordings, analyze them with the private pipeline, rerun the export with the
new expected count, update `EXPECTED_RECORDINGS`, then verify, test and push.

## Design process

The About panel can show selected design-research artifacts. See
[DESIGN-PROCESS.md](DESIGN-PROCESS.md). The section stays hidden until items are
added.

This is a personal, noncommercial demonstration.
