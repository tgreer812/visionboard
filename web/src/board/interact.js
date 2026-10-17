// Pointer, wheel, keyboard, clipboard and drag-and-drop handling for the board.
import { ctx, geom, LOCAL, r1, emit } from './ctx.js';
import { applyView, toWorld, zoomAt, clampS, screenCenterWorld, fitBox } from './view.js';
import { renderItem, setSelection, itemBox } from './items.js';
import { raise, setManyFields, deleteItems, duplicateItems } from './actions.js';
import { startEdit, endEdit, isEditing, createNote } from './text.js';
import { setPresence, sendCursor } from './presence.js';
import { uploadFiles } from './upload.js';
import { fitAll, toast, downloadSelection } from './ui.js';

const pointers = new Map();
let g = null;          // the gesture in progress
let space = false;
let lastPointerAt = 0;
let pasteTimer = 0;

const isTyping = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function pointerOrCenter() {
  if (ctx.pointer && Date.now() - lastPointerAt < 60000) return ctx.pointer;
  return screenCenterWorld();
}

function startPan(e) {
  g = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: ctx.view.x, vy: ctx.view.y };
  ctx.stage.classList.add('panning');
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  g = {
    type: 'pinch',
    d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    v0: { ...ctx.view },
  };
}

function onDown(e) {
  if (e.target.closest('[data-nodrag]')) return;
  if (e.button === 2) return;
  if (isEditing()) endEdit();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { ctx.stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  if (pointers.size === 2) { finish(); startPinch(); return; }
  if (pointers.size > 2) return;
  if (e.button === 1 || space) { e.preventDefault(); startPan(e); return; }

  const itemEl = e.target.closest('.item');
  const id = itemEl && itemEl.dataset.id;
  if (id && ctx.items.has(id)) {
    // A handle on the selected item resizes, even with Shift held (Shift scales notes).
    const handle = e.target.closest('.handle');
    if (handle && ctx.selection.size === 1 && ctx.selection.has(id)) {
      raise(id);
      const o = geom(id);
      if (o.kind === 'text') { const el = ctx.els.get(id); o.w = el.offsetWidth; o.h = el.offsetHeight; }
      g = { type: 'resize', id, sx: e.clientX, sy: e.clientY, o, dir: handle.dataset.dir || 'se', scale: e.shiftKey, moved: false };
      return;
    }
    let clickSelectOnly = false;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(ctx.selection);
      if (next.has(id)) { next.delete(id); setSelection(next); return; }
      next.add(id);
      setSelection(next);
    } else if (!ctx.selection.has(id)) {
      setSelection([id]);
    } else {
      clickSelectOnly = ctx.selection.size > 1;
    }
    raise(id);
    const orig = new Map();
    for (const sid of ctx.selection) { const sg = geom(sid); if (sg) orig.set(sid, { x: sg.x, y: sg.y }); }
    g = { type: 'move', id, sx: e.clientX, sy: e.clientY, orig, moved: false, clickSelectOnly };
    return;
  }
  if (e.shiftKey) {
    g = { type: 'marquee', sx: e.clientX, sy: e.clientY, base: new Set(ctx.selection) };
    return;
  }
  if (ctx.selection.size) setSelection([]);
  startPan(e);
}

function resizePatch(o, dx, dy, dir, scale) {
  const s = ctx.view.s;
  switch (o.kind) {
    case 'image':
    case 'video':
    case 'audio': {
      const k = Math.max((o.w + dx) / o.w, o.kind === 'audio' ? 0 : (o.h + dy) / o.h, (24 / s) / Math.min(o.w, o.h));
      return { w: r1(o.w * k), h: r1(o.h * k) };
    }
    case 'model': {
      const min = 120 / s;
      return { w: r1(Math.max(min, o.w + dx)), h: r1(Math.max(min * 0.8, o.h + dy)) };
    }
    default: {
      // Notes: Shift scales everything (text included); otherwise the box resizes and text rewraps.
      if (scale) {
        const k = Math.max((16 / s) / o.w, (o.w + dx) / o.w);
        return { w: r1(o.w * k), fontSize: r1(Math.max(0.5, o.fontSize * k)), minH: r1((o.minH || 0) * k), autoW: false };
      }
      const p = { autoW: false, w: r1(o.w) };
      if (dir !== 's') p.w = r1(Math.max(o.fontSize * 1.5, o.w + dx));
      if (dir !== 'e') p.minH = r1(Math.max(0, o.h + dy));
      return p;
    }
  }
}

