// Shared by the browser and the server so both sides agree on what can be uploaded.

const MB = 1024 * 1024;

export const KINDS = {
  image: {
    label: 'Image',
    max: 40 * MB,
    exts: {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
    },
  },
  video: {
    label: 'Video',
    max: 300 * MB,
    exts: { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' },
  },
  audio: {
    label: 'Audio',
    max: 100 * MB,
    exts: {
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
      m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm',
    },
  },
  model: {
    label: '3D model',
    max: 60 * MB,
    exts: {
      glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', stl: 'model/stl',
      fbx: 'application/octet-stream', ply: 'application/octet-stream',
    },
  },
};

/** Models denser than this are refused at render time; a screenshot is the better reference. */
export const MAX_TRIANGLES = 1_500_000;

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Returns {kind, ext, mime, max} for an allowed file name, or null. */
export function classify(name) {
  const ext = extOf(name);
  for (const [kind, def] of Object.entries(KINDS)) {
    if (def.exts[ext]) return { kind, ext, mime: def.exts[ext], max: def.max };
  }
  return null;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

export const ACCEPT = Object.values(KINDS).flatMap((k) => Object.keys(k.exts).map((e) => '.' + e)).join(',');

/** Room codes: lowercase letters and digits. A few words are reserved for routes. */
export const ROOM_RE = /^[a-z0-9]{4,32}$/;
export const RESERVED = new Set(['api', 'ws', 'm', 'assets', 'healthz', 'index', 'board']);
export const isRoomId = (s) => ROOM_RE.test(s) && !RESERVED.has(s);
