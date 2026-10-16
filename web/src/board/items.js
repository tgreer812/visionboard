// Turns Y.Doc items into DOM elements inside the world layer.
import { ctx, geom, emit } from './ctx.js';
import { ICON } from './icons.js';
import { formatBytes } from '../shared/mediaTypes.js';

const videoObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target.querySelector('video');
    if (!v) continue;
    if (e.isIntersecting && !v._userPaused) v.play().catch(() => {});
    else if (!e.isIntersecting && !v.paused) v.pause();
  }
}, { rootMargin: '200px' });

let playingAudio = null;

export function downloadItem(id) {
  const y = ctx.items.get(id);
  const src = y && y.get('src');
  if (!src) return false;
  const name = y.get('name') || src.split('/').pop();
  const a = document.createElement('a');
  a.href = `${src}?download=${encodeURIComponent(name)}`;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  return true;
}

function button(cls, html, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = html;
  b.title = title;
  b.dataset.nodrag = '';
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

function hoverTools(id) {
  const t = document.createElement('div');
  t.className = 'hover-tools';
  t.append(button('round', ICON.download, 'Download', () => downloadItem(id)));
  return t;
}

function brokenNote(el, text) {
  let b = el.querySelector('.broken');
  if (!b) { b = document.createElement('div'); b.className = 'broken'; el.append(b); }
  b.textContent = text;
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** A thin progress bar you can click or drag to seek. */
function scrubber(getMedia) {
  const wrap = document.createElement('div');
  wrap.className = 'scrub';
  wrap.dataset.nodrag = '';
  wrap.innerHTML = '<i><b></b></i>';
  const seek = (e) => {
    const m = getMedia();
    if (!m || !Number.isFinite(m.duration)) return;
    const r = wrap.getBoundingClientRect();
    m.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * m.duration;
  };
  wrap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    wrap.setPointerCapture(e.pointerId);
    seek(e);
    const move = (ev) => seek(ev);
    const up = () => { wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up); };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
  });
  wrap.setProgress = (f) => { wrap.querySelector('b').style.width = (Math.max(0, Math.min(1, f)) * 100) + '%'; };
  return wrap;
}

function buildImage(el, id, y) {
  const img = new Image();
  img.alt = y.get('name') || '';
  img.draggable = false;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.addEventListener('error', () => brokenNote(el, "This image couldn't be loaded"));
  img.src = y.get('src');
  el.append(img, hoverTools(id));
}

function buildVideo(el, id, y) {
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
  v.src = y.get('src');
  v.addEventListener('error', () => brokenNote(el, "This video couldn't be played here. Download it to watch."));

  const ctl = document.createElement('div');
  ctl.className = 'vctl';
  const play = button('round', ICON.play, 'Play', () => {
    if (v.paused) { v._userPaused = false; v.play().catch(() => {}); } else { v._userPaused = true; v.pause(); }
  });
  const scrub = scrubber(() => v);
  const snd = button('round', ICON.muted, 'Sound on', () => {
    v.muted = !v.muted;
    if (!v.muted && v.paused) { v._userPaused = false; v.play().catch(() => {}); }
  });
  const sync = () => {
    play.innerHTML = v.paused ? ICON.play : ICON.pause; play.title = v.paused ? 'Play' : 'Pause';
    snd.innerHTML = v.muted ? ICON.muted : ICON.sound; snd.title = v.muted ? 'Sound on' : 'Mute';
    el.classList.toggle('paused', v.paused);
  };
  for (const evt of ['play', 'pause', 'volumechange']) v.addEventListener(evt, sync);
  v.addEventListener('timeupdate', () => scrub.setProgress(v.currentTime / v.duration));
  ctl.append(play, scrub, snd);
  sync();
  el.append(v, ctl, hoverTools(id));
  el._toggle = () => play.click();
  videoObserver.observe(el);
  el._destroy = () => { videoObserver.unobserve(el); v.pause(); v.removeAttribute('src'); v.load(); };
}

function buildAudio(el, id, y) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="ico">${ICON.music}</div><div class="meta"><div class="name"></div><div class="row"></div></div>`;
  card.querySelector('.name').textContent = y.get('name') || 'Audio';
  card.querySelector('.name').title = y.get('name') || '';
  let a = null;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatBytes(y.get('size'));
  const scrub = scrubber(() => a);
  const media = () => {
    if (a) return a;
    a = new Audio();
    a.preload = 'metadata';
    a.src = y.get('src');
    const sync = () => {
      play.innerHTML = a.paused ? ICON.play : ICON.pause;
      play.title = a.paused ? 'Play' : 'Pause';
      time.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`;
    };
    a.addEventListener('play', () => { if (playingAudio && playingAudio !== a) playingAudio.pause(); playingAudio = a; sync(); });
    for (const evt of ['pause', 'ended', 'loadedmetadata']) a.addEventListener(evt, sync);
    a.addEventListener('timeupdate', () => { scrub.setProgress(a.currentTime / a.duration); sync(); });
    a.addEventListener('error', () => { time.textContent = "Can't play here"; });
    return a;
  };
  const play = button('play', ICON.play, 'Play', () => { const m = media(); if (m.paused) m.play().catch(() => {}); else m.pause(); });
  card.querySelector('.row').append(play, scrub, time);
  card.append(button('dl', ICON.download, 'Download', () => downloadItem(id)));
  el.append(card);
  el._toggle = () => play.click();
  el._destroy = () => { if (a) { a.pause(); a.removeAttribute('src'); } };
}

