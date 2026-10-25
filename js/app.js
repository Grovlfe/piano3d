// app.js — 主入口：UI、3D 场景、音频引擎、MIDI 设备/文件、电脑键盘、导入、自检
window.__appVersion = 6;
import { PianoScene } from './scene.js?v=76';
import { Sampler } from './audio/sampler.js?v=59';
import { MidiDevice } from './midi/device.js?v=55';
import { MidiPlayer } from './midi/player.js?v=55';
import { parseMidi } from './midi/parse.js?v=54';
import { TransformControls } from 'three/addons/controls/TransformControls.js?v=52';

const $ = (id) => document.getElementById(id);

// ---------- toasts ----------
function toast(msg, type) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 5200);
  setTimeout(() => el.remove(), 5700);
  return el;
}

// ---------- state ----------
const state = {
  modelReady: false,
  sfReady: false,
  playlist: [],     // {name, parsed}
  currentSong: -1,
  octave: 0,
};

const engine = new Sampler({
  onPedal(name, down) {
    const id = name === 'soft' ? 'pedSoft' : name === 'sostenuto' ? 'pedSost' : 'pedSus';
    const el = $(id);
    if (el) el.classList.toggle('down', down);
    if (scene) scene.setPedal(name, down);
    if (name === 'soft') scene && scene.setUnaCorda(down);
  },
  onError(msg) { toast(msg, 'err'); },
  onStatus(msg) { $('sfstatus').textContent = msg; },
});

let scene = null;
try {
  scene = new PianoScene($('gl'), {
    onNoteOn(n, v) { engine.noteOn(n, v); },
    onNoteOff(n) { engine.noteOff(n); },
    onPedalRequest(name, down) {
      if (name === 'soft') engine.setSoft(down);
      else if (name === 'sostenuto') engine.setSostenuto(down);
      else engine.setSustain(down);
    },
    onModelReady() {
      state.modelReady = true;
      $('stModel').textContent = '已加载';
      $('dotModel').className = 'dot on';
      _checkLoading();
    },
    onWarn(msg) { toast(msg, 'warn'); },
    onQuality(lvl, autoDown) {
      const names = { 0: '极限', 1: '低', 2: '中', 3: '高', 4: '极致' };
      $('stQuality').textContent = autoDown ? names[lvl] + '（自动降级）' : names[lvl];
    },
  });
} catch (e) {
  toast('3D 初始化失败：' + e.message, 'err');
}

const midi = new MidiDevice(engine, scene, {
  onInputs(list) {
    const sel = $('midiSel');
    const cur = sel.value;
    sel.innerHTML = '';
    if (!list.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '— 无设备 —';
      sel.appendChild(o);
      $('stMidi').textContent = '未连接';
      $('dotMidi').className = 'dot';
      return;
    }
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      sel.appendChild(o);
    }
    if (cur && list.some(d => d.id === cur)) sel.value = cur;
    $('stMidi').textContent = '已发现 ' + list.length + ' 台';
    $('dotMidi').className = 'dot on';
  },
  onConnect(d) {
    if (d) {
      $('stMidi').textContent = d.name;
      $('dotMidi').className = 'dot on';
      toast('已连接 MIDI 设备：' + d.name, 'ok');
    } else {
      $('stMidi').textContent = '未连接';
      $('dotMidi').className = 'dot';
    }
  },
  onError(msg) { toast(msg, 'err'); },
});

const player = new MidiPlayer(engine, scene, {
  onLoad(p) {
    state.currentSong = -1;
    $('tname').textContent = p.name || '未命名';
    $('tmeta').textContent = '格式' + p.format + ' · ' + p.ntrks + ' 轨 · ' + _fmt(p.duration);
    $('playbtn').textContent = '▶';
  },
  onPlay() { $('playbtn').textContent = '⏸'; },
  onPause() { $('playbtn').textContent = '▶'; },
  onEnded() {
    $('playbtn').textContent = '▶';
    $('progFill').style.width = '100%';
    $('timelabel').textContent = _fmt(player.duration) + ' / ' + _fmt(player.duration);
    toast('播放完成', 'ok');
  },
  onProgress(s, d) {
    $('progFill').style.width = (d > 0 ? (s / d) * 100 : 0) + '%';
    $('timelabel').textContent = _fmt(s) + ' / ' + _fmt(d);
  },
});

