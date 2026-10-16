// Live 3D preview inside a model card. Loaded only when someone presses Render, on their own
// device, and released again with Stop (or when too many are open) to give the GPU back.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MAX_TRIANGLES, formatBytes } from '../shared/mediaTypes.js';
import { ctx, on } from './ctx.js';
import { setPresence } from './presence.js';

const MAX_ACTIVE = 3;
const active = [];

class TooDense extends Error {}

async function parse(ext, buf) {
  switch (ext) {
    case 'glb':
    case 'gltf': {
      const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/loaders/DRACOLoader.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
      ]);
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      try {
        const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
        return { root: gltf.scene, clips: gltf.animations || [] };
      } catch (e) {
        if (ext === 'gltf') throw new Error('This .gltf needs separate files to load. Export it as a single .glb instead.');
        throw e;
      } finally {
        draco.dispose();
      }
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      const root = new FBXLoader().parse(buf, '');
      return { root, clips: root.animations || [] };
    }
    case 'obj': {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      return { root: new OBJLoader().parse(new TextDecoder().decode(buf)), clips: [] };
    }
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      const geo = new STLLoader().parse(buf);
      geo.computeVertexNormals();
      return { root: new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb9bdc7, roughness: 0.55, metalness: 0.1 })), clips: [] };
    }
    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const geo = new PLYLoader().parse(buf);
      const colored = geo.hasAttribute('color');
      if (!geo.index && geo.attributes.position.count % 3 !== 0) {
        return { root: new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.01, vertexColors: colored, color: colored ? 0xffffff : 0xb9bdc7 })), clips: [] };
      }
      geo.computeVertexNormals();
      return { root: new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: colored ? 0xffffff : 0xb9bdc7, vertexColors: colored, roughness: 0.6 })), clips: [] };
    }
    default:
      throw new Error(`.${ext} files can't be previewed.`);
  }
}

function countTriangles(root) {
  let tris = 0;
  root.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.geometry) {
      const geo = o.geometry;
      tris += (geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0)) / 3;
    }
  });
  return Math.round(tris);
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

function smallButton(label, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.title = title;
  b.dataset.nodrag = '';
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

export async function startViewer(el, y) {
  if (!y || el._viewer) return;
  while (active.length >= MAX_ACTIVE) active[0].stop();
  const body = el.querySelector('.body');
  const status = document.createElement('div');
  status.className = 'idle';
  status.textContent = `Loading ${formatBytes(y.get('size'))}…`;
  body.replaceChildren(status);

  const v = { stopped: false };
  el._viewer = v;
  active.push(v);
  let renderer = null, controls = null, pmrem = null, envTex = null, root = null, io = null, ro = null, offView = null, mixer = null;

  v.stop = (message) => {
    if (v.stopped) return;
    v.stopped = true;
    active.splice(active.indexOf(v), 1);
    if (el._viewer === v) el._viewer = null;
    if (renderer) renderer.setAnimationLoop(null);
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    if (offView) offView();
    if (mixer) mixer.stopAllAction();
    if (controls) controls.dispose();
    if (root) disposeTree(root);
    if (envTex) envTex.dispose();
    if (pmrem) pmrem.dispose();
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
    if (el.isConnected && el._renderIdle) el._renderIdle(message);
  };

  try {
    const res = await fetch(y.get('src'));
    if (!res.ok) throw new Error(`Couldn't download the model (${res.status}).`);
    const buf = await res.arrayBuffer();
    if (v.stopped) return;
    const parsed = await parse(String(y.get('ext') || '').toLowerCase(), buf);
    root = parsed.root;
    if (v.stopped) { disposeTree(root); return; }
    const tris = countTriangles(root);
    if (tris > MAX_TRIANGLES) throw new TooDense(`Too detailed to preview here (${(tris / 1e6).toFixed(1)}M triangles). Add a screenshot instead.`);

    const canvas = document.createElement('canvas');
    canvas.dataset.nodrag = '';
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    pmrem = new THREE.PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2b2f36, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 5, 4);
    scene.add(sun);

    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) throw new Error('This model has nothing to show.');
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1e-6, box.getSize(new THREE.Vector3()).length() / 2);
    root.position.sub(center);
    scene.add(root);

    const camera = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 100);
    const home = new THREE.Vector3(1, 0.65, 1.15).normalize().multiplyScalar(radius / Math.sin(THREE.MathUtils.degToRad(20)) * 1.05);
    camera.position.copy(home);
    controls = new OrbitControls(camera, canvas);
    controls.enableZoom = false; // the wheel zooms the board
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.6;
    controls.addEventListener('start', () => { controls.autoRotate = false; });

    const clock = new THREE.Clock();
    let clipIndex = 0, action = null, playing = true;
    if (parsed.clips.length) {
      mixer = new THREE.AnimationMixer(root);
      action = mixer.clipAction(parsed.clips[0]).play();
    }

    const tools = document.createElement('div');
    tools.className = 'mtools';
    if (parsed.clips.length) {
      const label = () => `${playing ? '❚❚' : '▶'} ${parsed.clips[clipIndex].name || 'Animation'}${parsed.clips.length > 1 ? ` (${clipIndex + 1}/${parsed.clips.length})` : ''}`;
      const anim = smallButton('', 'Pause or play the animation', () => { playing = !playing; action.paused = !playing; anim.textContent = label(); });
      anim.textContent = label();
      tools.append(anim);
      if (parsed.clips.length > 1) {
        tools.append(smallButton('Next', 'Next animation', () => {
          action.stop();
          clipIndex = (clipIndex + 1) % parsed.clips.length;
          action = mixer.clipAction(parsed.clips[clipIndex]).play();
          action.paused = !playing;
          anim.textContent = label();
        }));
      }
    }
    tools.append(
      smallButton('Reset', 'Reset the view', () => { camera.position.copy(home); controls.target.set(0, 0, 0); controls.update(); }),
      smallButton('Stop', 'Stop the preview and free graphics memory', () => v.stop()),
    );
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = `${tris.toLocaleString()} triangles · drag to spin`;
    body.replaceChildren(canvas, tools, note);

    const resize = () => {
      const w = Math.max(1, body.clientWidth), h = Math.max(1, body.clientHeight);
      const pr = Math.max(0.35, Math.min(2, devicePixelRatio * ctx.view.s, 2048 / w, 2048 / h));
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    let resizeTimer = 0;
    offView = on('view', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });
    ro = new ResizeObserver(resize);
    ro.observe(body);

    const loop = () => {
      const dt = clock.getDelta();
      if (mixer && playing) mixer.update(dt);
      controls.update();
      renderer.render(scene, camera);
    };
    io = new IntersectionObserver(([entry]) => {
      if (v.stopped) return;
      clock.getDelta();
      renderer.setAnimationLoop(entry.isIntersecting ? loop : null);
    });
    io.observe(el);
    setPresence({ act: { t: 'render' } });
    setTimeout(() => setPresence({ act: null }), 2500);
  } catch (e) {
    if (!(e instanceof TooDense)) console.error('3D preview failed', e);
    const msg = e instanceof TooDense ? e.message : `Couldn't preview this model. ${e && e.message ? e.message : ''}`.trim();
    v.stop(msg);
  }
}
