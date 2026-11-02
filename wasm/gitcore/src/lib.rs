//! Byte-level git primitives for the mobile backend, compiled to WASM.
//!
//! Nothing here does I/O. Pack indexing and object reads ask the host for byte ranges
//! (`next_read`) and the host feeds them back, so the same code runs on top of
//! Obsidian's async-only file API.

mod indexer;
mod object;
mod reader;

use sha1::{Digest, Sha1};
use wasm_bindgen::prelude::*;

fn js(e: String) -> JsError {
    JsError::new(&e)
}

fn kind_from_name(name: &str) -> Result<u8, JsError> {
    Ok(match name {
        "commit" => object::OBJ_COMMIT,
        "tree" => object::OBJ_TREE,
        "blob" => object::OBJ_BLOB,
        "tag" => object::OBJ_TAG,
        _ => return Err(js(format!("unknown object type {name}"))),
    })
}

/// Indexes a pack as it streams in (`push`), then resolves deltas against the stored
/// pack (`next_read` / `provide`) and produces a v2 `.idx`.
#[wasm_bindgen]
pub struct PackIndexer {
    parser: indexer::Parser,
    resolver: Option<indexer::Resolver>,
}

#[wasm_bindgen]
impl PackIndexer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PackIndexer {
        PackIndexer { parser: indexer::Parser::new(), resolver: None }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        self.parser.push(chunk).map_err(js)
    }

    /// End of stream: verifies the trailer and prepares delta resolution.
    pub fn finish(&mut self) -> Result<(), JsError> {
        if !self.parser.is_done() {
            return Err(js("pack stream ended early".into()));
        }
        self.resolver = Some(indexer::Resolver::new(&self.parser.entries).map_err(js)?);
        Ok(())
    }

    /// The next `[offset, length]` of the stored pack needed, or `undefined` when done.
    pub fn next_read(&mut self) -> Result<Option<Vec<f64>>, JsError> {
        let r = self.resolver.as_mut().ok_or_else(|| js("call finish() first".into()))?;
        Ok(r.next_read(&self.parser.entries).map_err(js)?.map(|(o, l)| vec![o as f64, l as f64]))
    }

    pub fn provide(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let r = self.resolver.as_mut().ok_or_else(|| js("call finish() first".into()))?;
        r.provide(&mut self.parser.entries, bytes).map_err(js)
    }

    pub fn build_idx(&self) -> Result<Vec<u8>, JsError> {
        let sum = self.parser.checksum.ok_or_else(|| js("pack not complete".into()))?;
        indexer::write_idx(&self.parser.entries, &sum).map_err(js)
    }

    pub fn checksum_hex(&self) -> Option<String> {
        self.parser.checksum.as_ref().map(object::to_hex)
    }

    pub fn object_count(&self) -> u32 {
        self.parser.entries.len() as u32
    }

    pub fn pack_len(&self) -> f64 {
        self.parser.pack_len() as f64
    }
}

/// Random-access object reads from one pack + `.idx`.
#[wasm_bindgen]
pub struct PackReader {
    inner: reader::Reader,
    kind: u8,
    data: std::rc::Rc<Vec<u8>>,
}

#[wasm_bindgen]
impl PackReader {
    #[wasm_bindgen(constructor)]
    pub fn new(idx: &[u8], pack_len: f64, cache_bytes: u32) -> Result<PackReader, JsError> {
        let inner = reader::Reader::new(idx, pack_len as u64, cache_bytes as usize).map_err(js)?;
        Ok(PackReader { inner, kind: 0, data: Default::default() })
    }

    pub fn has(&self, oid_hex: &str) -> Result<bool, JsError> {
        Ok(self.inner.offset_of(&object::from_hex(oid_hex).map_err(js)?).is_some())
    }

    /// The pack checksum recorded in the `.idx` (to compare with the pack trailer).
    pub fn pack_checksum_hex(&self) -> String {
        object::to_hex(&self.inner.pack_checksum)
    }

