//! Streaming pack indexer, the equivalent of `git index-pack`, without doing any I/O.
//!
//! Pass 1 (`push`): the pack is fed in arbitrary chunks as it arrives. Every entry is
//! inflated incrementally to find its boundaries, its CRC32 and, for non-delta objects,
//! its oid. Nothing but a small per-entry record is retained.
//!
//! Pass 2 (`next_read` / `provide`): deltas are resolved depth-first from each base, like
//! git does. The indexer asks for byte ranges of the already-stored pack; the host reads
//! them (asynchronously, from wherever it stored the pack) and hands them back.

use std::collections::HashMap;

use crc32fast::Hasher as Crc;
use miniz_oxide::inflate::stream::{inflate, InflateState};
use miniz_oxide::{DataFormat, MZError, MZFlush, MZStatus};
use sha1::{Digest, Sha1};

use crate::object::*;

pub struct Entry {
    pub offset: u64,
    pub data_offset: u64,
    pub end: u64,
    pub kind: u8,
    pub size: u64,
    pub base: Base,
    pub crc: u32,
    pub oid: Option<Oid>,
}

enum State {
    PackHeader,
    EntryHeader,
    Inflate,
    Trailer,
    Done,
}

struct Current {
    hasher: Option<Sha1>,
    crc: Crc,
    produced: u64,
}

pub struct Parser {
    buf: Vec<u8>,
    pos: usize,
    abs: u64,
    state: State,
    count: u32,
    pack_hash: Sha1,
    inflater: Box<InflateState>,
    out: Vec<u8>,
    cur: Option<Current>,
    pub entries: Vec<Entry>,
    pub checksum: Option<Oid>,
}

impl Parser {
    pub fn new() -> Self {
        Parser {
            buf: Vec::new(),
            pos: 0,
            abs: 0,
            state: State::PackHeader,
            count: 0,
            pack_hash: Sha1::new(),
            inflater: InflateState::new_boxed(DataFormat::Zlib),
            out: vec![0; 64 * 1024],
            cur: None,
            entries: Vec::new(),
            checksum: None,
        }
    }

