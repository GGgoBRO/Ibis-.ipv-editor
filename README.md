# IPV Layer Tool

**Take layers and pictures out of ibisPaint X `.ipv` files, and put photos back in as layers. All in your browser.**

[![Live site](https://img.shields.io/badge/live%20site-open-2f6fed)](https://gggobro.github.io/Ibis-.ipv-editor/)
![No upload](https://img.shields.io/badge/uploads-none-2ea44f)
![Dependencies](https://img.shields.io/badge/dependencies-none-2ea44f)

### [Open the tool → gggobro.github.io/Ibis-.ipv-editor](https://gggobro.github.io/Ibis-.ipv-editor/)

No install, no account, no server. Your files are processed on your device and never uploaded.

---

## Features

### Extract
- Download **every layer as a PNG**: full canvas size with a transparent background, or **cropped** to just the pixels (position is written in the file name).
- Get the **flattened picture** (all visible layers together) as PNG or JPG.
- Get the **preview image saved by the app**.
- Recover the **original photos** stored in the project history.
- Optionally include **hidden layers**.
- A `manifest.json` lists every layer: order, id, name, visibility, opacity, blend mode, parent folder and bounding box.
- Everything comes in **one ZIP**, or save a single layer straight from the layer list (with thumbnails).

### Import photos as layers
- Every photo becomes **its own layer**. The first photo is the bottom layer.
- Two modes: **add to an opened project** (keeps your layers and drawing history, photos go on top) or **make a new project**.
- Pick many photos at once, **reorder** them with ↑ / ↓, remove single ones, or sort by file name (natural order: 1, 2, 10) or reverse.
- **Canvas size**: same as the first photo, same as the largest, or custom. Largest-side cap of 1024 / 1600 / **2048 (default)** / 3000 / 4096 px, or no limit.
- **Fit**: whole photo visible, fill the canvas (edges cut), stretch, or original size centered.
- Phone photos keep their rotation (EXIF orientation is applied).
- A PNG that already matches the canvas size is written pixel for pixel, with no resampling.

### Put edited layers back
- Edit the exported layer PNGs in any editor, upload them again and the tool **swaps the pixels in the project**.
- Files are matched to layers by the number in the name (`03_layer25.png` → layer 25). Cropped files with `_x120_y340` in the name are placed at that position.
- The drawing history is left untouched.

### Under the hood
- Runs in **up to 4 Web Workers**, so the page stays responsive and several photos or layers are processed at the same time. Falls back to one thread if workers are unavailable.
- Pure JavaScript, **zero dependencies**. The engine (`ipv-core.js`) also runs in **Node 18+**.
- Light and dark theme, mobile friendly.
- Warns before a job that needs a lot of memory.

---

## How to use

1. **Open an .ipv file** (step 1). You see title, canvas size, layer count, app version and history size, plus a thumbnail for each layer.
2. **Extract pictures** (step 2, appears after opening a file). Tick what you want and press **Download ZIP**, or use **Flattened PNG / JPG**.
3. **Put photos in as layers** (step 3). Choose the mode, add photos, set size / fit / order and press **Build .ipv and download**.
   You can skip step 1 and go straight here to make a new project from photos.
4. **Put edited layer pictures back** (step 4, appears after opening a file). Choose the edited PNGs and press **Replace and download .ipv**.

Then copy the resulting `.ipv` to your phone and open it in ibisPaint X.

> **Tip:** keep the original `.ipv` somewhere safe. The tool never changes your original, it always downloads a new file, but a backup costs nothing.

### Output file names

| Action | File |
|---|---|
| Extract ZIP | `<project>_extract.zip` |
| Single layer | `<project>_layer<id>.png` or `<project>_layer<id>_x<X>_y<Y>.png` (cropped) |
| Flattened | `<project>_flattened.png` / `.jpg` |
| Add photos | `<project>_plus_photos.ipv` |
| New project | `<project name>.ipv` |
| Replace layers | `<project>_edited.ipv` |

### ZIP contents

```
<project>_extract.zip
├── layers/                  full-size PNG per layer, e.g. 03_layer25.png
├── layers_trimmed/          cropped PNG per layer, e.g. 03_layer25_x120_y340.png
├── flattened.png
├── preview_saved_by_app.png
├── originals/               imported_photo_01.png, ...
└── manifest.json
```

Each part is optional. File names start with the layer's position (bottom to top) and include the layer name if you gave it one.

### Import options

| Option | What it does |
|---|---|
| Mode | Add to the opened project, or make a new project |
| Project name | Title of a new project |
| Canvas size | First photo / largest photo / custom (16–8192 px per side) |
| Largest side | Scales big photos down so a phone does not run out of memory (default 2048 px) |
| Fit | `contain`, `cover`, `stretch`, `center` |
| Order | As listed, by file name, reversed |
| Also store the photos in the history | Mirrors what the app does on import. File gets about twice as big. Turn off for a smaller file |
| Save as a separate copy (new project ID) | Recommended, so the app does not confuse the new file with your original project |
| Use file names as layer names *(experimental)* | If the app refuses the file, build again with this off |

---

## Compatibility and limits

- **Tested with ibisPaint X 13.1.12.** The format was reverse-engineered from sample files of that version, so other versions may behave differently. Generated files were reported to open in the app on one device and one app version; this is not independently verified.
- **Blend modes** other than Normal are not reproduced in the flattened picture (they are drawn as Normal, and a note is added to the manifest). Individual layer PNGs are not affected.
- **HEIC photos** are not readable by most browsers. Convert them to JPG or PNG first.
- **Very large canvases** need a lot of RAM. Keep the 2048 px cap on phones.
- Needs a current Chrome, Edge, Firefox or Safari (uses `CompressionStream` / `DecompressionStream`).
- Text layers, filter layers, selections and some layer flags are not fully decoded yet. See [IPV_FORMAT.md](IPV_FORMAT.md), section 11, for what is unknown.

---

## Privacy

Nothing is uploaded and nothing is sent to any server. The page reads your files locally, builds the result in memory and hands it to your browser as a download. You can check this in the source: there are no network calls apart from loading the page's own files.

---

## Run it yourself

It is a plain static site, nothing to build.

**Locally**

```bash
git clone https://github.com/gggobro/Ibis-.ipv-editor.git
cd Ibis-.ipv-editor
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly from disk also works, but Web Workers are switched off there, so it runs on one thread.

**On GitHub Pages**

1. Push the files to a repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`.
3. After about a minute the site is live.

**Updating:** browsers and GitHub cache files for a few minutes. After you change a file, bump `?v=1` to `?v=2` in `index.html`, in `app.js` (the `worker.js?v=1` line) and in `worker.js` (the `importScripts` line).

---

## Project structure

| File | What it is |
|---|---|
| `index.html`, `style.css` | The page |
| `app.js` | User interface |
| `ipv-core.js` | The engine: reads and writes `.ipv`, PNG and layer-bitmap codecs, ZIP writer, compositing. No dependencies, runs in browsers and Node 18+ |
| `worker.js` | Runs the heavy image jobs in Web Workers |
| `format.html`, `IPV_FORMAT.md` | Notes on the file format (page and source) |
| `favicon.svg` | Icon |

---

## Use the engine in your own code

Image data is **straight (not premultiplied) RGBA**, `width × height × 4` bytes, already at canvas size.

**Node 18+**

```js
const fs = require('fs');
const IPV = require('./ipv-core.js');

(async () => {
  const bytes = new Uint8Array(fs.readFileSync('drawing.ipv'));
  const proj  = IPV.readProject(bytes);                 // canvas, title, layer stack, history info

  // extract: layers + flattened picture + manifest
  const files = await IPV.extractFiles(proj, { layers: true, flattened: true, manifest: true });
  fs.writeFileSync('extract.zip', IPV.zipStore(files));

  // add a photo as a new layer (rgba = Uint8Array of proj.canvas.w * proj.canvas.h * 4)
  const withPhoto = await IPV.addLayers(bytes, [{ name: 'photo.jpg', data: rgba }], {});
  fs.writeFileSync('drawing_plus_photos.ipv', withPhoto);

  // new project from photos
  const fresh = await IPV.buildNew([{ name: 'a', data: rgbaA }, { name: 'b', data: rgbaB }],
                                   { width: 1080, height: 1920, title: 'Photos' });

  // replace pixels of layers: Map(layerId -> RGBA)
  const edited = await IPV.replaceLayers(bytes, new Map([[25, rgba25]]), {});
})();
```

**Browser**

```html
<script src="ipv-core.js"></script>
<script>
  document.querySelector('input').onchange = async (e) => {
    const bytes = new Uint8Array(await e.target.files[0].arrayBuffer());
    const proj  = IPV.readProject(bytes);
    const zip   = IPV.zipStore(await IPV.extractFiles(proj, { layers: true, flattened: true }));
    // download `zip` as a Blob
  };
</script>
```

Options accepted by `addLayers` / `buildNew` / `replaceLayers`: `embedHistory`, `nameLayers`, `newIdentity`, `onProgress`.

---

## File format

The `.ipv` format is not documented by its maker. Everything the tool knows is written down in [IPV_FORMAT.md](IPV_FORMAT.md) (also as a [web page](https://gggobro.github.io/Ibis-.ipv-editor/format.html)): the record container, layer operations, layer records, the RPNG layer bitmap, the footer and how compositing is reproduced, each part marked verified, guess or unknown.

## Help wanted

Files from other app versions are the fastest way to make this better. The "Still unknown" list in `IPV_FORMAT.md` (section 11) describes small test files that would settle open questions: renamed / hidden / 50 % opacity layers, one layer per blend mode, folders, text layers, and any file the app refuses after editing with this tool (please include the exact message).

---

## Disclaimer

Unofficial tool, not affiliated with ibis Inc. "ibisPaint" is a trademark of ibis Inc. Only use it with your own files.
