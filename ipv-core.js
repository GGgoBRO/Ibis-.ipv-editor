/*  ipv-core.js  -  reader / writer for ibisPaint X ".ipv" project files
 *  Reverse-engineered from two sample files made with ibisPaint X ver.13.1.12.
 *  Pure JavaScript, no dependencies. Works in browsers and in Node 18+
 *  (uses the standard CompressionStream / DecompressionStream APIs).
 *  See IPV_FORMAT.md for the byte-level format description.
 */
(function (root) {
'use strict';
const IPV = {};

// ======================= byte helpers =======================
const te = new TextEncoder(), td = new TextDecoder('utf-8');
const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const f32 = (b, o) => dvOf(b).getFloat32(o);
const f64 = (b, o) => dvOf(b).getFloat64(o);
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

class Writer {
  constructor(cap) { this.buf = new Uint8Array(cap || 1024); this.len = 0; }
  _need(n) {
    if (this.len + n <= this.buf.length) return;
    let c = this.buf.length * 2; while (c < this.len + n) c *= 2;
    const nb = new Uint8Array(c); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  }
  u8(v) { this._need(1); this.buf[this.len++] = v & 255; return this; }
  u16(v) { this._need(2); this.buf[this.len++] = (v >>> 8) & 255; this.buf[this.len++] = v & 255; return this; }
  u32(v) { v = v >>> 0; this._need(4); const b = this.buf, l = this.len; b[l] = v >>> 24; b[l + 1] = (v >>> 16) & 255; b[l + 2] = (v >>> 8) & 255; b[l + 3] = v & 255; this.len += 4; return this; }
  i32(v) { return this.u32(v | 0); }
  u64(v) { return this.u32(Math.floor(v / 4294967296)).u32(v >>> 0); }
  u16le(v) { this._need(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >>> 8) & 255; return this; }
  u32le(v) { v = v >>> 0; this._need(4); const b = this.buf, l = this.len; b[l] = v & 255; b[l + 1] = (v >>> 8) & 255; b[l + 2] = (v >>> 16) & 255; b[l + 3] = v >>> 24; this.len += 4; return this; }
  f32(v) { this._need(4); dvOf(this.buf).setFloat32(this.len, v); this.len += 4; return this; }
  f64(v) { this._need(8); dvOf(this.buf).setFloat64(this.len, v); this.len += 8; return this; }
  bytes(a) { this._need(a.length); this.buf.set(a, this.len); this.len += a.length; return this; }
  zeros(n) { this._need(n); this.buf.fill(0, this.len, this.len + n); this.len += n; return this; }
  utf(s) { const e = te.encode(s); this.u16(e.length); return this.bytes(e); }
  result() { return this.buf.slice(0, this.len); }
}
function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function readUtf(b, o) { const n = u16(b, o); return [td.decode(b.subarray(o + 2, o + 2 + n)), o + 2 + n]; }

// ======================= record framing =======================
// record = [kind u8][0 u8][type u8][sub u8][payload length u32][payload][-(8+length) i32]
function parseRecords(buf) {
  const recs = []; let off = 0;
  while (off < buf.length) {
    if (off + 12 > buf.length) throw new Error('Truncated record at byte ' + off);
    const n = u32(buf, off + 4), end = off + 8 + n;
    if (end + 4 > buf.length || i32(buf, end) !== -(8 + n)) throw new Error('Bad record framing at byte ' + off + ' (not an ibisPaint .ipv file?)');
    recs.push({ i: recs.length, off, kind: buf[off], b1: buf[off + 1], type: buf[off + 2], sub: buf[off + 3], payload: buf.subarray(off + 8, end) });
    off = end + 4;
  }
  return recs;
}
function recordBytes(kind, type, sub, payload, b1) {
  const out = new Uint8Array(12 + payload.length);
  out[0] = kind; out[1] = b1 || 0; out[2] = type; out[3] = sub;
  const d = dvOf(out); d.setUint32(4, payload.length); out.set(payload, 8); d.setInt32(8 + payload.length, -(8 + payload.length));
  return out;
}
function serializeRecords(recs) { return concat(recs.map((r) => recordBytes(r.kind, r.type, r.sub, r.payload, r.b1))); }
// read one nested record at offset o inside a payload
function nested(p, o) {
  const n = u32(p, o + 4);
  if (i32(p, o + 8 + n) !== -(8 + n)) throw new Error('Bad nested record at ' + o);
  return { kind: p[o], type: p[o + 2], sub: p[o + 3], payload: p.subarray(o + 8, o + 8 + n), next: o + 12 + n };
}

// ======================= CRC32, zlib, PNG =======================
const CRC_T = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  for (let n = 0; n < 256; n++) { let c = t[n]; for (let k = 1; k < 8; k++) { c = t[c & 255] ^ (c >>> 8); t[k * 256 + n] = c >>> 0; } }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF, i = 0; const n = buf.length, T = CRC_T;
  for (; i + 8 <= n; i += 8) {
    const a = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) ^ c, b = buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
    c = T[1792 + (a & 255)] ^ T[1536 + ((a >>> 8) & 255)] ^ T[1280 + ((a >>> 16) & 255)] ^ T[1024 + (a >>> 24)] ^ T[768 + (b & 255)] ^ T[512 + ((b >>> 8) & 255)] ^ T[256 + ((b >>> 16) & 255)] ^ T[b >>> 24];
  }
  for (; i < n; i++) c = T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// 32-bit view helpers: is the alpha byte of a pixel non-zero?
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1, AMASK = LITTLE ? 0xFF000000 : 0x000000FF;
const aligned = (a) => (a.byteOffset % 4 === 0 ? a : a.slice());
async function pipeBytes(data, stream) { return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer()); }
const inflate = (d, fmt) => pipeBytes(d, new DecompressionStream(fmt || 'deflate'));
const deflate = (d, fmt) => pipeBytes(d, new CompressionStream(fmt || 'deflate'));

