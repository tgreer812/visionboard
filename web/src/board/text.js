// Editing a note: a textarea bound to the note's Y.Text. Concurrent typing merges character by
// character; the caret is carried across other people's edits.
import * as Y from 'yjs';
import { ctx, LOCAL, LOCAL_QUIET, emit, r1, maxZ } from './ctx.js';
import { renderItem, setSelection } from './items.js';
import { addItem, deleteItems } from './actions.js';
import { setPresence } from './presence.js';

let session = null;
let typingTimer = 0;

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

export function isEditing() { return !!session; }

export function startEdit(id) {
  if (session && session.id === id) return;
  if (session) endEdit();
  const y = ctx.items.get(id);
  const el = ctx.els.get(id);
  if (!y || !el || y.get('kind') !== 'text') return;
  let ytext = y.get('text');
  if (!(ytext instanceof Y.Text)) {
    ctx.doc.transact(() => y.set('text', new Y.Text(String(ytext || ''))), LOCAL_QUIET);
    ytext = y.get('text');
  }
  ctx.editing = id;
  setSelection([id]);

  const ta = document.createElement('textarea');
  ta.rows = 1;
  ta.spellcheck = false;
  ta.dataset.nodrag = '';
  ta.value = ytext.toString();
  el.classList.add('editing');
  el.append(ta);
  autosize(ta);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const onInput = () => {
    const prev = ytext.toString(), next = ta.value;
    let i = 0;
    while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
    let j = 0;
    while (j < prev.length - i && j < next.length - i && prev[prev.length - 1 - j] === next[next.length - 1 - j]) j++;
    const del = prev.length - i - j, ins = next.slice(i, next.length - j);
    if (del || ins) {
      ctx.doc.transact(() => {
        if (del) ytext.delete(i, del);
        if (ins) ytext.insert(i, ins);
      }, LOCAL);
    }
    autosize(ta);
    emit('geometry');
    setPresence({ act: { t: 'typing' } });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => setPresence({ act: null }), 2500);
  };

  const observer = (evt, tr) => {
    if (tr.origin === LOCAL) return;
    let s = ta.selectionStart, e = ta.selectionEnd, idx = 0;
    for (const op of evt.delta) {
      if (op.retain) idx += op.retain;
      else if (op.insert) {
        const n = typeof op.insert === 'string' ? op.insert.length : 1;
        if (idx <= s) s += n;
        if (idx < e) e += n;
        idx += n;
      } else if (op.delete) {
        const n = op.delete;
        if (idx < s) s -= Math.min(n, s - idx);
        if (idx < e) e -= Math.min(n, e - idx);
      }
    }
    ta.value = ytext.toString();
    ta.setSelectionRange(s, e);
    autosize(ta);
  };
  ytext.observe(observer);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(); }
    else e.stopPropagation(); // board shortcuts don't fire while typing
  };
  ta.addEventListener('input', onInput);
  ta.addEventListener('keydown', onKey);
  ta.addEventListener('blur', () => { if (session && session.ta === ta) endEdit(); });
  ta.addEventListener('paste', (e) => e.stopPropagation());

  session = { id, ta, ytext, observer, el };
  setPresence({ edit: id });
}

export function endEdit() {
  if (!session) return;
  const { id, ta, ytext, observer, el } = session;
  session = null;
  ctx.editing = null;
  ytext.unobserve(observer);
  clearTimeout(typingTimer);
  el.classList.remove('editing');
  ta.remove();
  setPresence({ edit: null, act: null });
  if (!ytext.toString().trim() && ctx.items.has(id)) deleteItems([id]);
  else renderItem(id);
}

export function createNote(at, text = '') {
  const s = ctx.view.s;
  const id = addItem({
    kind: 'text', x: r1(at.x), y: r1(at.y), w: r1(360 / s), fontSize: r1(28 / s), font: 'sans', z: maxZ() + 1,
  }, text);
  if (!text) startEdit(id);
  else setSelection([id]);
  return id;
}
