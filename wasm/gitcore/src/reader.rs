//! Random-access object reads from a stored pack + `.idx`, without doing any I/O.
//!
//! `begin(oid)` starts a lookup; the reader then asks for byte ranges of the pack
//! (`next_read`) until it has walked the delta chain down to a base object, and
//! reconstructs the object upwards. Resolved bases are kept in a small byte-bounded cache.

use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use miniz_oxide::inflate::stream::{inflate, InflateState};
use miniz_oxide::{DataFormat, MZError, MZFlush, MZStatus};
use sha1::{Digest, Sha1};

use crate::object::*;

struct Cache {
    map: HashMap<u64, (u8, Rc<Vec<u8>>)>,
    order: VecDeque<u64>,
    bytes: usize,
    limit: usize,
}

impl Cache {
    fn get(&self, off: u64) -> Option<(u8, Rc<Vec<u8>>)> {
        self.map.get(&off).cloned()
    }

    fn put(&mut self, off: u64, kind: u8, data: Rc<Vec<u8>>) {
        if data.len() > self.limit / 4 || self.map.contains_key(&off) {
            return;
        }
        self.bytes += data.len();
        self.map.insert(off, (kind, data));
        self.order.push_back(off);
        while self.bytes > self.limit {
            let old = self.order.pop_front().unwrap();
            if let Some((_, d)) = self.map.remove(&old) {
                self.bytes -= d.len();
            }
        }
    }
}

/// An entry whose bytes are arriving in pieces.
struct Partial {
    header_buf: Vec<u8>,
    header: Option<EntryHeader>,
    inflater: Box<InflateState>,
    out: Vec<u8>,
    produced: usize,
    done: bool,
}

impl Partial {
    fn inflate(&mut self, mut input: &[u8]) -> Result<(), String> {
        // Once `out` is full (or empty, for a zero-byte object) inflate into a scratch byte
        // so the stream can still reach its end; any output there means a size mismatch.
        let mut scratch = [0u8; 1];
        while !input.is_empty() && !self.done {
            let full = self.produced == self.out.len();
            let dst = if full { &mut scratch[..] } else { &mut self.out[self.produced..] };
            let res = inflate(&mut self.inflater, input, dst, MZFlush::None);
            if full && res.bytes_written > 0 {
                return Err("object inflates to more than its header says".into());
            }
            self.produced += res.bytes_written;
            input = &input[res.bytes_consumed..];
            match res.status {
                Ok(MZStatus::StreamEnd) => {
                    if self.produced != self.out.len() {
                        return Err("inflated size differs from header".into());
                    }
                    self.done = true;
                }
                Ok(_) if res.bytes_consumed > 0 || res.bytes_written > 0 => {}
                Ok(_) | Err(MZError::Buf) => return Err("inflate made no progress (object larger than header says?)".into()),
                Err(e) => return Err(format!("zlib error {e:?}")),
            }
        }
        Ok(())
    }
}

pub struct Reader {
    oids: Vec<Oid>,
    offsets: Vec<u64>,
    sorted_offsets: Vec<u64>,
    pack_data_end: u64,
    cache: Cache,
    /// Deltas collected walking down the chain: (entry offset, delta bytes).
    chain: Vec<(u64, Vec<u8>)>,
    pending: Option<u64>,
    partial: Option<Partial>,
    pub pack_checksum: Oid,
    result: Option<(u8, Rc<Vec<u8>>)>,
    pub bytes_requested: u64,
}

impl Reader {
    pub fn new(idx: &[u8], pack_len: u64, cache_limit: usize) -> Result<Self, String> {
        if idx.len() < 8 + 1024 + 40 || idx[0..4] != [0xff, b't', b'O', b'c'] {
            return Err("not a v2 pack index".into());
        }
        let (body, sum) = idx.split_at(idx.len() - 20);
        if Sha1::digest(body).as_slice() != sum {
            return Err("pack index checksum mismatch".into());
        }
        let be32 = |o: usize| u32::from_be_bytes(idx[o..o + 4].try_into().unwrap());
        let n = be32(8 + 255 * 4) as usize;
        let oid_at = 8 + 1024;
        let crc_at = oid_at + 20 * n;
        let off_at = crc_at + 4 * n;
        let large_at = off_at + 4 * n;
        let mut oids = Vec::with_capacity(n);
        let mut offsets = Vec::with_capacity(n);
        for i in 0..n {
            oids.push(idx[oid_at + 20 * i..oid_at + 20 * i + 20].try_into().unwrap());
            let o = be32(off_at + 4 * i);
            offsets.push(if o & 0x8000_0000 == 0 {
                o as u64
            } else {
                let at = large_at + 8 * (o & 0x7fff_ffff) as usize;
                u64::from_be_bytes(idx.get(at..at + 8).ok_or("bad large offset")?.try_into().unwrap())
            });
        }
        let pack_checksum: Oid = idx[idx.len() - 40..idx.len() - 20].try_into().unwrap();
        let mut sorted_offsets = offsets.clone();
        sorted_offsets.sort_unstable();
        Ok(Reader {
            oids,
            offsets,
            sorted_offsets,
            pack_data_end: pack_len - 20,
            cache: Cache { map: HashMap::new(), order: VecDeque::new(), bytes: 0, limit: cache_limit },
            chain: Vec::new(),
            pending: None,
            partial: None,
            pack_checksum,
            result: None,
            bytes_requested: 0,
        })
    }

