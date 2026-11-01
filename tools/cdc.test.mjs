import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cutPoints, chunkFile, MIN_SIZE, MAX_SIZE, GEAR } from "./cdc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const v0 = path.join(here, "..", "sample-game", "v0.1.0", "game", "images.rpa");
const v1 = path.join(here, "..", "sample-game", "v0.1.1", "game", "images.rpa");

test("gear table is deterministic (first entries pinned)", () => {
  // sha256([0]) = 6e340b9c..., sha256([1]) = 4bf5122f...
  assert.equal(GEAR[0], 0x6e340b9c);
  assert.equal(GEAR[1], 0x4bf5122f);
});

test("cut points respect min/max and cover the buffer", async () => {
  const buf = await fs.readFile(v0);
  const cuts = cutPoints(buf);
  let off = 0;
  for (const c of cuts) {
    assert.equal(c.offset, off);
    assert.ok(c.size <= MAX_SIZE);
    off += c.size;
  }
  assert.equal(off, buf.length);
  // all but the last chunk are ≥ MIN
  for (const c of cuts.slice(0, -1)) assert.ok(c.size >= MIN_SIZE, `chunk ${c.size} < MIN`);
  assert.ok(cuts.length >= 3 && cuts.length <= 24, `unexpected chunk count ${cuts.length}`);
});

test("streaming chunkFile matches in-memory cutPoints", async () => {
  const buf = await fs.readFile(v0);
  const expect = cutPoints(buf).map((c) => c.size);
  const fh = await fs.open(v0, "r");
  try {
    const res = await chunkFile(fh, buf.length);
    assert.deepEqual(res.chunks.map((c) => c.size), expect);
    assert.equal(res.size, buf.length);
  } finally { await fh.close(); }
});

test("inserting 100 KB mid-file only changes nearby chunks", async () => {
  const a = await fs.open(v0, "r"), b = await fs.open(v1, "r");
  try {
    const ra = await chunkFile(a, (await fs.stat(v0)).size);
    const rb = await chunkFile(b, (await fs.stat(v1)).size);
    const have = new Set(ra.chunks.map((c) => c.sha256));
    const newBytes = rb.chunks.filter((c) => !have.has(c.sha256)).reduce((n, c) => n + c.size, 0);
    assert.ok(newBytes < rb.size * 0.5, `new bytes ${newBytes} should be well under half of ${rb.size}`);
    assert.ok(newBytes >= 100 * 1024);
  } finally { await a.close(); await b.close(); }
});
