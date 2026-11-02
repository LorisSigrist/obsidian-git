//! Git object basics: types, hashing, pack entry headers, delta application.

use sha1::{Digest, Sha1};

pub type Oid = [u8; 20];

pub const OBJ_COMMIT: u8 = 1;
pub const OBJ_TREE: u8 = 2;
pub const OBJ_BLOB: u8 = 3;
pub const OBJ_TAG: u8 = 4;
pub const OBJ_OFS_DELTA: u8 = 6;
pub const OBJ_REF_DELTA: u8 = 7;

pub fn type_name(kind: u8) -> Result<&'static str, String> {
    Ok(match kind {
        OBJ_COMMIT => "commit",
        OBJ_TREE => "tree",
        OBJ_BLOB => "blob",
        OBJ_TAG => "tag",
        k => return Err(format!("not a base object type: {k}")),
    })
}

/// Hasher pre-seeded with the loose-object header `"<type> <size>\0"`.
pub fn object_hasher(kind: u8, size: u64) -> Result<Sha1, String> {
    let mut h = Sha1::new();
    h.update(format!("{} {}\0", type_name(kind)?, size).as_bytes());
    Ok(h)
}

pub fn hash_object(kind: u8, data: &[u8]) -> Result<Oid, String> {
    let mut h = object_hasher(kind, data.len() as u64)?;
    h.update(data);
    Ok(h.finalize().into())
}

#[derive(Clone, Copy, Debug)]
pub enum Base {
    None,
    /// Absolute pack offset of the base entry.
    Ofs(u64),
    Ref(Oid),
}

pub struct EntryHeader {
    pub header_len: usize,
    pub kind: u8,
    pub size: u64,
    pub base: Base,
}

/// Parse a pack entry header at absolute pack offset `offset`.
/// Returns `Ok(None)` if `buf` is too short to contain the full header.
pub fn parse_entry_header(buf: &[u8], offset: u64) -> Result<Option<EntryHeader>, String> {
    let mut i = 0;
    let Some(&c) = buf.get(i) else { return Ok(None) };
    i += 1;
    let kind = (c >> 4) & 7;
    let mut size = (c & 0x0f) as u64;
    let mut shift = 4;
    let mut c = c;
    while c & 0x80 != 0 {
        let Some(&n) = buf.get(i) else { return Ok(None) };
        i += 1;
        if shift > 60 {
            return Err("entry size varint too long".into());
        }
        size |= ((n & 0x7f) as u64) << shift;
        shift += 7;
        c = n;
    }
    let base = match kind {
        OBJ_COMMIT | OBJ_TREE | OBJ_BLOB | OBJ_TAG => Base::None,
        OBJ_OFS_DELTA => {
            let Some(&n) = buf.get(i) else { return Ok(None) };
            i += 1;
            let mut rel = (n & 0x7f) as u64;
            let mut c = n;
            while c & 0x80 != 0 {
                let Some(&n) = buf.get(i) else { return Ok(None) };
                i += 1;
                if rel > (u64::MAX >> 8) {
                    return Err("ofs-delta offset overflow".into());
                }
                rel = ((rel + 1) << 7) | (n & 0x7f) as u64;
                c = n;
            }
            if rel == 0 || rel > offset {
                return Err(format!("bad ofs-delta base at {offset}"));
            }
            Base::Ofs(offset - rel)
        }
        OBJ_REF_DELTA => {
            if buf.len() < i + 20 {
                return Ok(None);
            }
            let oid: Oid = buf[i..i + 20].try_into().unwrap();
            i += 20;
            Base::Ref(oid)
        }
        k => return Err(format!("unknown pack entry type {k} at {offset}")),
    };
    Ok(Some(EntryHeader { header_len: i, kind, size, base }))
}

fn delta_varint(d: &[u8], i: &mut usize) -> Result<u64, String> {
    let mut v = 0u64;
    let mut shift = 0;
    loop {
        let c = *d.get(*i).ok_or("truncated delta header")?;
        *i += 1;
        v |= ((c & 0x7f) as u64) << shift;
        shift += 7;
        if c & 0x80 == 0 {
            return Ok(v);
        }
        if shift > 63 {
            return Err("delta varint too long".into());
        }
    }
}

pub fn apply_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, String> {
    let mut i = 0;
    let src_size = delta_varint(delta, &mut i)?;
    let dst_size = delta_varint(delta, &mut i)?;
    if src_size != base.len() as u64 {
        return Err(format!("delta base size mismatch: {} != {}", src_size, base.len()));
    }
    let mut out = Vec::with_capacity(dst_size as usize);
    while i < delta.len() {
        let op = delta[i];
        i += 1;
        if op & 0x80 != 0 {
            let mut off = 0usize;
            let mut len = 0usize;
            for b in 0..4 {
                if op & (1 << b) != 0 {
                    off |= (*delta.get(i).ok_or("truncated copy op")? as usize) << (8 * b);
                    i += 1;
                }
            }
            for b in 0..3 {
                if op & (0x10 << b) != 0 {
                    len |= (*delta.get(i).ok_or("truncated copy op")? as usize) << (8 * b);
                    i += 1;
                }
            }
            if len == 0 {
                len = 0x10000;
            }
            let src = base.get(off..off + len).ok_or("delta copy out of range")?;
            out.extend_from_slice(src);
        } else if op != 0 {
            let n = op as usize;
            out.extend_from_slice(delta.get(i..i + n).ok_or("truncated insert op")?);
            i += n;
        } else {
            return Err("reserved delta opcode 0".into());
        }
    }
    if out.len() as u64 != dst_size {
        return Err("delta result size mismatch".into());
    }
    Ok(out)
}

pub fn inflate_exact(data: &[u8], size: u64) -> Result<Vec<u8>, String> {
    let out = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(data, size as usize)
        .map_err(|e| format!("inflate failed: {:?}", e.status))?;
    if out.len() as u64 != size {
        return Err(format!("inflated size {} != expected {}", out.len(), size));
    }
    Ok(out)
}

pub fn to_hex(oid: &Oid) -> String {
    oid.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(s: &str) -> Result<Oid, String> {
    if s.len() != 40 {
        return Err(format!("bad oid: {s}"));
    }
    let mut oid = [0u8; 20];
    for (i, b) in oid.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| format!("bad oid: {s}"))?;
    }
    Ok(oid)
}
