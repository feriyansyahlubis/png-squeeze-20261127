// PNG Squeeze — lossless re-encode of 1280x720 RGBA screenshots, smallest bytes wins.
// Written from scratch in this session for make.fun "Squeeze screenshots into the
// smallest PNG, 27 November 2026" (png-squeeze-01-run-20261127).
//
// Pipeline: own PNG decoder -> RGBA; image analysis (opaque / grey / colour count /
// single transparent key); colour-type screen (palette, grey, grey+alpha, RGB, RGBA,
// tRNS key forms); per-row filter choice by brute force (trial deflate) plus min-sum
// and fewest-pairs heuristics plus fixed filters; screen the candidates with zlib
// level 6 and shortlist the best three; final zlib level 9 variants; then a custom
// optimal-parsing DEFLATE encoder (Pareto-frontier hash-chain matcher +
// shortest-path DP with iterated Huffman lengths, 4 blocks) on the best
// candidate when the input is small enough and the time budget allows, keeping
// whichever stream is smallest. One IDAT chunk, hand-rolled CRC-32.
// Fully deterministic: no clock, no randomness, fixed iteration order.

import { deflateSync, inflateSync, constants as Z } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHAN = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ---------------------------------------------------------------- CRC-32
const CRC_TAB = (() => {
  const tab = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tab[n] = c;
  }
  return tab;
})();

function crc32(buf, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = CRC_TAB[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunkBytes(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function buildPng(width, height, colourType, plte, trns, idat) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = colourType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [SIG, chunkBytes('IHDR', ihdr)];
  if (plte) parts.push(chunkBytes('PLTE', plte));
  if (trns) parts.push(chunkBytes('tRNS', trns));
  parts.push(chunkBytes('IDAT', idat));
  parts.push(chunkBytes('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------------------------------------------------------------- PNG decode -> RGBA
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error('short png');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('bad signature');
  let at = 8;
  let hdr = null, pal = null, trn = null;
  const idatParts = [];
  let ended = false;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error('bad crc ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      hdr = { w: dv.getUint32(0), h: dv.getUint32(4), depth: data[8], ct: data[9], inter: data[12] };
    } else if (type === 'PLTE') pal = data;
    else if (type === 'tRNS') trn = data;
    else if (type === 'IDAT') idatParts.push(data);
    else if (type === 'IEND') { ended = true; break; }
    else throw new Error('chunk ' + type);
  }
  if (!hdr || !ended || idatParts.length === 0) throw new Error('incomplete');
  if (hdr.depth !== 8 || hdr.inter !== 0) throw new Error('depth/interlace');
  const bpp = CHAN[hdr.ct];
  if (!bpp) throw new Error('colour type');
  const stride = hdr.w * bpp;
  const want = hdr.h * (stride + 1);
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), { maxOutputLength: want + 1 });
  if (raw.length !== want) throw new Error('inflate size');
  const px = new Uint8Array(hdr.h * stride);
  for (let y = 0; y < hdr.h; y++) {
    const f = raw[y * (stride + 1)];
    const s = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (f === 0) px.set(raw.subarray(s, s + stride), o);
    else if (f === 1) {
      for (let i = 0; i < stride; i++) px[o + i] = (raw[s + i] + (i >= bpp ? px[o + i - bpp] : 0)) & 255;
    } else if (f === 2) {
      if (y === 0) px.set(raw.subarray(s, s + stride), o);
      else for (let i = 0; i < stride; i++) px[o + i] = (raw[s + i] + px[p + i]) & 255;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? px[o + i - bpp] : 0, b = y > 0 ? px[p + i] : 0;
        px[o + i] = (raw[s + i] + ((a + b) >> 1)) & 255;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? px[o + i - bpp] : 0, b = y > 0 ? px[p + i] : 0, c = (y > 0 && i >= bpp) ? px[p + i - bpp] : 0;
        const pa = a + b - c;
        const da = pa > a ? pa - a : a - pa, db = pa > b ? pa - b : b - pa, dc = pa > c ? pa - c : c - pa;
        px[o + i] = (raw[s + i] + (da <= db && da <= dc ? a : db <= dc ? b : c)) & 255;
      }
    } else throw new Error('filter ' + f);
  }
  const n = hdr.w * hdr.h;
  const rgba = new Uint8Array(n * 4);
  if (hdr.ct === 6) rgba.set(px);
  else if (hdr.ct === 2) {
    const key = trn ? (trn[1] << 16) | (trn[3] << 8) | trn[5] : -1;
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2];
      rgba[d + 3] = ((px[s] << 16) | (px[s + 1] << 8) | px[s + 2]) === key ? 0 : 255;
    }
  } else if (hdr.ct === 0) {
    const key = trn ? trn[1] : -1;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[i];
      rgba[d + 3] = px[i] === key ? 0 : 255;
    }
  } else if (hdr.ct === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1];
    }
  } else {
    const lut = new Uint8Array((pal.length / 3) * 4);
    for (let e = 0; e < pal.length / 3; e++) {
      lut[e * 4] = pal[e * 3]; lut[e * 4 + 1] = pal[e * 3 + 1]; lut[e * 4 + 2] = pal[e * 3 + 2];
      lut[e * 4 + 3] = trn && e < trn.length ? trn[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = px[i] * 4;
      rgba[d] = lut[e]; rgba[d + 1] = lut[e + 1]; rgba[d + 2] = lut[e + 2]; rgba[d + 3] = lut[e + 3];
    }
  }
  return { width: hdr.w, height: hdr.h, rgba };
}

