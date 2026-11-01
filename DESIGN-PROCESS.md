# Adding design-process artifacts

The About panel has a Design process section. It stays hidden until
`public/data/design-process.json` lists at least one item. Nothing is published
automatically: add only the artifacts you choose.

1. Export or screenshot the artifact as PNG, JPEG or WebP, ideally 1600 px wide
   or less. Put it in `public/design/`, for example
   `public/design/02-direction-a.png`.
2. Add an entry to `public/data/design-process.json`. Paths are relative to
   `public/data/`:

```json
{
  "items": [
    { "stage": "Early visual research", "title": "Signal console studies", "image": "../design/01-early-research.png" },
    { "stage": "Direction A", "title": "Editorial paper field", "image": "../design/02-direction-a.png" },
    { "stage": "Variation B", "title": "Instrument keys and meters", "image": "../design/03-variation-b.png" },
    { "stage": "Hybrid refinement", "title": "Combined panel architecture", "image": "../design/04-hybrid.png", "caption": "Optional one-line note." },
    { "stage": "Approved design system", "title": "Stage 2 tokens and components", "image": "../design/05-design-system.png" },
    { "stage": "Implemented Explorer", "title": "The working Stage 2 Explorer", "image": "../design/06-implemented.png" }
  ]
}
```

3. Run `pnpm verify`, `pnpm test` and `pnpm build`, look at the About panel with
   `pnpm exec vite preview`, then commit and push. Items appear in the order
   listed.

Check each image before adding it: the verifier only reads text files, so it
cannot see private paths or names shown inside a screenshot.
