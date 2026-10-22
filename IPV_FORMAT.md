# ibisPaint X `.ipv` file format – reverse-engineering notes

Based on two sample files made with **ibisPaint X ver.13.1.12** (Android, realme RMX1971):
`Untitled221.ipv` (107 KB, 59 records, 1 layer) and `Untitled71.ipv` (9.6 MB, 4515 records, 14 layers, 16 sessions).
The code in `ipv-core.js` implements everything marked ✅.

**Legend** ✅ verified by tests (details at the end) · 🟡 working guess that fits all data · ❓ unknown

All numbers are **big-endian** (Java `DataOutputStream` style). Times are `f64` seconds since 1970. A *UTF string* is `u16 length + UTF-8 bytes`.

---

## 1. Container ✅

The file is a flat list of records. Records also nest inside payloads.

```
[kind u8][0 u8][type u8][sub u8][payload length u32][payload ...][-(8+length) i32]
```

The trailing negative length lets a reader walk backwards. Both files parse to the last byte, and rebuilding every record gives a byte-identical file.

## 2. Typical file layout ✅

```
(1,1) canvas info               once
(1,2) app info                  one per editing session
   ... history of the session: (3,6) layer operations, (2,x)/(3,x) tool and stroke events, (4,15) stroke snapshots ...
(1,3) session end               one per session
(1,9) ...                       only seen in the small file
(1,5) layer images              one per layer, then the paper, then the flattened preview
(1,6) footer                    the final layer stack + settings (always last)
```

The loader almost certainly restores the document from the last block `(1,5)* + (1,6)`. The history before it is what the app replays for the drawing video / undo (🟡 – not testable without the app).

## 3. Record catalogue

| (kind,type) | Meaning | Status |
|---|---|---|
| (1,1) | Canvas info: `f64 t, u32 w, u32 h, UTF projectId, u8 0`. **w×h is the size at creation** | ✅ |
| (1,2) | App info: `u32 0x00010527, f64 t, UTF "ibisPaint X", UTF "ver.13.1.12", UTF device, 32 bytes` (the 32 bytes were identical everywhere; copied verbatim) | ✅ |
| (1,3) | Session end: `f64 t, f64 total active drawing seconds so far` (cumulative; the footer stores its integer part) | ✅ |
| (1,5) | Layer image, see §6 | ✅ |
| (1,6) | Footer, see §7 | ✅ |
| (1,9) | Small file only: two committed-stroke wrappers (see 4,15) plus glue | 🟡 |
| (2,1) | View change (pan/zoom): `f64 t, f32 x, f32 y, f32 zoom, f64 t2, f32 x, f32 y, f32 zoom, 12 bytes` | 🟡 |
| (2,2) | Tool change: `f64 t, i32 from, i32 to, u8 1` | 🟡 |
| (2,3) | Pen stroke: `f64 t0, f64 t1, 8 bytes, 3×u32, u32 n`, then *n* nested points `(2,3,sub 1)`: `f64 t, f32 x, f32 y` (canvas coordinates), then a 292/305-byte brush record `(1,2,sub 2)` and a 30-byte record `(2,3,sub 3)`. No pressure is stored | ✅ points · 🟡 rest |
| (2,5), (2,9) | Other gesture / tool records (a single point; two floats 100.0 and 50.0) | ❓ |
| (2,6) | Pen settings: `f64 t, 4 bytes, f32 10.0, f32 60.0` | 🟡 |
| (2,11) | Canvas crop/resize: old size `u32 w,h`, new size (as `u16` pairs), crop offset `u32 x,y` | 🟡 |
| (3,1) | Brush settings = the 292-byte brush record: brush id (twice), size `f32` at +12, many float parameters, a per-stroke value at +192 | 🟡 |
| (3,3) | Colour palette: list of `(3,3,sub 1)` records `u8 1, R, G, B, A` | 🟡 |
| (3,4) | Layer property snapshot: `f64 t, u8 flag (1/0), u32 1, u32 n, n × layer record` | ✅ shape |
| (3,5) | Layer attribute change: contains three `1.0f` at 5-float spacing (an identity matrix?) and sometimes a nested layer record | ❓ |
| (3,6) | **Layer list operation**, see §4 | ✅ |
| (4,15) | Compressed stroke snapshot: `…, u32 1, u32 len, raw DEFLATE`. Inflated data = one record `(4,14,3)` whose payload starts `u32 strokeNo, 4 bytes, f32 originX, f32 originY, …, f32 size at +44, u32 ARGB colour at +56`, followed by a nested stroke `(2,3)` whose points are **relative to the origin** | ✅ points · 🟡 size/colour offsets (matched one file) |