function buildModel(el, id, y) {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `${ICON.cube}<span class="name"></span><span class="fmt"></span>`;
  head.querySelector('.name').textContent = y.get('name') || '3D model';
  head.querySelector('.name').title = y.get('name') || '';
  head.querySelector('.fmt').textContent = y.get('ext') || '';
  head.append(button('dl', ICON.download, 'Download', () => downloadItem(id)));
  const body = document.createElement('div');
  body.className = 'body';
  card.append(head, body);
  el.append(card);

  el._renderIdle = (message) => {
    const idle = document.createElement('div');
    idle.className = 'idle';
    idle.innerHTML = `<div class="cube">${ICON.cube}</div>`;
    const btn = button('btn render-btn', `${ICON.play}<span>Render</span>`, 'Load a live 3D preview on this device', async () => {
      const { startViewer } = await import('./viewer3d.js');
      startViewer(el, ctx.items.get(id));
    });
    const note = document.createElement('div');
    note.textContent = message || `${formatBytes(y.get('size'))} · drag to spin once loaded`;
    idle.append(btn, note);
    body.replaceChildren(idle);
  };
  el._renderIdle();
  el._destroy = () => { if (el._viewer) el._viewer.stop(); };
}

function buildText(el) {
  const t = document.createElement('div');
  t.className = 'txt';
  el.append(t);
}

function build(id, y) {
  const kind = y.get('kind');
  const el = document.createElement('div');
  el.className = 'item ' + kind;
  el.dataset.id = id;
  el.dataset.kind = kind;
  if (kind === 'image') buildImage(el, id, y);
  else if (kind === 'video') buildVideo(el, id, y);
  else if (kind === 'audio') buildAudio(el, id, y);
  else if (kind === 'model') buildModel(el, id, y);
  else buildText(el);
  const h = document.createElement('div');
  h.className = 'handle';
  el.append(h);
  return el;
}

export function renderItem(id) {
  const y = ctx.items.get(id);
  let el = ctx.els.get(id);
  if (!y) {
    if (el) { el._destroy && el._destroy(); el.remove(); ctx.els.delete(id); }
    if (ctx.selection.delete(id)) emit('selection');
    return;
  }
  if (el && el.dataset.kind !== y.get('kind')) { el._destroy && el._destroy(); el.remove(); el = null; }
  if (!el) { el = build(id, y); ctx.els.set(id, el); ctx.world.append(el); }
  const g = geom(id);
  el.style.transform = `translate(${g.x}px, ${g.y}px)`;
  el.style.width = g.w + 'px';
  el.style.zIndex = String(Math.round(g.z));
  if (g.kind === 'text') {
    el.style.height = '';
    el.style.fontSize = g.fontSize + 'px';
    const font = y.get('font');
    el.classList.toggle('serif', font === 'serif');
    el.classList.toggle('mono', font === 'mono');
    if (ctx.editing !== id) {
      const t = y.get('text');
      const s = t ? t.toString() : '';
      const d = el.querySelector('.txt');
      if (d.textContent !== s) d.textContent = s;
    }
  } else {
    el.style.height = g.h + 'px';
    // Card contents are sized in em so they scale with the card.
    if (g.kind === 'audio') el.style.fontSize = (g.h / 92) * 14 + 'px';
    else if (g.kind === 'model') el.style.fontSize = Math.min(g.w / 360, g.h / 320) * 14 + 'px';
  }
  el.classList.toggle('sel', ctx.selection.has(id));
  el.classList.toggle('solo', ctx.selection.size === 1 && ctx.selection.has(id));
}

export function renderAll() {
  for (const id of ctx.items.keys()) renderItem(id);
  for (const id of [...ctx.els.keys()]) if (!ctx.items.has(id)) renderItem(id);
}

export function setSelection(ids) {
  const next = new Set(ids);
  const changed = [...ctx.selection, ...next];
  ctx.selection = next;
  for (const id of changed) {
    const el = ctx.els.get(id);
    if (el) el.classList.toggle('sel', next.has(id));
  }
  for (const el of ctx.els.values()) el.classList.toggle('solo', next.size === 1 && next.has(el.dataset.id));
  emit('selection');
}

/** World-space box of an item (notes measure their rendered height). */
export function itemBox(id) {
  const g = geom(id);
  if (!g) return null;
  const el = ctx.els.get(id);
  const h = g.kind === 'text' ? (el ? el.offsetHeight : g.fontSize * 1.3) : g.h;
  return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + h };
}

export function unionBox(ids) {
  let b = null;
  for (const id of ids) {
    const r = itemBox(id);
    if (!r) continue;
    b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : r;
  }
  return b;
}