    /// All oids in this pack whose hex form starts with `prefix`.
    pub fn oids_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.inner.oids_with_prefix(prefix)
    }

    /// Start reading an object. Then, for each `[offset, len]` from `next_read`, feed
    /// that range with `provide_part` and close it with `provide_end`, until `next_read`
    /// is `undefined`. The object is then available via `kind`, `len` and `read_data`.
    pub fn begin(&mut self, oid_hex: &str) -> Result<(), JsError> {
        self.inner.begin(&object::from_hex(oid_hex).map_err(js)?).map_err(js)?;
        self.collect();
        Ok(())
    }

    pub fn next_read(&self) -> Option<Vec<f64>> {
        self.inner.next_read().map(|(o, l)| vec![o as f64, l as f64])
    }

    pub fn provide_part(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.provide_part(bytes).map_err(js)
    }

    pub fn provide_end(&mut self) -> Result<(), JsError> {
        self.inner.provide_end().map_err(js)?;
        self.collect();
        Ok(())
    }

    fn collect(&mut self) {
        if let Some((kind, data)) = self.inner.take() {
            self.kind = kind;
            self.data = data;
        }
    }

    /// "commit" | "tree" | "blob" | "tag"
    pub fn kind(&self) -> String {
        object::type_name(self.kind).unwrap_or("?").to_string()
    }

    pub fn len(&self) -> f64 {
        self.data.len() as f64
    }

    /// Copy out `len` bytes of the current object starting at `offset`.
    pub fn read_data(&self, offset: f64, len: f64) -> Vec<u8> {
        let start = (offset as usize).min(self.data.len());
        let end = (start + len as usize).min(self.data.len());
        self.data[start..end].to_vec()
    }

    /// Release the current object.
    pub fn release(&mut self) {
        self.data = Default::default();
    }
}

/// Writes a pack without deltas, entry by entry. Every returned piece is part of the
/// pack stream, in order: `header()`, one `entry()` per object, then `finish()`.
#[wasm_bindgen]
pub struct PackWriter {
    hasher: Sha1,
    count: u32,
    written: u32,
}

#[wasm_bindgen]
impl PackWriter {
    #[wasm_bindgen(constructor)]
    pub fn new(count: u32) -> PackWriter {
        PackWriter { hasher: Sha1::new(), count, written: 0 }
    }

    pub fn header(&mut self) -> Vec<u8> {
        let mut h = b"PACK".to_vec();
        h.extend_from_slice(&2u32.to_be_bytes());
        h.extend_from_slice(&self.count.to_be_bytes());
        self.hasher.update(&h);
        h
    }

    pub fn entry(&mut self, kind: &str, data: &[u8]) -> Result<Vec<u8>, JsError> {
        if self.written == self.count {
            return Err(js("more entries than announced".into()));
        }
        let kind = kind_from_name(kind)?;
        let mut size = data.len() as u64;
        let mut out = Vec::with_capacity(data.len() / 2 + 16);
        let mut c = (kind << 4) | (size & 0x0f) as u8;
        size >>= 4;
        while size != 0 {
            out.push(c | 0x80);
            c = (size & 0x7f) as u8;
            size >>= 7;
        }
        out.push(c);
        out.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(data, 6));
        self.hasher.update(&out);
        self.written += 1;
        Ok(out)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        if self.written != self.count {
            return Err(js(format!("announced {} entries, wrote {}", self.count, self.written)));
        }
        Ok(std::mem::take(&mut self.hasher).finalize().to_vec())
    }
}

/// Git object id of `data` as an object of type `kind`.
#[wasm_bindgen]
pub fn hash_object(kind: &str, data: &[u8]) -> Result<String, JsError> {
    Ok(object::to_hex(&object::hash_object(kind_from_name(kind)?, data).map_err(js)?))
}

/// Hex SHA-1 of raw bytes.
#[wasm_bindgen]
pub fn sha1_hex(data: &[u8]) -> String {
    object::to_hex(&Sha1::digest(data).into())
}

#[wasm_bindgen]
pub fn deflate(data: &[u8]) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec_zlib(data, 1)
}

#[wasm_bindgen]
pub fn inflate(data: &[u8]) -> Result<Vec<u8>, JsError> {
    miniz_oxide::inflate::decompress_to_vec_zlib(data)
        .map_err(|e| js(format!("inflate failed: {:?}", e.status)))
}
