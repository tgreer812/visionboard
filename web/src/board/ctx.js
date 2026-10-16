// Shared board state. Everything durable lives in the Y.Doc; this file holds the per-tab bits.
import * as Y from 'yjs';

export const LOCAL = Symbol('local');          // edits that go on the undo stack
export const LOCAL_QUIET = Symbol('local-quiet'); // edits that don't (z-order bumps, room title)

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, ...args) {
  for (const fn of listeners.get(evt) || []) fn(...args);
}

export const ctx = {
  room: '',
  doc: /** @type {Y.Doc} */ (null),
  items: /** @type {Y.Map<Y.Map<any>>} */ (null),
  meta: /** @type {Y.Map<any>} */ (null),
  provider: null,
  awareness: null,
  undo: /** @type {Y.UndoManager} */ (null),
  view: { x: 0, y: 0, s: 1 },
  selection: new Set(),
  editing: null,        // id of the note this tab is typing in
  local: new Map(),     // id -> geometry override while this tab drags/resizes
  remote: new Map(),    // id -> geometry override while someone else drags/resizes
  els: new Map(),       // id -> element
  pointer: null,        // last pointer position in world coords
  dragging: false,      // true while this tab moves or resizes something
  synced: false,        // first sync with the server has finished
  stage: null,
  world: null,
};

export function init(room, doc) {
  ctx.room = room;
  ctx.doc = doc;
  ctx.items = doc.getMap('items');
  ctx.meta = doc.getMap('meta');
  ctx.undo = new Y.UndoManager([ctx.items], { trackedOrigins: new Set([LOCAL]), captureTimeout: 600 });
}

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => (x % 36).toString(36)).join('');
}

/** Current geometry of an item: stored values, then someone else's live drag, then ours. */
export function geom(id) {
  const y = ctx.items.get(id);
  if (!y) return null;
  const g = {
    kind: y.get('kind'), x: y.get('x') || 0, y: y.get('y') || 0, w: y.get('w') || 100, h: y.get('h') || 100,
    z: y.get('z') || 0, fontSize: y.get('fontSize') || 32,
  };
  Object.assign(g, ctx.remote.get(id), ctx.local.get(id));
  return g;
}

export function maxZ() {
  let z = 0;
  for (const y of ctx.items.values()) z = Math.max(z, y.get('z') || 0);
  return z;
}
export function minZ() {
  let z = Infinity;
  for (const y of ctx.items.values()) z = Math.min(z, y.get('z') || 0);
  return Number.isFinite(z) ? z : 0;
}

export const r1 = (n) => Math.round(n * 10) / 10;