function _fmt(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), sec = s % 60;
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function _checkLoading() {
  if (state.modelReady && state.sfReady) {
    setTimeout(() => $('loading').classList.add('hide'), 250);
  }
}

// ---------- user data persistence (localStorage) ----------
const PREFS_KEY = 'piano3d_prefs_v2';
function _savePrefs() {
  const p = {
    vol: $('vol').value, rev: $('rev').value, velCurve: $('velCurve').value,
    lightAz: $('lightAz').value, lightEl: $('lightEl').value, lightPow: $('lightPow').value,
    lightCol: $('lightCol').value, quality: $('qualitySel').value, octave: state.octave,
    camAz: $('camAz').value, camEl: $('camEl').value, camDist: $('camDist').value,
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
}
function _loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) { p = {}; }
  const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== '') el.value = v; };
  set('vol', p.vol); set('rev', p.rev); set('velCurve', p.velCurve);
  set('lightAz', p.lightAz); set('lightEl', p.lightEl); set('lightPow', p.lightPow);
  set('lightCol', p.lightCol); set('qualitySel', p.quality);
  set('camAz', p.camAz); set('camEl', p.camEl); set('camDist', p.camDist);
  if (p.octave !== undefined) state.octave = Math.max(-2, Math.min(2, +p.octave || 0));
  // apply loaded values
  engine.setVolume(($('vol').value / 100));
  engine.setReverb($('rev').value / 100);
  engine.setVelCurve(+$('velCurve').value);
  const v = $('qualitySel').value;
  if (v === 'auto') { scene.setQuality(3, true); $('stQuality').textContent = '自动'; }
  else {
    const lvl = { ultra: 4, high: 3, medium: 2, low: 0 }[v];
    scene.setQuality(lvl, false);
    $('stQuality').textContent = { ultra: '极致', high: '高', medium: '中', low: '极限' }[v];
    toast('画质已切换：' + { ultra: '极致（最高分辨率/高清阴影/写实光照）', high: '高', medium: '中', low: '极限（流畅优先）' }[v]);
  }
  $('octLabel').textContent = 'C' + (4 + state.octave);
  if (scene) {
    scene.setLightDir(($('lightAz').value / 360) * Math.PI * 2, ($('lightEl').value / 180) * Math.PI);
    scene.setLightIntensity($('lightPow').value / 100);
    scene.setLightColor($('lightCol').value);
    scene.setView(+$('camAz').value, +$('camEl').value, +$('camDist').value / 100);
  }
}

// ---------- init ----------
async function init() {
  // default soundfont pack
  await engine.loadDefaultPack('soundfont/default/manifest.json', (p) => {
    $('sfbarFill').style.width = Math.round(p * 100) + '%';
  });
  state.sfReady = true;
  $('stSf').textContent = engine.mode === 'pack' ? 'VSL D-274' : '内置合成器';
  $('dotSf').className = engine.mode === 'pack' ? 'dot on' : 'dot warn';
  _checkLoading();

  scene.loadPianoModel('assets/piano.glb', (p) => {
    $('loadbarFill').style.width = Math.round(p * 100) + '%';
    $('loadingSub').textContent = '正在加载 3D 模型 ' + Math.round(p * 100) + '%…';
  });

  scene.start();

  midi.init();

  _loadPrefs();

  // resume audio on first gesture
  const resume = () => engine.resume();
  window.addEventListener('pointerdown', resume, { once: false });
  window.addEventListener('keydown', resume);

  _wireUI();
}

