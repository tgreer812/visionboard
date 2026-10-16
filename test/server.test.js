// End-to-end: two clients sync through the server, and a room survives the server being killed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(port, dataDir) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, AZURE_STORAGE_CONNECTION_STRING: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10000);
    proc.stdout.on('data', (d) => { if (String(d).includes('server.listening')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return proc;
}

function client(port, room) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true });
  const synced = new Promise((r) => provider.on('sync', (s) => s && r()));
  const close = () => { provider.destroy(); provider.awareness.destroy(); doc.destroy(); };
  return { doc, provider, synced, close };
}

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(50); }
  throw new Error('timed out');
}

test('sync, uploads and persistence', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  let server = await startServer(port, dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
    assert.equal(res.status, 201);
    const { id: room } = await res.json();
    assert.match(room, /^[a-z0-9]{7}$/);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room}`)).json()).exists, true);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/rooms/nosuchroom`)).json()).exists, false);

    // upload + ranged + download
    const bytes = Buffer.from('fake-png-bytes-0123456789');
    const up = await fetch(`http://127.0.0.1:${port}/api/rooms/${room}/media?name=${encodeURIComponent('ref photo.png')}`, { method: 'PUT', body: bytes });
    assert.equal(up.status, 201);
    const { src } = await up.json();
    const part = await fetch(`http://127.0.0.1:${port}${src}`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'fake');
    const dl = await fetch(`http://127.0.0.1:${port}${src}?download=${encodeURIComponent('ref photo.png')}`);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="ref photo.png"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/rooms/${room}/media?name=evil.html`, { method: 'PUT', body: 'x' })).status, 415);

    // two clients see each other's edits
    const a = client(port, room), b = client(port, room);
    await Promise.all([a.synced, b.synced]);
    a.doc.transact(() => {
      const m = new Y.Map();
      a.doc.getMap('items').set('one', m);
      m.set('kind', 'text');
      m.set('text', new Y.Text('hello'));
    });
    await until(() => b.doc.getMap('items').get('one')?.get('text')?.toString() === 'hello');
    b.doc.getMap('items').get('one').get('text').insert(5, ' world');
    await until(() => a.doc.getMap('items').get('one').get('text').toString() === 'hello world');
    a.close(); b.close();

    // wait past the save debounce, then kill the server without a graceful shutdown
    await sleep(2600);
    server.kill('SIGKILL');
    server.stdout.destroy();
    server.stderr.destroy();
    await sleep(300);
    server = await startServer(port, dataDir);
    const c = client(port, room);
    await c.synced;
    await until(() => c.doc.getMap('items').get('one')?.get('text')?.toString() === 'hello world');
    c.close();
  } finally {
    server.kill('SIGKILL');
    server.stdout.destroy();
    server.stderr.destroy();
  }
});
