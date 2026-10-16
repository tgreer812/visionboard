// Two interchangeable stores: local disk for development, Azure Blob Storage in production.
// Rooms are Yjs state snapshots; media files are immutable blobs keyed "<room>/<id>.<ext>".

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BlobServiceClient } from '@azure/storage-blob';

export class DiskStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.kind = 'disk';
  }

  async init() {
    for (const d of ['rooms', 'backups', 'media']) await fsp.mkdir(path.join(this.dir, d), { recursive: true });
  }

  roomPath(id) { return path.join(this.dir, 'rooms', id + '.ybin'); }

  async getRoom(id) {
    try { return await fsp.readFile(this.roomPath(id)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  async putRoom(id, data) {
    const tmp = this.roomPath(id) + '.tmp';
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, this.roomPath(id));
  }

  async putBackup(id, stamp, data) {
    const dir = path.join(this.dir, 'backups', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, stamp + '.ybin'), data);
  }

  async roomExists(id) {
    try { await fsp.access(this.roomPath(id)); return true; } catch { return false; }
  }

  mediaPath(key) { return path.join(this.dir, 'media', ...key.split('/')); }

  async putMedia(key, stream, contentType) {
    const file = this.mediaPath(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await pipeline(stream, fs.createWriteStream(file));
    } catch (e) {
      await fsp.rm(file, { force: true });
      throw e;
    }
    await fsp.writeFile(file + '.type', contentType);
  }

  async statMedia(key) {
    const file = this.mediaPath(key);
    try {
      const [st, type] = await Promise.all([fsp.stat(file), fsp.readFile(file + '.type', 'utf8')]);
      return { size: st.size, contentType: type };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async mediaStream(key, start, end) {
    return fs.createReadStream(this.mediaPath(key), { start, end });
  }
}

export class AzureStore {
  constructor(connectionString) {
    this.kind = 'azure';
    this.svc = BlobServiceClient.fromConnectionString(connectionString);
    this.rooms = this.svc.getContainerClient('rooms');
    this.media = this.svc.getContainerClient('media');
  }

  async init() {
    await this.rooms.createIfNotExists();
    await this.media.createIfNotExists();
  }

  async getRoom(id) {
    const blob = this.rooms.getBlockBlobClient(`rooms/${id}.ybin`);
    try {
      return await blob.downloadToBuffer();
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  async putRoom(id, data) {
    await this.rooms.getBlockBlobClient(`rooms/${id}.ybin`).uploadData(data, {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
    });
  }

  async putBackup(id, stamp, data) {
    await this.rooms.getBlockBlobClient(`backups/${id}/${stamp}.ybin`).uploadData(data);
  }

  async roomExists(id) {
    return this.rooms.getBlockBlobClient(`rooms/${id}.ybin`).exists();
  }

  async putMedia(key, stream, contentType) {
    await this.media.getBlockBlobClient(key).uploadStream(stream, 4 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }

  async statMedia(key) {
    try {
      const p = await this.media.getBlockBlobClient(key).getProperties();
      return { size: p.contentLength, contentType: p.contentType || 'application/octet-stream' };
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }

  async mediaStream(key, start, end) {
    const res = await this.media.getBlockBlobClient(key).download(start, end - start + 1);
    return res.readableStreamBody;
  }
}

export function createStore() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  return conn ? new AzureStore(conn) : new DiskStore(process.env.DATA_DIR || './data');
}