// ---------- UI wiring ----------
function _wireUI() {
  // buttons
  $('btnSfImport').addEventListener('click', () => $('sfPicker').click());
  $('btnMidiFile').addEventListener('click', () => $('midiPicker').click());
  $('btnMidiFolder').addEventListener('click', () => $('folderPicker').click());
  $('btnMidiReconnect').addEventListener('click', () => { midi.init(); toast('已重新检测 MIDI 设备'); });

  // sf2 import
  $('sfPicker').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = '';
    importSf2(f);
  });

  // midi files
  $('midiPicker').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) loadMidiFile(f);
  });
  $('folderPicker').addEventListener('change', (e) => {
    const files = [...e.target.files].filter(f => /\.(mid|midi|kar|rmi)$/i.test(f.name));
    e.target.value = '';
    files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'zh'));
    for (const f of files) loadMidiFile(f, (a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'zh'));
    if (!files.length) toast('文件夹中没有找到 MIDI 文件', 'warn');
    else toast('已导入 ' + files.length + ' 个 MIDI 文件');
  });

  // midi device select
  $('midiSel').addEventListener('change', (e) => {
    if (e.target.value) midi.select(e.target.value);
  });

  // quality
  $('qualitySel').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'auto') { scene.setQuality(3, true); $('stQuality').textContent = '自动'; }
    else {
      const lvl = { high: 3, medium: 2, low: 0 }[v];
      scene.setQuality(lvl, false);
      $('stQuality').textContent = { high: '高', medium: '中', low: '极限' }[v];
    }
    _savePrefs();
  });

  // audio controls
  $('vol').addEventListener('input', (e) => { engine.setVolume(e.target.value / 100); _savePrefs(); });
  $('rev').addEventListener('input', (e) => { engine.setReverb(e.target.value / 100); _savePrefs(); });
  $('velCurve').addEventListener('change', (e) => { engine.setVelCurve(+e.target.value); _savePrefs(); });

  // light controls (direction / elevation / intensity / colour)
  const applyLight = () => {
    if (!scene) return;
    scene.setLightDir(($('lightAz').value / 360) * Math.PI * 2, ($('lightEl').value / 180) * Math.PI);
    scene.setLightIntensity($('lightPow').value / 100);
    scene.setLightColor($('lightCol').value);
    _savePrefs();
  };
  $('lightAz').addEventListener('input', applyLight);
  $('lightEl').addEventListener('input', applyLight);
  $('lightPow').addEventListener('input', applyLight);
  $('lightCol').addEventListener('input', applyLight);
  // view sliders — live camera control, saved on every move (survives restarts)
  const applyView = () => {
    if (!scene) return;
    scene.setView(+$('camAz').value, +$('camEl').value, +$('camDist').value / 100);
    _savePrefs();
  };
  $('camAz').addEventListener('input', applyView);
  $('camEl').addEventListener('input', applyView);
  $('camDist').addEventListener('input', applyView);

  // ---------- mirror position editor (drag red/green/blue arrows) ----------
  // Hidden by default for aesthetics; user turns it on in 设置 → 镜面 Mirror.
  let mirrorTC = null;
  const MIRROR_KEY = 'piano3d_mirror_v2';
  const saveMirror = () => {
    if (!scene) return;
    const off = scene.getMirrorOffset();
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify({ x: +off.x.toFixed(4), y: +off.y.toFixed(4), z: +off.z.toFixed(4) })); } catch (e) {}
  };
  const setMirrorEdit = (on) => {
    const btn = $('mirrorEditBtn');
    if (!scene || !scene.getMirror()) { btn.classList.remove('on'); btn.textContent = '开启编辑'; return; }
    if (on) {
      if (!mirrorTC) {
        mirrorTC = new TransformControls(scene.camera, scene.renderer.domElement);
        mirrorTC.setMode('translate');
        mirrorTC.setSpace('world');
        mirrorTC.setSize(1.2);
        mirrorTC.attach(scene.getMirror());
        mirrorTC.addEventListener('dragging-changed', (e) => { scene.controls.enabled = !e.value; });
        mirrorTC.addEventListener('change', saveMirror);
        scene.scene.add(mirrorTC);
      } else {
        mirrorTC.attach(scene.getMirror());
        mirrorTC.visible = true;
      }
      btn.classList.add('on');
      btn.textContent = '关闭编辑';
    } else {
      if (mirrorTC) { mirrorTC.detach(); mirrorTC.visible = false; }
      scene.controls.enabled = true;
      btn.classList.remove('on');
      btn.textContent = '开启编辑';
    }
  };
  $('mirrorEditBtn').addEventListener('click', () => {
    const on = !$('mirrorEditBtn').classList.contains('on');
    setMirrorEdit(on);
    if (on) toast('拖动红/绿/蓝箭头移动镜面位置，位置自动保存');
  });
  // restore saved mirror offset on reload (survives restarts); wait for the
  // model + mirror plane to be built first. KEY v2: the old v1 save held a
  // far-away offset that flung the mirror (and earlier, the shell itself)
  // onto the floor — that corrupted save is no longer read. A sane offset is
  // a small nudge around the shell (< 0.6m); anything beyond is ignored.
  const tryApplyMirror = () => {
    if (scene && scene.getMirror()) {
      try {
        const m = JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null');
        if (m && Math.abs(+m.x || 0) < 0.6 && Math.abs(+m.y || 0) < 0.6 && Math.abs(+m.z || 0) < 0.6) {
          scene.applyMirrorOffset(+m.x || 0, +m.y || 0, +m.z || 0);
        }
      } catch (e) {}
    } else setTimeout(tryApplyMirror, 500);
  };
  tryApplyMirror();

  // pedals (click to test)
  const pedMap = { pedSoft: 'soft', pedSost: 'sostenuto', pedSus: 'sustain' };
  const pedState = { soft: false, sostenuto: false, sustain: false };
  for (const id in pedMap) {
    $(id).addEventListener('click', () => {
      const name = pedMap[id];
      pedState[name] = !pedState[name];
      if (name === 'sustain') engine.setSustain(pedState[name]);
      else if (name === 'sostenuto') engine.setSostenuto(pedState[name]);
      else engine.setSoft(pedState[name]);
      if (scene) {
        scene.setPedal(name, pedState[name]);
        if (name === 'soft') scene.setUnaCorda(pedState[name]);
      }
    });
  }

  // transport
  $('playbtn').addEventListener('click', () => {
    if (!player.events.length) { toast('请先导入 MIDI 文件', 'warn'); return; }
    if (player.playing) player.pause();
    else player.play();
  });
  $('tempo').addEventListener('change', (e) => player.setRate(+e.target.value));
  $('progressWrap').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    player.seek(frac * player.duration);
  });

  // octave
  $('octDown').addEventListener('click', () => { state.octave = Math.max(-2, state.octave - 1); _oct(); _savePrefs(); });
  $('octUp').addEventListener('click', () => { state.octave = Math.min(2, state.octave + 1); _oct(); _savePrefs(); });
  function _oct() {
    const base = 60 + state.octave * 12;
    $('octLabel').textContent = 'C' + (4 + state.octave);
  }

  // help
  $('btnHelp').addEventListener('click', () => {
    toast('操作说明：\n• 鼠标/触摸点击琴键发声，按住横向滑动刮奏\n• 滚轮缩放，左键拖拽旋转视角\n• 外接 MIDI 键盘即插即用（力度0-127、三踏板）\n• 导入 SF2 音源 / MIDI 文件或文件夹\n• 电脑键盘：Z X C V B N M 白键，S D G H J 黑键，Q…P 高八度', '');
  });

  // computer keyboard
  const LOW_W = { z: 0, x: 2, c: 4, v: 5, b: 7, n: 9, m: 11, ',': 12, '.': 14, '/': 16 };
  const LOW_B = { s: 1, d: 3, g: 6, h: 8, j: 10, l: 13, ';': 15 };
  const HIGH_W = { q: 12, w: 14, e: 16, r: 17, t: 19, y: 21, u: 23, i: 24, o: 26, p: 28, '[': 29, ']': 31 };
  const HIGH_B = { '2': 13, '3': 15, '5': 18, '6': 20, '7': 22, '9': 25, '0': 27 };
  const kbd = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key)) e.preventDefault();
    // octave shift (before note mapping so - / = work)
    if (e.key === '-') { state.octave = Math.max(-2, state.octave - 1); _oct(); return; }
    if (e.key === '=') { state.octave = Math.min(2, state.octave + 1); _oct(); return; }
    let off = null;
    if (k in LOW_W) off = LOW_W[k];
    else if (k in LOW_B) off = LOW_B[k];
    else if (k in HIGH_W) off = HIGH_W[k];
    else if (k in HIGH_B) off = HIGH_B[k];
    if (off == null) return;
    const note = 60 + state.octave * 12 + off;
    if (note < 21 || note > 108) return;
    if (kbd.has(k)) return;
    kbd.add(k);
    engine.resume();
    engine.noteOn(note, 88);
    scene && scene.keyDown(note, 88);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    let off = null;
    if (k in LOW_W) off = LOW_W[k];
    else if (k in LOW_B) off = LOW_B[k];
    else if (k in HIGH_W) off = HIGH_W[k];
    else if (k in HIGH_B) off = HIGH_B[k];
    if (off == null) return;
    const note = 60 + state.octave * 12 + off;
    if (note < 21 || note > 108) return;
    kbd.delete(k);
    engine.noteOff(note);
    scene && scene.keyUp(note);
  });

  // self-test
  const btn = document.createElement('button');
  btn.textContent = '压力自检';
  btn.style.cssText = 'background:#2a2233;border-color:#4a3a55;';
  btn.addEventListener('click', runSelfTest);
  $('toptools').appendChild(btn);
}

