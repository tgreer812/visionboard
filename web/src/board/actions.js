// Document edits. Each is one transaction, so it syncs as one change and undoes as one step.
import * as Y from 'yjs';
import { ctx, LOCAL, LOCAL_QUIET, newId, maxZ, minZ, r1 } from './ctx.js';
import { setSelection } from './items.js';

export function addItem(fields, text = '') {
  const id = newId();
  ctx.doc.transact(() => {
    const m = new Y.Map();
    ctx.items.set(id, m);
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) m.set(k, v);
    if (fields.kind === 'text') m.set('text', new Y.Text(text));
  }, LOCAL);
  return id;
}

export function deleteItems(ids) {
  ids = [...ids];
  if (!ids.length) return;
  ctx.doc.transact(() => { for (const id of ids) ctx.items.delete(id); }, LOCAL);
  setSelection([]);
}

export function duplicateItems(ids) {
  const fresh = [];
  let z = maxZ();
  ctx.doc.transact(() => {
    for (const id of ids) {
      const y = ctx.items.get(id);
      if (!y) continue;
      const data = y.toJSON();
      const nid = newId();
      const m = new Y.Map();
      ctx.items.set(nid, m);
      for (const [k, v] of Object.entries(data)) if (k !== 'text') m.set(k, v);
      m.set('x', r1((data.x || 0) + 24));
      m.set('y', r1((data.y || 0) + 24));
      m.set('z', ++z);
      if (data.kind === 'text') m.set('text', new Y.Text(String(data.text || '')));
      fresh.push(nid);
    }
  }, LOCAL);
  setSelection(fresh);
}

/** Moves ids to the top (or bottom) of the stack, keeping their relative order. */
export function restack(ids, toFront = true) {
  const sorted = [...ids].filter((id) => ctx.items.has(id))
    .sort((a, b) => (ctx.items.get(a).get('z') || 0) - (ctx.items.get(b).get('z') || 0));
  if (!sorted.length) return;
  ctx.doc.transact(() => {
    if (toFront) { let z = maxZ(); for (const id of sorted) ctx.items.get(id).set('z', ++z); }
    else { let z = minZ() - sorted.length; for (const id of sorted) ctx.items.get(id).set('z', z++); }
  }, LOCAL);
}

/** Brings one item to the top when it's clicked, without adding an undo step. */
export function raise(id) {
  const y = ctx.items.get(id);
  if (!y) return;
  const top = maxZ();
  if ((y.get('z') || 0) >= top && [...ctx.items.values()].filter((m) => (m.get('z') || 0) === top).length === 1) return;
  ctx.doc.transact(() => y.set('z', top + 1), LOCAL_QUIET);
}

export function setFields(id, fields, origin = LOCAL) {
  const y = ctx.items.get(id);
  if (!y) return;
  ctx.doc.transact(() => { for (const [k, v] of Object.entries(fields)) y.set(k, v); }, origin);
}

export function setManyFields(map, origin = LOCAL) {
  ctx.doc.transact(() => {
    for (const [id, fields] of map) {
      const y = ctx.items.get(id);
      if (!y) continue;
      for (const [k, v] of Object.entries(fields)) y.set(k, v);
    }
  }, origin);
}
