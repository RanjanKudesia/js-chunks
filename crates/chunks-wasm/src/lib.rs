//! wasm-bindgen bindings over `chunks-rs`. Bytes-in, JS-values-out. PDF is
//! parsed by the engine itself, in wasm — [`chunk_pdf_markdown`] /
//! [`chunk_pdf_markdown_with_images`] exist only for callers that already have
//! markdown from some *other* parser and want it chunked identically.

use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

fn err_to_js<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// An engine error as the *message* py-chunks raises, without the variant
/// prefix `Display` adds — thrown as a JS `Error` carrying the variant in a
/// `kind` property (`"unsupported" | "invalid-arg" | "parse" | "io"`).
///
/// `ChunkError`'s `Display` writes `parse error: …`, and py-chunks maps the
/// variant onto an exception *type* and raises the bare message. Using `Display`
/// here made every failure read differently in JavaScript than in Python for
/// the same file — the [#78](TECH_DEBT.md)/[#79](TECH_DEBT.md) pattern, one
/// level up, and invisible to every parity harness until the PDF js↔py sweep
/// went looking for it. `Error.message` therefore stays byte-identical to the
/// py-chunks message; the variant travels out-of-band in `kind`, which the TS
/// layer maps onto `ChunkError`.
fn engine_err_to_js(e: chunks_rs::ChunkError) -> JsValue {
    use chunks_rs::ChunkError::*;
    let (kind, msg) = match e {
        Unsupported(m) => ("unsupported", m),
        InvalidArg(m) => ("invalid-arg", m),
        Parse(m) => ("parse", m),
        Io(e) => ("io", e.to_string()),
        // `ChunkError` is becoming #[non_exhaustive]; future variants surface
        // with their full Display (no bare-message rule is known for them yet).
        #[allow(unreachable_patterns)]
        other => ("unknown", other.to_string()),
    };
    let err = js_sys::Error::new(&msg);
    // Non-fatal if this ever fails: the message alone is still correct.
    let _ = js_sys::Reflect::set(&err, &JsValue::from_str("kind"), &JsValue::from_str(kind));
    err.into()
}

/// Serialize to JS with maps rendered as plain objects (so `chunk.metadata` is a
/// JS object like py-chunks' dict, not an ES `Map`).
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    // maps→objects so metadata is a JS object; missing/null→`null` (not
    // `undefined`) so `JSON.stringify` keeps null-valued metadata keys like
    // `section_heading` — matching py-chunks/chunks-rs exactly.
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_missing_as_null(true);
    value.serialize(&serializer).map_err(err_to_js)
}

/// Install a panic hook that surfaces Rust panics as console errors (dev aid).
#[wasm_bindgen(start)]
pub fn __start() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Chunk a document from raw bytes. `filename` is used only for extension routing.
/// Returns an array of `{ content, content_type, metadata }`.
#[wasm_bindgen(js_name = getChunks)]
#[allow(clippy::too_many_arguments)]
pub fn get_chunks(
    data: &[u8],
    filename: &str,
    mode: &str,
    window_size: usize,
    overlap: usize,
    sentences_per_chunk: usize,
    paragraphs_per_page: usize,
) -> Result<JsValue, JsValue> {
    let chunks = chunks_rs::get_chunks_from_bytes(
        data, filename, mode, window_size, overlap, sentences_per_chunk, paragraphs_per_page,
    )
    .map_err(engine_err_to_js)?;
    to_js(&chunks)
}

/// Convert a document from raw bytes to Markdown.
#[wasm_bindgen(js_name = getMarkdown)]
pub fn get_markdown(data: &[u8], filename: &str) -> Result<String, JsValue> {
    chunks_rs::get_markdown_from_bytes(data, filename)
    .map_err(engine_err_to_js)
}

/// Build a JS array of `{ name: string, data: Uint8Array }` from extracted images.
fn images_to_js(images: Vec<(String, Vec<u8>)>) -> Result<JsValue, JsValue> {
    let arr = js_sys::Array::new();
    for (name, bytes) in images {
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &JsValue::from_str("name"), &JsValue::from_str(&name))?;
        // Uint8Array copy (owns its own buffer, independent of wasm memory).
        let data = js_sys::Uint8Array::from(bytes.as_slice());
        js_sys::Reflect::set(&obj, &JsValue::from_str("data"), &data)?;
        arr.push(&obj);
    }
    Ok(arr.into())
}