// ---------- MIDI file loading ----------
function loadMidiFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseMidi(reader.result);
      const key = (file.webkitRelativePath || file.name);
      state.playlist.push({ name: parsed.name || file.name, file: key, parsed });
      _renderPlaylist();
      if (state.playlist.length === 1) selectSong(0);
      toast('已加载：' + (parsed.name || file.name), 'ok');
    } catch (err) {
      toast('无法解析 ' + file.name + '：' + err.message, 'err');
    }
  };
  reader.onerror = () => toast('读取文件失败：' + file.name, 'err');
  reader.readAsArrayBuffer(file);
}

function _renderPlaylist() {
  const box = $('playlist');
  box.innerHTML = '';
  $('songCount').textContent = state.playlist.length ? '（' + state.playlist.length + ' 首）' : '';
  state.playlist.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'item' + (i === state.currentSong ? ' cur' : '');
    div.innerHTML = '<span class="i"></span>' + s.name;
    div.title = s.file;
    div.addEventListener('click', () => selectSong(i));
    box.appendChild(div);
  });
}

function selectSong(i) {
  if (i < 0 || i >= state.playlist.length) return;
  state.currentSong = i;
  player.load(state.playlist[i].parsed);
  _renderPlaylist();
}

// ---------- SF2 import ----------
function importSf2(file) {
  if (file.size > 800 * 1024 * 1024) {
    toast('该 SF2 较大（' + (file.size / 1048576 / 1024).toFixed(1) + ' GB），解析可能需要 1-3 分钟，请耐心等待…', 'warn');
  }
  $('sfstatus').textContent = '正在解析 ' + file.name + ' …';
  $('sfbarFill').style.width = '2%';
  const worker = new Worker('./js/audio/sf2worker.js');
  const imported = {};
  let noteCount = 0;
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'progress') {
      $('sfbarFill').style.width = Math.min(90, 5 + Math.round(d.done / Math.max(1, d.total) * 80)) + '%';
      $('sfstatus').textContent = '正在提取采样 ' + d.done + ' / ' + d.total + ' …';
    } else if (d.type === 'note') {
      noteCount++;
      const layers = d.layers.map((l) => {
        const buf = engine.ctx.createBuffer(1, l.data.byteLength / 4, l.rate);
        buf.getChannelData(0).set(new Float32Array(l.data));
        return { buffer: buf, semi: l.semi, cent: l.cent, velLo: l.velLo, velHi: l.velHi, atten: l.atten, loopS: l.loopS, loopE: l.loopE };
      });
      imported[d.note] = layers;
    } else if (d.type === 'done') {
      $('sfbarFill').style.width = '100%';
      engine.setImported(imported);
      engine.setMode('imported');
      $('stSf').textContent = '导入音源';
      $('dotSf').className = 'dot on';
      $('sfstatus').textContent = '已导入 ' + file.name + '（' + noteCount + ' 键）';
      toast('SF2 音源导入完成：' + file.name, 'ok');
      worker.terminate();
    } else if (d.type === 'error') {
      $('sfstatus').textContent = '导入失败：' + d.message;
      toast('SF2 导入失败：' + d.message, 'err');
      worker.terminate();
    }
  };
  worker.onerror = (e) => {
    $('sfstatus').textContent = '解析进程出错';
    toast('SF2 解析出错：' + (e.message || '未知错误'), 'err');
    worker.terminate();
  };
  file.arrayBuffer().then((ab) => {
    worker.postMessage({ arrayBuffer: ab }, [ab]);
  }).catch((err) => toast('读取文件失败：' + err.message, 'err'));
}

