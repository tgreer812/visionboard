// Pan/zoom of the world layer.
import { ctx, emit } from './ctx.js';

const MIN_S = 0.03, MAX_S = 12;
export const clampS = (s) => Math.min(MAX_S, Math.max(MIN_S, s));

let saveTimer = 0;
let raf = 0;

export function applyView() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const { x, y, s } = ctx.view;
    ctx.world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    ctx.world.style.setProperty('--s', s);
    let g = 24 * s;
    while (g < 12) g *= 4;
    while (g > 96) g /= 4;
    ctx.stage.style.backgroundSize = `${g}px ${g}px`;
    ctx.stage.style.backgroundPosition = `${x}px ${y}px`;
    emit('view');
  });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('vb:view:' + ctx.room, JSON.stringify(ctx.view)); } catch { /* storage blocked */ }
  }, 400);
}

export function loadSavedView() {
  try {
    const v = JSON.parse(localStorage.getItem('vb:view:' + ctx.room) || 'null');
    if (v && [v.x, v.y, v.s].every(Number.isFinite) && v.s > 0) { ctx.view = v; return true; }
  } catch { /* storage blocked */ }
  ctx.view = { x: innerWidth / 2, y: innerHeight / 2, s: 1 };
  return false;
}

export const toWorld = (sx, sy) => ({ x: (sx - ctx.view.x) / ctx.view.s, y: (sy - ctx.view.y) / ctx.view.s });
export const toScreen = (wx, wy) => ({ x: ctx.view.x + wx * ctx.view.s, y: ctx.view.y + wy * ctx.view.s });
export const screenCenterWorld = () => toWorld(innerWidth / 2, innerHeight / 2);

export function zoomAt(sx, sy, s) {
  s = clampS(s);
  const w = toWorld(sx, sy);
  ctx.view = { s, x: sx - w.x * s, y: sy - w.y * s };
  applyView();
}

let anim = 0;
/** Smoothly move so world point (wx, wy) is centred at scale s. */
export function flyTo(wx, wy, s = ctx.view.s) {
  cancelAnimationFrame(anim);
  s = clampS(s);
  const from = { ...ctx.view };
  const to = { s, x: innerWidth / 2 - wx * s, y: innerHeight / 2 - wy * s };
  const t0 = performance.now(), dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 320;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    ctx.view = { s: from.s + (to.s - from.s) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    applyView();
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

/** Fit a world-space box {x0,y0,x1,y1} on screen. */
export function fitBox(b, maxS = 1.5) {
  const pad = 56, top = 70;
  const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
  const s = clampS(Math.min((innerWidth - pad * 2) / bw, (innerHeight - pad * 2 - top) / bh, maxS));
  flyTo((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2 - top / 2 / s, s);
}