function onMove(e) {
  const w = toWorld(e.clientX, e.clientY);
  ctx.pointer = w;
  lastPointerAt = Date.now();
  sendCursor(w.x, w.y);
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!g) return;

  if (g.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const s = clampS(g.v0.s * Math.hypot(a.x - b.x, a.y - b.y) / g.d0);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const wx = (g.m0.x - g.v0.x) / g.v0.s, wy = (g.m0.y - g.v0.y) / g.v0.s;
    ctx.view = { s, x: m.x - wx * s, y: m.y - wy * s };
    applyView();
    return;
  }
  const dxs = e.clientX - g.sx, dys = e.clientY - g.sy;
  if (g.type === 'pan') {
    ctx.view = { ...ctx.view, x: g.vx + dxs, y: g.vy + dys };
    applyView();
    return;
  }
  if (!g.moved) {
    if (Math.hypot(dxs, dys) < 3) return;
    g.moved = true;
    if (g.type !== 'marquee') { ctx.dragging = true; emit('geometry'); }
  }
  const s = ctx.view.s;
  if (g.type === 'move') {
    const dx = r1(dxs / s), dy = r1(dys / s);
    for (const [id, o] of g.orig) { ctx.local.set(id, { x: r1(o.x + dx), y: r1(o.y + dy) }); renderItem(id); }
    setPresence({ drag: { ids: [...g.orig.keys()].slice(0, 500), dx, dy } });
  } else if (g.type === 'resize') {
    g.patch = resizePatch(g.o, dxs / s, dys / s, g.dir, g.scale || e.shiftKey);
    ctx.local.set(g.id, g.patch);
    renderItem(g.id);
    setPresence({ drag: { id: g.id, ...g.patch } });
    emit('geometry');
  } else if (g.type === 'marquee') {
    const m = document.getElementById('marquee');
    const x0 = Math.min(g.sx, e.clientX), y0 = Math.min(g.sy, e.clientY);
    Object.assign(m.style, { left: x0 + 'px', top: y0 + 'px', width: Math.abs(dxs) + 'px', height: Math.abs(dys) + 'px' });
    m.hidden = false;
    const a = toWorld(x0, y0), b = toWorld(x0 + Math.abs(dxs), y0 + Math.abs(dys));
    const next = new Set(g.base);
    for (const id of ctx.items.keys()) {
      const r = itemBox(id);
      if (r && r.x1 >= a.x && r.x0 <= b.x && r.y1 >= a.y && r.y0 <= b.y) next.add(id);
    }
    if (next.size !== ctx.selection.size || [...next].some((id) => !ctx.selection.has(id))) setSelection(next);
  }
}

function finish() {
  const gg = g;
  g = null;
  ctx.stage.classList.remove('panning');
  document.getElementById('marquee').hidden = true;
  if (!gg) return;
  if (gg.type === 'move') {
    if (gg.moved) {
      const map = new Map();
      for (const id of gg.orig.keys()) { const l = ctx.local.get(id); if (l) map.set(id, { x: l.x, y: l.y }); }
      setManyFields(map, LOCAL);
    } else if (gg.clickSelectOnly) {
      setSelection([gg.id]);
    }
    for (const id of gg.orig.keys()) { ctx.local.delete(id); renderItem(id); }
    if (gg.moved) setPresence({ drag: null });
  } else if (gg.type === 'resize') {
    if (gg.moved && gg.patch) setManyFields(new Map([[gg.id, gg.patch]]), LOCAL);
    ctx.local.delete(gg.id);
    renderItem(gg.id);
    if (gg.moved) setPresence({ drag: null });
  }
  if (ctx.dragging) { ctx.dragging = false; emit('geometry'); }
}

function onUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (g && g.type === 'pinch') { if (pointers.size < 2) g = null; return; }
  finish();
}

function onWheel(e) {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, ctx.view.s * Math.exp(-dy * 0.01)); return; }
  // Mouse wheels zoom (like PureRef); two-finger trackpad scrolls pan.
  const trackpad = e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY));
  if (trackpad) { ctx.view = { ...ctx.view, x: ctx.view.x - dx, y: ctx.view.y - dy }; applyView(); }
  else zoomAt(e.clientX, e.clientY, ctx.view.s * Math.exp(-dy * 0.0015));
}