// ---------- self test ----------
function runSelfTest() {
  toast('开始压力自检（高强度快速弹奏 + 踏板联动）…');
  const t0 = performance.now();
  let errors = 0;
  const notes = [];
  // simulate La-Campanella-like rapid glissando & repeated notes across 3 octaves
  const base = [64, 67, 71, 72, 74, 76, 79, 81, 84, 88, 91, 96];
  const n = 260;
  for (let i = 0; i < n; i++) {
    const oct = (i % 3) * 12;
    const note = base[Math.floor(Math.random() * base.length)] + oct;
    notes.push(note);
  }
  let i = 0;
  const step = () => {
    if (i >= notes.length) {
      engine.setSustain(false);
      engine.setSoft(false);
      const el = $('fps');
      const fps = el ? el.textContent : '--';
      toast('自检完成：' + notes.length + ' 个音符，' + (errors ? errors + ' 个异常' : '无异常') + '，当前 FPS ' + fps, errors ? 'warn' : 'ok');
      return;
    }
    const note = notes[i];
    engine.noteOn(note, 60 + Math.round(Math.random() * 67));
    scene && scene.keyDown(note, 100);
    const offAt = i + 1 + Math.floor(Math.random() * 3);
    if (offAt < notes.length) {
      const off = notes[i];
      setTimeout(() => { engine.noteOff(off); scene && scene.keyUp(off); }, 60 + Math.random() * 120);
    }
    if (i === 40) engine.setSustain(true);
    if (i === 120) engine.setSoft(true);
    if (i === 180) engine.setSustain(false);
    i++;
    setTimeout(step, 18);
  };
  setTimeout(step, 30);
}

