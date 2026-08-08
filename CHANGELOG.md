# Changelog

All notable changes to the `js-chunks` npm package.

## [0.6.2] - 2026-08-08

- **The options object can no longer escape the `ChunkError` contract.** Four
  routes out of it are closed: `getChunks(bytes, null)` / `getMarkdown(bytes,
  null)` threw a raw `TypeError` (the source normaliser read `opts.filename`
  unguarded); a **throwing getter** on `opts` propagated as whatever it threw;
  `streamChunks(source, opts)` hit the same getter through `{ ...opts }` even
  though it reads no option itself; and a `Blob` subclass whose
  `arrayBuffer()` rejects escaped as its own rejection. Options are now
  **snapshotted once** into a plain object before anything reads a key, `null`
  is accepted as "no options", a non-object `opts` is rejected by name, and the
  `Blob` read reports `kind: "io"` — the same kind a failed path read reports.
- **Option values are validated instead of coerced.** The wasm boundary takes
  `usize`, so `windowSize: -1` used to return chunks, `2.5` silently truncated
  to `2`, `"3"` silently coerced to `3`, and a non-string `filename` / `mode`
  surfaced as `ChunkError(kind: "unknown")` with the message `memory access out
  of bounds`. All of these now throw `kind: "invalid-arg"`. Out-of-range values
  reuse the **engine's verbatim sentence** (`window_size must be greater than
  0`), so the message is identical whichever side rejects; type mistakes name
  the camelCase key the caller typed (`windowSize must be an integer, got
  2.5.`). `overlap: 0` remains legal, and zero is still left to the engine so
  its message keeps naming the parameter the target format actually uses.
- **EPUB now validates its mode arguments.** `getChunks("book.epub", { mode:
  "sliding_window", windowSize: 100, overlap: 100 })` returned an **empty
  array**; it now throws `kind: "invalid-arg"` with `overlap must be less than
  window_size`. The EPUB facade never ran the shared argument check, and its
  per-chapter builder failures are swallowed on purpose (an image-only cover
  page must not abort a whole book), so a bad argument silently became "this
  book has no content". An unknown `mode` now reports
  `mode must be one of [...] for EPUB, got: '<mode>'`.
- **Spreadsheets reject `paragraphsPerPage: 0`.** The spreadsheet family
  paginates by `rows_per_chunk`, so `paragraphsPerPage` was dropped at the
  dispatch mapping site and `page_aware` with `0` was silently accepted —
  the one thing the docs promise cannot happen. It is now
  `kind: "invalid-arg"`, `paragraphs_per_page must be greater than 0`.
- **`window_size must be >= 1` is gone.** The spreadsheet family was the only
  place that wording survived; every format now says `window_size must be
  greater than 0`. Match on `kind`, not on message text.
- `ChunkError` is now the **complete** error contract: the three host-side
  argument validations that previously threw a plain `Error`/`TypeError` —
  a filesystem path off Node, an unsupported `source` type, and byte input
  with no filename — now throw `ChunkError` with `kind: "invalid-arg"`. The
  message text of all three is unchanged, so only the thrown *type* differs
  (code that caught `TypeError` for the unsupported-source case must catch
  `ChunkError` instead). Engine errors are unaffected.
- A **missing or unreadable file path** now throws `ChunkError` with
  `kind: "io"` instead of Node's raw `Error`. The `fs.readFileSync` for path
  sources sat outside the wrapping, so the most common failure of all was the
  one case `catch (e instanceof ChunkError)` missed. Node's message is
  preserved verbatim (`ENOENT: no such file or directory, open './x.md'`).
- Bad `sliding_window` / `sentence` / `page_aware` arguments now report
  `kind: "invalid-arg"` for **every** format. `md`, `txt`, `html`, `csv` and
  the formats that render through the markdown pipeline (odt, odp, eml, mbox,
  json, rtf, msg, ipynb, pdf, epub) previously reported `kind: "parse"` for
  `overlap must be less than window_size` and its siblings, while docx/pptx/
  xlsx reported `"invalid-arg"`. Fixed in the engine, so all SDKs agree.
  Message text is unchanged except for `txt`/`html`, which used to say
  `overlap must be < window_size` / `window_size must be > 0` and now use the
  documented wording (`less than` / `greater than 0`).
- Documented `streamChunks` honestly in the README: it is an **ergonomic
  wrapper, not incremental streaming**. The WASM boundary is a synchronous
  full-parse, so the whole chunk array is computed before the first `yield`;
  peak memory matches `getChunks`. No API change — the TSDoc already said so,
  the README now says it too.

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