## 4. Layer operation `(3,6)` ✅

All 82 records in both samples (including two that carry whole photos) rebuild byte-identically from this grammar:

```
f64 t | u32 op
u32 nA, nA × rec(3,6,3){i32 id}                 layer ids before   (bottom → top, the paper -1 last)
u32 nB, nB × rec(3,6,3){i32 id}                 layer ids after
u32 x1 | u32 x2 | u32 n1, n1 × layer record     x1 = |A|, x2 = insert index for "add" ops
i32 bg (= 0xFFFFFF00) | u32 pngLen | PNG        PNG only for photo ops, else pngLen = 0
u32 6 | f32 1.0 | u32 0 | u32 0 | u32 0         (20 fixed bytes)
u32 n2, n2 × layer record                       state of layers in A
u32 n3, n3 × layer record                       state of layers in B
16 bytes: 80000000 80000000 00000000 80000000
```

Operation codes seen: `0` move layer · `1` add empty layer · `2` (once, insert) · `4`, `5` delete layer · `6` set paper / initial list · `7` **first photo of a new canvas** · `10` **add photo as a new layer** (embeds the photo as a canvas-sized PNG). Ops 7 and 10 are exactly what the tool writes for each photo; the generated ops 7 and 6 are field-for-field identical to the app's own.

## 5. Layer record `(3,4,sub 2|3)` ✅ (47 bytes with an empty name)

| Field | Meaning | Status |
|---|---|---|
| `i32 id` | unique layer id, paper = -1 | ✅ |
| `u8 flags` | bit 0 = visible. Also seen: 3, 0x21 | ✅ bit 0 · ❓ rest |
| `f32 opacity` | 0..1 (paper stores 0.5, no visible effect) | ✅ |
| `i32 blend` | 0 = normal. Seen in history: 1, 2, 9, 13, 16, 17 (names unknown) | ✅ 0 · ❓ others |
| `i32 -1` | constant | |
| `u32 d` | 0x80000000 normally, 0xFFFFFFFC for a layer just created, 6 on one layer | ❓ |
| `UTF name` | empty unless the user renamed the layer; then `sub` = 3 | ✅ |
| `i32 -1, i32 0` | constants | |
| `i32 parent` | -5 = top level, otherwise the id of the folder that contains it; paper 0x80000000 | ✅ |
| `i32 0, u32 0x80000000, i32 -1` | constants | |

A **folder** is a layer record with no image record; its children carry its id in `parent`. Folders are shown above their children in the bottom→top list.

## 6. Layer images `(1,5)` and RPNG bitmaps ✅

```
f64 t | i32 layerId (-1 = paper / whole canvas) | i32 kind (1 layer, 0 flattened preview) | u16 (0x0400 for layers, 0 for preview) | u32 len | data
```

* Empty layers and the paper have `len = 0`. The record with `kind 0` holds a normal PNG (the flattened preview, opaque RGBA, canvas size).
* A layer with pixels holds an **RPNG** block:

```
"RPNG" | u32 45 | u32 0
header (45 bytes): u8 flag, then 11 × u32:
   canvasW, canvasH, boxW, boxH, boxX, boxYFromBottom, pngW, pngH, pad, z2, indexBytes
run index: indexBytes/4 entries of (u16 gap, u16 run)
u32 pngLen | PNG (8-bit RGBA)
```