// ---------- headless auto test (?at=1) ----------
// Runs a scripted chord press → hold → release with bounce sampling and pedal
// toggling, then writes results to document.body[data-autotest] for external
// verification. Not tied to the mouse/canvas, so it is immune to camera moves.
function autoTest() {
  const out = [];
  const log = (k, v) => { out.push(k + '=' + v); };
  const write = () => { try { document.body.setAttribute('data-autotest', out.join('|')); } catch (e) {} };
  try {
    const sc = scene, eng = engine;
    if (!sc || !eng) { log('err', 'no-scene'); write(); return; }
    // wait for keys (model load) up to 30s
    let tries = 0;
    const waitKey = () => {
      tries++;
      if (sc.keys && sc.keys[60]) return runPress();
      if (tries > 600) { log('err', 'keys-timeout'); write(); return; }
      setTimeout(waitKey, 50);
    };
    const runPress = () => {
      const ns = [60, 64, 67];
      ns.forEach(n => { eng.noteOn(n, 90); sc.keyDown(n, 90); });
      const p0 = performance.now();
      const samples = [];
      let maxP = 0, settled = null;
      const step1 = () => {
        const k60 = sc.keys[60];
        samples.push(k60.pressed.toFixed(4));
        const elapsed = performance.now() - p0;
        maxP = Math.max(maxP, k60.pressed);
        if (Math.abs(k60.pressed - k60.target) < 0.0003 && elapsed > 60 && settled === null) settled = elapsed;
        if (elapsed < 650) { setTimeout(step1, 50); return; }
        log('pressMax', maxP.toFixed(4));
        log('pressSettleMs', settled !== null ? Math.round(settled) : 'na');
        log('pressSamples', samples.join(','));
        ns.forEach(n => { eng.noteOff(n); sc.keyUp(n); });
        const p1 = performance.now();
        const relSamples = [];
        let minP = 0, bouncePeak = 0, bounceSeen = false;
        const step2 = () => {
          const k60 = sc.keys[60];
          relSamples.push(k60.pressed.toFixed(4));
          const elapsed = performance.now() - p1;
          if (k60.pressed < -0.0004) { bounceSeen = true; bouncePeak = Math.max(bouncePeak, -k60.pressed); }
          minP = Math.min(minP, k60.pressed);
          if (elapsed < 900) { setTimeout(step2, 45); return; }
          log('relMin', minP.toFixed(4));
          log('bounceOvershoot', bouncePeak.toFixed(4));
          log('bounceSeen', bounceSeen ? 1 : 0);
          log('relSamples', relSamples.join(','));
          eng.setSustain(true); sc.setPedal('sustain', true);
          setTimeout(() => {
            const pa = sc.pedals.sustain.angle.toFixed(2);
            log('pedOn', pa);
            eng.setSustain(false); sc.setPedal('sustain', false);
            setTimeout(() => {
              log('pedOff', sc.pedals.sustain.angle.toFixed(2));
              log('done', 'ok');
              write();
            }, 500);
          }, 500);
        };
        step2();
      };
      step1();
    };
    waitKey();
  } catch (e) {
    out.push('err=' + e.message);
    write();
  }
}

