// scene.js — 3D 场景：原模型琴键（运行时拆分）+ 竖直物理按压动画 + 三踏板原位互动 + 镜面衰减反射 + 自适应画质
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js?v=51';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js?v=51';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js?v=51';
import { Reflector } from 'three/addons/objects/Reflector.js?v=56';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js?v=1';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js?v=1';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js?v=1';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js?v=1';

const WHITE_NOTES = new Set([0, 2, 4, 5, 7, 9, 11]);
const NOTE0 = 21, NOTE1 = 108;

export class PianoScene {
  constructor(canvas, callbacks) {
    this.cb = callbacks || {};
    this.canvas = canvas;
    this.keys = [];           // by midi note (NOTE0..NOTE1)
    this.keyByMesh = new Map();
    this.pedals = { soft: null, sostenuto: null, sustain: null };
    this.quality = { level: 3, auto: true, target: 3, pixelRatio: 1 };
    this.fps = { ema: 60, lowT: 0, highT: 0, last: performance.now() };
    this.unaCordaShift = 0;
    this.unaCorda = false;
    this._downVec = new THREE.Vector3(0, -1, 0);
    this._keysBaseX = 0;
    this._init();
  }

  _init() {
    const canvas = this.canvas;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    } catch (e) {
      this._fatal('当前浏览器不支持 WebGL，无法启动 3D 场景。请使用最新版 Chrome / Edge。');
      return;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x232e40);

    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.01, 400);
    this.camera.position.set(0, 1.1, 2.6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 12;
    this.controls.target.set(0, 0.1, 0);

    // lights
    const hemi = new THREE.HemisphereLight(0xcfd8e6, 0x1a1c20, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff2df, 1.5);
    key.position.set(-1.6, 2.4, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.1; key.shadow.camera.far = 12;
    key.shadow.camera.left = -2.5; key.shadow.camera.right = 2.5;
    key.shadow.camera.top = 2.5; key.shadow.camera.bottom = -2.5;
    key.shadow.bias = -0.0006;
    this.scene.add(key);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x9db4ff, 0.35);
    fill.position.set(2.2, 1.2, -1.4);
    this.scene.add(fill);
    this.fillLight = fill;

    // user-adjustable light: azimuth / elevation / colour / intensity
    // azimuth 0 = light from the front (+z), positive rotates counter-clockwise
    this._lightAz = -0.65;
    this._lightEl = 0.9;
    this._lightIntensity = 1.5;
    this._lightColor = 0xfff2df;

    const spot = new THREE.SpotLight(0xffffff, 0.6, 0, Math.PI / 6, 0.4, 1.2);
    spot.position.set(0, 2.9, 0.6);
    this.scene.add(spot);
    this.spot = spot;

    // environment reflection (预反射)
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = envTex;
      pmrem.dispose();
    } catch (e) { /* env optional */ }

    // post-processing: bloom (default OFF for perf; user slider enables it)
    try {
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0, 0.55, 0.82);
      this.bloomPass.enabled = false;
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
      this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this._bloom = 0;
      this._useComposer = false;
    } catch (e) { /* composer optional (very old GL) */ }

    // floor
    this._floorReflect = false; // floor mirror bonus pass off by default (perf)
    this._buildFloor();

    this.keysGroup = new THREE.Group();
    this.scene.add(this.keysGroup);
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this._hitDebug = location.search.indexOf('dbg=1') >= 0;

    this._bindPointer();
    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  _fatal(msg) {
    const box = document.getElementById('errBox');
    box.textContent = msg;
    document.getElementById('errScreen').style.display = 'flex';
  }

  _buildFloor() {
    // White porcelain-tile floor (procedural texture). The ONLY mirror
    // reflections are the black fallboard panel and — in ULTRA quality only —
    // the glossy tiles (attenuated sheen). No other floor mirror.
    const tileTex = this._makeTileTexture();
    tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
    tileTex.repeat.set(6, 4);
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 7),
      new THREE.MeshStandardMaterial({
        map: tileTex, color: 0xffffff, roughness: 0.34, metalness: 0.0,
        envMapIntensity: 0.35,
      })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.6;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    // ULTRA: glossy-tile mirror overlay — white porcelain sheen with strong
    // attenuation (dim reflection), the tiles show through (glass-like).
    this.floorReflector = new Reflector(new THREE.PlaneGeometry(9, 7), {
      clipBias: 0.0012, textureWidth: 512, textureHeight: 512, color: 0xffffff,
    });
    this.floorReflector.rotation.x = -Math.PI / 2;
    this.floorReflector.position.y = -0.5995;
    this.floorReflector.material.transparent = true;
    this.floorReflector.material.depthWrite = false;
    this.floorReflector.material.uniforms.bodyColor.value.set(0.74, 0.74, 0.72);
    this.floorReflector.material.uniforms.opacity.value = 0.55;  // reflection strength (smooth-glaze tiles, attenuated)
    this.floorReflector.material.uniforms.alphaOut.value = 0.45; // tile shows through
    this.floorReflector.renderOrder = 18;
    this.floorReflector.visible = false; // only enabled in ULTRA mode
    this.scene.add(this.floorReflector);
  }

  _makeTileTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#f0f0ea';
    g.fillRect(0, 0, 512, 512);
    // subtle per-tile brightness variation (2×2 tiles of 256 px)
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const v = 0.96 + Math.random() * 0.07;
        g.fillStyle = 'rgba(' + Math.round(240 * v) + ',' + Math.round(240 * v) + ',' + Math.round(234 * v) + ',0.55)';
        g.fillRect(tx * 256, ty * 256, 256, 256);
      }
    }
    // grout lines (fine grey joints)
    g.strokeStyle = 'rgba(148,148,144,0.9)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, 256); g.lineTo(512, 256);
    g.moveTo(256, 0); g.lineTo(256, 512);
    g.stroke();
    // faint porcelain grain
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      const a = Math.random() * 0.05;
      g.fillStyle = 'rgba(' + (Math.random() > 0.5 ? 255 : 228) + ',' + (Math.random() > 0.5 ? 255 : 228) + ',242,' + a.toFixed(3) + ')';
      g.fillRect(x, y, 1.5, 1.5);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  loadPianoModel(url, onProgress) {
    const loader = new GLTFLoader();
    // GitHub Pages: repo cannot hold the 55 MB GLB (Contents API limit),
    // so the model is stored as 12 same-origin chunks and merged in-browser.
    // Same-origin fetch avoids any CORS issue on the live site.
    const onGitHubPages = location.hostname.indexOf('github.io') >= 0;
    const finish = (gltf) => {
      try {
        this._processModel(gltf.scene);
        this._alignModel();
        this._buildKeysFromModel();
        this._setupPedals();
        this._buildReflectors();
        this._autoFrame();
        if (this.cb.onModelReady) this.cb.onModelReady();
      } catch (e) {
        console.error('model process error', e);
        this._buildFallbackPiano();
        if (this.cb.onModelReady) this.cb.onModelReady();
        if (this.cb.onWarn) this.cb.onWarn('模型解析失败，已使用内置简易钢琴模型。');
      }
    };
    const onErr = (err) => {
      console.error('model load error', err);
      this._buildFallbackPiano();
      if (this.cb.onModelReady) this.cb.onModelReady();
      if (this.cb.onWarn) this.cb.onWarn('模型加载失败，已使用内置简易钢琴模型。');
    };
    if (onGitHubPages) {
      // 12 same-origin chunks (the repo cannot hold the 55 MB GLB via the
      // Contents API, so it ships split; same-origin fetch is CORS-free).
      // Note: jsDelivr rejects the chunk filenames, so keep these on Pages.
      // Each chunk gets a 40 s timeout + 3 retries, and chunks download in
      // batches of 6 — a stalled request can never hang the whole piano.
      const CHUNKS = 12;
      const loadChunk = async (i) => {
        for (let a = 0; a < 3; a++) {
          const ctrl = new AbortController();
          const tm = setTimeout(() => ctrl.abort(), 40000);
          try {
            const r = await fetch('assets/piano.glb.' + String(i).padStart(2, '0'), { signal: ctrl.signal });
            clearTimeout(tm);
            if (!r.ok) throw new Error('chunk ' + i + ' http ' + r.status);
            const b = await r.arrayBuffer();
            if (onProgress) onProgress((i + 1) / CHUNKS);
            return b;
          } catch (e) {
            clearTimeout(tm);
            if (a === 2) throw e;
          }
        }
      };
      (async () => {
        const bufs = [];
        for (let b = 0; b < CHUNKS; b += 6) {
          const part = await Promise.all(
            Array.from({ length: Math.min(6, CHUNKS - b) }, (_, k) => loadChunk(b + k))
          );
          bufs.push(...part);
        }
        const total = bufs.reduce((s, x) => s + x.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const x of bufs) {
          merged.set(new Uint8Array(x), off);
          off += x.byteLength;
        }
        const objUrl = URL.createObjectURL(new Blob([merged], { type: 'model/gltf-binary' }));
        loader.load(objUrl, finish, undefined, onErr);
      })().catch(onErr);
    } else {
      loader.load(url, finish, (ev) => {
        if (onProgress) onProgress(ev.loaded / ev.total);
      }, onErr);
    }
  }

  // ---------- model processing ----------
  _findByPrefix(root, prefix) {
    const out = [];
    root.traverse((o) => {
      if (o.isMesh && o.name && o.name.indexOf(prefix) === 0) out.push(o);
    });
    return out;
  }

  _processModel(scene) {
    this.modelGroup.add(scene);
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.castShadow = true;
      const m = o.material;
      if (!(m.isMeshPhysicalMaterial || m.isMeshStandardMaterial)) return;
      if (o.name.indexOf('White_Keys') === 0 || o.name.indexOf('Black_Keys') === 0) return; // handled by split
      const c = m.color;
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const sat = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      let nm;
      if (lum < 0.24) {
        // glossy black lacquer body — 镜面衰减反射
        nm = new THREE.MeshPhysicalMaterial({
          color: c, roughness: 0.10, metalness: 0.0,
          clearcoat: 1.0, clearcoatRoughness: 0.05,
          envMapIntensity: 1.35, side: THREE.DoubleSide,
        });
      } else if (sat > 0.28 && lum < 0.75) {
        // brass / gold / bronze strings & pedals
        nm = new THREE.MeshPhysicalMaterial({
          color: c, roughness: 0.26, metalness: 0.85,
          envMapIntensity: 1.6, side: THREE.DoubleSide,
        });
      } else if (lum > 0.72) {
        // ivory / bright parts
        nm = new THREE.MeshPhysicalMaterial({
          color: c, roughness: 0.30, metalness: 0.0,
          clearcoat: 0.7, clearcoatRoughness: 0.15,
          envMapIntensity: 1.1, side: THREE.DoubleSide,
        });
      } else {
        // wood / mid tone
        nm = new THREE.MeshPhysicalMaterial({
          color: c, roughness: 0.42, metalness: 0.0,
          clearcoat: 0.35, clearcoatRoughness: 0.2,
          envMapIntensity: 0.9, side: THREE.DoubleSide,
        });
      }
      o.material = nm;
    });
  }

  _alignModel() {
    const white = this._findByPrefix(this.modelGroup, 'White_Keys');
    const fallboard = this._findByPrefix(this.modelGroup, 'Fall_Board');
    if (!white.length) return;
    const wb = new THREE.Box3().setFromObject(white[0]);
    const size = new THREE.Vector3(); wb.getSize(size);
    let longDir = new THREE.Vector3(1, 0, 0);
    let frontDir = new THREE.Vector3(0, 0, 1);
    if (size.x >= size.y && size.x >= size.z) {
      longDir = new THREE.Vector3(1, 0, 0);
    } else if (size.y >= size.x && size.y >= size.z) {
      longDir = new THREE.Vector3(0, 1, 0);
    } else {
      longDir = new THREE.Vector3(0, 0, 1);
    }
    if (fallboard.length) {
      const fb = new THREE.Box3().setFromObject(fallboard[0]);
      const kc = wb.getCenter(new THREE.Vector3());
      const fc = fb.getCenter(new THREE.Vector3());
      const d = new THREE.Vector3().subVectors(kc, fc); // fallboard -> keys = front (player side)
      d.y = 0;
      if (d.lengthSq() > 1e-8) {
        d.normalize();
        frontDir = d.clone();
      }
    }
    const up = new THREE.Vector3(0, 1, 0);
    const perp = new THREE.Vector3().crossVectors(longDir, frontDir);
    if (perp.lengthSq() < 1e-6) {
      frontDir = new THREE.Vector3().crossVectors(longDir, up).normalize();
    }
    const yAxis = new THREE.Vector3().crossVectors(frontDir, longDir).normalize();
    const m = new THREE.Matrix4().makeBasis(longDir, yAxis, frontDir);
    this.modelGroup.quaternion.setFromRotationMatrix(m);
    this.modelGroup.updateMatrixWorld(true);
  }

  // ---------- keys from ORIGINAL model geometry (runtime split, no model modification) ----------
  _blackBoundary(k) {
    if (k === 0) return 1; // A#0 (88-key A-start)
    const o = Math.floor((k - 1) / 5);
    const p = (k - 1) % 5;
    return 3 + 7 * o + [0, 1, 3, 4, 5][p];
  }

  _keyTexture(white) {
    // procedural micro-texture for key caps: ivory grain on white keys,
    // fine resin/wood grain on black keys. Only affects shading (bump) —
    // the key colour stays exactly the model's colour (pressing never changes
    // appearance).
    try {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 256;
      const c = cv.getContext('2d');
      c.fillStyle = white ? '#ffffff' : '#141414';
      c.fillRect(0, 0, 256, 256);
      const n = white ? 3400 : 2200;
      for (let i = 0; i < n; i++) {
        const x = Math.random() * 256, y = Math.random() * 256;
        const v = Math.random();
        if (white) {
          c.fillStyle = v > 0.5 ? 'rgba(228,224,214,' + (v * 0.09) + ')' : 'rgba(255,255,255,' + (v * 0.08) + ')';
        } else {
          c.fillStyle = v > 0.5 ? 'rgba(255,255,255,' + (v * 0.03) + ')' : 'rgba(0,0,0,' + (v * 0.05) + ')';
        }
        c.fillRect(x, y, 1, 1);
      }
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1, 1);
      return t;
    } catch (e) { return null; }
  }

  _glossMaterial(srcMat, opt) {
    const c = (srcMat && srcMat.color) ? srcMat.color.clone() : new THREE.Color(0xf5f3ee);
    return new THREE.MeshPhysicalMaterial({
      color: c, roughness: opt.r, metalness: 0.0,
      clearcoat: opt.cc, clearcoatRoughness: opt.ccr,
      envMapIntensity: opt.env, side: THREE.DoubleSide,
      bumpMap: opt.bump || null, bumpScale: opt.bumpS || 0.4,
    });
  }

  _splitKeyMesh(mesh, count, kind, xmin, pw) {
    const src = mesh.geometry.toNonIndexed();
    const pos = src.attributes.position;
    const nrm = src.attributes.normal;
    const uv = src.attributes.uv;
    const nTri = pos.count / 3;
    const cx = new Float32Array(nTri);
    for (let i = 0; i < nTri; i++) {
      cx[i] = (pos.getX(i * 3) + pos.getX(i * 3 + 1) + pos.getX(i * 3 + 2)) / 3;
    }
    const groups = [];
    for (let k = 0; k < count; k++) groups.push([]);
    if (kind === 'white') {
      for (let i = 0; i < nTri; i++) {
        let k = Math.floor((cx[i] - xmin) / pw);
        if (k < 0) k = 0; else if (k >= count) k = count - 1;
        groups[k].push(i);
      }
    } else {
      const centers = [];
      for (let k = 0; k < count; k++) centers.push(xmin + this._blackBoundary(k) * pw);
      for (let i = 0; i < nTri; i++) {
        let best = 0, bd = Infinity;
        for (let k = 0; k < count; k++) {
          const d = Math.abs(cx[i] - centers[k]);
          if (d < bd) { bd = d; best = k; }
        }
        groups[best].push(i);
      }
    }
    const out = [];
    for (let k = 0; k < count; k++) {
      const tris = groups[k];
      const g = new THREE.BufferGeometry();
      const vc = tris.length * 3;
      const p = new Float32Array(vc * 3);
      const nn = new Float32Array(vc * 3);
      const uu = uv ? new Float32Array(vc * 2) : null;
      for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        for (let v = 0; v < 3; v++) {
          const si = t * 3 + v;
          p[(i * 3 + v) * 3] = pos.getX(si); p[(i * 3 + v) * 3 + 1] = pos.getY(si); p[(i * 3 + v) * 3 + 2] = pos.getZ(si);
          nn[(i * 3 + v) * 3] = nrm.getX(si); nn[(i * 3 + v) * 3 + 1] = nrm.getY(si); nn[(i * 3 + v) * 3 + 2] = nrm.getZ(si);
          if (uu) { uu[(i * 3 + v) * 2] = uv.getX(si); uu[(i * 3 + v) * 2 + 1] = uv.getY(si); }
        }
      }
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
      if (uu) g.setAttribute('uv', new THREE.BufferAttribute(uu, 2));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      out.push(g);
    }
    return out;
  }

  _measureKeybed(white, black) {
    const wb = new THREE.Box3().setFromObject(white);
    let xMin = wb.min.x, xMax = wb.max.x;
    const zFront = wb.max.z, zBackFull = wb.min.z;
    const yTop = wb.max.y, yBottom = wb.min.y;
    let blackTop = yTop;
    if (black) {
      const bb = new THREE.Box3().setFromObject(black);
      blackTop = bb.max.y;
      xMin = Math.min(xMin, bb.min.x); xMax = Math.max(xMax, bb.max.x);
    }
    let zVisBack = zBackFull + (zFront - zBackFull) * 0.55;
    const fallboard = this._findByPrefix(this.modelGroup, 'Fall_Board')[0];
    if (fallboard) {
      const fb = new THREE.Box3().setFromObject(fallboard);
      const faceZ = fb.min.z;
      const minBack = zBackFull + (zFront - zBackFull) * 0.30;
      const maxBack = zFront - (zFront - zBackFull) * 0.15;
      if (faceZ > minBack && faceZ < maxBack) zVisBack = faceZ;
    }
    return { xMin, xMax, zFront, zBackFull, zVisBack, yTop, yBottom, blackTop, span: xMax - xMin };
  }

  _buildKeysFromModel() {
    const white = this._findByPrefix(this.modelGroup, 'White_Keys')[0];
    const black = this._findByPrefix(this.modelGroup, 'Black_Keys')[0];
    if (!white) throw new Error('no white keys');

    white.geometry.computeBoundingBox();
    const wbb = white.geometry.boundingBox;
    const pw = (wbb.max.x - wbb.min.x) / 52;
    const xmin = wbb.min.x;
    this.keyW = pw;
    this.keyH = Math.max(0.02, wbb.max.z - wbb.min.z); // local z = world height (keys stand up via node rotation)

    // world-space keybed measurements (before removing meshes)
    this.kb = this._measureKeybed(white, black);
    this.keyLen = Math.max(0.01, this.kb.zFront - this.kb.zVisBack);

    // note -> slot mapping (A0 = white slot 0 .. C8)
    const noteToSlot = new Array(NOTE1 + 1).fill(null);
    let wi = 0, bi = 0;
    for (let n = NOTE0; n <= NOTE1; n++) {
      noteToSlot[n] = WHITE_NOTES.has(n % 12) ? { kind: 'white', slot: wi++ } : { kind: 'black', slot: bi++ };
    }

    // split original merged meshes into per-key geometries (identical shapes/positions)
    const wParts = this._splitKeyMesh(white, 52, 'white', xmin, pw);
    const bParts = black ? this._splitKeyMesh(black, 36, 'black', xmin, pw) : [];

    // group carries the ORIGINAL mesh transform — keys stay exactly in place
    const parent = white.parent;
    const group = new THREE.Group();
    group.position.copy(white.position);
    group.quaternion.copy(white.quaternion);
    group.scale.copy(white.scale);
    group.name = 'keysGroup';
    if (parent) {
      parent.remove(white);
      if (black && black.parent) parent.remove(black);
      parent.add(group);
    } else {
      this.modelGroup.add(group);
    }
    // drop the empty scene-level group
    if (this.keysGroup && this.keysGroup.parent === this.scene) this.scene.remove(this.keysGroup);
    this.keysGroup = group;
    this._keysBaseX = group.position.x;

    // press direction in group-local space (robust to any model orientation)
    const wq = group.getWorldQuaternion(new THREE.Quaternion()).invert();
    this._downVec.set(0, -1, 0).applyQuaternion(wq).normalize();

    // White keys: glossy lacquered ivory via PBR clearcoat + fine grain bump
    // (pressing must NEVER change colour/appearance). Black keys: satin-matte
    // (slight sheen, no reflection of other objects — user requirement).
    const wBump = this._keyTexture(true);
    const bBump = this._keyTexture(false);
    const whiteMat = this._glossMaterial(white.material, { r: 0.11, cc: 1.0, ccr: 0.045, env: 1.15, bump: wBump, bumpS: 0.35 });
    const blackMat = this._glossMaterial(black ? black.material : null, { r: 0.42, cc: 0.10, ccr: 0.3, env: 0.28, bump: bBump, bumpS: 0.5 });

    for (let n = NOTE0; n <= NOTE1; n++) {
      const st = noteToSlot[n];
      const geo = st.kind === 'white' ? wParts[st.slot] : (bParts[st.slot] || wParts[0]);
      const mesh = new THREE.Mesh(geo, st.kind === 'white' ? whiteMat : blackMat);
      mesh.name = 'key_' + n;
      mesh.userData.note = n;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      this.keys[n] = {
        note: n, white: st.kind === 'white', mesh,
        basePos: mesh.position.clone(),
        pressed: 0, target: 0, vel: 0, dir: 0, releaseTime: 0,
      };      this.keyByMesh.set(mesh, this.keys[n]);
    }
  }

  // ---------- pedals (in place — no re-parenting, original positions preserved) ----------
  _setupPedals() {
    const targets = [
      ['Left_SustainPedal', 'soft'],
      ['Middle_Sustain_Pedal', 'sostenuto'],
      ['Right_Sustain_Pedal', 'sustain'],
    ];
    for (const [prefix, name] of targets) {
      const meshes = this._findByPrefix(this.modelGroup, prefix);
      if (!meshes.length) continue;
      const mesh = meshes[0];
      const down = new THREE.Vector3(0, -1, 0);
      if (mesh.parent) {
        down.applyQuaternion(mesh.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
      }
      this.pedals[name] = {
        mesh, basePos: mesh.position.clone(), baseRotX: mesh.rotation.x, down,
        angle: 0, target: 0,
      };
    }
  }

  setPedal(name, down) {
    const p = this.pedals[name];
    if (p) p.target = down ? 1 : 0;
  }

  setUnaCorda(down) {
    this.unaCorda = down;
  }

  // ---------- key animation control (straight vertical press, physics spring) ----------
  keyDown(note, vel) {
    const k = this.keys[note];
    if (!k) return;
    const depth = (this.keyH || 0.026) * (0.08 + 0.26 * (vel / 127));
    k.target = depth;
    k.dir = 1;   // explicit direction intent (press): spring uses press params
    // IMPORTANT: k.vel is the SPRING velocity in m/s. Never assign the MIDI
    // velocity value here — a stray value (e.g. 90) would fling the key out
    // of the keyboard. The spring re-seats velocity naturally.
    k.releaseTime = 0;
  }

  keyUp(note) {
    const k = this.keys[note];
    if (k) { k.target = 0; k.dir = 0; k.releaseTime = performance.now(); }
  }

  allKeysUp() {
    for (const k of this.keys) if (k) { k.target = 0; k.dir = 0; }
  }

  // ---------- pointer interaction (per-pointerId: supports multi-touch chords) ----------
  _bindPointer() {
    const el = this.canvas;
    this._ptrs = new Map(); // pointerId -> current note (-1 = none)
    el.addEventListener('pointerdown', (e) => {
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or non-capturable pointer */ }
      this._ptrs.set(e.pointerId, -1);
      this._hit(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (this._ptrs.has(e.pointerId)) this._hit(e);
    });
    const up = (e) => {
      if (!this._ptrs.has(e.pointerId)) return;
      const n = this._ptrs.get(e.pointerId);
      this._ptrs.delete(e.pointerId);
      if (n >= 0) {
        if (this.cb.onNoteOff) this.cb.onNoteOff(n);
        this.keyUp(n);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _hit(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    // 3D pedals first — click toggles pedal state (same as UI pedal buttons)
    for (const name in this.pedals) {
      const p = this.pedals[name];
      if (!p || !p.mesh) continue;
      const phits = this.raycaster.intersectObject(p.mesh, false);
      if (phits.length) {
        const down = !(p.target > 0.5);
        if (this.cb.onPedalRequest) this.cb.onPedalRequest(name, down);
        return;
      }
    }

    // keys
    const meshes = [];
    for (const n in this.keys) if (this.keys[n]) meshes.push(this.keys[n].mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (document.body && this._hitDebug) {
      document.body.setAttribute('data-hit', JSON.stringify({
        hit: hits.length,
        first: hits.length ? hits[0].object.name : 'none',
        ndc: [ndc.x.toFixed(3), ndc.y.toFixed(3)],
        cam: [this.camera.position.x.toFixed(2), this.camera.position.y.toFixed(2), this.camera.position.z.toFixed(2)],
      }));
    }
    if (!hits.length) return;
    const key = this.keyByMesh.get(hits[0].object);
    if (!key) return;

    const worldZ = hits[0].point.z;
    const kb = this.kb;
    const norm = THREE.MathUtils.clamp((worldZ - kb.zVisBack) / Math.max(1e-5, this.keyLen), 0, 1);
    const v = Math.round(60 + 67 * Math.pow(norm, 1.15) + (Math.random() * 6 - 3));

    const pid = e.pointerId !== undefined ? e.pointerId : 1;
    if (this._ptrs.get(pid) === key.note) return;
    const prev = this._ptrs.get(pid);
    if (prev >= 0) {
      if (this.cb.onNoteOff) this.cb.onNoteOff(prev);
      this.keyUp(prev);
    }
    this._ptrs.set(pid, key.note);
    if (this.cb.onNoteOn) this.cb.onNoteOn(key.note, THREE.MathUtils.clamp(v, 1, 127));
    this.keyDown(key.note, v);
  }

  // ---------- mirror reflections ----------
  // User requirements:
  //  - Black piano body: glossy lacquer MIRROR with attenuation (参照实拍双手倒影).
  //  - Black keys: MATTE, must not reflect other objects.
  //  - White keys: glossy ivory via PBR clearcoat only (pressing must not change colour).
  //  - NO floor mirror.
  // Physical planar mirror: the reflector plane must coincide with the mirror
  // surface; the mirrored object is at the SAME perpendicular distance behind
  // the plane as the real object in front (Reflector's oblique projection does
  // this exactly). Plane normal faces the player (+z toward camera).
  _buildReflectors() {
    const fb = this._findByPrefix(this.modelGroup, 'Fall_Board')[0];
    if (!fb) return;
    const fbb = new THREE.Box3().setFromObject(fb);
    const fw = fbb.max.x - fbb.min.x, fh = fbb.max.y - fbb.min.y;
    if (fw < 0.01 || fh < 0.01) return;
    // MODEL RESTORED: the black fallboard shell keeps its ORIGINAL transform,
    // orientation and material — never hidden, moved, re-parented or flipped
    // (user: 模型复原, 不许改动模型). The shell sits behind the gold logo,
    // toward the strings.
    fb.visible = true;
    // Independent mirror plane, flush with the fallboard FRONT surface
    // (z ≈ 0.817), full height, lower edge exactly at the white-key top
    // surface (y ≈ 0.736) so no key is ever cut by the mirror. Reflects
    // toward the PLAYER (+z, toward the user — rejected inward reflection).
    const keyTop = 0.736; // White_Keys.002 top surface (panel probe)
    const y0 = Math.max(fbb.min.y, keyTop);
    const y1 = fbb.max.y;
    const fw2 = fw * 0.995, fh2 = y1 - y0;
    if (fh2 < 0.01) return;
    const fbRef = new Reflector(new THREE.PlaneGeometry(fw2, fh2), {
      clipBias: 0.0008, textureWidth: 768, textureHeight: 768, color: 0xffffff,
    });
    fbRef.position.set((fbb.min.x + fbb.max.x) / 2, (y0 + y1) / 2, fbb.max.z + 0.001);
    // reflection faces the player: PlaneGeometry normal is +z, no flip.
    fbRef.material.transparent = true;
    fbRef.material.depthWrite = false;
    // black-lacquer attenuated mirror: dim reflection + dark body tint
    fbRef.material.uniforms.opacity.value = 0.45;
    fbRef.renderOrder = 19;
    this.scene.add(fbRef);
    this.fbReflector = fbRef;
    this._mirrorDefault = fbRef.position.clone();
    this._fbRefInfo = { frontZ: fbb.max.z, keyTop: keyTop };
  }
  // ---- mirror position editor (user-adjustable, persisted) ----
  getMirror() { return this.fbReflector || null; }
  // ---- user view sliders (azimuth / elevation / distance) ----
  setView(azDeg, elDeg, dist) {
    this._camAz = azDeg; this._camEl = elDeg; this._camDist = dist;
    if (!this.controls || !this.controls.target) return;
    const t = this.controls.target;
    const el = elDeg * Math.PI / 180;
    const az = azDeg * Math.PI / 180;
    const r = Math.max(0.5, dist);
    this.camera.position.set(
      t.x + Math.sin(az) * Math.cos(el) * r,
      t.y + Math.sin(el) * r,
      t.z + Math.cos(az) * Math.cos(el) * r
    );
  }
  getView() {
    if (!this.camera || !this.controls || !this.controls.target) return { az: 0, el: 0, dist: 2.6 };
    const rel = this.camera.position.clone().sub(this.controls.target);
    const dist = rel.length();
    const az = (Math.atan2(rel.x, rel.z) * 180 / Math.PI + 360) % 360;
    const el = Math.asin(Math.max(-1, Math.min(1, rel.y / Math.max(1e-6, dist)))) * 180 / Math.PI;
    return { az: Math.round(az), el: Math.round(el), dist: Math.round(dist * 100) };
  }
  getMirrorOffset() {
    const m = this.getMirror();
    if (!m || !this._mirrorDefault) return { x: 0, y: 0, z: 0 };
    return {
      x: m.position.x - this._mirrorDefault.x,
      y: m.position.y - this._mirrorDefault.y,
      z: m.position.z - this._mirrorDefault.z,
    };
  }
  applyMirrorOffset(dx, dy, dz) {
    const m = this.getMirror();
    if (!m || !this._mirrorDefault) return;
    m.position.set(this._mirrorDefault.x + dx, this._mirrorDefault.y + dy, this._mirrorDefault.z + dz);
  }

  // ---------- user light control ----------
  setLightDir(azRad, elRad) {
    this._lightAz = azRad;
    this._lightEl = Math.max(0.08, Math.min(1.45, elRad));
    this._applyLight();
  }
  setLightColor(hex) { this._lightColor = hex; this.keyLight.color.set(hex); }
  setLightIntensity(v) {
    this._lightIntensity = Math.max(0, Math.min(4, v));
    this.keyLight.intensity = this._lightIntensity;
  }
  _applyLight() {
    if (!this.keyLight) return;
    let cx = 0, cy = 0, cz = 0, ls = 1;
    try {
      const bb = new THREE.Box3().setFromObject(this.modelGroup);
      if (!bb.isEmpty()) {
        const c = bb.getCenter(new THREE.Vector3());
        cx = c.x; cy = c.y; cz = c.z;
        ls = Math.max(bb.getSize(new THREE.Vector3()).x, bb.getSize(new THREE.Vector3()).z, 0.4);
      }
    } catch (e) { /* keep defaults */ }
    const dist = 2.0 * ls;
    const ce = Math.cos(this._lightEl);
    this.keyLight.position.set(
      cx + Math.sin(this._lightAz) * ce * dist,
      cy + Math.sin(this._lightEl) * dist,
      cz + Math.cos(this._lightAz) * ce * dist
    );
    this.keyLight.target.position.set(cx, cy, cz);
    this.scene.add(this.keyLight.target);
    // fill light opposite the key light, softer
    this.fillLight.position.set(
      cx - Math.sin(this._lightAz) * ce * dist * 0.7,
      cy + 0.6 * ls,
      cz - Math.cos(this._lightAz) * ce * dist * 0.7
    );
  }

  // ---------- framing ----------
  _autoFrame() {
    const bb = new THREE.Box3().setFromObject(this.modelGroup);
    if (bb.isEmpty()) return;
    const c = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const s = Math.max(size.x, size.z, 0.4);
    const y0 = bb.min.y;
    const fy = y0 - 0.02 * s;
    this.floor.position.y = fy;
    if (this.floorBase) this.floorBase.position.y = fy - 0.001;
    const fs = Math.max(2.4, s * 0.8);
    this.floor.scale.setScalar(fs);
    if (this.floorBase) this.floorBase.scale.setScalar(fs);

    // Frame from the player's perspective: anchor on the keyboard area so the
    // front pedals (in the model at z≈0.8) stay visible near the bottom edge.
    let ax = c.x, ay = c.y, az = c.z, ar = s;
    try {
      const kwb = new THREE.Box3().setFromObject(this.keysGroup);
      if (!kwb.isEmpty()) {
        const kc = kwb.getCenter(new THREE.Vector3());
        ax = kc.x; ay = kc.y; az = kc.z;
        ar = Math.max(s * 0.9, kwb.getSize(new THREE.Vector3()).x * 1.35);
      }
    } catch (e) { /* keep model center */ }
    const dist = Math.max(ar * 1.18, 2.3);
    this.controls.target.set(ax, ay + 0.16, az + 0.42);
    // low eye level (near seated player): piano sits close to the bottom edge
    // of the view — no "floating" look. Pedals stay visible at the bottom.
    this.camera.position.set(ax + ar * 0.02, ay + dist * 0.38, az + dist * 0.98);
    this.camera.near = Math.max(0.002, s * 0.002);
    this.camera.far = s * 20;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = s * 0.12;
    this.controls.maxDistance = s * 6;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    const ls = s;
    this._applyLight();
    this.keyLight.shadow.camera.left = -1.1 * ls; this.keyLight.shadow.camera.right = 1.1 * ls;
    this.keyLight.shadow.camera.top = 1.1 * ls; this.keyLight.shadow.camera.bottom = -1.1 * ls;
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.spot.position.set(0, 1.1 * ls, 0.25 * ls);
    this.spot.target.position.set(c.x, c.y, c.z);
    this.scene.add(this.spot.target);
    // Sync OrbitControls internal state so the camera does not slide after framing
    this.controls.update();
  }

  // ---------- quality ----------
  setQuality(level, auto) {
    this.quality.target = level;
    this.quality.auto = auto !== false;
    // apply IMMEDIATELY — previously only `target` changed and `level` stayed
    // at the old value, so switching quality did nothing visible.
    this.quality.level = level;
    this._applyQuality();
  }

  _applyQuality() {
    const q = this.quality;
    const r = this.renderer;
    this.qLevel = q.level;
    // level 4 = 极致 ULTRA (highest realism): full devicePixelRatio, 2048px
    // shadows, 1024px mirror, max environment — an approximation of path
    // traced realism on WebGL (soft shadows + high-res lacquer + strong IBL).
    const cap = { 4: Math.max(2, window.devicePixelRatio || 1), 3: 1.5, 2: 1.0, 1: 0.85, 0: 0.75 };
    const pr = Math.min(cap[q.level] || cap[0], 2.5);
    if (Math.abs(pr - q.pixelRatio) > 0.01) {
      q.pixelRatio = pr;
      r.setPixelRatio(pr);
      // setPixelRatio alone does NOT resize the drawing buffer — call
      // setSize so the quality switch visibly changes resolution (fixes
      // "切换画质没反应").
      r.setSize(window.innerWidth, window.innerHeight, false);
    }
    const sizes = { 4: 1024, 3: 768, 2: 640, 1: 512, 0: 384 };
    const msz = sizes[q.level] || sizes[0];
    const rate = q.level >= 4 ? 1 : (q.level >= 3 ? 1 : 2);
    if (this.floor) this.floor.visible = true;
    // ULTRA only: glossy porcelain-tile mirror sheen (attenuated reflection).
    // Lower qualities keep the plain matte-white tiled floor.
    if (this.floorReflector) this.floorReflector.visible = q.level >= 4;
    if (this.fbReflector) { this.fbReflector.visible = true; this.fbReflector.setTextureSize(msz, msz); this.fbReflector.reflectionRate = rate; }
    // shadows degrade first; ULTRA uses 2048px soft-ish shadow map
    r.shadowMap.enabled = q.level >= 2;
    const sm = q.level >= 4 ? 2048 : (q.level >= 3 ? 1024 : (q.level >= 2 ? 512 : 256));
    this.keyLight.shadow.mapSize.set(sm, sm);
    if (this.keyLight.shadow.map) this.keyLight.shadow.map.dispose();
    this.keyLight.shadow.map = null;
    // ULTRA: lift the environment so the lacquer reads photoreal
    if (this.hemi) {
      this.hemi.intensity = q.level >= 4 ? 0.85 : 0.55;
    }
  }

  // ---------- loop ----------
  _animateKeys(dt) {
    // Physically-mechanical key action via a spring-damper system:
    //   pressing  — stiff, near-critically damped (fast & clean, ~95ms to seat)
    //   releasing — slightly UNDER-damped: the key bounces past the rest
    //               position with a weak 1-2 oscillation, then settles
    //               (visible "回弹起跳" micro-vibration, mechanical feel).
    // Semi-implicit Euler with fixed sub-steps keeps it stable at any dt.
    const h = Math.min(0.02, dt);
    const steps = Math.max(1, Math.ceil(dt / h));
    for (const k of this.keys) {
      if (!k) continue;
      for (let s = 0; s < steps; s++) {
        // Direction comes from explicit intent (dir), NOT from the sign of
        // (target - pressed): an under-damped release momentarily crosses the
        // rest position (pressed < 0), and comparing to target would flip us
        // into press-mode and kill the visible bounce.
        const pressing = k.dir === 1;
        // press: slightly slower, mechanical (st 900 / dm 72 → ~160ms travel)
        const st = pressing ? 900 : 400;
        // release damping ratio ≈ 0.32 (more under-damped than before so the
        // key bounces PAST rest with a clearly visible micro-overshoot and
        // 1-2 oscillations — "回弹起跳" mechanical vibration, and a touch
        // slower than before as requested)
        const dm = pressing ? 72 : 13;
        k.vel += (st * (k.target - k.pressed) - dm * k.vel) * h;
        k.pressed += k.vel * h;
        // hard clamps: never let a numeric glitch fling a key out of the group
        k.vel = Math.max(-8, Math.min(8, k.vel));
        k.pressed = Math.max(-0.06, Math.min(1.5, k.pressed));
      }
      if (k.target === 0 && Math.abs(k.pressed) < 0.0003 && Math.abs(k.vel) < 0.0006) {
        k.pressed = 0; k.vel = 0;
      }
      k.mesh.position.copy(k.basePos).addScaledVector(this._downVec, k.pressed);
    }
    // una corda: whole keyboard shifts clearly along its axis (soft pedal)
    const targetShift = this.unaCorda ? (this.keyW || 0.02) * 0.28 : 0;
    this.unaCordaShift += (targetShift - this.unaCordaShift) * (1 - Math.exp(-dt / 0.05));
    if (Math.abs(targetShift - this.unaCordaShift) < 1e-6) this.unaCordaShift = targetShift;
    this.keysGroup.position.x = this._keysBaseX + this.unaCordaShift;
    // pedals (in place): pure downward press — never tilt upward
    for (const name in this.pedals) {
      const p = this.pedals[name];
      if (!p || !p.mesh) continue;
      p.angle += (p.target - p.angle) * (1 - Math.exp(-dt / 0.03));
      if (Math.abs(p.target - p.angle) < 0.001) p.angle = p.target;
      p.mesh.position.copy(p.basePos).addScaledVector(p.down, p.angle * 0.006);
    }
  }

  start() {
    const loop = () => {
      if (this._dead) return;
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, this.clock.getDelta());
      this._animateKeys(dt);
      this.controls.update();
      this._updateFps();
      if (this._useComposer && this.composer) this.composer.render();
      else if (this.renderer) this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }

  // user-controlled bloom intensity (0..~1.5); 0 bypasses the composer
  // entirely so the normal (fast) render path is used.
  setBloom(v) {
    this._bloom = v;
    if (!this.bloomPass) return;
    this.bloomPass.strength = v;
    this.bloomPass.enabled = v > 0.001;
    this._useComposer = v > 0.001;
  }

  _updateFps() {
    const now = performance.now();
    const inst = 1000 / Math.max(1, now - this.fps.last);
    this.fps.last = now;
    this.fps.ema = this.fps.ema * 0.94 + inst * 0.06;
    const el = document.getElementById('fps');
    if (el) el.textContent = Math.round(this.fps.ema);
    if (document.body && (!this._pedalProbe || now - this._pedalProbe > 2000)) {
      this._pedalProbe = now;
      const arr = ['cam=' + this.camera.position.x.toFixed(2) + ',' + this.camera.position.y.toFixed(2) + ',' + this.camera.position.z.toFixed(2),
                   'tgt=' + this.controls.target.x.toFixed(2) + ',' + this.controls.target.y.toFixed(2) + ',' + this.controls.target.z.toFixed(2)];
      for (const name in this.pedals) {
        const p = this.pedals[name];
        if (p && p.mesh) {
          const g = p.mesh.geometry;
          if (!g.boundingBox) g.computeBoundingBox();
          const c = g.boundingBox.getCenter(new THREE.Vector3());
          p.mesh.localToWorld(c);
          const nd = c.clone().project(this.camera);
          arr.push(name + '@' + c.x.toFixed(2) + ',' + c.y.toFixed(2) + ',' + c.z.toFixed(2) + '|' + nd.x.toFixed(3) + ',' + nd.y.toFixed(3));
        }
      }
      // live key-row projection for automation (note 60 center)
      const k60 = this.keys[60];
      if (k60 && k60.mesh.geometry) {
        if (!k60.mesh.geometry.boundingBox) k60.mesh.geometry.computeBoundingBox();
        const kc = k60.mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
        k60.mesh.localToWorld(kc);
        const knd = kc.clone().project(this.camera);
        arr.push('key60@' + knd.x.toFixed(3) + ',' + knd.y.toFixed(3));
      }
      // fallboard world bbox (mirror plane geometry reference)
      const fbs = this._findByPrefix(this.modelGroup, 'Fall_Board');
      if (fbs.length) {
        const fb = new THREE.Box3().setFromObject(fbs[0]);
        arr.push('fb@min=' + fb.min.x.toFixed(3) + ',' + fb.min.y.toFixed(3) + ',' + fb.min.z.toFixed(3) +
                 ' max=' + fb.max.x.toFixed(3) + ',' + fb.max.y.toFixed(3) + ',' + fb.max.z.toFixed(3));
        if (this._fbRefInfo) arr.push('fz=' + this._fbRefInfo.frontZ.toFixed(3) + ' nF=' + this._fbRefInfo.nF);
      }
      const kwb2 = this.keysGroup ? new THREE.Box3().setFromObject(this.keysGroup) : null;
      if (kwb2 && !kwb2.isEmpty()) {
        arr.push('kb@min=' + kwb2.min.x.toFixed(3) + ',' + kwb2.min.y.toFixed(3) + ',' + kwb2.min.z.toFixed(3) +
                 ' max=' + kwb2.max.x.toFixed(3) + ',' + kwb2.max.y.toFixed(3) + ',' + kwb2.max.z.toFixed(3));
      }
      document.body.setAttribute('data-pedalproj', arr.join(' '));
    }
    // high-frequency key-animation probe for automation (note 60 pressed, 4 dp)
    if (document.body && this.keys[60] && (!this._keyProbe || now - this._keyProbe > 30)) {
      this._keyProbe = now;
      document.body.setAttribute('data-keyanim', this.keys[60].pressed.toFixed(4) + '|' + this.keys[60].vel.toFixed(4) + '|' + this.keys[60].target.toFixed(2));
    }
    this._autoQuality();
  }

  _autoQuality() {
    const q = this.quality;
    if (!q.auto) return;
    const f = this.fps.ema;
    if (f < 32) { q.lowT += 1; q.highT = 0; } else if (f > 45) { q.highT += 1; q.lowT = 0; } else { q.lowT = 0; q.highT = 0; }
    if (q.lowT > 25 && q.level > 0) {
      q.level -= 1; q.lowT = 0;
      this._applyQuality();
      if (this.cb.onQuality) this.cb.onQuality(q.level, true);
    } else if (q.highT > 300 && q.level < q.target) {
      q.level += 1; q.highT = 0;
      this._applyQuality();
      if (this.cb.onQuality) this.cb.onQuality(q.level, false);
    }
  }

  _resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
  }

  dispose() {
    this._dead = true;
    if (this.renderer) this.renderer.dispose();
  }

  // ---------- fallback procedural piano (only when model unavailable) ----------
  _generateKeys(kb) {
    const W = (kb.xMax - kb.xMin) / 52;
    const keyLen = Math.max(W * 1.2, kb.zFront - kb.zVisBack);
    const Hw = Math.max(0.016, (kb.yTop - kb.yBottom) * 0.5);
    const blackL = keyLen * 0.68;
    const blackW = W * 0.58;
    const blackH = Hw * 1.9;
    const wGeo = new THREE.BoxGeometry(W * 0.985, Hw, keyLen);
    const bGeo = new THREE.BoxGeometry(blackW, blackH, blackL);
    const whiteMat = new THREE.MeshPhysicalMaterial({ color: 0xf5f3ee, roughness: 0.26, clearcoat: 0.9, clearcoatRoughness: 0.10, envMapIntensity: 1.25, side: THREE.DoubleSide });
    const blackMat = new THREE.MeshPhysicalMaterial({ color: 0x101013, roughness: 0.30, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 1.1, side: THREE.DoubleSide });
    this._downVec.set(0, -1, 0);
    this.keyH = Hw;
    let whiteIndex = 0;
    for (let note = NOTE0; note <= NOTE1; note++) {
      const white = WHITE_NOTES.has(note % 12);
      const mesh = new THREE.Mesh(white ? wGeo : bGeo, white ? whiteMat : blackMat);
      let x;
      if (white) {
        x = kb.xMin + W * (whiteIndex + 0.5);
        whiteIndex++;
      } else {
        let cnt = 0;
        for (let n = NOTE0; n < note; n++) if (WHITE_NOTES.has(n % 12)) cnt++;
        x = kb.xMin + W * cnt;
      }
      mesh.position.set(
        x,
        kb.yBottom + (white ? Hw / 2 : blackH / 2),
        white ? kb.zVisBack + keyLen / 2 : kb.zVisBack + blackL * 0.78
      );
      mesh.userData.note = note;
      mesh.castShadow = false;
      this.keysGroup.add(mesh);
      this.keys[note] = {
        note, white, mesh,
        basePos: mesh.position.clone(),
        pressed: 0, target: 0, vel: 0, dir: 0, releaseTime: 0,
      };
      this.keyByMesh.set(mesh, this.keys[note]);
    }
    this.keyW = W;
    this.keyLen = keyLen;
    this.kb = kb;
  }

  _buildFallbackPiano() {
    const W = 0.0235;
    const xMin = -52 * W / 2;
    const xMax = 52 * W / 2;
    const zFront = 0.26, zBack = 0.0, yTop = 0.02, yBottom = -0.005;
    const kb = { xMin, xMax, zFront, zBackFull: zBack, zVisBack: zBack + 0.14, yTop, yBottom, blackTop: yTop + 0.012, span: xMax - xMin };
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0x0d0c0b, roughness: 0.10, clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.35, side: THREE.DoubleSide });
    const woodMat = new THREE.MeshPhysicalMaterial({ color: 0x2a1d14, roughness: 0.6, side: THREE.DoubleSide });
    const brassMat = new THREE.MeshPhysicalMaterial({ color: 0x9c7b3a, roughness: 0.26, metalness: 0.85, envMapIntensity: 1.6, side: THREE.DoubleSide });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.32, 0.62), bodyMat);
    body.position.set(0, 0.02, -0.18); body.castShadow = true;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 2.0), bodyMat);
    tail.position.set(0, 0.10, -1.45); tail.castShadow = true;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.02, 1.9), bodyMat);
    lid.position.set(0, 0.42, -1.45); lid.rotation.x = -0.42; lid.castShadow = true;
    const keybed = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.06, 0.34), bodyMat);
    keybed.position.set(0, 0.005, 0.27); keybed.castShadow = true;
    const fallboard = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.42, 0.03), bodyMat);
    fallboard.position.set(0, 0.26, 0.42); fallboard.castShadow = true;
    const rack = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.16, 0.02), woodMat);
    rack.position.set(0, 0.55, 0.50); rack.rotation.x = 0.5;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.05, 0.5), bodyMat);
    frame.position.set(0, 0.30, -0.28);
    for (const m of [body, tail, lid, keybed, fallboard, rack, frame]) {
      m.castShadow = true; this.modelGroup.add(m);
    }
    for (const [lx, lz] of [[-0.72, 0.28], [0.72, 0.28], [0, -2.2]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.9, 12), bodyMat);
      leg.position.set(lx, -0.45, lz); leg.castShadow = true; this.modelGroup.add(leg);
    }
    for (const [lx, lz] of [[-0.72, 0.28], [0.72, 0.28], [0, -2.2]]) {
      const wl = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), brassMat);
      wl.position.set(lx, -0.92, lz); this.modelGroup.add(wl);
    }
    // pedals (in place, translation press)
    const pedalDefs = [
      { x: -0.36, name: 'soft' }, { x: 0.0, name: 'sostenuto' }, { x: 0.36, name: 'sustain' },
    ];
    for (const pd of pedalDefs) {
      const ped = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.16), brassMat);
      ped.position.set(pd.x, -0.44, 0.40);
      this.scene.add(ped);
      this.pedals[pd.name] = {
        mesh: ped, basePos: ped.position.clone(), baseRotX: 0, down: new THREE.Vector3(0, -1, 0),
        angle: 0, target: 0,
      };
    }
    // strings hint
    const stringMat = new THREE.MeshPhysicalMaterial({ color: 0x8a8578, roughness: 0.2, metalness: 0.9, side: THREE.DoubleSide });
    for (let i = 0; i < 60; i++) {
      const str = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 1.7, 4), stringMat);
      str.position.set(-0.5 + (i / 59) * 1.0, 0.02, -1.4);
      str.rotation.x = Math.PI / 2;
      this.modelGroup.add(str);
    }
    this._generateKeys(kb);
    this._keysBaseX = 0;
  }
}
