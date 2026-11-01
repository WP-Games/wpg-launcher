//! Content-defined chunking — MUST match tools/cdc.mjs exactly.
//!
//! Gear rolling hash over a 256-entry u32 table (first 4 bytes of
//! sha256([i])). Within each chunk, bytes before MIN_SIZE don't influence the
//! cut; a cut happens at the first position where the top 22 bits of the hash
//! are zero, or at MAX_SIZE. A trailing remainder ≤ MIN_SIZE is one chunk.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::OnceLock;

pub const MIN_SIZE: usize = 1 << 20;
pub const MAX_SIZE: usize = 16 << 20;
pub const MASK: u32 = 0xfffffc00;

fn gear() -> &'static [u32; 256] {
    static T: OnceLock<[u32; 256]> = OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let h = Sha256::digest([i as u8]);
            *slot = u32::from_be_bytes([h[0], h[1], h[2], h[3]]);
        }
        t
    })
}

/// Length of the first chunk in `buf` (same rules as cutPoints() in cdc.mjs,
/// applied to a window that is either the whole remaining file or ≥ MAX_SIZE+1 bytes).
pub fn first_cut(buf: &[u8]) -> usize {
    let n = buf.len();
    if n <= MIN_SIZE {
        return n;
    }
    let limit = n.min(MAX_SIZE);
    let g = gear();
    let mut h: u32 = 0;
    for i in MIN_SIZE..limit {
        h = h.wrapping_shl(1).wrapping_add(g[buf[i] as usize]);
        if h & MASK == 0 {
            return i + 1;
        }
    }
    limit
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub offset: u64,
    pub size: u64,
    pub sha256: String,
}

/// Chunk a whole reader, returning the pieces and the whole-file sha256.
/// Memory stays around 2×MAX_SIZE regardless of file size.
pub fn chunk_reader<R: Read>(mut r: R) -> std::io::Result<(Vec<Chunk>, String)> {
    let mut whole = Sha256::new();
    let mut out = Vec::new();
    let mut buf: Vec<u8> = Vec::with_capacity(MAX_SIZE * 2 + 1);
    let mut eof = false;
    let mut file_offset: u64 = 0;
    let mut tmp = vec![0u8; 1 << 20];

    loop {
        // Fill until we have > MAX_SIZE bytes (or EOF) so one cut decision never spans a refill.
        while !eof && buf.len() <= MAX_SIZE {
            let n = r.read(&mut tmp)?;
            if n == 0 {
                eof = true;
            } else {
                buf.extend_from_slice(&tmp[..n]);
            }
        }
        if buf.is_empty() {
            break;
        }
        let window = if eof { &buf[..] } else { &buf[..(MAX_SIZE + 1).min(buf.len())] };
        let cut = first_cut(window);
        let piece = &buf[..cut];
        whole.update(piece);
        out.push(Chunk {
            offset: file_offset,
            size: cut as u64,
            sha256: hex::encode(Sha256::digest(piece)),
        });
        file_offset += cut as u64;
        buf.drain(..cut);
    }
    Ok((out, hex::encode(whole.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gear_table_matches_node() {
        assert_eq!(gear()[0], 0x6e340b9c);
        assert_eq!(gear()[1], 0x4bf5122f);
    }

    #[test]
    fn small_input_is_one_chunk() {
        let data = vec![7u8; 1000];
        let (chunks, _) = chunk_reader(&data[..]).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].size, 1000);
    }

    #[test]
    fn chunks_cover_input_and_respect_bounds() {
        // Deterministic pseudo-random 40 MiB
        let mut x: u64 = 0x9e3779b97f4a7c15;
        let data: Vec<u8> = (0..40 << 20)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        let (chunks, whole) = chunk_reader(&data[..]).unwrap();
        let mut off = 0;
        for c in &chunks {
            assert_eq!(c.offset, off);
            assert!(c.size as usize <= MAX_SIZE);
            off += c.size;
        }
        assert_eq!(off as usize, data.len());
        for c in &chunks[..chunks.len() - 1] {
            assert!(c.size as usize >= MIN_SIZE);
        }
        assert_eq!(whole, hex::encode(Sha256::digest(&data)));
        // Streaming (1 MiB reads) must equal one-shot cutting
        let mut off2 = 0usize;
        for c in &chunks {
            let cut = first_cut(&data[off2..]);
            assert_eq!(cut as u64, c.size);
            off2 += cut;
        }
    }
}
