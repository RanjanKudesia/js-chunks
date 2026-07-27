// Emits the same JSON-lines format as chunks-rs examples/parity_dump.rs, but via
// the wasm engine (bytes API). Piped into chunks-rs examples/parity_check.py to
// verify JS output == py-chunks output. Covers the formats wasm currently
// supports (grows as no-FS byte entry points are added in chunks-rs).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wasm = require("../pkg-node/chunks_wasm.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../test_files");

// Extensions with no-FS byte support in chunks-rs today.
const PROSE_EXTS = new Set(["md","txt","html","htm","json","jsonl","ndjson","eml","mbox","odt","odp","ipynb","rtf","epub","doc","ppt","msg","docx","docm","dotx","dotm","pptx","potx","potm","ppsx","ppsm"]);
const DELIM_EXTS = new Set(["csv","tsv"]);
const SHEET_EXTS = new Set(["xlsx","xls","xlsm","xlsb","ods","xltx","xltm"]);
const SHEET_MODES = ["default","table","sheet","semantic","page_aware","sliding_window"];
const DELIM_MODES = ["default","sliding_window","page_aware"];
const PROSE_MODES = ["default", "section", "semantic", "sentence", "page_aware", "sliding_window"];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

const files = [];
walk(ROOT, files);
files.sort();

for (const p of files) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const isDelim = DELIM_EXTS.has(ext);
  const isSheet = SHEET_EXTS.has(ext);
  if (!PROSE_EXTS.has(ext) && !isDelim && !isSheet) continue;
  if (fs.statSync(p).size > 10 * 1024 * 1024) continue;
  const data = new Uint8Array(fs.readFileSync(p));
  const name = path.basename(p);
  for (const mode of (isSheet ? SHEET_MODES : isDelim ? DELIM_MODES : PROSE_MODES)) {
    try {
      const chunks = wasm.getChunks(data, p, mode, 3, 1, 3, 15);
      process.stdout.write(JSON.stringify({ path: p, ext, mode, ok: true, chunks }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ path: p, ext, mode, ok: false, error: String(e) }) + "\n");
    }
  }
}
