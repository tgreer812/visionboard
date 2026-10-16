// Other people in the room: floating ghosts at their cursors (with what they're doing), edge
// markers for anyone off-screen, coloured outlines on what they've selected, and live drags.
import { ctx, on } from './ctx.js';
import { toScreen, toWorld, flyTo } from './view.js';
import { renderItem } from './items.js';
import { ICON } from './icons.js';

const COLORS = ['#8fb6ff', '#f5a97f', '#a6da95', '#f0a6ca', '#c6a0f6', '#eed49f', '#7dc4e4', '#ff9e9e'];
const ADJ = ['Misty', 'Quiet', 'Velvet', 'Lunar', 'Amber', 'Hollow', 'Drifting', 'Pale', 'Silver', 'Faint', 'Wispy', 'Soft'];
const NOUN = ['Otter', 'Moth', 'Heron', 'Fox', 'Lantern', 'Comet', 'Fern', 'Wren', 'Marten', 'Willow', 'Lynx', 'Finch'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let me = null;
let pending = {};
let flushTimer = 0;
let lastSent = 0;

function loadMe() {
  try {
    const v = JSON.parse(localStorage.getItem('vb:me') || 'null');
    if (v && typeof v.name === 'string' && typeof v.color === 'string') return v;
  } catch { /* storage blocked */ }
  const v = { name: `${pick(ADJ)} ${pick(NOUN)}`, color: pick(COLORS) };
  try { localStorage.setItem('vb:me', JSON.stringify(v)); } catch { /* storage blocked */ }
  return v;
}

export function myIdentity() { return me; }

export function rename(name) {
  name = String(name || '').trim().slice(0, 32);
  if (!name) return;
  me = { ...me, name };
  try { localStorage.setItem('vb:me', JSON.stringify(me)); } catch { /* storage blocked */ }
  setPresence({ user: me }, true);
}

/** Merge fields into this tab's presence; sent at most ~30 times a second. */
export function setPresence(patch, now = false) {
  Object.assign(pending, patch);
  const due = Math.max(0, 33 - (performance.now() - lastSent));
  if (now || due === 0) return flush();
  if (!flushTimer) flushTimer = setTimeout(flush, due);
}
function flush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  lastSent = performance.now();
  const cur = ctx.awareness.getLocalState() || {};
  ctx.awareness.setLocalState({ ...cur, ...pending });
  pending = {};
}

function peers() {
  const out = [];
  for (const [clientId, st] of ctx.awareness.getStates()) {
    if (clientId === ctx.doc.clientID || !st || !st.user) continue;
    out.push({ clientId, ...st });
  }
  return out;
}

// ---- remote drags ------------------------------------------------------------------------
function applyRemoteDrags(list) {
  const next = new Map();
  for (const p of list) {
    const d = p.drag;
    if (!d) continue;
    if (Array.isArray(d.ids) && Number.isFinite(d.dx) && Number.isFinite(d.dy)) {
      for (const id of d.ids.slice(0, 500)) {
        const y = ctx.items.get(id);
        if (y) next.set(id, { x: (y.get('x') || 0) + d.dx, y: (y.get('y') || 0) + d.dy });
      }
    } else if (typeof d.id === 'string' && ctx.items.has(d.id)) {
      const g = {};
      for (const k of ['w', 'h', 'fontSize']) if (Number.isFinite(d[k])) g[k] = d[k];
      next.set(d.id, g);
    }
  }
  const touched = new Set([...ctx.remote.keys(), ...next.keys()]);
  ctx.remote = next;
  for (const id of touched) renderItem(id);
}

// ---- outlines on items others have selected ----------------------------------------------
let outlined = new Set();
function applyOutlines(list) {
  const now = new Map();
  for (const p of list) {
    for (const id of (Array.isArray(p.sel) ? p.sel : []).slice(0, 200)) if (!now.has(id)) now.set(id, { color: p.user.color, typing: false });
    if (typeof p.edit === 'string') now.set(p.edit, { color: p.user.color, typing: true });
  }
  for (const id of outlined) if (!now.has(id)) ctx.els.get(id)?.classList.remove('peer', 'typing');
  for (const [id, o] of now) {
    const el = ctx.els.get(id);
    if (!el) continue;
    el.classList.add('peer');
    el.classList.toggle('typing', o.typing);
    el.style.setProperty('--peer', o.color);
  }
  outlined = new Set(now.keys());
}

// ---- ghosts --------------------------------------------------------------------------------
const ghostEls = new Map();
const layer = () => document.getElementById('ghosts');

function activityText(p) {
  const a = p.act;
  if (!a || typeof a.t !== 'string') return p.drag ? 'moving' : '';
  if (a.t === 'typing') return 'typing';
  if (a.t === 'paste') return 'pasting';
  if (a.t === 'upload') {
    const n = Number(a.n) || 1;
    const pct = Number.isFinite(a.pct) ? ` ${Math.round(a.pct * 100)}%` : '';
    return n > 1 ? `uploading ${n} files${pct}` : `uploading${pct}`;
  }
  if (a.t === 'render') return 'viewing a model';
  return '';
}

function ghostEl(p) {
  let g = ghostEls.get(p.clientId);
  if (!g) {
    g = { inner: document.createElement('div'), edge: document.createElement('button') };
    g.inner.className = 'ghost';
    g.inner.innerHTML = `<span class="dot"></span><div class="body">${ICON.ghost}<span class="tag"><b></b><em></em></span></div>`;
    g.edge.className = 'edge';
    g.edge.type = 'button';
    g.edge.innerHTML = `<span class="arrow"></span>${ICON.ghost}`;
    g.edge.addEventListener('click', () => jumpTo(g.clientId));
    layer().append(g.inner, g.edge);
    ghostEls.set(p.clientId, g);
  }
  g.clientId = p.clientId;
  return g;
}

