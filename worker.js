// Background worker: runs the heavy image jobs from ipv-core.js so the page stays responsive and several jobs can run at once.
'use strict';
importScripts('ipv-core.js?v=1');
function buffers(x, out) {
  if (!x) return out;
  if (ArrayBuffer.isView(x)) { if (!out.includes(x.buffer)) out.push(x.buffer); }
  else if (typeof x === 'object') for (const k of Object.keys(x)) buffers(x[k], out);
  return out;
}
onmessage = async (e) => {
  const { name, args } = e.data;
  try { const res = await IPV.tasks[name](...args); postMessage({ ok: true, res }, buffers(res, [])); }
  catch (err) { postMessage({ ok: false, err: String((err && err.message) || err) }); }
};