    fn consume(&mut self, n: usize, hash: bool) {
        let bytes = &self.buf[self.pos..self.pos + n];
        if hash {
            self.pack_hash.update(bytes);
        }
        if let Some(cur) = &mut self.cur {
            cur.crc.update(bytes);
        }
        self.pos += n;
        self.abs += n as u64;
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<(), String> {
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(chunk);
        loop {
            let avail = self.buf.len() - self.pos;
            match self.state {
                State::PackHeader => {
                    if avail < 12 {
                        return Ok(());
                    }
                    let h = &self.buf[self.pos..self.pos + 12];
                    if &h[0..4] != b"PACK" {
                        return Err("not a packfile".into());
                    }
                    let version = u32::from_be_bytes(h[4..8].try_into().unwrap());
                    if version != 2 && version != 3 {
                        return Err(format!("unsupported pack version {version}"));
                    }
                    self.count = u32::from_be_bytes(h[8..12].try_into().unwrap());
                    self.consume(12, true);
                    self.state = if self.count == 0 { State::Trailer } else { State::EntryHeader };
                }
                State::EntryHeader => {
                    let Some(h) = parse_entry_header(&self.buf[self.pos..], self.abs)? else {
                        return Ok(());
                    };
                    let hasher = match h.base {
                        Base::None => Some(object_hasher(h.kind, h.size)?),
                        _ => None,
                    };
                    self.cur = Some(Current { hasher, crc: Crc::new(), produced: 0 });
                    let offset = self.abs;
                    self.consume(h.header_len, true);
                    self.entries.push(Entry {
                        offset,
                        data_offset: self.abs,
                        end: 0,
                        kind: h.kind,
                        size: h.size,
                        base: h.base,
                        crc: 0,
                        oid: None,
                    });
                    self.inflater.reset(DataFormat::Zlib);
                    self.state = State::Inflate;
                }
                State::Inflate => {
                    if avail == 0 {
                        return Ok(());
                    }
                    let res = inflate(
                        &mut self.inflater,
                        &self.buf[self.pos..],
                        &mut self.out,
                        MZFlush::None,
                    );
                    let cur = self.cur.as_mut().unwrap();
                    if let Some(h) = &mut cur.hasher {
                        h.update(&self.out[..res.bytes_written]);
                    }
                    cur.produced += res.bytes_written as u64;
                    self.consume(res.bytes_consumed, true);
                    match res.status {
                        Ok(MZStatus::StreamEnd) => {
                            let cur = self.cur.take().unwrap();
                            let e = self.entries.last_mut().unwrap();
                            if cur.produced != e.size {
                                return Err(format!(
                                    "entry at {} inflated to {} bytes, header says {}",
                                    e.offset, cur.produced, e.size
                                ));
                            }
                            e.end = self.abs;
                            e.crc = cur.crc.finalize();
                            e.oid = cur.hasher.map(|h| h.finalize().into());
                            self.state = if self.entries.len() as u32 == self.count {
                                State::Trailer
                            } else {
                                State::EntryHeader
                            };
                        }
                        Ok(_) => {}
                        Err(MZError::Buf) if res.bytes_consumed == 0 && res.bytes_written == 0 => {
                            return Ok(());
                        }
                        Err(e) => return Err(format!("zlib error {e:?} in entry at {}", self.abs)),
                    }
                }
                State::Trailer => {
                    if avail < 20 {
                        return Ok(());
                    }
                    let trailer: Oid = self.buf[self.pos..self.pos + 20].try_into().unwrap();
                    let computed: Oid = std::mem::take(&mut self.pack_hash).finalize().into();
                    if trailer != computed {
                        return Err("pack checksum mismatch".into());
                    }
                    self.consume(20, false);
                    self.checksum = Some(trailer);
                    self.state = State::Done;
                }
                State::Done => {
                    if avail > 0 {
                        return Err("trailing bytes after pack".into());
                    }
                    return Ok(());
                }
            }
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self.state, State::Done)
    }

    pub fn pack_len(&self) -> u64 {
        self.abs
    }
}

struct Frame {
    kind: u8,
    content: Vec<u8>,
    children: Vec<usize>,
    next: usize,
}

pub struct Resolver {
    ofs_children: HashMap<usize, Vec<usize>>,
    ref_children: HashMap<Oid, Vec<usize>>,
    roots: Vec<usize>,
    root_cursor: usize,
    stack: Vec<Frame>,
    pending: Option<(usize, bool)>,
    stack_bytes: usize,
    pub max_stack_bytes: usize,
    pub max_depth: usize,
    pub bytes_requested: u64,
}

impl Resolver {
    pub fn new(entries: &[Entry]) -> Result<Self, String> {
        let mut ofs_children: HashMap<usize, Vec<usize>> = HashMap::new();
        let mut ref_children: HashMap<Oid, Vec<usize>> = HashMap::new();
        for (i, e) in entries.iter().enumerate() {
            match e.base {
                Base::None => {}
                Base::Ofs(off) => {
                    let b = entries
                        .binary_search_by_key(&off, |e| e.offset)
                        .map_err(|_| format!("ofs-delta at {} points to no entry", e.offset))?;
                    ofs_children.entry(b).or_default().push(i);
                }
                Base::Ref(oid) => {
                    ref_children.entry(oid).or_default().push(i);
                }
            }
        }
        let roots: Vec<usize> =
            (0..entries.len()).filter(|&i| matches!(entries[i].base, Base::None)).collect();
        Ok(Resolver {
            ofs_children,
            ref_children,
            roots,
            root_cursor: 0,
            stack: Vec::new(),
            pending: None,
            stack_bytes: 0,
            max_stack_bytes: 0,
            max_depth: 0,
            bytes_requested: 0,
        })
    }

    fn take_children(&mut self, i: usize, oid: &Oid) -> Vec<usize> {
        let mut c = self.ofs_children.remove(&i).unwrap_or_default();
        if let Some(r) = self.ref_children.remove(oid) {
            c.extend(r);
        }
        c
    }

    fn has_children(&self, i: usize, oid: &Oid) -> bool {
        self.ofs_children.contains_key(&i) || self.ref_children.contains_key(oid)
    }

