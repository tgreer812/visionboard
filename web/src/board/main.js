import '../styles/base.css';
import '../styles/board.css';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { ctx, init, emit } from './ctx.js';
import { applyView, loadSavedView } from './view.js';
import { renderItem, renderAll } from './items.js';
import { initPresence } from './presence.js';
import { initInput } from './interact.js';
import { initUI, fitAll } from './ui.js';
import { isRoomId } from '../shared/mediaTypes.js';
import { rememberRoom } from '../recent.js';

const room = location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
if (!isRoomId(room)) location.replace('/');

const doc = new Y.Doc();
init(room, doc);
ctx.stage = document.getElementById('stage');
ctx.world = document.getElementById('world');

const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
ctx.provider = new WebsocketProvider(wsBase, room, doc, { maxBackoffTime: 4000 });
ctx.awareness = ctx.provider.awareness;

const hadView = loadSavedView();
applyView();
rememberRoom(room, '');

ctx.items.observeDeep((events) => {
  const ids = new Set();
  for (const ev of events) {
    if (ev.target === ctx.items) for (const k of ev.changes.keys.keys()) ids.add(k);
    else if (ev.path.length) ids.add(ev.path[0]);
  }
  for (const id of ids) renderItem(id);
  emit('items');
});

initUI();
initPresence();
initInput();

let first = true;
ctx.provider.on('sync', (synced) => {
  if (!synced || !first) return;
  first = false;
  ctx.synced = true;
  renderAll();
  emit('synced');
  emit('items');
  if (!hadView && ctx.items.size) requestAnimationFrame(fitAll);
});

addEventListener('resize', () => { applyView(); });
// Flush presence promptly so others see us leave.
addEventListener('pagehide', () => { ctx.awareness.setLocalState(null); });
