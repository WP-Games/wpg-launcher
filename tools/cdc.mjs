/**
 * cdc.mjs — content-defined chunking (gear rolling hash).
 *
 * Big files (Ren'Py .rpa archives are gigabytes) are split into ~4 MiB pieces
 * whose boundaries depend on the bytes themselves, not on offsets. Insert a
 * new image in the middle of images.rpa and only the pieces around the
 * insertion change — everything before and after keeps the same hashes, so
 * players only download the new pieces. This is the same idea as rsync /
 * Steam's depot chunks.
 *
 * THE ALGORITHM MUST MATCH src-tauri/src/cdc.rs EXACTLY (same table, same
 * parameters, same rules). A Rust test re-chunks the sample game and compares
 * against what this file produced.
 *
 *   MIN  1 MiB   — never cut before this (also skipped by the hash for speed)
 *   AVG ~4 MiB   — cut when the top 22 bits of the hash are zero
 *   MAX 16 MiB   — always cut here
 *   Files smaller than CHUNK_THRESHOLD (8 MiB) are stored whole.
 */
import { createHash } from "node:crypto";

export const MIN_SIZE = 1 << 20;
export const MAX_SIZE = 16 << 20;
export const MASK = 0xfffffc00; // 22 high bits set → average 4 MiB
export const CHUNK_THRESHOLD = 8 << 20;

/** 256 × u32, derived deterministically: first 4 bytes of sha256([i]). */
export const GEAR = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const h = createHash("sha256").update(Buffer.from([i])).digest();
    t[i] = h.readUInt32BE(0);
  }
  return t;
})();

/**
 * Find chunk boundaries in a byte buffer. Returns [{offset, size}].
 * (Operates on one in-memory buffer; chunkFile() streams a big file through
 * it window by window.)
 */
export function cutPoints(buf) {
  const cuts = [];
  const n = buf.length;
  let start = 0;
  while (start < n) {
    const remaining = n - start;
    if (remaining <= MIN_SIZE) { cuts.push({ offset: start, size: remaining }); break; }
    const limit = Math.min(remaining, MAX_SIZE);
    let h = 0;
    let i = MIN_SIZE; // bytes before MIN never influence the cut
    let cut = limit;
    for (; i < limit; i++) {
      h = ((h << 1) + GEAR[buf[start + i]]) >>> 0;
      if ((h & MASK) === 0) { cut = i + 1; break; }
    }
    cuts.push({ offset: start, size: cut });
    start += cut;
  }
  return cuts;
}

/**
 * Chunk a file on disk. Calls `onChunk({offset, size, sha256, data})` for each
 * piece in order and resolves to { size, sha256 (whole file), chunks:[{size, sha256}] }.
 * Streams with a sliding buffer so memory stays ~2×MAX_SIZE.
 */
export async function chunkFile(fh, fileSize, onChunk) {
  const whole = createHash("sha256");
  const chunks = [];
  let fileOffset = 0; // offset in file of buf[0]
  let buf = Buffer.alloc(0);
  let eof = false;

  const fill = async () => {
    // Keep at least MAX_SIZE + 1 bytes buffered (if available) so one cut decision never spans a refill.
    const want = MAX_SIZE * 2;
    if (buf.length >= want || eof) return;
    const chunk = Buffer.allocUnsafe(want - buf.length);
    const { bytesRead } = await fh.read(chunk, 0, chunk.length, fileOffset + buf.length);
    if (bytesRead === 0) { eof = true; return; }
    buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
    if (fileOffset + buf.length >= fileSize) eof = true;
  };

  await fill();
  while (buf.length > 0) {
    // Decide ONE cut from the current window. If the window is shorter than
    // MAX_SIZE and not at EOF, refill first so the decision matches cutPoints().
    if (buf.length < MAX_SIZE && !eof) { await fill(); continue; }
    const [first] = cutPoints(eof ? buf : buf.subarray(0, MAX_SIZE + 1)); // +1 so a full MAX window still uses the "limit" rule correctly
    const size = Math.min(first.size, buf.length);
    const data = buf.subarray(0, size);
    const sha256 = createHash("sha256").update(data).digest("hex");
    whole.update(data);
    chunks.push({ size, sha256 });
    if (onChunk) await onChunk({ offset: fileOffset, size, sha256, data });
    buf = buf.subarray(size);
    fileOffset += size;
    if (!eof) await fill();
  }
  return { size: fileOffset, sha256: whole.digest("hex"), chunks };
}
