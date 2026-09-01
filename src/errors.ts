/**
 * The error contract, in its own module so host-side helpers can throw the same
 * `ChunkError` without importing the wasm-backed entry point (which would make
 * a runtime import cycle out of what is really a leaf dependency).
 *
 * Everything here is re-exported from `index.ts`; that is the public surface.
 */

/**
 * The engine error variant, carried across the wasm boundary out-of-band so the
 * message itself can stay byte-identical to what py-chunks raises:
 *  - `"unsupported"` — unsupported extension / capability (py-chunks `ValueError`)
 *  - `"invalid-arg"` — bad mode or parameter (py-chunks `ValueError`)
 *  - `"parse"`       — the document failed to parse (py-chunks `RuntimeError`)
 *  - `"io"`          — an I/O failure inside the engine
 *  - `"unknown"`     — an error that carried no recognised variant tag
 */
export type ChunkErrorKind = "unsupported" | "invalid-arg" | "parse" | "io" | "unknown";

const CHUNK_ERROR_KINDS: ReadonlySet<string> = new Set([
  "unsupported",
  "invalid-arg",
  "parse",
  "io",
  "unknown",
]);

/**
 * Error thrown for every failure this package raises — engine failures *and*
 * host-side argument validation, so `catch (e) { if (e instanceof ChunkError) }`
 * is a complete contract.
 *
 * For engine failures `message` is byte-identical to the message py-chunks
 * raises for the same input (the cross-SDK parity contract), and `kind`
 * restores the variant that py-chunks expresses as an exception *type*.
 *
 * Host-side validation (a filesystem path off Node, an unsupported `source`
 * type, byte input with no filename, a bad `fitTokens` argument) never reaches
 * the engine, so it has no py-chunks counterpart; it is reported with
 * `kind: "invalid-arg"`.
 *
 * Reading a path on Node happens host-side too. A missing or unreadable file
 * is reported with `kind: "io"` and Node's own message (`ENOENT: no such file
 * or directory, open './missing.md'`), matching the variant the engine uses
 * when it does the read itself.
 */
export class ChunkError extends Error {
  readonly kind: ChunkErrorKind;

  constructor(message: string, kind: ChunkErrorKind) {
    super(message);
    this.name = "ChunkError";
    this.kind = kind;
  }
}

/** Normalize whatever the wasm boundary threw into a ChunkError. */
export function toChunkError(e: unknown): ChunkError {
  if (e instanceof ChunkError) return e;
  if (typeof e === "string") return new ChunkError(e, "unknown");
  if (e instanceof Error || (typeof e === "object" && e !== null && "message" in e)) {
    const message = String((e as { message: unknown }).message);
    const rawKind = (e as { kind?: unknown }).kind;
    const kind: ChunkErrorKind =
      typeof rawKind === "string" && CHUNK_ERROR_KINDS.has(rawKind)
        ? (rawKind as ChunkErrorKind)
        : "unknown";
    return new ChunkError(message, kind);
  }
  return new ChunkError(String(e), "unknown");
}

/** Run a wasm call, rethrowing any failure as a typed {@link ChunkError}. */
export function wrapWasm<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw toChunkError(e);
  }
}
