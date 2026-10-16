import './styles/base.css';
import './styles/landing.css';
import { isRoomId } from './shared/mediaTypes.js';
import { recentRooms } from './recent.js';

const $ = (s) => document.querySelector(s);
const errorEl = $('#error');

function showError(msg, action) {
  errorEl.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action.label;
    b.addEventListener('click', action.run);
    errorEl.append(' ', b);
  }
  errorEl.hidden = false;
}

async function createRoom() {
  const btn = $('#create');
  btn.disabled = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server said ${res.status}`);
    location.href = '/' + body.id;
  } catch (e) {
    btn.disabled = false;
    showError(`Couldn't create a room: ${e.message}`);
  }
}

/** Accepts "zasd234", " ZASD234 ", or a pasted link like https://visionboard.tylergreer.io/zasd234 */
function parseCode(raw) {
  let s = String(raw || '').trim();
  try { if (/^https?:\/\//i.test(s)) s = new URL(s).pathname; } catch { /* not a URL */ }
  s = s.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
  return s.toLowerCase();
}

$('#create').addEventListener('click', createRoom);
$('#join').addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const code = parseCode($('#code').value);
  if (!code) return showError('Enter a room code.');
  if (!isRoomId(code)) return showError('Room codes are 4 to 32 letters or numbers.');
  try {
    const res = await fetch('/api/rooms/' + code);
    const body = await res.json();
    if (body.exists) location.href = '/' + code;
    else showError(`No room called "${code}" yet.`, { label: 'Create it', run: () => { location.href = '/' + code; } });
  } catch {
    showError("Couldn't reach the server. Check your connection and try again.");
  }
});

const recent = recentRooms();
if (recent.length) {
  const list = $('#recent-list');
  for (const r of recent.slice(0, 6)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/' + r.id;
    const t = document.createElement('span'); t.className = 't'; t.textContent = r.title || 'Untitled room';
    const c = document.createElement('span'); c.className = 'c'; c.textContent = r.id;
    a.append(t, c); li.append(a); list.append(li);
  }
  $('#recent').hidden = false;
}