async function pngDecode(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('Not a PNG');
  let o = 8, ihdr = null, plte = null, trns = null; const idat = [];
  while (o + 8 <= bytes.length) {
    const len = u32(bytes, o), type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const data = bytes.subarray(o + 8, o + 8 + len); o += 12 + len;
    if (type === 'IHDR') ihdr = data; else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG without IHDR');
  const w = u32(ihdr, 0), h = u32(ihdr, 4), bd = ihdr[8], ct = ihdr[9];
  if (ihdr[12] !== 0) throw new Error('Interlaced PNG is not supported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!ch) throw new Error('Unsupported PNG colour type ' + ct);
  const bpp = Math.max(1, (ch * bd) >> 3), stride = (w * ch * bd + 7) >> 3;
  const raw = await inflate(idat.length === 1 ? idat[0] : concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error('PNG data too short');
  const img = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], s = y * (stride + 1) + 1, d = y * stride, p = d - stride, first = Math.min(bpp, stride);
    if (ft === 0) img.set(raw.subarray(s, s + stride), d);
    else if (ft === 1) { for (let x = 0; x < first; x++) img[d + x] = raw[s + x]; for (let x = bpp; x < stride; x++) img[d + x] = raw[s + x] + img[d + x - bpp]; }
    else if (ft === 2) { if (y) for (let x = 0; x < stride; x++) img[d + x] = raw[s + x] + img[p + x]; else img.set(raw.subarray(s, s + stride), d); }
    else if (ft === 3) { for (let x = 0; x < first; x++) img[d + x] = raw[s + x] + (y ? img[p + x] >> 1 : 0); for (let x = bpp; x < stride; x++) img[d + x] = raw[s + x] + ((img[d + x - bpp] + (y ? img[p + x] : 0)) >> 1); }
    else if (ft === 4) {
      for (let x = 0; x < first; x++) img[d + x] = raw[s + x] + (y ? img[p + x] : 0);
      for (let x = bpp; x < stride; x++) {
        const a = img[d + x - bpp], b = y ? img[p + x] : 0, c = y ? img[p + x - bpp] : 0, pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        img[d + x] = raw[s + x] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
      }
    } else throw new Error('Bad PNG filter ' + ft);
  }
  const out = new Uint8Array(w * h * 4);
  if (ct === 6 && bd === 8) { out.set(img); return { width: w, height: h, data: out }; }
  const maxv = (1 << Math.min(bd, 8)) - 1;
  const sample = (y, idx) => {
    if (bd === 8) return img[y * stride + idx];
    if (bd === 16) return img[y * stride + idx * 2];
    const bit = idx * bd, byte = img[y * stride + (bit >> 3)]; return (byte >> (8 - bd - (bit & 7))) & maxv;
  };
  const scale = (v) => bd >= 8 ? v : Math.round(v * 255 / maxv);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = (y * w + x) * 4; let r, g, b, a = 255;
    if (ct === 0) { r = g = b = scale(sample(y, x)); if (trns && bd <= 8 && sample(y, x) === u16(trns, 0)) a = 0; }
    else if (ct === 2) { r = sample(y, x * 3); g = sample(y, x * 3 + 1); b = sample(y, x * 3 + 2); }
    else if (ct === 3) { const k = sample(y, x); r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
    else { r = g = b = sample(y, x * 2); a = sample(y, x * 2 + 1); }
    out[q] = r; out[q + 1] = g; out[q + 2] = b; out[q + 3] = a;
  }
  return { width: w, height: h, data: out };
}

async function pngEncode(w, h, rgba) {
  const stride = w * 4, raw = new Uint8Array((stride + 1) * h), pix = Math.max(1, Math.floor(w / 48));
  for (let y = 0; y < h; y++) {
    const row = y * stride, prev = row - stride, o = y * (stride + 1) + 1;
    // score the five filters on ~48 sample pixels of this row (sum of absolute residuals) and take the best
    let s0 = 0, s1 = 0, s2 = y ? 0 : 1e12, s3 = y ? 0 : 1e12, s4 = y ? 0 : 1e12;
    for (let px = 0; px < w; px += pix) for (let c = 0; c < 4; c++) {
      const x = px * 4 + c, v = rgba[row + x], a = px ? rgba[row + x - 4] : 0;
      s0 += v < 128 ? v : 256 - v; let r = (v - a) & 255; s1 += r < 128 ? r : 256 - r;
      if (y) {
        const b = rgba[prev + x], cc = px ? rgba[prev + x - 4] : 0;
        r = (v - b) & 255; s2 += r < 128 ? r : 256 - r;
        r = (v - ((a + b) >> 1)) & 255; s3 += r < 128 ? r : 256 - r;
        const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc);
        r = (v - ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : cc))) & 255; s4 += r < 128 ? r : 256 - r;
      }
    }
    let f = 0, best = s0; if (s1 < best) { best = s1; f = 1; } if (s2 < best) { best = s2; f = 2; } if (s3 < best) { best = s3; f = 3; } if (s4 < best) { f = 4; }
    raw[o - 1] = f;
    if (f === 0) raw.set(rgba.subarray(row, row + stride), o);
    else if (f === 1) { for (let x = 0; x < 4; x++) raw[o + x] = rgba[row + x]; for (let x = 4; x < stride; x++) raw[o + x] = rgba[row + x] - rgba[row + x - 4]; }
    else if (f === 2) { for (let x = 0; x < stride; x++) raw[o + x] = rgba[row + x] - rgba[prev + x]; }
    else if (f === 3) { for (let x = 0; x < 4; x++) raw[o + x] = rgba[row + x] - (rgba[prev + x] >> 1); for (let x = 4; x < stride; x++) raw[o + x] = rgba[row + x] - ((rgba[row + x - 4] + rgba[prev + x]) >> 1); }
    else {
      for (let x = 0; x < 4; x++) raw[o + x] = rgba[row + x] - rgba[prev + x];
      for (let x = 4; x < stride; x++) {
        const a = rgba[row + x - 4], b = rgba[prev + x], c = rgba[prev + x - 4], pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        raw[o + x] = rgba[row + x] - ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
      }
    }
  }
  const z = await deflate(raw);
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), d = dvOf(out);
    d.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8); d.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
  };
  const ihdr = new Uint8Array(13), dh = dvOf(ihdr); dh.setUint32(0, w); dh.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  return concat([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]);
}