    pub fn offset_of(&self, oid: &Oid) -> Option<u64> {
        self.oids.binary_search(oid).ok().map(|i| self.offsets[i])
    }

    pub fn oids_with_prefix(&self, prefix: &str) -> Vec<String> {
        // oids are sorted, so the matches form one contiguous run.
        let start = self.oids.partition_point(|o| to_hex(o).as_str() < prefix);
        self.oids[start..]
            .iter()
            .map(to_hex)
            .take_while(|h| h.starts_with(prefix))
            .collect()
    }

    fn entry_end(&self, off: u64) -> u64 {
        match self.sorted_offsets.binary_search(&off) {
            Ok(i) if i + 1 < self.sorted_offsets.len() => self.sorted_offsets[i + 1],
            _ => self.pack_data_end,
        }
    }

    pub fn begin(&mut self, oid: &Oid) -> Result<(), String> {
        let off = self.offset_of(oid).ok_or_else(|| format!("object {} not in pack", to_hex(oid)))?;
        self.chain.clear();
        self.result = None;
        self.pending = None;
        self.partial = None;
        self.step(off)
    }

    /// Continue the walk at `off`: either finish from cache or ask for the entry's bytes.
    fn step(&mut self, off: u64) -> Result<(), String> {
        match self.cache.get(off) {
            Some((kind, data)) => self.unwind(kind, data),
            None => {
                self.pending = Some(off);
                Ok(())
            }
        }
    }

    fn unwind(&mut self, kind: u8, mut data: Rc<Vec<u8>>) -> Result<(), String> {
        while let Some((off, delta)) = self.chain.pop() {
            data = Rc::new(apply_delta(&data, &delta)?);
            self.cache.put(off, kind, data.clone());
        }
        self.result = Some((kind, data));
        Ok(())
    }

    pub fn next_read(&self) -> Option<(u64, u64)> {
        if self.partial.is_some() {
            return None;
        }
        self.pending.map(|off| (off, self.entry_end(off) - off))
    }

    /// Feed the next piece of the requested range. The entry is inflated as it arrives
    /// into a buffer of exactly the object's size, so the compressed bytes are never
    /// held in full.
    pub fn provide_part(&mut self, bytes: &[u8]) -> Result<(), String> {
        let off = self.pending.ok_or("provide_part() without a pending read")?;
        self.bytes_requested += bytes.len() as u64;
        let p = self.partial.get_or_insert_with(|| Partial {
            header_buf: Vec::new(),
            header: None,
            inflater: InflateState::new_boxed(DataFormat::Zlib),
            out: Vec::new(),
            produced: 0,
            done: false,
        });
        if p.header.is_none() {
            p.header_buf.extend_from_slice(bytes);
            let Some(h) = parse_entry_header(&p.header_buf, off)? else { return Ok(()) };
            let rest = std::mem::take(&mut p.header_buf).split_off(h.header_len);
            p.out = vec![0; h.size as usize];
            p.header = Some(h);
            return p.inflate(&rest);
        }
        p.inflate(bytes)
    }

    /// The whole requested range has been provided.
    pub fn provide_end(&mut self) -> Result<(), String> {
        let off = self.pending.take().ok_or("provide_end() without a pending read")?;
        let p = self.partial.take().ok_or("provide_end() before any data")?;
        if !p.done {
            return Err(format!("entry at {off} ended before its zlib stream did"));
        }
        let h = p.header.unwrap();
        let data = p.out;
        match h.base {
            Base::None => {
                let data = Rc::new(data);
                self.cache.put(off, h.kind, data.clone());
                self.unwind(h.kind, data)
            }
            Base::Ofs(base) => {
                self.chain.push((off, data));
                self.step(base)
            }
            Base::Ref(oid) => {
                let base = self.offset_of(&oid).ok_or("ref-delta base not in this pack")?;
                self.chain.push((off, data));
                self.step(base)
            }
        }
    }

    pub fn take(&mut self) -> Option<(u8, Rc<Vec<u8>>)> {
        self.result.take()
    }
}
