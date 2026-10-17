# Vision Board

A collaborative, PureRef-style reference board at **https://visionboard.tylergreer.io**.

Make a room, share its link (`visionboard.tylergreer.io/<code>`), and everyone in it can drop
images, videos, audio, 3D models and notes on an endless canvas, all synced live.

## Using it

| Do this | How |
| --- | --- |
| Add files | Drag them in, paste (`Ctrl+V`), or use **Add files** |
| Write a note | Double-click empty space, or press `T` |
| Move, resize | Drag an item; drag the blue corner handle to resize. Notes also have right and bottom edge handles; text rewraps instead of scaling, and `Shift` + corner scales the whole note |
| Select several | `Shift`-drag a box, or `Shift`-click items |
| Pan, zoom | Drag empty space (or hold `Space`); mouse wheel or pinch to zoom; `F` fits everything |
| Download | The download button on any file, the selection bar, or `Ctrl+S` for everything selected |
| Undo, redo | `Ctrl+Z`, `Ctrl+Shift+Z` |
| Duplicate, delete | `Ctrl+D`, `Delete` |
| 3D models | Press **Render** on the card to load a live preview on your device; drag to spin; **Stop** frees the GPU |
| See others | Their ghosts float at their cursors and show what they're doing; click an avatar to jump to their view |

Supported uploads: images (png, jpg, gif, webp, avif, svg, bmp) up to 40 MB, video (mp4, webm, mov,
ogv) up to 300 MB, audio (mp3, wav, ogg, opus, m4a, aac, flac, weba) up to 100 MB, and models (glb,
single-file gltf, obj, stl, fbx, ply) up to 100 MB. Models over 1.5M triangles won't preview.

## How it works

- **Server** (`server/`): Node + Express. Each room is a [Yjs](https://yjs.dev) document synced over
  WebSockets using the standard y-websocket protocol, plus Yjs awareness for cursors and activity.
  Rooms are saved to storage about 2 seconds after a change (at most 10 seconds during constant
  editing), on shutdown, and as an hourly backup kept for 30 days. Saving merges with what's
  stored, so overlapping instances during a deploy don't overwrite each other.
- **Storage**: Azure Blob Storage in production (`rooms` and `media` containers), local `./data`
  in development. Media is streamed through the server with range support and an
  `?download=<name>` mode that forces a real download with the original filename.
- **Client** (`web/`): vanilla JS + Vite. three.js loads only when someone presses Render.

## Running locally

```bash
npm install
npm run build
npm start            # http://localhost:8080, stores data in ./data
```

For live-reloading UI work, run `npm start` and `npm run dev` together, then open http://localhost:5173.

```bash
npm test             # end-to-end: sync between two clients, uploads, survives a server kill
```

## Hosting

Everything lives in the `tg-visionboard` resource group (TylerGreerSubscription):

| Resource | What it is |
| --- | --- |
| `visionboard` | Container App: 0.25 vCPU, 0.5 GB, exactly one always-on replica |
| `tg-visionboard-env` | Container Apps environment (consumption) |
| `tgvisionboard` | Storage account: room snapshots, backups, uploaded files |
| `tg-visionboard-logs` | Log Analytics, 30-day retention, 100 MB/day cap |

DNS: `visionboard` CNAME and `asuid.visionboard` TXT in the `tylergreer.io` zone (`tylergreer-rg`),
with an Azure-managed TLS certificate that renews itself.

Pushing to `main` runs tests, builds the image to `ghcr.io/tgreer812/visionboard`, and rolls it
out to the Container App through GitHub OIDC (no stored credentials). `infra/provision.sh` is the
one-time setup, kept as a record and safe to re-run.

Logs: Azure portal → `visionboard` → Log stream, or

```bash
az containerapp logs show -n visionboard -g tg-visionboard --follow
```