// ======================= RPNG layer bitmaps =======================
// 'RPNG' block = tag, u32 45, u32 0, 45-byte header, run index, u32 pngLen, PNG.
// The PNG holds only the non-transparent pixels, packed row by row and stored bottom-up.
// The index is a list of (gap u16, run u16) over the bounding box scanned bottom-up, left to right.
function rpngParse(data) {
  if (data[0] !== 82 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71) throw new Error('Not an RPNG block');
  const hdrlen = u32(data, 4);
  if (hdrlen !== 45) throw new Error('Unsupported RPNG header length ' + hdrlen);
  const h = data.subarray(12, 12 + hdrlen), v = [];
  for (let i = 0; i < 11; i++) v.push(u32(h, 1 + 4 * i));
  const [cw, ch, bw, bh, bx, byBottom, pw, ph, pad, z2, idxlen] = v;
  let o = 12 + hdrlen;
  const idx = data.subarray(o, o + idxlen); o += idxlen;
  const pngLen = u32(data, o); o += 4;
  const entries = []; for (let i = 0; i < idx.length; i += 4) entries.push([u16(idx, i), u16(idx, i + 2)]);
  return { flag: h[0], canvasW: cw, canvasH: ch, bx, bw, bh, byBottom, by: ch - byBottom - bh, pw, ph, pad, z2, entries, png: data.subarray(o, o + pngLen) };
}
async function rpngDecode(data) {
  const r = rpngParse(data), img = await pngDecode(r.png);
  if (img.width !== r.pw || img.height !== r.ph) throw new Error('RPNG packed image size mismatch');
  const cw = r.canvasW, bw = r.bw, pw = r.pw, ph = r.ph, full = new Uint8Array(cw * r.canvasH * 4);
  const dst = new Uint32Array(full.buffer), src = new Uint32Array(img.data.buffer, img.data.byteOffset, pw * ph);
  let pos = 0, k = 0;
  for (const entry of r.entries) {
    pos += entry[0]; let run = entry[1];
    while (run > 0) {
      const row = (pos / bw) | 0, col = pos - row * bw, srow = ph - 1 - ((k / pw) | 0), scol = k % pw;
      const n = Math.min(run, bw - col, pw - scol), di = (r.by + r.bh - 1 - row) * cw + r.bx + col, si = srow * pw + scol;
      if (n > 8) dst.set(src.subarray(si, si + n), di); else for (let j = 0; j < n; j++) dst[di + j] = src[si + j];
      pos += n; k += n; run -= n;
    }
  }
  if (k !== pw * ph - r.pad || pos !== bw * r.bh) throw new Error('RPNG index does not match its bitmap');
  return { width: cw, height: r.canvasH, data: full, bbox: { x: r.bx, y: r.by, w: bw, h: r.bh }, info: r };
}
// rgba: Uint8Array(w*h*4) straight alpha. Returns null for a fully transparent layer.
async function rpngEncode(w, h, rgba, opt) {
  opt = opt || {}; rgba = aligned(rgba);
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
  let x0 = w, x1 = -1, y0 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const base = y * w; let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (px[base + x] & AMASK) { first = x; break; }
    if (first < 0) continue;
    for (let x = w - 1; x >= first; x--) if (px[base + x] & AMASK) { last = x; break; }
    if (y0 < 0) y0 = y; y1 = y; if (first < x0) x0 = first; if (last > x1) x1 = last;
  }
  if (y0 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, packed = new Uint32Array(bw * bh), entries = [];
  const push = (gap, run) => { while (gap > 65535) { entries.push([65535, 0]); gap -= 65535; } while (run > 65535) { entries.push([gap, 65535]); gap = 0; run -= 65535; } entries.push([gap, run]); };
  let np = 0, lastEnd = 0, runStart = -1, runEnd = -1;
  for (let r = 0; r < bh; r++) {
    const base = (y1 - r) * w + x0, rowPos = r * bw; let x = 0;
    while (x < bw) {
      while (x < bw && !(px[base + x] & AMASK)) x++;
      if (x >= bw) break;
      const s = x; while (x < bw && (px[base + x] & AMASK)) x++;
      const fs = rowPos + s, fe = rowPos + x;
      if (runStart >= 0 && fs === runEnd) runEnd = fe;
      else { if (runStart >= 0) { push(runStart - lastEnd, runEnd - runStart); lastEnd = runEnd; } runStart = fs; runEnd = fe; }
      const len = x - s; if (len > 16) packed.set(px.subarray(base + s, base + x), np); else for (let j = 0; j < len; j++) packed[np + j] = px[base + s + j];
      np += len;
    }
  }
  if (runStart >= 0) { push(runStart - lastEnd, runEnd - runStart); lastEnd = runEnd; }
  push(bw * bh - lastEnd, 0);                       // terminator carries the trailing gap
  const pw = Math.max(8, Math.ceil(Math.sqrt(np) / 8) * 8), ph = Math.ceil(np / pw), pad = pw * ph - np;
  const img = new Uint32Array(pw * ph);
  for (let r = 0; r < ph; r++) img.set(packed.subarray(r * pw, Math.min(np, (r + 1) * pw)), (ph - 1 - r) * pw);
  const png = await pngEncode(pw, ph, new Uint8Array(img.buffer));
  const hd = new Writer(64).u8(opt.flag === undefined ? 4 : opt.flag);
  [w, h, bw, bh, x0, h - 1 - y1, pw, ph, pad, opt.z2 === undefined ? 0xFFFFFF00 : opt.z2, entries.length * 4].forEach((v) => hd.u32(v));
  const idx = new Writer(entries.length * 4 + 4); entries.forEach(([g, r2]) => idx.u16(g).u16(r2));
  return concat([Uint8Array.from([82, 80, 78, 71]), new Writer(8).u32(45).u32(0).result(), hd.result(), idx.result(), new Writer(4).u32(png.length).result(), png]);
}

// ======================= layer property records =======================
// record (3,4,sub 2|3): id i32 | flags u8 (bit0 = visible) | opacity f32 | blend i32 | -1 | d u32 | name UTF
//   | -1 | 0 | parent folder id (-5 = none) | 0 | 0x80000000 | -1        (47 bytes with an empty name)
function parseP(sub, p) {
  const nl = u16(p, 21);
  return { sub, id: i32(p, 0), flags: p[4], opacity: f32(p, 5), blend: i32(p, 9), c: i32(p, 13), d: u32(p, 17), name: td.decode(p.subarray(23, 23 + nl)),
    f: i32(p, 23 + nl), g: i32(p, 27 + nl), parent: i32(p, 31 + nl), i: i32(p, 35 + nl), j: u32(p, 39 + nl), k: i32(p, 43 + nl) };
}
function buildP(o) {
  return new Writer(64).i32(o.id).u8(o.flags === undefined ? 1 : o.flags).f32(o.opacity === undefined ? 1 : o.opacity).i32(o.blend || 0)
    .i32(o.c === undefined ? -1 : o.c).u32(o.d === undefined ? 0x80000000 : o.d).utf(o.name || '').i32(o.f === undefined ? -1 : o.f)
    .i32(o.g || 0).i32(o.parent === undefined ? -5 : o.parent).i32(o.i || 0).u32(o.j === undefined ? 0x80000000 : o.j).i32(o.k === undefined ? -1 : o.k).result();
}

