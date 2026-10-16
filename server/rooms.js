// Live rooms: one Yjs document per room, synced to browsers with the y-websocket wire protocol
// (sync + awareness), and saved to storage a couple of seconds after it changes.

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { log } from './log.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

const SAVE_DEBOUNCE_MS = 2000;   // save this long after the last edit...
const SAVE_MAX_WAIT_MS = 10000;  // ...but never wait longer than this while edits keep coming
const BACKUP_EVERY_MS = 60 * 60 * 1000;
const UNLOAD_AFTER_MS = 60 * 1000;
const PING_MS = 25000;

const STORAGE = Symbol('storage');

function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(msg, (err) => { if (err) ws.terminate(); });
}

function hourStamp() {
  return new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
}

class Room {
  constructor(id, manager) {
    this.id = id;
    this.manager = manager;
    this.store = manager.store;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    this.conns = new Map(); // ws -> Set of awareness client ids it controls
    this.dirty = false;
    this.firstDirtyAt = 0;
    this.saveTimer = null;
    this.saving = null;
    this.lastBackupAt = 0;
    this.unloadTimer = null;

    this.doc.on('update', (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) send(ws, msg);
      if (origin !== STORAGE) this.markDirty();
    });

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const ids = origin && this.conns.get(origin);
      if (ids) {
        for (const c of added) ids.add(c);
        for (const c of removed) ids.delete(c);
      }
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) send(ws, msg);
    });
  }

  async load() {
    const data = await this.store.getRoom(this.id);
    if (data) Y.applyUpdate(this.doc, new Uint8Array(data), STORAGE);
  }

  markDirty() {
    this.dirty = true;
    if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();
    clearTimeout(this.saveTimer);
    const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, this.firstDirtyAt + SAVE_MAX_WAIT_MS - Date.now()));
    this.saveTimer = setTimeout(() => this.save(), wait);
  }

  /** Merge whatever is in storage (another instance may have written it) and write the result back. */
  async save() {
    while (this.saving) await this.saving;
    if (!this.dirty) return;
    clearTimeout(this.saveTimer);
    this.dirty = false;
    this.firstDirtyAt = 0;
    this.saving = (async () => {
      try {
        const stored = await this.store.getRoom(this.id);
        if (stored) Y.applyUpdate(this.doc, new Uint8Array(stored), STORAGE);
        const state = Y.encodeStateAsUpdate(this.doc);
        await this.store.putRoom(this.id, state);
        if (Date.now() - this.lastBackupAt > BACKUP_EVERY_MS) {
          this.lastBackupAt = Date.now();
          await this.store.putBackup(this.id, hourStamp(), state);
        }
        log('room.saved', { room: this.id, bytes: state.length });
      } catch (e) {
        log('room.save_failed', { room: this.id, error: String(e && e.stack || e) });
        this.markDirty(); // try again on the next timer
      } finally {
        this.saving = null;
      }
    })();
    await this.saving;
  }

  join(ws) {
    clearTimeout(this.unloadTimer);
    this.conns.set(ws, new Set());

    let enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    send(ws, encoding.toUint8Array(enc));

    const states = this.awareness.getStates();
    if (states.size) {
      enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      send(ws, encoding.toUint8Array(enc));
    }
  }

  receive(ws, data) {
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), ws);
      } else if (type === MSG_QUERY_AWARENESS) {
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]));
        send(ws, encoding.toUint8Array(enc));
      }
    } catch (e) {
      log('room.bad_message', { room: this.id, error: String(e) });
    }
  }

  leave(ws) {
    const ids = this.conns.get(ws);
    if (!ids) return;
    this.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    if (this.conns.size === 0) {
      this.save();
      this.unloadTimer = setTimeout(() => this.manager.unload(this), UNLOAD_AFTER_MS);
    }
  }
}

export class RoomManager {
  constructor(store) {
    this.store = store;
    this.rooms = new Map(); // id -> Promise<Room>
  }

  get(id) {
    let p = this.rooms.get(id);
    if (!p) {
      const room = new Room(id, this);
      p = room.load().then(() => room);
      p.catch(() => this.rooms.delete(id));
      this.rooms.set(id, p);
    }
    return p;
  }

  isLoaded(id) { return this.rooms.has(id); }

  async unload(room) {
    if (room.conns.size) return;
    await room.save();
    if (room.conns.size) return;
    this.rooms.delete(room.id);
    room.awareness.destroy();
    room.doc.destroy();
    log('room.unloaded', { room: room.id });
  }

  /** Create an empty room so its code resolves before anyone has added anything. */
  async create(id) {
    const doc = new Y.Doc();
    doc.getMap('meta').set('createdAt', Date.now());
    await this.store.putRoom(id, Y.encodeStateAsUpdate(doc));
    doc.destroy();
  }

  async exists(id) {
    return this.rooms.has(id) || this.store.roomExists(id);
  }

  handleConnection(ws, id) {
    ws.binaryType = 'arraybuffer';
    let room = null;
    let closed = false;
    const pending = [];
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => { if (room) room.receive(ws, data); else pending.push(data); });
    ws.on('close', () => { closed = true; if (room) room.leave(ws); });
    ws.on('error', (e) => log('ws.error', { room: id, error: String(e) }));

    this.get(id).then((r) => {
      if (closed) return;
      room = r;
      r.join(ws);
      for (const m of pending) r.receive(ws, m);
      pending.length = 0;
    }).catch((e) => {
      log('room.load_failed', { room: id, error: String(e && e.stack || e) });
      ws.close(1011, 'Room failed to load');
    });
  }

  startHeartbeat(wss) {
    this.heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }, PING_MS);
  }

  async flushAll() {
    clearInterval(this.heartbeat);
    const rooms = await Promise.allSettled([...this.rooms.values()]);
    await Promise.allSettled(rooms.filter((r) => r.status === 'fulfilled').map((r) => r.value.save()));
  }
}