* The box is the bounding box of the non-transparent pixels. Scan it **bottom row first, left to right, as one long line** (rows are not separated).
* Each entry skips `gap` empty cells, then `run` pixels follow. Gaps/runs above 65535 are split: `(65535,0)` for gaps (seen in the app's data), `(gap,65535)` then `(0,…)` for runs (my choice). The last entry carries the trailing gap and `run = 0`.
* The PNG holds only those pixels, in scan order, in rows of `pngW`; **its rows are stored bottom-up**. `pngW = ceil(sqrt(count)/8)·8`, `pngH = ceil(count/pngW)`, `pad = pngW·pngH − count` zero pixels at the end of the last data row.
* Pixels are **straight (not premultiplied) RGBA**. `flag`/`z2` were 4 / 0xFFFFFF00 in the photo file and 0 / 0 in the other (🟡 per-file settings; copied from the source file).

## 7. Footer `(1,6)` ✅

```
u32 0x527 | UTF projectId | UTF title | 16 zero bytes | f64 created | f64 saved | f64 saved−0.002
u64 total seconds | u16 0 | u32 w | u32 h  (CURRENT canvas size) | UTF "Unknown" | 8 zero bytes
u16 number of non-empty layer images | u32 number of layer records
layer records (§5) – the FINAL layer stack, bottom → top, paper last
opaque tail (≈ 700 bytes): tool settings, the title again, the creation size u32 0x527,w,h, a UUID (UTF, 36 chars)
```

The project id occurs only in `(1,1)` and here; the UUID only here.

## 8. Stack order and compositing ✅

Layer order is **bottom → top**; the paper entry is a sentinel at the end of the list. Rendering visible layers with straight-alpha "normal" blending, hidden layers skipped, opacity applied and folders composited as groups, over white, reproduces the app's saved preview: **0 / 255 difference on file 1, ≤ 1 / 255 on file 2**. Other blend modes are drawn as normal by the tool (flagged in the manifest).

## 9. What the tool writes

* **Extract**: every layer (full size and cropped), the flattened picture, the app's preview, the photos stored in history, `manifest.json`.
* **Add photos to a project**: keeps all old history records and layer images byte-for-byte, appends a new session with one op 10 per photo, new `(1,5)` images, a new preview and an updated footer. IDs: highest used id + 1.
* **New project**: `(1,1)`, `(1,2)`, op 7 for the first photo, op 6, op 10 for the others, `(1,3)`, images, footer. Settings bytes come from the sample file.
* **Replace layer pixels**: swaps the RPNG data and the preview; the history is untouched.
* Optional "separate copy" gives the copy a new project id and UUID.

## 10. Evidence (all re-run on every change)

* Byte-exact rebuild of both files; every footer and (3,6) record rebuilt identically; 1393 layer records regenerated identically from parsed fields.
* All 12 real layer bitmaps decode pixel-identically in two independent implementations (Python and JavaScript); decode → encode → decode gives the same header, run index and pixels.
* Generated files (new / add / replace, with and without history) were re-read by independent Python code: framing, grammar, footer counts, layer order, pixel equality, preview vs. independent compositing, embedded photos equal to the inputs, untouched history and layer images identical to the original.
* The page was exercised in headless Chromium (open, ZIP export, single downloads, photo import with several options, add to both sample files, replace by name/position).

**Opening generated files in ibisPaint X:** reported working by the owner of the sample files (one device, one app version). Not independently verified here.

## 11. Still unknown – and the small test files that would settle it

Make each file with the smallest possible edit (new canvas, one change, save as `.ipv`):

1. Blank canvas saved at once (baseline) · the same canvas with one photo imported.
2. One layer **renamed** · one layer **hidden** · one layer with **opacity 50 %** · **alpha lock** on · **clipping** on · **locked** layer (one setting per file → decodes `flags`, `d`).
3. One file with a layer for **every blend mode** in the order of the app's list (write the order down → decodes `blend`).
4. A **folder** with two layers · a renamed folder · a folder inside a folder.
5. A **text** layer · a layer with a **filter/effect** · a **selection** active when saving.
6. Paper colour changed / paper hidden · canvas rotated · canvas created with a transparent background.
7. Any file that the app refuses after editing with this tool (tell me the exact message).