// ======================= layer operation records (3,6) =======================
// t f64 | op u32 | nA, A ids | nB, B ids | x1 u32 | x2 u32 | n1, P*n1 | bg i32 | pngLen u32, PNG | 20 mid bytes | n2, P*n2 | n3, P*n3 | 16 tail bytes
// op: 0 move, 1 add layer, 4/5 delete, 6 set paper, 7 first photo, 10 add photo as layer.  Lists are bottom->top and end with the paper (-1).
const MID = Uint8Array.from([0, 0, 0, 6, 0x3f, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const TAIL = Uint8Array.from([0x80, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0x80, 0, 0, 0]);
function parseOp(p) {
  const q = { t: f64(p, 0), op: u32(p, 8) }; let o = 12;
  for (const name of ['A', 'B']) {
    const n = u32(p, o); o += 4; q[name] = [];
    for (let k = 0; k < n; k++) { const r = nested(p, o); if (r.kind !== 3 || r.type !== 6 || r.sub !== 3) throw new Error('Bad layer id record'); q[name].push(i32(r.payload, 0)); o = r.next; }
  }
  q.x1 = u32(p, o); q.x2 = u32(p, o + 4); const n1 = u32(p, o + 8); o += 12;
  const recs = (n) => { const out = []; for (let k = 0; k < n; k++) { const r = nested(p, o); if (r.kind !== 3 || r.type !== 4) throw new Error('Bad layer property record'); out.push({ sub: r.sub, payload: r.payload }); o = r.next; } return out; };
  q.g1 = recs(n1);
  q.bg = i32(p, o); const pl = u32(p, o + 4); o += 8; q.png = p.subarray(o, o + pl); o += pl;
  q.mid = p.subarray(o, o + 20); o += 20;
  const n2 = u32(p, o); o += 4; q.g2 = recs(n2);
  const n3 = u32(p, o); o += 4; q.g3 = recs(n3);
  q.tail = p.subarray(o);
  if (q.tail.length !== 16) throw new Error('Unexpected layer-operation tail');
  return q;
}
function buildOp(q) {
  const w = new Writer(2048).f64(q.t).u32(q.op);
  for (const name of ['A', 'B']) { w.u32(q[name].length); q[name].forEach((id) => w.bytes(recordBytes(3, 6, 3, new Writer(4).i32(id).result()))); }
  w.u32(q.x1).u32(q.x2).u32(q.g1.length); q.g1.forEach((r) => w.bytes(recordBytes(3, 4, r.sub, r.payload)));
  w.i32(q.bg === undefined ? -256 : q.bg); const png = q.png || new Uint8Array(0); w.u32(png.length).bytes(png).bytes(q.mid || MID);
  w.u32(q.g2.length); q.g2.forEach((r) => w.bytes(recordBytes(3, 4, r.sub, r.payload)));
  w.u32(q.g3.length); q.g3.forEach((r) => w.bytes(recordBytes(3, 4, r.sub, r.payload)));
  return w.bytes(q.tail || TAIL).result();
}

// ======================= footer record (1,6) =======================
// u32 0x527 | UTF projectId | UTF title | 16 zeros | 3 x f64 time | u64 seconds | u16 0 | u32 w | u32 h | UTF author | 8 zeros
//   | u16 bitmapCount | u32 layerRecordCount | layer records (the final layer stack, bottom->top, paper last) | opaque tail (tool settings, UUID)
function parseFooter(p) {
  const f = { version: u32(p, 0) }; let o = 4;
  [f.projectId, o] = readUtf(p, o); [f.title, o] = readUtf(p, o);
  f.pre = p.subarray(o, o + 16); o += 16;
  f.t0 = f64(p, o); f.t1 = f64(p, o + 8); f.t2 = f64(p, o + 16); o += 24;
  f.seconds = u64(p, o); o += 8; f.u16a = u16(p, o); o += 2;
  f.w = u32(p, o); f.h = u32(p, o + 4); o += 8;
  [f.author, o] = readUtf(p, o);
  f.z8 = p.subarray(o, o + 8); o += 8;
  f.nBitmaps = u16(p, o); o += 2;
  const n = u32(p, o); o += 4; f.layers = [];
  for (let k = 0; k < n; k++) { const r = nested(p, o); if (r.kind !== 3 || r.type !== 4) throw new Error('Bad footer layer record'); f.layers.push({ sub: r.sub, payload: r.payload }); o = r.next; }
  f.tail = p.subarray(o);
  return f;
}
function buildFooter(f) {
  const w = new Writer(4096).u32(f.version).utf(f.projectId).utf(f.title).bytes(f.pre || new Uint8Array(16)).f64(f.t0).f64(f.t1).f64(f.t2)
    .u64(f.seconds).u16(f.u16a || 0).u32(f.w).u32(f.h).utf(f.author).bytes(f.z8 || new Uint8Array(8)).u16(f.nBitmaps).u32(f.layers.length);
  f.layers.forEach((l) => w.bytes(recordBytes(3, 4, l.sub, l.payload)));
  return w.bytes(f.tail).result();
}

// ======================= project model =======================
// image record (1,5): f64 time | i32 layerId (-1 = paper/whole canvas) | i32 kind (1 = layer, 0 = flattened preview) | u16 | u32 len | data
function parseImageRec(p) { const len = u32(p, 18); return { t: f64(p, 0), id: i32(p, 8), kind: i32(p, 12), c: u16(p, 16), len, data: p.subarray(22, 22 + len) }; }
function buildImageRec(t, id, kind, c, data) { data = data || new Uint8Array(0); return new Writer(22 + data.length).f64(t).i32(id).i32(kind).u16(c).u32(data.length).bytes(data).result(); }
const isPng = (d) => d.length > 8 && d[0] === 137 && d[1] === 80 && d[2] === 78 && d[3] === 71;
const isRpng = (d) => d.length > 12 && d[0] === 82 && d[1] === 80 && d[2] === 78 && d[3] === 71;

function readProject(bytes) {
  const recs = parseRecords(bytes), proj = { bytes, records: recs, warnings: [] };
  const find = (k, t) => recs.find((r) => r.kind === k && r.type === t);
  const last = (k, t) => { for (let i = recs.length - 1; i >= 0; i--) if (recs[i].kind === k && recs[i].type === t) return recs[i]; return null; };
  const r11 = find(1, 1), rf = last(1, 6);
  if (!r11 || !rf) throw new Error('This does not look like a complete ibisPaint .ipv file (missing header or footer record).');
  proj.created = f64(r11.payload, 0); proj.origW = u32(r11.payload, 8); proj.origH = u32(r11.payload, 12);
  proj.footerRec = rf; proj.footer = parseFooter(rf.payload);
  proj.projectId = proj.footer.projectId; proj.title = proj.footer.title;
  proj.canvas = { w: proj.footer.w, h: proj.footer.h };
  const r12 = find(1, 2);
  if (r12) { let o = 12, s; proj.app = {}; [proj.app.name, o] = readUtf(r12.payload, o); [proj.app.version, o] = readUtf(r12.payload, o); [proj.app.device, o] = readUtf(r12.payload, o); }
  proj.images = recs.filter((r) => r.kind === 1 && r.type === 5).map((r) => Object.assign(parseImageRec(r.payload), { rec: r }));
  const byId = new Map(); proj.images.forEach((im) => { if (im.kind === 1) byId.set(im.id, im); });
  proj.previewImage = proj.images.find((im) => im.kind === 0 && isPng(im.data)) || null;
  proj.layers = proj.footer.layers.map((l) => {
    const P = parseP(l.sub, l.payload), im = byId.get(P.id);
    return Object.assign(P, { raw: l.payload, image: im || null, hasPixels: !!(im && isRpng(im.data)), kind: P.id === -1 ? 'paper' : (im ? 'layer' : 'folder'), visible: !!(P.flags & 1) });
  });
  proj.paper = proj.layers.find((l) => l.kind === 'paper') || null;
  proj.stack = proj.layers.filter((l) => l.kind !== 'paper');           // bottom -> top
  proj.embedded = [];                                                    // photos embedded in "add photo" history records
  recs.forEach((r) => { if (r.kind === 3 && r.type === 6 && r.payload.length > 200) { try { const q = parseOp(r.payload); if (q.png.length) proj.embedded.push({ rec: r.i, op: q.op, t: q.t, png: q.png, ids: q.B.filter((x) => !q.A.includes(x)) }); } catch (e) { /* not an image operation */ } } });
  proj.sessions = recs.filter((r) => r.kind === 1 && r.type === 2).length;
  return proj;
}

async function decodeLayer(proj, layer) {
  if (!layer.hasPixels) return null;
  const d = await rpngDecode(layer.image.data);
  if (d.width !== proj.canvas.w || d.height !== proj.canvas.h) proj.warnings.push('Layer ' + layer.id + ' bitmap size differs from the canvas size');
  return d;
}

// Flatten visible layers (folders are composited as groups). Row by row, top layer first, stopping at the first opaque pixel. RGBA8 over white paper.
async function renderComposite(proj, opt) {
  opt = opt || {}; const w = proj.canvas.w, h = proj.canvas.h, warned = new Set();
  const stack = proj.stack, isFolder = (l) => l.kind === 'folder', folderIds = new Set(stack.filter(isFolder).map((l) => l.id));
  const kids = new Map(); stack.forEach((l) => { if (folderIds.has(l.parent)) { if (!kids.has(l.parent)) kids.set(l.parent, []); kids.get(l.parent).push(l); } });
  const roots = stack.filter((l) => !folderIds.has(l.parent)), shown = (l) => l.visible || opt.includeHidden;
  async function prep(items) {                                  // sources of one group, top -> bottom
    const list = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const L = items[i]; if (!shown(L)) continue;
      if (L.blend && !warned.has(L.id)) { warned.add(L.id); (proj.warnings || []).push('Blend mode ' + L.blend + ' on layer ' + L.id + ' is shown as normal'); }
      if (isFolder(L)) list.push({ g: new Float32Array(w * 4), o: L.opacity, sub: await prep(kids.get(L.id) || []) });
      else if (L.hasPixels !== false) { const d = opt.pixelsOf ? await opt.pixelsOf(L) : await decodeLayer(proj, L); if (d) list.push({ d: d.data, o: L.opacity }); }
    }
    return list;
  }
  const rowGroup = (list, y, out) => {
    for (const S of list) if (S.g) rowGroup(S.sub, y, S.g);
    const base = y * w * 4, n = list.length;
    for (let x = 0; x < w; x++) {
      const i = x * 4; let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < n; s++) {
        const S = list[s], k = 1 - a;
        if (S.g) { const ga = S.g[i + 3]; if (!ga) continue; const m = S.o * k; r += S.g[i] * m; g += S.g[i + 1] * m; b += S.g[i + 2] * m; a += ga * m; }
        else { const a8 = S.d[base + i + 3]; if (!a8) continue; const m = a8 * S.o * k / 255 / 255; r += S.d[base + i] * m; g += S.d[base + i + 1] * m; b += S.d[base + i + 2] * m; a += a8 * S.o * k / 255; }
        if (a >= 0.999999) break;
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  };
  const tree = await prep(roots), row = new Float32Array(w * 4), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    rowGroup(tree, y, row);
    for (let x = 0; x < w; x++) {
      const i = x * 4, q = (y * w + x) * 4, a = row[i + 3];
      if (opt.transparent) { if (a > 0) { out[q] = Math.min(255, Math.round(row[i] / a * 255)); out[q + 1] = Math.min(255, Math.round(row[i + 1] / a * 255)); out[q + 2] = Math.min(255, Math.round(row[i + 2] / a * 255)); out[q + 3] = Math.round(a * 255); } }
      else { out[q] = Math.min(255, Math.round((row[i] + 1 - a) * 255)); out[q + 1] = Math.min(255, Math.round((row[i + 1] + 1 - a) * 255)); out[q + 2] = Math.min(255, Math.round((row[i + 2] + 1 - a) * 255)); out[q + 3] = 255; }
    }
  }
  return { width: w, height: h, data: out };
}

// ======================= background tasks (can run in Web Workers) =======================
// Heavy, independent jobs are written as tasks. In a page, IPV.executor can be set to a worker pool; otherwise they run right here.
const TASKS = {
  pngEncode: (w, h, rgba) => pngEncode(w, h, rgba),
  // a photo -> its PNG for the history (optional) and its layer bitmap
  encodePhoto: async (w, h, rgba, o) => ({ png: o.png ? await pngEncode(w, h, rgba) : null, rpng: await rpngEncode(w, h, rgba, { flag: o.flag, z2: o.z2 }) }),
  // a layer bitmap -> PNG files (full canvas and/or cropped)
  layerToPng: async (rpng, o) => {
    const px = await rpngDecode(rpng), res = { bbox: px.bbox, width: px.width, height: px.height, full: null, cropped: null };
    if (o.full) res.full = await pngEncode(px.width, px.height, px.data);
    if (o.cropped) res.cropped = await cropPng(px, px.bbox);
    return res;
  },
  // a layer bitmap -> small preview picture
  layerThumb: async (rpng, size) => {
    const px = await rpngDecode(rpng), W = px.width, H = px.height, d = px.data, s = Math.min(1, size / Math.max(W, H));
    const tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s)), out = new Uint8Array(tw * th * 4);
    for (let ty = 0; ty < th; ty++) {
      const y0 = Math.floor(ty * H / th), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * H / th));
      for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor(tx * W / tw), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * W / tw)); let sa = 0, sr = 0, sg = 0, sb = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4, a = d[i + 3]; n++; if (a) { sa += a; sr += d[i] * a; sg += d[i + 1] * a; sb += d[i + 2] * a; } }
        const o = (ty * tw + tx) * 4; if (sa) { out[o] = sr / sa; out[o + 1] = sg / sa; out[o + 2] = sb / sa; out[o + 3] = Math.min(255, 60 + (sa / n) * 3); }
      }
    }
    return { width: tw, height: th, data: out, bbox: px.bbox };
  },
  // flatten a project: spec = { w, h, stack: [{id, kind, visible, opacity, blend, parent, rpng}] }
  flatten: async (spec, o) => {
    const stack = spec.stack.map((e) => Object.assign({}, e, { hasPixels: !!e.rpng, image: e.rpng ? { data: e.rpng } : null }));
    const pseudo = { canvas: { w: spec.w, h: spec.h }, stack, warnings: [] }, c = await renderComposite(pseudo, { includeHidden: o.includeHidden });
    return { width: c.width, height: c.height, warnings: pseudo.warnings, png: o.raw ? null : await pngEncode(c.width, c.height, c.data), data: o.raw ? c.data : null };
  }
};
IPV.tasks = TASKS; IPV.executor = null; IPV.concurrency = 1;
const runTask = (name, args) => (IPV.executor ? IPV.executor(name, args) : TASKS[name](...args));
const own = (a) => (IPV.executor ? a.slice() : a);          // a private copy when the data is handed to a worker
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}
function flattenSpec(proj) { return { w: proj.canvas.w, h: proj.canvas.h, stack: proj.stack.map((L) => ({ id: L.id, kind: L.kind, visible: L.visible, opacity: L.opacity, blend: L.blend, parent: L.parent, rpng: L.hasPixels ? own(L.image.data) : null })) }; }
// flatten all visible layers; opt.raw -> { data } instead of { png }
async function flatten(proj, opt) { opt = opt || {}; const r = await runTask('flatten', [flattenSpec(proj), { includeHidden: !!opt.includeHidden, raw: !!opt.raw }]); (r.warnings || []).forEach((m) => proj.warnings.push(m)); return r; }