/// Chunk a document and also return its embedded images (py-chunks `list_images=True`).
/// Returns `{ chunks: Chunk[], images: { name, data: Uint8Array }[] }`.
#[wasm_bindgen(js_name = getChunksWithImages)]
#[allow(clippy::too_many_arguments)]
pub fn get_chunks_with_images(
    data: &[u8],
    filename: &str,
    mode: &str,
    window_size: usize,
    overlap: usize,
    sentences_per_chunk: usize,
    paragraphs_per_page: usize,
) -> Result<JsValue, JsValue> {
    let (chunks, images) = chunks_rs::get_chunks_with_images_from_bytes(
        data, filename, mode, window_size, overlap, sentences_per_chunk, paragraphs_per_page,
    )
    .map_err(engine_err_to_js)?;
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &JsValue::from_str("chunks"), &to_js(&chunks)?)?;
    js_sys::Reflect::set(&obj, &JsValue::from_str("images"), &images_to_js(images)?)?;
    Ok(obj.into())
}

/// Convert a document to Markdown and also return its embedded images.
/// Returns `{ markdown: string, images: { name, data: Uint8Array }[] }`.
#[wasm_bindgen(js_name = getMarkdownWithImages)]
pub fn get_markdown_with_images(data: &[u8], filename: &str) -> Result<JsValue, JsValue> {
    let (markdown, images) =
        chunks_rs::get_markdown_with_images_from_bytes(data, filename)
    .map_err(engine_err_to_js)?;
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &JsValue::from_str("markdown"), &JsValue::from_str(&markdown))?;
    js_sys::Reflect::set(&obj, &JsValue::from_str("images"), &images_to_js(images)?)?;
    Ok(obj.into())
}

/// Chunk PDF markdown a host-side parser already produced (`.pdf` bytes are
/// parsed by the engine itself — this is for callers with their own markdown).
/// `total_pages` populates `document_metadata.total_pages`.
#[wasm_bindgen(js_name = chunkPdfMarkdown)]
#[allow(clippy::too_many_arguments)]
pub fn chunk_pdf_markdown(
    markdown: &str,
    total_pages: usize,
    mode: &str,
    window_size: usize,
    overlap: usize,
    sentences_per_chunk: usize,
    paragraphs_per_page: usize,
) -> Result<JsValue, JsValue> {
    let chunks = chunks_rs::formats::pdf::chunk_pdf_markdown(
        markdown, total_pages, mode, window_size, overlap, sentences_per_chunk, paragraphs_per_page,
    )
    .map_err(engine_err_to_js)?;
    to_js(&chunks)
}

/// Apply the engine's PDF-markdown normalisation to host-parsed markdown.
///
/// `chunkPdfMarkdown` already does this internally, so chunks agree across SDKs
/// without any help. `getMarkdown` returns the host parser's string directly,
/// which would otherwise skip it — this is what keeps the two in step.
#[wasm_bindgen(js_name = normalizePdfMarkdown)]
pub fn normalize_pdf_markdown(markdown: &str) -> String {
    chunks_rs::formats::pdf::author_block::normalize(markdown)
}

/// Parse a JS `{ name: string, data: Uint8Array }[]` into `Vec<(String, Vec<u8>)>`.
fn js_to_images(value: &JsValue) -> Result<Vec<(String, Vec<u8>)>, JsValue> {
    let arr: js_sys::Array = value.clone().dyn_into().map_err(|_| JsValue::from_str("images must be an array"))?;
    let mut out = Vec::with_capacity(arr.length() as usize);
    for item in arr.iter() {
        let name = js_sys::Reflect::get(&item, &JsValue::from_str("name"))?
            .as_string()
            .ok_or_else(|| JsValue::from_str("image.name must be a string"))?;
        let data = js_sys::Reflect::get(&item, &JsValue::from_str("data"))?;
        let bytes = js_sys::Uint8Array::new(&data).to_vec();
        out.push((name, bytes));
    }
    Ok(out)
}

/// Like [`chunk_pdf_markdown`] but with host-supplied PDF images (image chunks
/// first). `images` is a JS `{ name, data: Uint8Array }[]`. Returns
/// `{ chunks, images }` like [`get_chunks_with_images`].
#[wasm_bindgen(js_name = chunkPdfMarkdownWithImages)]
#[allow(clippy::too_many_arguments)]
pub fn chunk_pdf_markdown_with_images(
    markdown: &str,
    images: &JsValue,
    total_pages: usize,
    mode: &str,
    window_size: usize,
    overlap: usize,
    sentences_per_chunk: usize,
    paragraphs_per_page: usize,
) -> Result<JsValue, JsValue> {
    let imgs = js_to_images(images)?;
    let (chunks, out_images) = chunks_rs::formats::pdf::chunk_pdf_markdown_with_images(
        markdown, imgs, total_pages, mode, window_size, overlap, sentences_per_chunk, paragraphs_per_page,
    )
    .map_err(engine_err_to_js)?;
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &JsValue::from_str("chunks"), &to_js(&chunks)?)?;
    js_sys::Reflect::set(&obj, &JsValue::from_str("images"), &images_to_js(out_images)?)?;
    Ok(obj.into())
}
