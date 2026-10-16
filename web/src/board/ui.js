// Floating chrome: top bar, connection status, selection toolbar, toasts, empty state.
import { ctx, on, LOCAL, LOCAL_QUIET, r1 } from './ctx.js';
import { applyView, fitBox, zoomAt, screenCenterWorld, toScreen } from './view.js';
import { unionBox, downloadItem, itemBox } from './items.js';
import { deleteItems, duplicateItems, restack, setManyFields } from './actions.js';
import { createNote } from './text.js';
import { uploadFiles } from './upload.js';
import { rememberRoom } from '../recent.js';
import { ACCEPT } from '../shared/mediaTypes.js';

const $ = (s) => document.querySelector(s);
let toastTimer = 0;

export function toast(msg, ms = 4200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function fitAll() {
  const ids = ctx.selection.size ? [...ctx.selection] : [...ctx.items.keys()];
  const b = unionBox(ids);
  if (b) fitBox(b, ctx.selection.size ? 4 : 1.5);
  else { ctx.view = { x: innerWidth / 2, y: innerHeight / 2, s: 1 }; applyView(); }
}

export function downloadSelection() {
  const ids = [...ctx.selection].filter((id) => ctx.items.get(id)?.get('src'));
  ids.forEach((id, i) => setTimeout(() => downloadItem(id), i * 350));
  if (ids.length > 1) toast(`Downloading ${ids.length} files. Your browser may ask to allow multiple downloads.`);
}

function initTitle() {
  const input = $('#title');
  const sync = () => {
    const t = ctx.meta.get('title') || '';
    if (document.activeElement !== input) input.value = t;
    document.title = (t || ctx.room) + ' · Vision Board';
    rememberRoom(ctx.room, t);
  };
  ctx.meta.observe(sync);
  sync();
  const commit = () => {
    const v = input.value.trim().slice(0, 80);
    if (v !== (ctx.meta.get('title') || '')) ctx.doc.transact(() => ctx.meta.set('title', v), LOCAL_QUIET);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Escape') input.value = ctx.meta.get('title') || ''; input.blur(); }
  });
  input.addEventListener('blur', commit);
}

function initStatus() {
  const dot = $('#status');
  let synced = false;
  const set = (state) => {
    dot.className = 'status ' + (state === 'live' ? 'live' : state === 'down' ? 'down' : '');
    dot.title = state === 'live' ? 'Live: changes sync instantly' : state === 'down' ? 'Reconnecting… your changes will sync when it’s back' : 'Connecting…';
  };
  set('connecting');
  let downTimer = 0;
  ctx.provider.on('status', ({ status }) => {
    clearTimeout(downTimer);
    if (status === 'connected') { if (synced) set('live'); }
    else downTimer = setTimeout(() => set('down'), 1500);
  });
  ctx.provider.on('sync', (isSynced) => { synced = isSynced; if (isSynced) set('live'); });
}

function initToolbar() {
  const fileInput = $('#file-input');
  fileInput.accept = ACCEPT;
  $('#add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files], screenCenterWorld());
    fileInput.value = '';
  });
  $('#note').addEventListener('click', () => {
    const c = screenCenterWorld();
    createNote({ x: c.x - 180 / ctx.view.s, y: c.y - 20 / ctx.view.s });
  });
  $('#fit').addEventListener('click', fitAll);
  $('#zoom').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1));
  on('view', () => { $('#zoom').textContent = Math.round(ctx.view.s * 100) + '%'; });
  $('#share').addEventListener('click', async () => {
    const url = location.origin + '/' + ctx.room;
    try { await navigator.clipboard.writeText(url); toast('Link copied. Anyone with it can join this room.'); }
    catch { toast(url, 8000); }
  });
}

// ---- selection toolbar ------------------------------------------------------------------
function placeSelbar() {
  const bar = $('#selbar');
  const ids = [...ctx.selection].filter((id) => ctx.items.has(id));
  if (!ids.length || ctx.dragging) { bar.hidden = true; return; }
  const kinds = new Set(ids.map((id) => ctx.items.get(id).get('kind')));
  const onlyText = kinds.size === 1 && kinds.has('text');
  const anyFile = ids.some((id) => ctx.items.get(id).get('src'));
  $('#sb-download').hidden = !anyFile;
  for (const s of ['#sb-font', '#sb-smaller', '#sb-bigger']) $(s).hidden = !onlyText;
  $('#sb-sep').hidden = !(anyFile || onlyText);
  bar.hidden = false;
  const b = ids.length === 1 ? itemBox(ids[0]) : unionBox(ids);
  const tl = toScreen(b.x0, b.y0), br = toScreen(b.x1, b.y1);
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = tl.y - bh - 12;
  if (top < 64) top = br.y + 12;
  if (top > innerHeight - bh - 8) top = Math.max(64, Math.min(innerHeight - bh - 8, tl.y + 12));
  const left = Math.min(Math.max(8, (tl.x + br.x) / 2 - bw / 2), innerWidth - bw - 8);
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

let selRaf = 0;
export function scheduleSelbar() {
  if (selRaf) return;
  selRaf = requestAnimationFrame(() => { selRaf = 0; placeSelbar(); });
}

function initSelbar() {
  const bar = $('#selbar');
  bar.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
  $('#sb-download').addEventListener('click', downloadSelection);
  $('#sb-front').addEventListener('click', () => restack(ctx.selection, true));
  $('#sb-back').addEventListener('click', () => restack(ctx.selection, false));
  $('#sb-dup').addEventListener('click', () => duplicateItems([...ctx.selection]));
  $('#sb-delete').addEventListener('click', () => deleteItems(ctx.selection));
  const FONTS = ['sans', 'serif', 'mono'];
  $('#sb-font').addEventListener('click', () => {
    const map = new Map();
    for (const id of ctx.selection) {
      const f = ctx.items.get(id)?.get('font') || 'sans';
      map.set(id, { font: FONTS[(FONTS.indexOf(f) + 1) % FONTS.length] });
    }
    setManyFields(map, LOCAL);
  });
  const scale = (k) => {
    const map = new Map();
    for (const id of ctx.selection) {
      const y = ctx.items.get(id);
      if (!y) continue;
      map.set(id, { fontSize: r1(Math.max(2, (y.get('fontSize') || 28) * k)), w: r1(Math.max(20, (y.get('w') || 300) * k)) });
    }
    setManyFields(map, LOCAL);
  };
  $('#sb-bigger').addEventListener('click', () => scale(1.25));
  $('#sb-smaller').addEventListener('click', () => scale(1 / 1.25));
  for (const evt of ['selection', 'view', 'items', 'geometry']) on(evt, scheduleSelbar);
}

function initEmpty() {
  const update = () => {
    const empty = ctx.synced && ctx.items.size === 0;
    $('#empty').hidden = !empty;
    $('#hint').hidden = !ctx.synced;
  };
  $('#empty').hidden = true;
  on('items', update);
  on('synced', update);
}

export function initUI() {
  initTitle();
  initStatus();
  initToolbar();
  initSelbar();
  initEmpty();
}