// ======================= extraction =======================
function safeName(s) { return String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'layer'; }
async function cropPng(px, bb) {
  const w = bb.w, h = bb.h, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(px.data.subarray(((bb.y + y) * px.width + bb.x) * 4, ((bb.y + y) * px.width + bb.x + w) * 4), y * w * 4);
  return pngEncode(w, h, out);
}
// opt: { layers, trimmed, flattened, appPreview, originals, manifest, includeHidden, onProgress }
async function extractFiles(proj, opt) {
  opt = Object.assign({ layers: true, trimmed: false, flattened: true, appPreview: false, originals: false, manifest: true, includeHidden: true }, opt || {});
  const files = [], man = { tool: 'ipv-core.js', file: proj.title, canvas: proj.canvas, originalCanvas: { w: proj.origW, h: proj.origH }, app: proj.app, layersBottomToTop: [], warnings: proj.warnings };
  const pad = String(proj.stack.length).length, want = (L) => L.hasPixels && (opt.includeHidden || L.visible) && (opt.layers || opt.trimmed);
  const total = proj.stack.filter(want).length + (opt.flattened ? 1 : 0); let done = 0;
  const step = (m) => { done++; if (opt.onProgress) opt.onProgress(m, done, total); };
  const jobs = proj.stack.map((L, k) => k); if (opt.flattened) jobs.push(-1);
  const res = await mapLimit(jobs, IPV.concurrency, async (k) => {
    if (k === -1) { const f = await flatten(proj, { includeHidden: false }); step('Flattened picture'); return f; }
    const L = proj.stack[k]; if (!want(L)) return null;
    const r = await runTask('layerToPng', [own(L.image.data), { full: opt.layers, cropped: opt.trimmed }]); step('Layer ' + L.id); return r;
  });
  proj.stack.forEach((L, k) => {
    const num = String(k + 1).padStart(pad, '0'), nm = (L.name ? safeName(L.name) + '_' : '') + 'layer' + L.id, r = res[k];
    const entry = { order: k + 1, id: L.id, type: L.kind, name: L.name || null, visible: L.visible, opacity: Math.round(L.opacity * 1000) / 1000, blendMode: L.blend, parentFolder: L.parent === -5 ? null : L.parent };
    if (r) {
      entry.bbox = r.bbox;
      if (r.full) { const f = 'layers/' + num + '_' + nm + '.png'; files.push({ name: f, data: r.full }); entry.file = f; }
      if (r.cropped) { const f = 'layers_trimmed/' + num + '_' + nm + '_x' + r.bbox.x + '_y' + r.bbox.y + '.png'; files.push({ name: f, data: r.cropped }); entry.trimmedFile = f; }
    } else if (!L.hasPixels) entry.note = L.kind === 'folder' ? 'folder (no pixels)' : 'empty layer';
    man.layersBottomToTop.push(entry);
  });
  if (opt.flattened) { files.push({ name: 'flattened.png', data: res[res.length - 1].png }); man.flattened = 'flattened.png'; }
  if (opt.appPreview && proj.previewImage) { files.push({ name: 'preview_saved_by_app.png', data: proj.previewImage.data }); man.appPreview = 'preview_saved_by_app.png'; }
  if (opt.originals && proj.embedded.length) {
    man.originals = [];
    proj.embedded.forEach((e, k) => { const f = 'originals/imported_photo_' + String(k + 1).padStart(2, '0') + '.png'; files.push({ name: f, data: e.png }); man.originals.push({ file: f, operation: e.op, layerIds: e.ids }); });
  }
  if (opt.manifest) files.push({ name: 'manifest.json', data: te.encode(JSON.stringify(man, null, 2)) });
  return files;
}