// ---------------------------------------------------------------- PNG filters
// Apply filter `f` to row `cur` given previous row `prev` (null on row 0), writing
// the filtered bytes (without the filter-type byte) into `out`.
function applyFilter(f, cur, prev, bpp, out) {
  const n = cur.length;
  if (f === 0) { out.set(cur); return; }
  if (f === 1) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 255;
    return;
  }
  if (f === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = (cur[i] - prev[i]) & 255;
    return;
  }
  if (f === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = (cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1)) & 255;
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    const p = a + b - c;
    const da = p > a ? p - a : a - p, db = p > b ? p - b : b - p, dc = p > c ? p - c : c - p;
    out[i] = (cur[i] - (da <= db && da <= dc ? a : db <= dc ? b : c)) & 255;
  }
}

// Sum of absolute values of signed bytes: cheap filter-quality proxy.
function absSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}

// Count of distinct adjacent byte pairs: another cheap proxy (fewer pairs ~ more repeats).
function pairCount(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- image analysis
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true, grey = true;
  const counts = new Map();
  let overflow = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!overflow) {
      const c = words[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) overflow = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!overflow) {
    colours = [];
    for (const [word, count] of counts) {
      const b = new Uint8Array(Uint32Array.of(word).buffer);
      colours.push({ word, count, r: b[0], g: b[1], b: b[2], a: b[3] });
    }
  }
  return { opaque, grey, colours };
}

