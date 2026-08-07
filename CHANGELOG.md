# Changelog

All notable changes to the `js-chunks` npm package.

## [0.6.1] - 2026-08-08

- Typed errors: every engine failure now throws `ChunkError` (an `Error`
  subclass) with a `kind` of `"unsupported" | "invalid-arg" | "parse" | "io" |
  "unknown"`. Engine-raised messages are unchanged (byte-identical to py-chunks); errors py-chunks raises in its Python layer match at prefix level.
- New subpath export `js-chunks/web` (plus `js-chunks/web/chunks_wasm_bg.wasm`)
  for bundled browser apps; the `pkg-bundler` build (2.6MB, previously
  unreachable through `exports`) is no longer built or shipped.
- `chunkPdfMarkdownWithImages` and `normalizePdfMarkdown` are now part of the
  public TypeScript API.
- `"sideEffects": false` for better tree-shaking; ESM-only status documented
  (`require()` needs Node ≥ 20.19 / ≥ 22.12).
- Tests run against a committed fixture subset (`test/fixtures/`) when the
  workspace corpus is absent, so CI is genuinely green; a dist smoke test now
  exercises the built `dist/index.js` on every `npm test`.

## 0.6.0 — 2026-08-07

First release since 0.1.0. Versions 0.2–0.5 were never published for
js-chunks; 0.6.0 aligns the version with py-chunks/rs-chunks, and folds in
every engine re-sync since the initial release. Highlights, from the git log:

- PDF is parsed by the engine itself, in WASM — the
  `@llamaindex/liteparse-wasm` peer dependency is gone; PDF gains a real
  streaming iterator, distinct `default`/`structural` modes, base-14 and
  subset-font metric decoding, exact whitespace measurement, column splits,
  and hardened inline-image stripping.
- Legacy `.doc` gains tables, list depth, breadcrumbs, and page provenance;
  `.ppt` gains slide metadata; ppt/pptx handle empty decks, background
  images, and slide numbers; docx fixes section order/bounds, list grouping,
  SmartArt extraction, and semantic content loss.
- Spreadsheets: real xlsx streaming, `.bin.rels` fallback, xlsm workbook
  repair, header-only sheets kept, sheet isolation, ODS named ranges and
  parity fixes, csv header inference.
- Text formats: txt encoding detection, html omitted-end-tag and nested-table
  fixes, entity-reference fixes, RTF overhaul, over-long lines bounded, line
  endings normalised at decode.
- Email/notebook/e-book: eml charset retry, msg RTF codepages and metadata,
  ipynb ANSI stripping and image work, epub metadata/TOC, odf ordered-list
  detection and odp slide metadata.
- Parity plumbing: image names and image alt text identical across SDKs, JSON
  chunks carry `record_range`, deterministic `primary_merge_reason`
  tie-breaks, error messages match py-chunks byte-for-byte.
- Release: npm OIDC trusted publishing; stale lockfile fixed.

## 0.1.0 — 2026-07-28

- Initial release: WASM-backed chunking for Node/Bun/Deno/browsers with
  `getChunks`, `getMarkdown`, `streamChunks`, `chunkPdfMarkdown`, image
  extraction (`listImages`), and 36 supported formats.
