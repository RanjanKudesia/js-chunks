import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Smoke test against the BUILT package entry (dist/index.js) — the thing npm
 * actually publishes. The vitest suite otherwise imports ../src/index.ts, so
 * without this the published entry would ship untested.
 *
 * Build ordering: `npm test` runs `npm run build` first, so dist/ is always
 * fresh there. Running vitest directly with a missing or stale dist fails
 * loudly below instead of silently testing old output.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist/index.js");
const SRC = path.resolve(__dirname, "../src/index.ts");

function fixturePath(rel: string): string {
  const corpus = path.resolve(__dirname, "../../test_files", rel);
  if (process.env.JS_CHUNKS_FIXTURES !== "local" && fs.existsSync(corpus)) return corpus;
  const local = path.resolve(__dirname, "fixtures", rel);
  if (fs.existsSync(local)) return local;
  throw new Error(`fixture not found in corpus or test/fixtures/: ${rel}`);
}

describe("dist smoke", () => {
  it("dist/index.js exists and is not stale", () => {
    if (!fs.existsSync(DIST)) {
      throw new Error(
        "dist/index.js is missing — run `npm run build` (or `npm test`, which builds first).",
      );
    }
    const distMtime = fs.statSync(DIST).mtimeMs;
    const srcMtime = fs.statSync(SRC).mtimeMs;
    if (srcMtime > distMtime) {
      throw new Error(
        "dist/index.js is STALE (src/index.ts is newer) — run `npm run build` " +
          "(or `npm test`, which builds first).",
      );
    }
  });

  it("built dist entry chunks a real file", async () => {
    const dist = (await import(DIST)) as typeof import("../src/index.ts");
    const chunks = await dist.getChunks(fixturePath("md/test.md"));
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(typeof chunks[0]!.content).toBe("string");
    expect(typeof chunks[0]!.contentType).toBe("string");
    // Typed errors survive the build too.
    expect(typeof dist.ChunkError).toBe("function");
  });
});
