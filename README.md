# IPV Layer Tool

Extract layers and pictures from **ibisPaint X `.ipv`** files, and put many photos back in as layers.
Runs completely in the browser – no server, nothing is uploaded.

* **Extract** – one ZIP with every layer as PNG (full size or cropped), the flattened picture, the preview saved by the app, the original photos stored in the history, and a `manifest.json`.
* **Import photos** – every photo becomes its own layer, added to an opened project or in a new project. Options for canvas size, fit, order and file size.
* **Put edited layers back** – upload edited layer PNGs (matched to layers by the number in the file name).

Live page: `https://<your-user-name>.github.io/<repository-name>/`

## Put it on GitHub Pages

The site is plain static files, nothing to build.

1. On github.com press **+ → New repository**, give it a name (for example `ipv-layer-tool`), keep it **Public**, press **Create repository**.
2. Press **uploading an existing file**, select **all files of this folder** (`index.html`, `style.css`, `app.js`, `ipv-core.js`, `worker.js`, `format.html`, `favicon.svg`, `README.md`; `IPV_FORMAT.md` is optional) and press **Commit changes**.
3. Open **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, press **Save**.
4. After about a minute the page is live at the address shown on that screen.

With git instead:

```
git init && git add . && git commit -m "IPV Layer Tool"
git branch -M main && git remote add origin https://github.com/<user>/<repo>.git && git push -u origin main
```

**Updating:** browsers and GitHub cache files for a few minutes. After you change a file, bump `?v=1` to `?v=2` in `index.html`, `app.js` (the `worker.js?v=1` line) and `worker.js` (the `importScripts` line).

The tool also works when you simply open `index.html` from your phone or computer; only the background workers are switched off there (see below).

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css` | the page |
| `app.js` | user interface |
| `ipv-core.js` | the engine: reads and writes `.ipv`, PNG and layer-bitmap codecs, ZIP writer, compositing. No dependencies; works in browsers and Node 18+ |
| `worker.js` | runs the heavy image jobs in Web Workers |
| `format.html`, `IPV_FORMAT.md` | notes on the file format (page and source) |

## Speed

* The slow part of saving an image is compression, which the browser already does in native code. The tool's own pixel loops were rewritten to be about twice as fast (6 photos of 2048×1536: 13.3 s → 7.1 s on one core).
* Independent jobs (one per photo or layer) run in **up to 4 Web Workers** at the same time and the page stays responsive. Workers need the page to be served over `http(s)` – GitHub Pages does that. Opened from disk, the tool falls back to one thread automatically.
* Large photos are scaled to a canvas of at most 2048 px on the long side by default, which keeps phones from running out of memory.

## Use the engine in your own page

```html
<script src="ipv-core.js"></script>
<script>
  const proj = IPV.readProject(new Uint8Array(await file.arrayBuffer()));   // layers, canvas, title
  const files = await IPV.extractFiles(proj, { layers: true, flattened: true });
  const zip = IPV.zipStore(files);
  const newIpv = await IPV.addLayers(bytes, [{ name: 'a.jpg', data: rgbaCanvasSized }]);
</script>
```

## Notes

* Unofficial tool, not affiliated with ibis Inc. “ibisPaint” is a trademark of ibis Inc. Only use it with your own files.
* The file format was reverse-engineered from sample files made with ibisPaint X 13.1.12. Other versions may differ; see `IPV_FORMAT.md` for what is known and what is not.
* Choose a license for your repository before you publish it (GitHub: *Add file → Create new file → name it `LICENSE`* offers templates).