// If every non-opaque pixel is fully transparent with one single colour value,
// and no opaque pixel uses that value, return that value (grey: one byte,
// colour: 24-bit); else null.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// Extract the sample plane for a colour type from RGBA.
function samplesFor(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// Order palette entries: transparent ones first (so tRNS stays short), then by
// count or by luminance depending on `order`.
function orderPalette(colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  return [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0, ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = orderPalette(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// Candidate colour-type forms for one image, each with its filter choices.
function candidateForms(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      p.filters = [0, 'minsum', 'brute'];
      forms.push(p);
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push({
    colourType: ct, bpp: { 0: 1, 2: 3, 4: 2, 6: 4 }[ct],
    samples: samplesFor(rgba, ct), plte: null, trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

const extraBytes = (form) =>
  (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);

// ---------------------------------------------------------------- per-row filtering
const TRIAL_CTX = 32768;   // dictionary window for brute-force filter trials
const TRIAL_LEVEL = 4;     // deflate level for those trials (fast proxy)

// Filter `samples` (height rows of width*bpp) by `choice`: a fixed filter 0..4,
// 'minsum' (least absolute byte sum per row), 'pairs' (fewest distinct adjacent
// pairs per row) or 'brute' (try all five per row, keep the one whose trial
// deflate with the preceding 32 KiB as dictionary is smallest).
// Returns the raw scanline data (filter byte + filtered row per row).
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) { const r = new Uint8Array(stride + 1); r[0] = t; trial.push(r); }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      applyFilter(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - TRIAL_CTX), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      applyFilter(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = absSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairCount(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0
          ? { level: TRIAL_LEVEL, memLevel: 9 }
          : { level: TRIAL_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const SCREEN = { level: 6, memLevel: 8, strategy: Z.Z_DEFAULT_STRATEGY };

// Final zlib variants (level 9) tried on the shortlisted candidates.
const FINAL_VARIANTS = [
  { level: 9, memLevel: 9, strategy: Z.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: Z.Z_FILTERED },
  { level: 9, memLevel: 8, strategy: Z.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 8, strategy: Z.Z_FILTERED },
  { level: 9, memLevel: 7, strategy: Z.Z_DEFAULT_STRATEGY },
];

// ---------------------------------------------------------------- optimal-parse DEFLATE
// A from-scratch DEFLATE encoder in the manner of zopfli: hash-chain longest-match
// search, shortest-path (DP) parse with iterated Huffman lengths, fixed block
// splitting, dynamic Huffman blocks (fixed fallback when a tree would be too deep).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Uint16Array(259); // length symbols run 257..285: do NOT fit a byte
const LEN_EXT = new Uint8Array(259);
for (let l = 3; l <= 258; l++) {
  let s = 0;
  while (s < 28 && LEN_BASE[s + 1] <= l) s++;
  LEN_SYM[l] = 257 + s; LEN_EXT[l] = LEN_EXTRA[s];
}
const DIST_SYM = new Uint8Array(32769);
const DIST_EXT = new Uint8Array(32769);
for (let d = 1; d <= 32768; d++) {
  let s = 0;
  while (s < 29 && DIST_BASE[s + 1] <= d) s++;
  DIST_SYM[d] = s; DIST_EXT[d] = DIST_EXTRA[s];
}

// Fixed Huffman lengths (DEFLATE spec).
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

// Bit writer: bits go LSB-first into bytes; Huffman codes are fed MSB-first.
class BitWriter {
  constructor(cap) {
    this.out = new Uint8Array(Math.max(1024, cap));
    this.pos = 0; this.acc = 0; this.nbits = 0;
  }
  grow() {
    const bigger = new Uint8Array(this.out.length * 2);
    bigger.set(this.out.subarray(0, this.pos));
    this.out = bigger;
  }
  bits(value, count) {
    this.acc |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      if (this.pos >= this.out.length) this.grow();
      this.out[this.pos++] = this.acc & 255;
      this.acc >>>= 8; this.nbits -= 8;
    }
  }
  code(code, len) {
    // Huffman code bits are stored MSB-first: emit from the top bit down.
    for (let i = len - 1; i >= 0; i--) this.bits((code >> i) & 1, 1);
  }
  finish() {
    if (this.nbits > 0) {
      if (this.pos >= this.out.length) this.grow();
      this.out[this.pos++] = this.acc & 255;
      this.acc = 0; this.nbits = 0;
    }
    return this.out.subarray(0, this.pos);
  }
}

// Cap code lengths at `maxLen` while keeping Kraft's inequality, assigning the
// longest lengths to the rarest symbols (rearrangement: minimises total cost
// for the resulting length multiset). Returns a fresh length array.
function capLens(lens, freq, maxLen) {
  const n = lens.length;
  let maxD = 0;
  for (let i = 0; i < n; i++) if (lens[i] > maxD) maxD = lens[i];
  if (maxD <= maxLen) return lens;
  const bl = new Int32Array(maxD + 1);
  for (let i = 0; i < n; i++) if (lens[i] > 0) bl[lens[i]]++;
  let overflow = 0;
  for (let b = maxLen + 1; b <= maxD; b++) { overflow += bl[b]; bl[b] = 0; }
  bl[maxLen] += overflow;
  // Kraft sum scaled by 2^maxLen: S = sum_b bl[b] * 2^(maxLen-b); need S <= 2^maxLen.
  const LIM = 1 << maxLen;
  let S = 0;
  for (let b = 1; b <= maxLen; b++) S += bl[b] * (1 << (maxLen - b));
  while (S > LIM) {
    let b = maxLen - 1;
    while (b > 0 && bl[b] === 0) b--;
    if (b === 0) break;
    bl[b]--; bl[b + 1]++;
    S -= (1 << (maxLen - b - 1));
  }
  // Complete the code (Kraft must be exactly 1: DEFLATE rejects an incomplete
  // code). Shortening a code at length b to b-1 adds 2^(maxLen-b) units; spend
  // the deficit D = LIM - S in binary, largest gain first (gain 1, i.e. a
  // maxLen code, is always available: the overflow codes sit there).
  let D = LIM - S;
  while (D > 0) {
    let done = false;
    for (let k = 31 - Math.clz32(D); k >= 0; k--) {
      const b = maxLen - k;
      if (b < 2 || b > maxLen || bl[b] === 0) continue;
      bl[b]--; bl[b - 1]++;
      D -= (1 << k);
      done = true;
      break;
    }
    if (!done) break;
  }
  const order = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
  order.sort((a, b) => freq[a] - freq[b] || a - b);
  const out = new Uint8Array(n);
  let idx = 0;
  for (let b = maxLen; b >= 1; b--) {
    for (let k = 0; k < bl[b]; k++) out[order[idx++]] = b;
  }
  return out;
}

// Canonical Huffman codes from symbol frequencies. Always returns a valid
// {codes, lens} with every length <= `maxLen` (deep trees are capped, never
// dropped to fixed codes). A complete code needs at least two symbols: callers
// top up sparse alphabets.
function huffmanCodes(freq, maxLen) {
  const n = freq.length;
  const alive = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) alive.push(i);
  if (alive.length === 0) return { codes: new Uint16Array(n), lens: new Uint8Array(n) };
  if (alive.length === 1) {
    const lens = new Uint8Array(n); lens[alive[0]] = 1;
    return { codes: new Uint16Array(n), lens };
  }
  // Two-queue Huffman: leaves sorted by frequency, internal nodes in creation order.
  const order = [...alive].sort((a, b) => freq[a] - freq[b] || a - b);
  const parent = new Int32Array(2 * n).fill(-1);
  const weight = new Float64Array(n);
  const q = [];
  let qi = 0, nodes = 0;
  const wOf = (id) => (id < n ? freq[id] : weight[id - n]);
  const take = () => {
    if (qi < order.length && (q.length === 0 || freq[order[qi]] <= wOf(q[0]))) return order[qi++];
    return q.shift();
  };
  while (order.length - qi + q.length > 1) {
    const a = take(), b = take();
    weight[nodes] = wOf(a) + wOf(b);
    const id = n + nodes;
    nodes++;
    parent[a] = id; parent[b] = id;
    q.push(id);
  }
  const depth = new Uint8Array(n);
  let maxDepth = 0;
  for (const s of alive) {
    let d = 0, x = s;
    while (parent[x] !== -1) { x = parent[x]; d++; }
    depth[s] = d;
    if (d > maxDepth) maxDepth = d;
  }
  const lens = capLens(depth, freq, maxLen);
  // Canonical codes from the (capped) lengths.
  const blCount = new Uint16Array(maxLen + 1);
  for (const s of alive) blCount[lens[s]]++;
  const nextCode = new Uint16Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint16Array(n);
  for (const s of alive) codes[s] = nextCode[lens[s]]++;
  return { codes, lens };
}

// Guarantee at least two symbols with nonzero frequency (Huffman completeness).
function topUp(freq, a, b) {
  let seen = 0;
  for (let i = 0; i < freq.length; i++) if (freq[i] > 0) seen++;
  if (seen < 2) { if (freq[a] === 0) freq[a] = 1; if (freq[b] === 0) freq[b] = 1; }
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i]; if (a >= 65521) a -= 65521;
    b += a; if (b >= 65521) b -= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function codesFromLens(lens) {
  const n = lens.length;
  let maxLen = 0;
  const blCount = new Uint16Array(16);
  for (let i = 0; i < n; i++) { if (lens[i] > maxLen) maxLen = lens[i]; blCount[lens[i]]++; }
  const nextCode = new Uint16Array(16);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lens[i] > 0) codes[i] = nextCode[lens[i]]++;
  return { codes, lens };
}

const FIXED_LIT = codesFromLens(FIXED_LIT_LEN);
const FIXED_DIST = codesFromLens(FIXED_DIST_LEN);

// ---------------------------------------------------------------- longest matches
// Pareto frontier per position (zopfli-style `sublen`): up to 3 (length,
// distance) pairs that are not dominated (a pair dominates another when it is
// both longer and nearer). The frontier captures the length/distance tradeoff
// the DP needs, instead of a single best match. Two hash tables: 4-byte (long
// matches at pattern starts) and 8-byte (long matches at any distance; buckets
// are tiny because few positions share 8 bytes). Match propagation: the
// longest match at i-1 (length L, distance D) implies a match of length L-1
// at distance D at position i, so positions inside a run start from a good
// match without a deep walk. A candidate is measured only when it can improve
// the frontier (gate on the best length among pairs with distance <= the
// candidate's distance).
const FRONTIER_N = 3;
const OPT_CAP4 = 512;    // 4-byte hash-chain walk cap
const OPT_CAP8 = 64;     // 8-byte hash-chain walk cap
const OPT_STOP_LEN = 258;

function findMatches(data) {
  const n = data.length;
  const NF = FRONTIER_N;
  const fLen = new Uint16Array(n * NF);
  const fDist = new Uint16Array(n * NF);
  const HSIZE = 1 << 17;
  const HSHIFT = 32 - 17;
  const head4 = new Int32Array(HSIZE).fill(-1);
  const prev4 = new Int32Array(n);
  const head8 = new Int32Array(HSIZE).fill(-1);
  const prev8 = new Int32Array(n);
  let propLen = 0, propDist = 0;
  for (let i = 0; i + 3 <= n; i++) {
    const maxLen = Math.min(258, n - i);
    const base = i * NF;
    let fc = 0;
    if (propLen >= 4) {
      const pl = propLen - 1 <= maxLen ? propLen - 1 : maxLen;
      if (pl >= 3) { fLen[base] = pl; fDist[base] = propDist; fc = 1; }
    }
    // ---- 4-byte chain ----
    if (i + 4 <= n) {
      const v4 = (data[i] << 24) ^ (data[i + 1] << 16) ^ (data[i + 2] << 8) ^ data[i + 3];
      const h4 = (Math.imul(v4, 2654435761) >>> HSHIFT) & (HSIZE - 1);
      let cand = head4[h4];
      let chain = 0;
      while (cand !== -1 && chain < OPT_CAP4) {
        const dist = i - cand;
        if (dist > 32768) break;
        let t = 0;
        for (let k = 0; k < fc; k++) if (fDist[base + k] <= dist && fLen[base + k] > t) t = fLen[base + k];
        if (t < maxLen && data[cand + t] === data[i + t]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l >= 3) {
            let dominated = false;
            for (let k = 0; k < fc; k++) if (fLen[base + k] >= l && fDist[base + k] <= dist) { dominated = true; break; }
            if (!dominated) {
              let w = 0;
              for (let k = 0; k < fc; k++) {
                if (fLen[base + k] <= l && fDist[base + k] >= dist) continue;
                fLen[base + w] = fLen[base + k]; fDist[base + w] = fDist[base + k]; w++;
              }
              fc = w;
              if (fc < NF || l > fLen[base + fc - 1]) {
                if (fc >= NF) fc--;
                let at = fc;
                while (at > 0 && fLen[base + at - 1] < l) at--;
                for (let k = fc; k > at; k--) { fLen[base + k] = fLen[base + k - 1]; fDist[base + k] = fDist[base + k - 1]; }
                fLen[base + at] = l; fDist[base + at] = dist; fc++;
              }
            }
          }
          if (l >= 258) break;
        }
        cand = prev4[cand];
        chain++;
        if (fc > 0 && fLen[base] >= OPT_STOP_LEN && chain >= 32) break;
      }
      prev4[i] = head4[h4];
      head4[h4] = i;
    }
    // ---- 8-byte chain: long matches at any distance ----
    if (i + 8 <= n) {
      let v8 = 0;
      for (let k = 0; k < 8; k++) v8 = (Math.imul(v8, 257) + data[i + k]) | 0;
      const h8 = (Math.imul(v8, 2654435761) >>> HSHIFT) & (HSIZE - 1);
      let cand = head8[h8];
      let chain = 0;
      while (cand !== -1 && chain < OPT_CAP8) {
        const dist = i - cand;
        if (dist > 32768) break;
        let t = 0;
        for (let k = 0; k < fc; k++) if (fDist[base + k] <= dist && fLen[base + k] > t) t = fLen[base + k];
        if (t < 8) t = 8;
        if (t < maxLen && data[cand + t] === data[i + t]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l >= 8) {
            let dominated = false;
            for (let k = 0; k < fc; k++) if (fLen[base + k] >= l && fDist[base + k] <= dist) { dominated = true; break; }
            if (!dominated) {
              let w = 0;
              for (let k = 0; k < fc; k++) {
                if (fLen[base + k] <= l && fDist[base + k] >= dist) continue;
                fLen[base + w] = fLen[base + k]; fDist[base + w] = fDist[base + k]; w++;
              }
              fc = w;
              if (fc < NF || l > fLen[base + fc - 1]) {
                if (fc >= NF) fc--;
                let at = fc;
                while (at > 0 && fLen[base + at - 1] < l) at--;
                for (let k = fc; k > at; k--) { fLen[base + k] = fLen[base + k - 1]; fDist[base + k] = fDist[base + k - 1]; }
                fLen[base + at] = l; fDist[base + at] = dist; fc++;
              }
            }
          }
          if (l >= 258) break;
        }
        cand = prev8[cand];
        chain++;
        if (fc > 0 && fLen[base] >= OPT_STOP_LEN && chain >= 16) break;
      }
      prev8[i] = head8[h8];
      head8[h8] = i;
    }
    propLen = fc > 0 ? fLen[base] : 0;
    propDist = fc > 0 ? fDist[base] : 0;
  }
  return { fLen, fDist, NF };
}

// Bit costs for a parse, from literal/length and distance Huffman lengths.
function costTables(litLens, distLens) {
  const litBits = new Float64Array(288);
  for (let i = 0; i < 288; i++) litBits[i] = litLens[i];
  const lenBits = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenBits[l] = litLens[LEN_SYM[l]] + LEN_EXT[l];
  const distBits = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distBits[d] = distLens[DIST_SYM[d]] + DIST_EXT[d];
  return { litBits, lenBits, distBits };
}

// Shortest-path parse of data[start..end) with the given bit costs. Each
// frontier pair is tried at its full length and at length 3 (a shorter use of
// the same match can be cheaper once the Huffman lengths are fixed).
function parseBlock(data, fLen, fDist, NF, start, end, costs) {
  const n = end - start;
  const { litBits, lenBits, distBits } = costs;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const prev = new Int32Array(n + 1).fill(-1);
  const tokLen = new Int16Array(n + 1);
  const tokDist = new Uint16Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const pos = start + i;
    const ncLit = c + litBits[data[pos]];
    if (ncLit < cost[i + 1]) { cost[i + 1] = ncLit; prev[i + 1] = i; tokLen[i + 1] = 1; }
    const base = pos * NF;
    const rem = n - i;
    for (let k = 0; k < NF; k++) {
      let L = fLen[base + k];
      if (L < 3) continue;
      if (L > rem) L = rem;
      if (L < 3) continue;
      const d = fDist[base + k];
      const bc = c + distBits[d];
      const nc = bc + lenBits[L];
      if (nc < cost[i + L]) { cost[i + L] = nc; prev[i + L] = i; tokLen[i + L] = L; tokDist[i + L] = d; }
      if (L > 3) {
        const nc3 = bc + lenBits[3];
        if (nc3 < cost[i + 3]) { cost[i + 3] = nc3; prev[i + 3] = i; tokLen[i + 3] = 3; tokDist[i + 3] = d; }
      }
    }
  }
  const toks = [];
  let j = n;
  while (j > 0) {
    const p = prev[j];
    const l = tokLen[j];
    if (l === 1) toks.push({ lit: data[start + p] });
    else toks.push({ len: l, dist: tokDist[j] });
    j = p;
  }
  toks.reverse();
  return toks;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Plan a dynamic block header from literal and distance code lengths. Returns
// the header plan or null when the code-length code would be too deep.
function planDynamicHeader(litLens, distLens) {
  let hlit = 288;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(litLens.subarray(0, hlit), 0);
  all.set(distLens.subarray(0, hdist), hlit);
  const seq = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const t = Math.min(r, 138); seq.push({ sym: 18, extra: t - 11, bits: 7 }); r -= t; }
      if (r >= 3) { seq.push({ sym: 17, extra: r - 3, bits: 3 }); r = 0; }
      for (; r > 0; r--) seq.push({ sym: 0, extra: 0, bits: 0 });
    } else {
      seq.push({ sym: v, extra: 0, bits: 0 });
      let r = run - 1;
      while (r >= 3) { const t = Math.min(r, 6); seq.push({ sym: 16, extra: t - 3, bits: 2 }); r -= t; }
      for (; r > 0; r--) seq.push({ sym: v, extra: 0, bits: 0 });
    }
    i += run;
  }
  const clFreq = new Float64Array(19);
  for (const s of seq) clFreq[s.sym]++;
  topUp(clFreq, 0, 1);
  const clH = huffmanCodes(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clH.lens[CL_ORDER[hclen - 1]] === 0) hclen--;
  return { hlit, hdist, hclen, seq, clCodes: clH.codes, clLens: clH.lens };
}

function writeTokens(w, toks, litH, distH) {
  for (const t of toks) {
    if (t.lit !== undefined) {
      w.code(litH.codes[t.lit], litH.lens[t.lit]);
    } else {
      const ls = LEN_SYM[t.len];
      w.code(litH.codes[ls], litH.lens[ls]);
      const le = LEN_EXT[t.len];
      if (le > 0) w.bits(t.len - LEN_BASE[ls - 257], le);
      const ds = DIST_SYM[t.dist];
      w.code(distH.codes[ds], distH.lens[ds]);
      const de = DIST_EXT[t.dist];
      if (de > 0) w.bits(t.dist - DIST_BASE[ds], de);
    }
  }
  w.code(litH.codes[256], litH.lens[256]);
}

// Emit one block: dynamic Huffman when its trees fit, fixed otherwise.
function emitBlock(w, toks, isLast) {
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(30);
  for (const t of toks) {
    if (t.lit !== undefined) litFreq[t.lit]++;
    else { litFreq[LEN_SYM[t.len]]++; distFreq[DIST_SYM[t.dist]]++; }
  }
  litFreq[256]++;
  topUp(litFreq, 0, 1);
  topUp(distFreq, 0, 1);
  const litH = huffmanCodes(litFreq, 15);
  const distH = huffmanCodes(distFreq, 15);
  const header = planDynamicHeader(litH.lens, distH.lens);
  if (header) {
    w.bits(isLast ? 1 : 0, 1);
    w.bits(2, 2);
    w.bits(header.hlit - 257, 5);
    w.bits(header.hdist - 1, 5);
    w.bits(header.hclen - 4, 4);
    for (let k = 0; k < header.hclen; k++) w.bits(header.clLens[CL_ORDER[k]], 3);
    for (const s of header.seq) {
      w.code(header.clCodes[s.sym], header.clLens[s.sym]);
      if (s.bits > 0) w.bits(s.extra, s.bits);
    }
    writeTokens(w, toks, litH, distH);
  } else {
    w.bits(isLast ? 1 : 0, 1);
    w.bits(1, 2);
    writeTokens(w, toks, FIXED_LIT, FIXED_DIST);
  }
}

const OPT_BLOCKS = 4;      // split the input into this many blocks
const OPT_ROUNDS = 5;      // DP rounds: fixed costs, then refined rounds (2 rounds overshoot: round-1 costs skew match-heavy)

// Optimal-parse DEFLATE of `data`, wrapped as a zlib stream. Returns the stream
// bytes (or null for empty input).
function optimalDeflate(data) {
  const n = data.length;
  if (n === 0) return null;
  const { fLen, fDist, NF } = findMatches(data);
  const nBlocks = OPT_BLOCKS;
  const blockLen = Math.ceil(n / nBlocks);
  const bounds = [];
  for (let s = 0; s < n; s += blockLen) bounds.push([s, Math.min(n, s + blockLen)]);
  let litLens = FIXED_LIT_LEN, distLens = FIXED_DIST_LEN;
  let allToks = null;
  for (let round = 0; round < OPT_ROUNDS; round++) {
    const costs = costTables(litLens, distLens);
    allToks = [];
    for (const [s, e] of bounds) allToks.push(parseBlock(data, fLen, fDist, NF, s, e, costs));
    if (round + 1 >= OPT_ROUNDS) break;
    const litFreq = new Float64Array(288);
    const distFreq = new Float64Array(30);
    for (const toks of allToks) {
      for (const t of toks) {
        if (t.lit !== undefined) litFreq[t.lit]++;
        else { litFreq[LEN_SYM[t.len]]++; distFreq[DIST_SYM[t.dist]]++; }
      }
    }
    litFreq[256]++;
    topUp(litFreq, 0, 1);
    topUp(distFreq, 0, 1);
    const lh = huffmanCodes(litFreq, 15);
    const dh = huffmanCodes(distFreq, 15);
    litLens = lh.lens; distLens = dh.lens;
  }
  const w = new BitWriter(n);
  for (let b = 0; b < bounds.length; b++) emitBlock(w, allToks[b], b === bounds.length - 1);
  const raw = w.finish();
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(raw, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 255;
  out[out.length - 3] = (ad >>> 16) & 255;
  out[out.length - 2] = (ad >>> 8) & 255;
  out[out.length - 1] = ad & 255;
  return out;
}

// ---------------------------------------------------------------- legacy optimal-parse DEFLATE
// The previous single-best-match optimal parser (3-byte hash, chain cap 128).
// Kept as the fallback for large inputs, where the frontier parser above is
// too slow: it is fast and still beats zlib level 9 on those inputs.
const LEGACY_MAX_CHAIN = 128;
const LEGACY_GOOD_LEN = 32;

function findMatchesLegacy(data) {
  const n = data.length;
  const lenArr = new Uint16Array(n);
  const distArr = new Uint16Array(n);
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(n);
  for (let i = 0; i + 3 <= n; i++) {
    const h = ((data[i] << 10) + (data[i + 1] << 5) + data[i + 2]) & 65535;
    const maxLen = Math.min(258, n - i);
    let best = 0, bestDist = 0;
    let cand = head[h];
    let chain = 0;
    while (cand !== -1 && chain < LEGACY_MAX_CHAIN) {
      const dist = i - cand;
      if (dist > 32768) break;
      if (best < maxLen && data[cand + best] === data[i + best]) {
        let l = 0;
        while (l < maxLen && data[cand + l] === data[i + l]) l++;
        if (l > best) {
          best = l; bestDist = dist;
          if (l >= 258) break;
        }
      }
      cand = prev[cand];
      chain++;
      if (best >= LEGACY_GOOD_LEN && chain >= 16) break;
    }
    if (best >= 3) { lenArr[i] = best; distArr[i] = bestDist; }
    prev[i] = head[h];
    head[h] = i;
  }
  return { lenArr, distArr };
}

function parseBlockLegacy(data, lenArr, distArr, start, end, costs) {
  const n = end - start;
  const { litBits, lenBits, distBits } = costs;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const prev = new Int32Array(n + 1).fill(-1);
  const tokLen = new Int16Array(n + 1);
  const tokDist = new Uint16Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const pos = start + i;
    const ncLit = c + litBits[data[pos]];
    if (ncLit < cost[i + 1]) { cost[i + 1] = ncLit; prev[i + 1] = i; tokLen[i + 1] = 1; }
    let L = lenArr[pos];
    if (L >= 3) {
      const rem = n - i;
      if (L > rem) L = rem;
      const base = c + distBits[distArr[pos]];
      const lo = Math.max(3, L - 3);
      for (let cl = L; cl >= lo; cl--) {
        const nc = base + lenBits[cl];
        if (nc < cost[i + cl]) { cost[i + cl] = nc; prev[i + cl] = i; tokLen[i + cl] = cl; tokDist[i + cl] = distArr[pos]; }
      }
      if (lo > 3) {
        const nc = base + lenBits[3];
        if (nc < cost[i + 3]) { cost[i + 3] = nc; prev[i + 3] = i; tokLen[i + 3] = 3; tokDist[i + 3] = distArr[pos]; }
      }
    }
  }
  const toks = [];
  let j = n;
  while (j > 0) {
    const p = prev[j];
    const l = tokLen[j];
    if (l === 1) toks.push({ lit: data[start + p] });
    else toks.push({ len: l, dist: tokDist[j] });
    j = p;
  }
  toks.reverse();
  return toks;
}

function optimalDeflateLegacy(data) {
  const n = data.length;
  if (n === 0) return null;
  const { lenArr, distArr } = findMatchesLegacy(data);
  const nBlocks = n > 1048576 ? 8 : 1;
  const blockLen = Math.ceil(n / nBlocks);
  const bounds = [];
  for (let s = 0; s < n; s += blockLen) bounds.push([s, Math.min(n, s + blockLen)]);
  let litLens = FIXED_LIT_LEN, distLens = FIXED_DIST_LEN;
  let allToks = null;
  for (let round = 0; round < OPT_ROUNDS; round++) {
    const costs = costTables(litLens, distLens);
    allToks = [];
    for (const [s, e] of bounds) allToks.push(parseBlockLegacy(data, lenArr, distArr, s, e, costs));
    if (round + 1 >= OPT_ROUNDS) break;
    const litFreq = new Float64Array(288);
    const distFreq = new Float64Array(30);
    for (const toks of allToks) {
      for (const t of toks) {
        if (t.lit !== undefined) litFreq[t.lit]++;
        else { litFreq[LEN_SYM[t.len]]++; distFreq[DIST_SYM[t.dist]]++; }
      }
    }
    litFreq[256]++;
    topUp(litFreq, 0, 1);
    topUp(distFreq, 0, 1);
    const lh = huffmanCodes(litFreq, 15);
    const dh = huffmanCodes(distFreq, 15);
    litLens = lh.lens; distLens = dh.lens;
  }
  const w = new BitWriter(n);
  for (let b = 0; b < bounds.length; b++) emitBlock(w, allToks[b], b === bounds.length - 1);
  const raw = w.finish();
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(raw, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 255;
  out[out.length - 3] = (ad >>> 16) & 255;
  out[out.length - 2] = (ad >>> 8) & 255;
  out[out.length - 1] = ad & 255;
  return out;
}

// The frontier optimal-parse DEFLATE is slow on large inputs (its hash-chain
// walk is the bottleneck). It runs only on small inputs (<= 1 MiB, the most
// repetitive screenshots), where it pays best per second; everything else
// uses the fast legacy optimal parser above. The choice is purely
// size-based (never time-based) so the output is fully deterministic.
const OPT_SMALL_BYTES = 1000000;

function squeeze(rgba, width, height) {
  const forms = candidateForms(rgba);
  const cands = [];
  for (const form of forms) {
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      cands.push({ form, data, bytes: zlib.length + extraBytes(form) });
    }
  }
  cands.sort((a, b) => a.bytes - b.bytes);
  const short = cands.slice(0, 2);
  let best = null;
  for (const cand of short) {
    for (const variant of FINAL_VARIANTS) {
      const zlib = deflateSync(cand.data, variant);
      const bytes = zlib.length + extraBytes(cand.form);
      if (best === null || bytes < best.bytes) {
        best = { form: cand.form, data: cand.data, bytes, idat: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length) };
      }
    }
  }
  // Optimal-parse DEFLATE on the winning candidate's filtered data: the
  // frontier parser on small inputs, otherwise the fast legacy parser.
  const useFrontier = best.data.length <= OPT_SMALL_BYTES;
  const opt = useFrontier ? optimalDeflate(best.data) : optimalDeflateLegacy(best.data);
  if (opt !== null) {
    const bytes = opt.length + extraBytes(best.form);
    if (bytes < best.bytes) best = { form: best.form, data: best.data, bytes, idat: opt };
  }
  return buildPng(width, height, best.form.colourType, best.form.plte, best.form.trns, best.idat);
}

// ---------------------------------------------------------------- main
function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  const ids = readdirSync(inputDir).filter((name) => {
    try { return existsSync(join(inputDir, name, 'image.png')); } catch { return false; }
  }).sort();
  for (const id of ids) {
    const bytes = readFileSync(join(inputDir, id, 'image.png'));
    const { width, height, rgba } = decodePng(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const out = squeeze(rgba, width, height);
    const dir = join(outputDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'image.png'), out);
  }
}

main();





