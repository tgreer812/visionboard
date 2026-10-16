// Uploading dropped / pasted / picked files. Each file shows a local placeholder with progress;
// it joins the shared board only once the server has stored it.
import { ctx, maxZ, r1 } from './ctx.js';
import { classify, formatBytes, KINDS } from '../shared/mediaTypes.js';
import { addItem } from './actions.js';
import { setSelection } from './items.js';
import { setPresence } from './presence.js';
import { toast } from './ui.js';
import { ICON } from './icons.js';

const inFlight = new Map(); // token -> fraction done

function reportActivity() {
  if (!inFlight.size) return setPresence({ act: null });
  let sum = 0;
  for (const f of inFlight.values()) sum += f;
  setPresence({ act: { t: 'upload', n: inFlight.size, pct: sum / inFlight.size } });
}

/** Clipboard images often arrive as "image.png" or with no name at all. */
function describe(file) {
  let info = classify(file.name);
  let name = file.name;
  if (!info && file.type) {
    for (const [kind, def] of Object.entries(KINDS)) {
      const ext = Object.keys(def.exts).find((e) => def.exts[e] === file.type);
      if (ext) { info = { kind, ext, mime: file.type, max: def.max }; break; }
    }
  }
  if (!info) return null;
  if (!name || !/\.[a-z0-9]+$/i.test(name) || name === 'image.png') {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    name = `pasted-${stamp}.${info.ext}`;
  }
  return { ...info, name };
}

function measure(url, kind) {
  return new Promise((resolve) => {
    const done = (w, h) => resolve(w > 0 && h > 0 ? { w, h } : { w: 480, h: 320 });
    const timer = setTimeout(() => done(), 6000);
    const finish = (w, h) => { clearTimeout(timer); done(w, h); };
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => finish(img.naturalWidth, img.naturalHeight);
      img.onerror = () => finish();
      img.src = url;
    } else {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => finish(v.videoWidth, v.videoHeight);
      v.onerror = () => finish();
      v.src = url;
    }
  });
}

function put(file, name, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/rooms/${ctx.room}/media?name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.src) resolve(body);
      else reject(new Error((body && body.error) || `The server said ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new Error('The connection dropped.'));
    xhr.send(file);
  });
}

function placeholder(kind, url, x, y, w, h, name) {
  const el = document.createElement('div');
  el.className = `item ${kind} pending`;
  el.style.transform = `translate(${x}px, ${y}px)`;
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.zIndex = String(maxZ() + 1);
  if (kind === 'image') { const i = new Image(); i.src = url; el.append(i); }
  else if (kind === 'video') { const v = document.createElement('video'); v.muted = true; v.src = url; el.append(v); }
  else {
    const c = document.createElement('div');
    c.className = 'card';
    c.style.cssText = 'display:grid;place-items:center;gap:6px;color:var(--muted);font-size:13px;padding:12px;text-align:center';
    c.innerHTML = `<div style="width:28px;height:28px;color:var(--accent)">${kind === 'audio' ? ICON.music : ICON.cube}</div><div></div>`;
    c.lastChild.textContent = name;
    el.append(c);
  }
  const bar = document.createElement('div');
  bar.className = 'upload-bar';
  bar.innerHTML = '<b></b>';
  el.append(bar);
  ctx.world.append(el);
  return { el, progress: (f) => { bar.firstChild.style.width = Math.round(f * 100) + '%'; } };
}

async function uploadOne(file, info, at, size) {
  const { kind, name } = info;
  const url = kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null;
  const s = ctx.view.s;
  let w, h;
  if (kind === 'audio') { w = 340 / s; h = 92 / s; }
  else if (kind === 'model') { w = 360 / s; h = 320 / s; }
  else {
    const nat = size || await measure(url, kind);
    const k = Math.min(1 / s, (440 / s) / Math.max(nat.w, nat.h));
    w = nat.w * k; h = nat.h * k;
  }
  w = r1(w); h = r1(h);
  const x = r1(at.x), y = r1(at.y);
  const ph = placeholder(kind, url, x, y, w, h, name);
  const token = {};
  inFlight.set(token, 0);
  reportActivity();
  try {
    const res = await put(file, name, (f) => { ph.progress(f); inFlight.set(token, f); reportActivity(); });
    const id = addItem({ kind, x, y, w, h, z: maxZ() + 1, src: res.src, name, mime: res.mime, size: res.size, ext: info.ext });
    return id;
  } catch (e) {
    toast(`${name} didn't upload: ${e.message}`);
    return null;
  } finally {
    ph.el.remove();
    if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
    inFlight.delete(token);
    reportActivity();
  }
}

/** Upload files and lay them out left to right from `at` (world coords). */
export async function uploadFiles(files, at) {
  const accepted = [];
  for (const file of files) {
    const info = describe(file);
    if (!info) { toast(`${file.name || 'That file'} isn't a supported type. Try images, video, audio (mp3, wav, ogg, m4a, flac) or 3D models (glb, gltf, obj, stl, fbx, ply).`, 6000); continue; }
    if (file.size > info.max) { toast(`${info.name} is ${formatBytes(file.size)}. ${KINDS[info.kind].label} files can be up to ${formatBytes(info.max)}.`, 6000); continue; }
    if (!file.size) { toast(`${info.name} is empty.`); continue; }
    accepted.push({ file, info });
  }
  if (!accepted.length) return;
  const gap = 20 / ctx.view.s;
  let x = at.x, rowY = at.y, rowH = 0, col = 0;
  const jobs = [];
  for (const { file, info } of accepted) {
    let size = null, w, h;
    if (info.kind === 'image' || info.kind === 'video') {
      const url = URL.createObjectURL(file);
      const nat = await measure(url, info.kind);
      URL.revokeObjectURL(url);
      const k = Math.min(1 / ctx.view.s, (440 / ctx.view.s) / Math.max(nat.w, nat.h));
      size = nat;
      w = nat.w * k; h = nat.h * k;
    } else {
      w = (info.kind === 'audio' ? 340 : 360) / ctx.view.s;
      h = (info.kind === 'audio' ? 92 : 320) / ctx.view.s;
    }
    if (col === 4) { col = 0; x = at.x; rowY += rowH + gap; rowH = 0; }
    jobs.push(uploadOne(file, info, { x, y: rowY }, size));
    x += w + gap; rowH = Math.max(rowH, h); col++;
  }
  const ids = (await Promise.all(jobs)).filter(Boolean);
  if (ids.length) setSelection(ids);
}