// ======================= ZIP (store only) =======================
function zipStore(files) {
  const parts = [], central = []; let off = 0; const d = new Date();
  const dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = te.encode(f.name), crc = crc32(f.data);
    const lh = new Writer(30 + name.length).u32le(0x04034b50).u16le(20).u16le(0x0800).u16le(0).u16le(dosT).u16le(dosD).u32le(crc).u32le(f.data.length).u32le(f.data.length).u16le(name.length).u16le(0).bytes(name).result();
    central.push(new Writer(46 + name.length).u32le(0x02014b50).u16le(20).u16le(20).u16le(0x0800).u16le(0).u16le(dosT).u16le(dosD).u32le(crc).u32le(f.data.length).u32le(f.data.length).u16le(name.length).u16le(0).u16le(0).u16le(0).u16le(0).u32le(0).u32le(off).bytes(name).result());
    parts.push(lh, f.data); off += lh.length + f.data.length;
  }
  const cd = concat(central);
  if (off + cd.length > 0xFFFFFFFF) throw new Error('ZIP would be larger than 4 GB');
  return concat([...parts, cd, new Writer(22).u32le(0x06054b50).u16le(0).u16le(0).u16le(files.length).u16le(files.length).u32le(cd.length).u32le(off).u16le(0).result()]);
}