    /// The next `(offset, len)` range of the pack the resolver needs, or `None` when done.
    pub fn next_read(&mut self, entries: &[Entry]) -> Result<Option<(u64, u64)>, String> {
        loop {
            if let Some((i, _)) = self.pending {
                let e = &entries[i];
                return Ok(Some((e.data_offset, e.end - e.data_offset)));
            }
            if let Some(top) = self.stack.last_mut() {
                if top.next < top.children.len() {
                    self.pending = Some((top.children[top.next], false));
                    top.next += 1;
                } else {
                    let f = self.stack.pop().unwrap();
                    self.stack_bytes -= f.content.len();
                }
                continue;
            }
            while self.root_cursor < self.roots.len() {
                let i = self.roots[self.root_cursor];
                self.root_cursor += 1;
                if self.has_children(i, &entries[i].oid.unwrap()) {
                    self.pending = Some((i, true));
                    break;
                }
            }
            if self.pending.is_none() {
                if !self.ofs_children.is_empty() || !self.ref_children.is_empty() {
                    return Err("unresolved deltas (thin pack or missing base)".into());
                }
                return Ok(None);
            }
        }
    }

    pub fn provide(&mut self, entries: &mut [Entry], bytes: &[u8]) -> Result<(), String> {
        let (i, is_root) = self.pending.take().ok_or("provide() without a pending read")?;
        self.bytes_requested += bytes.len() as u64;
        let data = inflate_exact(bytes, entries[i].size)?;
        let (kind, content) = if is_root {
            (entries[i].kind, data)
        } else {
            let base = self.stack.last().ok_or("delta without base frame")?;
            let content = apply_delta(&base.content, &data)?;
            entries[i].oid = Some(hash_object(base.kind, &content)?);
            let kind = base.kind;
            // Last child of its base: drop the base now rather than holding it while we
            // descend. Long linear chains (a file edited many times) then cost one object,
            // not the whole chain.
            if base.next == base.children.len() {
                let f = self.stack.pop().unwrap();
                self.stack_bytes -= f.content.len();
            }
            (kind, content)
        };
        let oid = entries[i].oid.unwrap();
        let children = self.take_children(i, &oid);
        if !children.is_empty() {
            self.stack_bytes += content.len();
            self.stack.push(Frame { kind, content, children, next: 0 });
            self.max_stack_bytes = self.max_stack_bytes.max(self.stack_bytes);
            self.max_depth = self.max_depth.max(self.stack.len());
        }
        Ok(())
    }
}

/// Serialize a version 2 `.idx` file, byte-identical to what `git index-pack` writes.
pub fn write_idx(entries: &[Entry], pack_checksum: &Oid) -> Result<Vec<u8>, String> {
    let mut sorted: Vec<(Oid, u32, u64)> = Vec::with_capacity(entries.len());
    for e in entries {
        let oid = e.oid.ok_or_else(|| format!("entry at {} unresolved", e.offset))?;
        sorted.push((oid, e.crc, e.offset));
    }
    sorted.sort_unstable_by(|a, b| a.0.cmp(&b.0));

    let mut out = Vec::with_capacity(8 + 1024 + sorted.len() * 28 + 40);
    out.extend_from_slice(&[0xff, b't', b'O', b'c']);
    out.extend_from_slice(&2u32.to_be_bytes());
    let mut fanout = [0u32; 256];
    for (oid, _, _) in &sorted {
        fanout[oid[0] as usize] += 1;
    }
    let mut acc = 0;
    for f in fanout {
        acc += f;
        out.extend_from_slice(&acc.to_be_bytes());
    }
    for (oid, _, _) in &sorted {
        out.extend_from_slice(oid);
    }
    for (_, crc, _) in &sorted {
        out.extend_from_slice(&crc.to_be_bytes());
    }
    let mut large = Vec::new();
    for (_, _, off) in &sorted {
        if *off < 0x8000_0000 {
            out.extend_from_slice(&(*off as u32).to_be_bytes());
        } else {
            out.extend_from_slice(&(0x8000_0000 | large.len() as u32).to_be_bytes());
            large.push(*off);
        }
    }
    for off in large {
        out.extend_from_slice(&off.to_be_bytes());
    }
    out.extend_from_slice(pack_checksum);
    let idx_sum: Oid = Sha1::digest(&out).into();
    out.extend_from_slice(&idx_sum);
    Ok(out)
}