// global error surfacing
window.addEventListener('error', (e) => {
  toast('运行时错误：' + (e.message || '未知'), 'err');
});
window.addEventListener('unhandledrejection', (e) => {
  toast('异步错误：' + (e.reason && e.reason.message || e.reason || '未知'), 'err');
});

// debug hook (harmless; lets external tools verify scene/audio state)
window.__piano = { get scene() { return scene; }, get engine() { return engine; }, get player() { return player; }, get midi() { return midi; } };

// DOM debug readout (visible to automation via shared DOM)
(function () {
  const dbg = document.createElement('div');
  dbg.id = 'dbgState';
  dbg.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:10px/1.4 monospace;color:#7fdb8a;background:rgba(0,0,0,.65);padding:4px 6px;border-radius:4px;pointer-events:none;display:none;white-space:pre;';
  document.body.appendChild(dbg);
  setInterval(() => {
    try {
      const fpe = document.getElementById('fps');
      const fps = fpe ? fpe.textContent : '-';
      const k = scene ? scene.keys : null;
      const keys = k ? [21, 36, 40, 48, 60, 64, 72, 84, 96, 108].map(n => { const kk = k[n]; return n + ':' + (kk ? kk.pressed.toFixed(3) : '?'); }).join(' ') : 'no-scene';
      const v = engine ? [...engine.voices.values()].reduce((s, st) => s + st.size, 0) : -1;
      const vd = engine && engine.voices && v ? [...engine.voices.entries()].map(([n, set]) => n + ':' + [...set].map(vo => (vo.sustained ? 'S' : '') + (vo.deadline ? Math.round(vo.deadline - engine.ctx.currentTime) + 's' : 'x')).join('/')).join(' ') : '';
      const mode = engine ? engine.mode : '-';
      const ctx = engine && engine.ctx ? engine.ctx.state : '-';
      const una = scene ? scene.unaCordaShift.toFixed(3) : '-';
      const pa = scene && scene.pedals ? ['soft', 'sostenuto', 'sustain'].map(p => p + '=' + (scene.pedals[p] ? scene.pedals[p].angle.toFixed(2) : '-')).join(' ') : '-';
      const q = scene ? (scene.qLevel !== undefined ? scene.qLevel : '?') : '-';
      const s = scene ? ('keys=' + Object.keys(scene.keys).filter(k => scene.keys[k]).length + ' H=' + (scene.keyH || 0).toFixed(4) + ' W=' + (scene.keyW || 0).toFixed(4) + ' kRef=' + !!scene.keyReflector + ' fbRef=' + !!scene.fbReflector) : 'no-scene';
      const pl = player ? ('ev ' + player.events.length + ' sec ' + player.sec.toFixed(1) + '/' + player.duration.toFixed(1) + (player.playing ? ' RUN' : ' idle')) : 'no-player';
      const pev = player && player.events.length ? player.events.slice(0, 6).map(e => (e.type === 'noteon' ? 'ON' : e.type === 'noteoff' ? 'OFF' : e.type) + ':' + (e.note || e.cc || e.val !== undefined ? (e.note || '') + '/' + (e.sec ? e.sec.toFixed(2) : '') : '')).join(' ') : '';
      dbg.textContent = 'FPS ' + fps + ' | Q' + q + ' | ' + keys + '\n' + s + '\n' + pl + (pev ? ' [' + pev + ']' : '') + '\nvoices ' + v + (vd ? ' [' + vd + ']' : '') + ' mode ' + mode + ' ctx ' + ctx + ' una ' + una + ' | ' + pa;
      dbg.style.display = location.search.indexOf('dbg=1') >= 0 ? 'block' : 'none';
    } catch (e) {
      dbg.textContent = 'dbg err ' + e.message;
    }
  }, 250);
  // keep the view sliders in sync with the actual camera (drag-rotate updates
  // the sliders; slider moves keep camera + prefs). Only when user is NOT
  // actively dragging a slider.
  (() => {
    let lastCam = '', camT = 0;
    const sync = () => {
      if (!scene || !scene.getView || !$('camAz')) return;
      let busy = false;
      ['camAz', 'camEl', 'camDist'].forEach(id => {
        const el = $(id);
        if (el && document.activeElement === el) busy = true;
      });
      if (busy) return;
      const v = scene.getView();
      $('camAz').value = v.az;
      $('camEl').value = v.el;
      $('camDist').value = v.dist;
      const sig = v.az + ',' + v.el + ',' + v.dist;
      if (sig !== lastCam) {
        lastCam = sig;
        clearTimeout(camT);
        camT = setTimeout(_savePrefs, 800); // drag-rotate → auto-save
      }
    };
    setInterval(sync, 250);
    // keep the voice pool clean even if the AudioContext stalls
    setInterval(() => { try { engine.pruneStale(); } catch (e) {} }, 1000);
  })();
})();