// ======================= builders =======================
// Template pieces taken from a real ibisPaint X 13.1.12 file (device settings, tool settings). Used only when no base file is given.
const b64 = (s) => { const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
const TEMPLATE = {
  appInfo: b64('AAEFJ0HaWUhtwocFAAtpYmlzUGFpbnQgWAALdmVyLjEzLjEuMTIADnJlYWxtZSBSTVgxOTcxAAAAAAAAAAAAAAABAAAAAT1MzM09TMzNAAAAAgAAAAE='),
  footerTail: b64('AAAAAAAAAAEAAAAAAAAAAAAAAAMAAAACAAAAAP+0af8/gAAAAAAAAAAAAB46ZAAAAAIAClVudGl0bGVkNzEAAAAAAAdVbmtub3duAAAAAfw9AAH8PQAAAAQBAAYBAAAADgAAAAAAAQAAAAAAAAAA////6gEABgEAAAAOAAEAAAADAAAAAgAAAAD////qAQAGAQAAAA4AAgAAAAgAAAACQMAAAP///+oBAAYBAAAADgADAAAAAwAAAAA/gAAA////6gAA//8/gAAAAPBkZAAAAAAAAAABMAAJAAAAABUAAAAB/wAAAAAAAAAAAAAAAAAAAAD////jAAD/////AAAAAAYDAAkAAAAABQAAAAAA////8wMACQAAAAARAQAAAAM/AAAAPwAAAH/AAAD////nAwAJAAAAABUCAAAABD8AAAA/AAAAQhAAAH/AAAD////jAwAJAAAAABUDAAAABD8AAAA/AAAAQhAAAH/AAAD////jAwAJAAAAAD0EAAAADj6AAAA+gAAAP0AAAD6AAAA/QAAAP0AAAD6AAAA/QAAAQEAAAEBAAAAAAAAAf8AAAAAAAAAAAAAA////uwMACQAAAACBBQAAAB8+5mZmPoAAAD9AAAA+qqqqP0AAAD8qqqs+5mZmP0AAAD6AAAA/KqqrPoAAAD6qqqoAAAAAAAAAAEBAAABAQAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////dwAAAAAAAAAAAAAAAAAABScAAAQqAAAGQP////0AAAAACDmfDwD/////AAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJGY1Y2ZkYzYzLWMwNjAtNDg0ZS1iYWMzLTdjMzQwMzYxM2UwMwAAAAA='),
  tailTitle: "Untitled71", tailW: 1066, tailH: 1600, author: "Unknown", version: 0x527, rpngFlag: 4, rpngZ2: 0xffffff00
};
function rnd(n, alphabet) { const a = new Uint8Array(n); (root.crypto || require('crypto').webcrypto).getRandomValues(a); let s = ''; for (let i = 0; i < n; i++) s += alphabet[a[i] % alphabet.length]; return s; }
const newProjectId = () => rnd(10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
const newUuid = () => { const h = rnd(32, '0123456789abcdef'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32); };
function indexOf(hay, needle, from) { outer: for (let i = from || 0; i + needle.length <= hay.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return i; } return -1; }
// make the template's footer tail describe the new project (title, original canvas size, UUID)
function patchTail(tail, from, to) {
  let t = tail.slice();
  const oldT = new Writer(32).utf(from.title).result(), at = indexOf(t, oldT);
  if (at >= 0) t = concat([t.subarray(0, at), new Writer(32).utf(to.title).result(), t.subarray(at + oldT.length)]);
  for (let i = t.length - 12; i >= 0; i--) if (u32(t, i) === 0x527 && u32(t, i + 4) === from.w && u32(t, i + 8) === from.h) { const d = dvOf(t); d.setUint32(i + 4, to.w); d.setUint32(i + 8, to.h); break; }
  let s = ''; for (let i = 0; i < t.length; i++) s += String.fromCharCode(t[i]);
  const m = /\x00\x24([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(s);
  if (m) { const base = m.index + 2; for (let i = 0; i < 36; i++) t[base + i] = to.uuid.charCodeAt(i); }
  return t;
}

// Give a copy of a project a new identity (project ID in the header and footer, UUID in the footer) so the app treats it as a separate project.
function makeIdentity() { return { id: newProjectId(), uuid: newUuid() }; }
function reidentHeader(r, ident) {
  const p = r.payload, o2 = readUtf(p, 16)[1];
  return rec(1, 1, 0, concat([p.subarray(0, 16), new Writer(16).utf(ident.id).result(), p.subarray(o2)]));
}
function reidentFooter(footer, proj, ident) {
  const from = { title: footer.title, w: proj.origW, h: proj.origH };
  return Object.assign({}, footer, { projectId: ident.id, tail: patchTail(footer.tail, from, Object.assign({ uuid: ident.uuid }, from)) });
}
const PAPER_P = () => buildP({ id: -1, flags: 1, opacity: 0.5, parent: -2147483648 });
const layerP = (id, o) => { o = o || {}; const name = o.name || ''; return { sub: name ? 3 : 2, payload: buildP({ id, flags: o.flags === undefined ? 1 : o.flags, opacity: o.opacity === undefined ? 1 : o.opacity, d: o.d === undefined ? 0x80000000 : o.d, name, parent: -5 }) }; };
const rec = (kind, type, sub, payload) => ({ kind, b1: 0, type, sub, payload });
const opRec = (q) => rec(3, 6, 0, buildOp(q));

// Shared tail of every build: image records, composite preview, footer. layers = [{id, rgba|null(unchanged), imageRec|null, p:{sub,payload}}] bottom->top
async function finishSnapshot(out, ctx) {
  const { proj, layers, T, w, h, pixelsById } = ctx;
  let nBitmaps = 0;
  for (const L of layers) {
    const payload = L.keepImage ? L.keepImage : buildImageRec(T, L.id, 1, 0x0400, ctx.rpngById.get(L.id));
    if (isRpng(parseImageRec(payload).data)) nBitmaps++;
    out.push(rec(1, 5, 0, payload));
  }
  out.push(rec(1, 5, 0, ctx.paperImage || buildImageRec(T, -1, 1, 0x0400, null)));
  const asPseudo = (L) => ({ id: L.id, kind: 'layer', visible: !!(L.p.payload[4] & 1), opacity: f32(L.p.payload, 5), blend: i32(L.p.payload, 9), parent: i32(L.p.payload, 31 + u16(L.p.payload, 21)), hasPixels: true });
  const stackForComp = ctx.compStack || layers.map(asPseudo);
  const pseudo = { canvas: { w, h }, stack: stackForComp, warnings: [] };
  const comp = await renderComposite(pseudo, { pixelsOf: async (S) => pixelsById.has(S.id) ? { width: w, height: h, data: pixelsById.get(S.id) } : decodeLayer(proj, S) });
  out.push(rec(1, 5, 0, buildImageRec(T, -1, 0, 0, await runTask('pngEncode', [w, h, comp.data]))));
  return nBitmaps;
}

// Build a brand-new project: every image becomes one layer (first image = bottom). images: [{name, data: RGBA w*h*4}]
async function buildNew(images, opt) {
  const o = Object.assign({ title: 'Untitled', embedHistory: true, nameLayers: false, tpl: TEMPLATE, now: Date.now() / 1000, onProgress: null }, opt);
  const w = o.width, h = o.height, N = images.length, T = o.now, tpl = o.tpl;
  if (!N) throw new Error('No images'); if (N > 200) throw new Error('Too many layers (limit 200)');
  images.forEach((im) => { if (im.data.length !== w * h * 4) throw new Error('Image "' + im.name + '" is not canvas sized'); });
  const log = (m, i) => o.onProgress && o.onProgress(m, i, N);
  const projectId = o.projectId || newProjectId(), uuid = o.uuid || newUuid(), out = [];
  out.push(rec(1, 1, 0, new Writer(40).f64(T).u32(w).u32(h).utf(projectId).u8(0).result()));
  const app = tpl.appInfo.slice(); dvOf(app).setFloat64(4, T + 0.05); out.push(rec(1, 2, 0, app));
  const L = (i, ex) => layerP(i, Object.assign({ name: o.nameLayers ? safeName(images[i].name.replace(/\.[^.]+$/, '')) : '' }, ex));
  const Lp = { sub: 2, payload: PAPER_P() };
  let t = T + 0.5; const step = () => (t += 0.5);
  const enc = await mapLimit(images, IPV.concurrency, async (im, i) => { const r = await runTask('encodePhoto', [w, h, own(im.data), { png: o.embedHistory, flag: tpl.rpngFlag, z2: tpl.rpngZ2 }]); log('Encoded photo ' + (i + 1), i); return r; });
  const pngs = enc.map((e) => e.png), rpngById = new Map(enc.map((e, i) => [i, e.rpng]));
  if (o.embedHistory) {
    out.push(opRec({ t: step(), op: 7, A: [], B: [0], x1: 1, x2: 0, g1: [L(0)], bg: -256, png: pngs[0], g2: [], g3: [L(0)] }));
    out.push(opRec({ t: step(), op: 6, A: [0, -1], B: [0, -1], x1: 1, x2: 1, g1: [Lp], bg: -256, g2: [L(0), Lp], g3: [L(0), Lp] }));
    for (let k = 1; k < N; k++) {
      const before = [], ids = []; for (let i = 0; i < k; i++) { before.push(L(i)); ids.push(i); }
      out.push(opRec({ t: step(), op: 10, A: [...ids, -1], B: [...ids, k, -1], x1: k + 1, x2: k, g1: [L(k, { d: 0xFFFFFFFC })], bg: -256, png: pngs[k], g2: [...before, Lp], g3: [...before, L(k, { d: 0xFFFFFFFC }), Lp] }));
    }
  } else {
    const all = []; for (let i = 0; i < N; i++) all.push(L(i));
    const ids = all.map((_, i) => i);
    out.push(opRec({ t: step(), op: 6, A: [...ids, -1], B: [...ids, -1], x1: 1, x2: 1, g1: [Lp], bg: -256, g2: [...all, Lp], g3: [...all, Lp] }));
  }
  const secs = 10 + 3 * N, Tend = step();
  out.push(rec(1, 3, 0, new Writer(16).f64(Tend).f64(secs).result()));
  const Tsave = Tend + 1, layers = [], px = new Map();
  for (let i = 0; i < N; i++) { log('Packing layer ' + (i + 1), i); px.set(i, images[i].data); layers.push({ id: i, p: L(i) }); }
  const nBitmaps = await finishSnapshot(out, { proj: null, layers, T: Tsave, tpl, seconds: secs, w, h, pixelsById: px, rpngById });
  const footer = { version: tpl.version, projectId, title: o.title, pre: new Uint8Array(16), t0: T, t1: Tsave, t2: Tsave - 0.002, seconds: secs, u16a: 0, w, h, author: tpl.author, z8: new Uint8Array(8), nBitmaps,
    layers: [...layers.map((x) => x.p), Lp], tail: patchTail(tpl.footerTail, { title: tpl.tailTitle, w: tpl.tailW, h: tpl.tailH }, { title: o.title, w, h, uuid }) };
  out.push(rec(1, 6, 0, buildFooter(footer)));
  return serializeRecords(out);
}

// Add images as new top layers of an existing project (same record sequence the app writes for "add photo as layer").
async function addLayers(baseBytes, images, opt) {
  const o = Object.assign({ embedHistory: true, nameLayers: false, now: Date.now() / 1000, onProgress: null }, opt);
  const proj = readProject(baseBytes), w = proj.canvas.w, h = proj.canvas.h, N = images.length;
  if (!N) throw new Error('No images');
  images.forEach((im) => { if (im.data.length !== w * h * 4) throw new Error('Image "' + im.name + '" is not canvas sized (' + w + 'x' + h + ')'); });
  const log = (m, i) => o.onProgress && o.onProgress(m, i, N);
  const recs = proj.records, firstImg = recs.findIndex((r) => r.kind === 1 && r.type === 5);
  if (firstImg < 0) throw new Error('The project has no saved layer images');
  const prefix = recs.slice(0, firstImg), fl = proj.footer.layers;
  if (i32(fl[fl.length - 1].payload, 0) !== -1) throw new Error('Unexpected layer order: the paper entry is not last');
  // ids already used anywhere in the file
  let maxId = 0; fl.forEach((l) => { maxId = Math.max(maxId, i32(l.payload, 0)); });
  recs.forEach((r) => { if (r.kind === 3 && r.type === 6) { try { const q = parseOp(r.payload); q.A.concat(q.B).forEach((x) => { maxId = Math.max(maxId, x); }); } catch (e) { /* ignore */ } } });
  proj.images.forEach((im) => { maxId = Math.max(maxId, im.id); });
  const lastEnd = (() => { let v = 0; recs.forEach((r) => { if (r.kind === 1 && r.type === 3) v = f64(r.payload, 8); }); return v; })();
  const T = Math.max(o.now, proj.footer.t1 + 1), out = prefix.slice(), ident = o.newIdentity ? makeIdentity() : null;
  if (ident) { const i11 = out.findIndex((r) => r.kind === 1 && r.type === 1); if (i11 >= 0) out[i11] = reidentHeader(out[i11], ident); }
  const app = recs.filter((r) => r.kind === 1 && r.type === 2).pop().payload.slice(); dvOf(app).setFloat64(4, T); out.push(rec(1, 2, 0, app));
  let state = fl.map((l) => ({ sub: l.sub, payload: l.payload })), t = T; const step = () => (t += 0.5);
  const newLayers = [], px = new Map(), rpngById = new Map();
  const refRp = proj.images.find((im) => isRpng(im.data)), refInfo = refRp ? rpngParse(refRp.data) : null;
  const encOpts = { png: o.embedHistory, flag: refInfo ? refInfo.flag : TEMPLATE.rpngFlag, z2: refInfo ? refInfo.z2 : TEMPLATE.rpngZ2 };
  const enc = await mapLimit(images, IPV.concurrency, async (im, k) => { const r = await runTask('encodePhoto', [w, h, own(im.data), encOpts]); log('Encoded photo ' + (k + 1), k); return r; });
  for (let k = 0; k < N; k++) {
    const id = maxId + 1 + k; log('Adding photo ' + (k + 1), k);
    const p = layerP(id, { name: o.nameLayers ? safeName(images[k].name.replace(/\.[^.]+$/, '')) : '' });
    const png = enc[k].png;
    if (o.embedHistory) {
      const A = state.map((s) => i32(s.payload, 0)), pos = state.length - 1, newP = layerP(id, { name: o.nameLayers ? safeName(images[k].name.replace(/\.[^.]+$/, '')) : '', d: 0xFFFFFFFC });
      const B = A.slice(0, pos).concat([id], A.slice(pos)), g3 = state.slice(0, pos).concat([newP], state.slice(pos));
      out.push(opRec({ t: step(), op: 10, A, B, x1: A.length, x2: pos, g1: [newP], bg: -256, png, g2: state, g3 }));
      state = g3.map((s) => (i32(s.payload, 0) === id ? p : s));
    } else { state = state.slice(0, state.length - 1).concat([p], state.slice(-1)); }
    newLayers.push({ id, p }); px.set(id, images[k].data); rpngById.set(id, enc[k].rpng);
  }
  const secs = lastEnd + 3 + 2 * N, Tend = step();
  out.push(rec(1, 3, 0, new Writer(16).f64(Tend).f64(secs).result()));
  const Tsave = Tend + 1;
  // snapshot images: untouched old layer images, then the new ones, then paper + fresh preview
  const layers = [], oldById = new Map(proj.images.filter((im) => im.kind === 1).map((im) => [im.id, im]));
  proj.stack.forEach((S) => { if (S.kind === 'folder') return; layers.push({ id: S.id, p: { sub: S.sub, payload: S.raw }, keepImage: oldById.get(S.id).rec.payload, srcLayer: S }); });
  newLayers.forEach((nl) => layers.push({ id: nl.id, p: nl.p }));
  const paperRec = oldById.get(-1) ? oldById.get(-1).rec.payload : null;
  const compStack = proj.stack.concat(newLayers.map((nl) => ({ id: nl.id, kind: 'layer', visible: true, opacity: 1, blend: 0, parent: -5, hasPixels: true })));
  const nBitmaps = await finishSnapshot(out, { proj, layers, T: Tsave, w, h, pixelsById: px, compStack, rpngById, paperImage: paperRec });
  const f = proj.footer;
  let footer = Object.assign({}, f, { t1: Tsave, t2: Tsave - 0.002, seconds: Math.floor(secs), nBitmaps, layers: state.map((s) => ({ sub: s.sub, payload: s.payload })) });
  if (ident) footer = reidentFooter(footer, proj, ident);
  out.push(rec(1, 6, 0, buildFooter(footer)));
  return serializeRecords(out);
}

// Replace the pixels of existing layers (snapshot only; the edit history is left untouched). replacements: Map(layerId -> RGBA w*h*4)
async function replaceLayers(baseBytes, replacements, opt) {
  const proj = readProject(baseBytes), w = proj.canvas.w, h = proj.canvas.h;
  const out = []; let nBitmaps = 0; const ident = opt && opt.newIdentity ? makeIdentity() : null;
  const pix = new Map(replacements), encoded = new Map(), oldById = new Map(proj.images.filter((im) => im.kind === 1).map((im) => [im.id, im]));
  await mapLimit([...pix.keys()], IPV.concurrency, async (id) => {
    const im = oldById.get(id), old = im && isRpng(im.data) ? rpngParse(im.data) : null;
    const r = await runTask('encodePhoto', [w, h, own(pix.get(id)), { png: false, flag: old ? old.flag : TEMPLATE.rpngFlag, z2: old ? old.z2 : TEMPLATE.rpngZ2 }]);
    encoded.set(id, r.rpng);
  });
  const spec = { w, h, stack: proj.stack.map((L) => ({ id: L.id, kind: L.kind, visible: L.visible, opacity: L.opacity, blend: L.blend, parent: L.parent,
    rpng: pix.has(L.id) ? (encoded.get(L.id) ? own(encoded.get(L.id)) : null) : (L.hasPixels ? own(L.image.data) : null) })) };
  const flat = await runTask('flatten', [spec, { includeHidden: false, raw: false }]);
  for (const r of proj.records) {
    if (r.kind === 1 && r.type === 5) {
      const im = parseImageRec(r.payload);
      if (im.kind === 1 && pix.has(im.id)) { const rp = encoded.get(im.id); out.push(rec(1, 5, 0, buildImageRec(im.t, im.id, 1, im.c, rp))); if (rp) nBitmaps++; }
      else if (im.kind === 0) out.push(rec(1, 5, 0, buildImageRec(im.t, -1, 0, im.c, flat.png)));
      else { out.push(r); if (isRpng(im.data)) nBitmaps++; }
    } else if (r.kind === 1 && r.type === 6) {
      let ft = Object.assign({}, proj.footer, { nBitmaps }); if (ident) ft = reidentFooter(ft, proj, ident);
      out.push(rec(1, 6, 0, buildFooter(ft)));
    } else if (ident && r.kind === 1 && r.type === 1) out.push(reidentHeader(r, ident));
    else out.push(r);
  }
  return serializeRecords(out);
}

Object.assign(IPV, { parseRecords, serializeRecords, recordBytes, readProject, decodeLayer, renderComposite, extractFiles, zipStore, pngDecode, pngEncode, rpngParse, rpngDecode, rpngEncode,
  parseP, buildP, parseOp, buildOp, parseFooter, buildFooter, buildNew, addLayers, replaceLayers, flatten, runTask, mapLimit, own, TEMPLATE, crc32, safeName, util: { Writer, concat, u16, u32, i32, f32, f64, isPng, isRpng } });
if (typeof module !== 'undefined' && module.exports) module.exports = IPV; else root.IPV = IPV;
})(typeof globalThis !== 'undefined' ? globalThis : this);
