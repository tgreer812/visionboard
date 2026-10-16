import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createStore } from './storage.js';
import { RoomManager } from './rooms.js';
import { log } from './log.js';
import { classify, isRoomId } from '../web/src/shared/mediaTypes.js';

const PORT = Number(process.env.PORT || 8080);
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const store = createStore();
await store.init();
const rooms = new RoomManager(store);

function randomCode(len = 7) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));

// ---- rooms -------------------------------------------------------------------------------
app.post('/api/rooms', async (req, res, next) => {
  try {
    for (let i = 0; i < 8; i++) {
      const id = randomCode();
      if (!isRoomId(id) || (await rooms.exists(id))) continue;
      await rooms.create(id);
      log('room.created', { room: id });
      return res.status(201).json({ id });
    }
    res.status(503).json({ error: 'Could not pick a free room code. Try again.' });
  } catch (e) { next(e); }
});

app.get('/api/rooms/:room', async (req, res, next) => {
  try {
    const id = String(req.params.room).toLowerCase();
    if (!isRoomId(id)) return res.status(400).json({ error: 'Room codes are 4–32 letters or numbers.' });
    res.json({ id, exists: await rooms.exists(id) });
  } catch (e) { next(e); }
});

// ---- media -------------------------------------------------------------------------------
function limitBytes(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, enc, cb) {
      seen += chunk.length;
      if (seen > max) cb(Object.assign(new Error('File is larger than allowed'), { status: 413 }));
      else cb(null, chunk);
    },
  });
}

app.put('/api/rooms/:room/media', async (req, res, next) => {
  try {
    const room = String(req.params.room);
    if (!isRoomId(room)) return res.status(400).json({ error: 'Unknown room.' });
    const name = String(req.query.name || '').slice(0, 200);
    const info = classify(name);
    if (!info) return res.status(415).json({ error: `${name || 'That file'} isn't a supported type.` });
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len <= 0) return res.status(411).json({ error: 'Empty upload.' });
    if (len > info.max) return res.status(413).json({ error: `Too large. ${info.kind} files can be up to ${Math.round(info.max / 1048576)} MB.` });

    const key = `${room}/${crypto.randomBytes(12).toString('base64url')}.${info.ext}`;
    const body = req.pipe(limitBytes(Math.min(len, info.max)));
    req.on('error', (e) => body.destroy(e));
    await store.putMedia(key, body, info.mime);
    log('media.uploaded', { room, key, bytes: len, kind: info.kind });
    res.status(201).json({ src: `/m/${key}`, kind: info.kind, mime: info.mime, size: len });
  } catch (e) { next(e); }
});

function contentDisposition(name) {
  const clean = String(name).replace(/[\r\n"\\/]/g, '').slice(0, 200) || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

app.get('/m/:room/:file', async (req, res, next) => {
  try {
    const { room, file } = req.params;
    if (!isRoomId(room) || !/^[A-Za-z0-9_-]{8,40}\.[a-z0-9]{1,5}$/.test(file)) return res.sendStatus(404);
    const key = `${room}/${file}`;
    if (req.headers['if-none-match'] === `"${key}"`) return res.sendStatus(304);
    const st = await store.statMedia(key);
    if (!st) return res.sendStatus(404);

    res.set({
      'Content-Type': st.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${key}"`,
      // Opened directly, a file can never run script on this origin.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    if (req.query.download !== undefined) res.set('Content-Disposition', contentDisposition(req.query.download || file));

    let start = 0, end = st.size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      else { start = Math.max(0, st.size - Number(range[2])); }
      if (start > end || start >= st.size) {
        res.set('Content-Range', `bytes */${st.size}`);
        return res.sendStatus(416);
      }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    const stream = await store.mediaStream(key, start, end);
    stream.on('error', (e) => { log('media.stream_error', { key, error: String(e) }); res.destroy(e); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) { next(e); }
});

// ---- pages -------------------------------------------------------------------------------
app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y', index: false }));
app.use(express.static(DIST, { index: false, maxAge: '1h' }));
const page = (file) => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(DIST, file));
app.get('/', page('index.html'));
app.get('/:room', (req, res, next) => {
  const id = String(req.params.room);
  if (isRoomId(id)) return page('board.html')(req, res);
  if (isRoomId(id.toLowerCase())) return res.redirect(301, '/' + id.toLowerCase());
  next();
});
app.use((req, res) => res.status(404).set('Cache-Control', 'no-cache').sendFile(path.join(DIST, 'index.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) log('http.error', { path: req.path, error: String(err && err.stack || err) });
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: status === 413 ? 'File is larger than allowed.' : 'Something went wrong on the server.' });
});

// ---- realtime ----------------------------------------------------------------------------
const server = http.createServer(app);
server.requestTimeout = 0; // long uploads on slow connections
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const m = /^\/ws\/([a-z0-9]{4,32})$/.exec(new URL(req.url, 'http://x').pathname);
  if (!m || !isRoomId(m[1])) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => rooms.handleConnection(ws, m[1]));
});
rooms.startHeartbeat(wss);

server.listen(PORT, () => log('server.listening', { port: PORT, store: store.kind }));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('server.stopping', { signal });
  server.close();
  await rooms.flushAll();
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  log('server.stopped');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