function onDouble(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (!hit || hit.closest('[data-nodrag], .chrome')) return;
  const el = hit.closest('.item');
  if (el) {
    const id = el.dataset.id;
    if (el.dataset.kind === 'text') startEdit(id);
    else if (el._toggle) el._toggle();
    else if (el.dataset.kind === 'image') { const b = itemBox(id); if (b) fitBox(b, 8); }
    return;
  }
  const w = toWorld(e.clientX, e.clientY);
  createNote({ x: w.x, y: w.y - 18 / ctx.view.s });
}

function nudge(dx, dy) {
  const map = new Map();
  for (const id of ctx.selection) { const y = ctx.items.get(id); if (y) map.set(id, { x: r1((y.get('x') || 0) + dx), y: r1((y.get('y') || 0) + dy) }); }
  if (map.size) setManyFields(map, LOCAL);
}

function onKey(e) {
  if (isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.key === ' ') {
    if (!space) { space = true; ctx.stage.classList.add('grab'); }
    e.preventDefault();
    return;
  }
  if (mod) {
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) ctx.undo.redo(); else ctx.undo.undo(); }
    else if (k === 'y') { e.preventDefault(); ctx.undo.redo(); }
    else if (k === 'a') { e.preventDefault(); setSelection([...ctx.items.keys()]); }
    else if (k === 'd') { e.preventDefault(); duplicateItems([...ctx.selection]); }
    else if (k === 's') { e.preventDefault(); downloadSelection(); }
    return;
  }
  if (e.altKey) return;
  const step = (e.shiftKey ? 10 : 1) / ctx.view.s;
  switch (k) {
    case 'Delete':
    case 'Backspace':
      if (ctx.selection.size) { e.preventDefault(); deleteItems(ctx.selection); }
      break;
    case 'Escape': setSelection([]); break;
    case 'f': fitAll(); break;
    case 't': {
      e.preventDefault();
      const at = pointerOrCenter();
      createNote({ x: at.x, y: at.y });
      break;
    }
    case 'Enter': {
      const [only] = ctx.selection;
      if (ctx.selection.size === 1 && ctx.items.get(only)?.get('kind') === 'text') { e.preventDefault(); startEdit(only); }
      break;
    }
    case 'ArrowLeft': e.preventDefault(); nudge(-step, 0); break;
    case 'ArrowRight': e.preventDefault(); nudge(step, 0); break;
    case 'ArrowUp': e.preventDefault(); nudge(0, -step); break;
    case 'ArrowDown': e.preventDefault(); nudge(0, step); break;
    default:
  }
}

function flashActivity(t) {
  setPresence({ act: { t } });
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(() => setPresence({ act: null }), 1500);
}

function onPaste(e) {
  if (isTyping(e.target)) return;
  const dt = e.clipboardData;
  if (!dt) return;
  const files = [...dt.files];
  const at = pointerOrCenter();
  if (files.length) { e.preventDefault(); flashActivity('paste'); uploadFiles(files, at); return; }
  const text = dt.getData('text/plain');
  if (text && text.trim()) { e.preventDefault(); flashActivity('paste'); createNote(at, text.slice(0, 20000)); }
}

export function initInput() {
  const stage = ctx.stage;
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) onUp(e); });
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('dblclick', onDouble);
  stage.addEventListener('pointerleave', () => setPresence({ cursor: null }));
  addEventListener('keydown', onKey);
  addEventListener('keyup', (e) => { if (e.key === ' ') { space = false; ctx.stage.classList.remove('grab'); } });
  addEventListener('blur', () => { space = false; ctx.stage.classList.remove('grab'); });
  document.addEventListener('paste', onPaste);
  // Keep the browser from zooming the page itself with pinch or ctrl+wheel over the chrome.
  addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  for (const evt of ['gesturestart', 'gesturechange']) addEventListener(evt, (e) => e.preventDefault());

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; stage.classList.add('dropping'); } });
  addEventListener('dragleave', (e) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) stage.classList.remove('dropping'); } });
  addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    stage.classList.remove('dropping');
    if (!e.dataTransfer) return;
    const files = [...e.dataTransfer.files];
    if (files.length) { uploadFiles(files, toWorld(e.clientX, e.clientY)); return; }
    if (e.dataTransfer.getData('text/uri-list')) toast("Images dragged from another site can't be pinned directly. Copy the image and paste it here, or save it and drop the file.", 6500);
  });
}