function renderGhosts() {
  const list = peers();
  const seen = new Set();
  const W = innerWidth, H = innerHeight, M = 26;
  for (const p of list) {
    const c = p.cursor;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    seen.add(p.clientId);
    const g = ghostEl(p);
    const color = p.user.color;
    g.inner.style.setProperty('--c', color);
    g.edge.style.setProperty('--c', color);
    g.inner.querySelector('b').textContent = p.user.name || 'Someone';
    const act = activityText(p);
    const em = g.inner.querySelector('em');
    em.textContent = act;
    em.className = act === 'typing' ? 'dots' : '';
    em.hidden = !act;
    g.edge.title = `${p.user.name || 'Someone'}: go to them`;
    const s = toScreen(c.x, c.y);
    const inside = s.x >= 0 && s.y >= 0 && s.x <= W && s.y <= H;
    g.inner.hidden = !inside;
    g.edge.hidden = inside;
    if (inside) {
      g.inner.style.transform = `translate(${s.x}px, ${s.y}px)`;
    } else {
      const cx = W / 2, cy = H / 2, dx = s.x - cx, dy = s.y - cy;
      const k = Math.min((W / 2 - M) / Math.abs(dx || 1e-6), (H / 2 - M) / Math.abs(dy || 1e-6));
      const ex = cx + dx * k, ey = cy + dy * k;
      g.edge.style.transform = `translate(${ex - 15}px, ${ey - 17}px)`;
      g.edge.querySelector('.arrow').style.transform = `rotate(${Math.atan2(dy, dx)}rad) translateX(20px)`;
    }
  }
  for (const [id, g] of ghostEls) {
    if (!seen.has(id)) { g.inner.remove(); g.edge.remove(); ghostEls.delete(id); }
  }
}

// ---- people list -----------------------------------------------------------------------
function initials(name) {
  return String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function renderPeople() {
  const box = document.getElementById('avatars');
  box.replaceChildren();
  const mine = document.createElement('button');
  mine.type = 'button';
  mine.className = 'av me';
  mine.style.background = me.color;
  mine.textContent = initials(me.name);
  mine.title = `You (${me.name}). Click to rename`;
  mine.addEventListener('click', () => openRename(mine));
  box.append(mine);
  const others = peers();
  for (const p of others.slice(0, 7)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'av';
    b.style.background = p.user.color;
    b.textContent = initials(p.user.name);
    b.title = `${p.user.name || 'Someone'}: click to go to their view`;
    b.addEventListener('click', () => jumpTo(p.clientId));
    box.append(b);
  }
  if (others.length > 7) {
    const more = document.createElement('span');
    more.className = 'av more';
    more.textContent = '+' + (others.length - 7);
    box.append(more);
  }
}

function openRename(anchor) {
  document.querySelector('.namepop')?.remove();
  const pop = document.createElement('form');
  pop.className = 'namepop';
  pop.innerHTML = '<label for="my-name">Your name in this room</label><input id="my-name" maxlength="32" autocomplete="off">';
  const input = pop.querySelector('input');
  input.value = me.name;
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 10 + 'px';
  pop.style.right = Math.max(12, innerWidth - r.right) + 'px';
  document.body.append(pop);
  input.focus();
  input.select();
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  document.addEventListener('pointerdown', outside, true);
  pop.addEventListener('submit', (e) => { e.preventDefault(); rename(input.value); renderPeople(); close(); });
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
}

function jumpTo(clientId) {
  const st = ctx.awareness.getStates().get(clientId);
  if (!st) return;
  const v = st.view;
  if (v && [v.cx, v.cy, v.s].every(Number.isFinite)) flyTo(v.cx, v.cy, v.s);
  else if (st.cursor && Number.isFinite(st.cursor.x)) flyTo(st.cursor.x, st.cursor.y);
}

// ---- wiring ------------------------------------------------------------------------------
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderGhosts(); });
}

export function initPresence() {
  me = loadMe();
  setPresence({ user: me, cursor: null, sel: [], edit: null, act: null, drag: null }, true);

  ctx.awareness.on('change', ({ added, removed }) => {
    const list = peers();
    applyRemoteDrags(list);
    applyOutlines(list);
    scheduleRender();
    if (added.length || removed.length) renderPeople();
    else if (list.length !== document.querySelectorAll('#avatars .av:not(.me):not(.more)').length) renderPeople();
  });
  // names/colours can change without joins/leaves
  setInterval(renderPeople, 5000);

  on('view', () => {
    scheduleRender();
    const c = toWorld(innerWidth / 2, innerHeight / 2);
    setPresence({ view: { cx: Math.round(c.x), cy: Math.round(c.y), s: Math.round(ctx.view.s * 1000) / 1000 } });
  });
  on('selection', () => setPresence({ sel: [...ctx.selection].slice(0, 200) }));
  on('items', () => applyOutlines(peers()));

  addEventListener('pointerleave', () => setPresence({ cursor: null }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPresence({ cursor: null }, true); });
  renderPeople();
}

export function sendCursor(wx, wy) {
  setPresence({ cursor: { x: Math.round(wx), y: Math.round(wy) } });
}