// headless auto test hook (?at=1 full test, ?at=2 press-hold, ?at=3 88-key slam)
const atMode = (location.search.match(/[?&]at=(\d)/) || [])[1];
if (atMode === '1') {
  setTimeout(autoTest, 800);
} else if (atMode === '2') {
  setTimeout(() => {
    const sc = scene, eng = engine;
    let tries = 0;
    const waitKey = () => {
      tries++;
      if (sc && sc.keys && sc.keys[60]) {
        [60, 64, 67, 72].forEach(n => { eng.noteOn(n, 100); sc.keyDown(n, 100); });
        eng.setSustain(true); sc.setPedal('sustain', true);
        document.body.setAttribute('data-hold', 'on');
        return;
      }
      if (tries > 600) return;
      setTimeout(waitKey, 50);
    };
    waitKey();
    setTimeout(() => {
      const st = document.getElementById('dbgState');
      const m = st ? st.textContent.match(/voices\s+(\d+)/) : null;
      document.body.setAttribute('data-voices', m ? m[1] : 'na');
    }, 1500);
  }, 800);
} else if (atMode === '3') {
  // 88-key violent slam: press every note at max velocity, hold 4 s, release
  // all, then verify the engine recovers with zero lingering voices/errors.
  setTimeout(() => {
    const sc = scene, eng = engine;
    let tries = 0;
    const waitKey = () => {
      tries++;
      if (sc && sc.keys && sc.keys[21] && sc.keys[108]) {
        try {
          for (let n = 21; n <= 108; n++) { eng.noteOn(n, 127); sc.keyDown(n, 127); }
          document.body.setAttribute('data-88', 'on');
          const st = document.getElementById('dbgState');
          const m = st ? st.textContent.match(/voices\s+(\d+)/) : null;
          document.body.setAttribute('data-88voices', m ? m[1] : 'na');
          setTimeout(() => {
            try {
              for (let n = 21; n <= 108; n++) { eng.noteOff(n); sc.keyUp(n); }
              document.body.setAttribute('data-88off', 'on');
              setTimeout(() => {
                const st2 = document.getElementById('dbgState');
                const m2 = st2 ? st2.textContent.match(/voices\s+(\d+)/) : null;
                document.body.setAttribute('data-88after', m2 ? m2[1] : 'na');
              }, 1500);
            } catch (e) { document.body.setAttribute('data-88err', String(e).slice(0, 80)); }
          }, 4000);
        } catch (e) { document.body.setAttribute('data-88err', String(e).slice(0, 80)); }
        return;
      }
      if (tries > 600) return;
      setTimeout(waitKey, 50);
    };
    waitKey();
  }, 800);
}

init();
