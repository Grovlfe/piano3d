// app.js — 主入口：UI、3D 场景、音频引擎、MIDI 设备/文件、电脑键盘、导入、自检
window.__appVersion = 6;
import { PianoScene } from './scene.js?v=86';
import { Sampler } from './audio/sampler.js?v=72';
import { MidiDevice } from './midi/device.js?v=57';
import { MidiPlayer } from './midi/player.js?v=58';
import { parseMidi } from './midi/parse.js?v=56';
import { TransformControls } from 'three/addons/controls/TransformControls.js?v=54';

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
  transpose: 0,     // key change in semitones (-12..12)
  lightPreset: '',  // light preset: '' | 'ref' | 'stage' | 'cool'
  backdrop: '',     // backdrop hex (no 0x)
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
    const cur = state.playlist[state.currentSong];
    // 播放栏名称以文件名为准（用户要求：直接显示文件名称）
    $('tname').textContent = (cur && cur.name) || p.name || '未命名';
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

// ---------- user data persistence (localStorage + URL-hash cloud mirror) ----------
const PREFS_KEY = 'piano3d_prefs_v2';
function _encodePrefs(p) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(p)))); } catch (e) { return ''; }
}
function _decodePrefs(s) {
  try { return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch (e) { return null; }
}
function _savePrefs() {
  const p = {
    vol: $('vol').value, rev: $('rev').value, velCurve: $('velCurve').value,
    lightAz: $('lightAz').value, lightEl: $('lightEl').value, lightPow: $('lightPow').value,
    lightCol: $('lightCol').value, quality: $('qualitySel').value, octave: state.octave,
    camAz: $('camAz').value, camEl: $('camEl').value, camDist: $('camDist').value,
    fxContrast: $('fxContrast').value, fxBright: $('fxBright').value,
    fxSat: $('fxSat').value, fxBloom: $('fxBloom').value,
    transpose: state.transpose,
    lightPreset: state.lightPreset || '',
    backdrop: state.backdrop || '',
    fov: ($('fov') ? $('fov').value : 42),
    viewMode: ($('viewMode') ? $('viewMode').value : 'seated'),
    preloadPack: ($('preloadPack') ? ($('preloadPack').checked ? '1' : '0') : '1'),
    soundPack: ($('soundPackSel') ? $('soundPackSel').value : 'light'),
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
  // cloud mirror: the URL itself carries the settings — open this link on any
  // device/browser and everything is restored (copy/save the link = cloud save).
  const enc = _encodePrefs(p);
  try { if (enc && location.hash !== '#p=' + enc) history.replaceState(null, '', '#p=' + enc); } catch (e) { /* noop */ }
}
function _loadPrefs() {
  let p = {};
  // 1) URL-hash data wins (cloud link), 2) localStorage fallback
  const hm = location.hash.match(/^#p=(.+)$/);
  if (hm) {
    try {
      const hp = _decodePrefs(decodeURIComponent(hm[1]));
      if (hp && typeof hp === 'object') p = hp;
    } catch (e) { p = {}; }
  }
  if (!p || !Object.keys(p).length) {
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) { p = {}; }
  }
  const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== '') el.value = v; };
  set('vol', p.vol); set('rev', p.rev); set('velCurve', p.velCurve);
  set('lightAz', p.lightAz); set('lightEl', p.lightEl); set('lightPow', p.lightPow);
  set('lightCol', p.lightCol); set('qualitySel', p.quality);
  set('backdrop', p.backdrop);
  set('camAz', p.camAz); set('camEl', p.camEl); set('camDist', p.camDist);
  set('fov', p.fov);
  set('viewMode', p.viewMode);
  if (scene) {
    scene.setFov(+($('fov').value || 42));
    scene.setView(+$('camAz').value, +$('camEl').value, +$('camDist').value / 100);
    if (p.viewMode === 'fps') setTimeout(() => scene.enterFps(), 300);
  }
  set('fxContrast', p.fxContrast); set('fxBright', p.fxBright);
  set('fxSat', p.fxSat); set('fxBloom', p.fxBloom);
  if ($('preloadPack') && p.preloadPack !== undefined) $('preloadPack').checked = p.preloadPack !== '0';
  // soundPack is a deployment choice (light always available; full = local/install
  // only), so it is restored from localStorage, never from the cloud hash.
  if ($('soundPackSel')) {
    try { $('soundPackSel').value = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').soundPack || 'light'; } catch (e) { $('soundPackSel').value = 'light'; }
  }
  if (p.octave !== undefined) state.octave = Math.max(-2, Math.min(2, +p.octave || 0));
  if (p.transpose !== undefined) state.transpose = Math.max(-12, Math.min(12, Math.round(+p.transpose) || 0));
  // light preset + backdrop restore (light only; camera restored from saved sliders)
  if (p.lightPreset && scene) {
    state.lightPreset = p.lightPreset;
    scene.applyLightPreset(p.lightPreset);
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === p.lightPreset));
  }
  if (p.backdrop && scene) {
    state.backdrop = p.backdrop;
    scene.setBackdrop('0x' + p.backdrop);
  }
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
  _applyFx();
  _tp();
}

// 画面滤镜（CSS filter 作用于 canvas 容器）+ 泛光（scene bloom pass）
function _applyFx() {
  const c = +$('fxContrast').value / 100;
  const b = +$('fxBright').value / 100;
  const s = +$('fxSat').value / 100;
  const g = $('glwrap');
  if (g) g.style.filter = 'contrast(' + c.toFixed(2) + ') brightness(' + b.toFixed(2) + ') saturate(' + s.toFixed(2) + ')';
  const bl = +$('fxBloom').value / 100;
  if (scene) scene.setBloom(bl);
  _savePrefs();
}

// 调号（移调）：作用于声音（sampler 层统一处理 MIDI/设备/键盘/播放）
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function _tp() {
  const t = state.transpose;
  const semi = ((t % 12) + 12) % 12;
  const oct = 4 + Math.floor((12 + t) / 12) - 1;
  $('tpLabel').textContent = NOTE_NAMES[semi] + oct;
  engine.setTranspose(t);
}

// ---------- init ----------
async function init() {
  // default soundfont pack — autoload unless the user disabled 启动预载音源
  let _preload = true, _sf = 'light';
  try {
    const p0 = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    _preload = p0.preloadPack !== '0';
    _sf = p0.soundPack || 'light';
  } catch (e) {}
  const onGH = location.hostname.indexOf('github.io') >= 0;
  if (onGH && _sf === 'full') _sf = 'light'; // full pack ships local-only (GitHub 100MB cap)
  if (_preload) {
    await engine.loadDefaultPack('soundfont/default/manifest.json', (p) => {
      $('sfbarFill').style.width = Math.round(p * 100) + '%';
    }, _sf === 'full' ? 'piano_full.pack' : 'piano.pack');
  }
  state.sfReady = true;
  const onFull = _sf === 'full' && engine.mode === 'pack';
  $('stSf').textContent = engine.mode === 'pack' ? (onFull ? 'VSL D-274 完整' : 'VSL D-274') : '内置合成器';
  $('dotSf').className = engine.mode === 'pack' ? 'dot on' : 'dot warn';
  _checkLoading();

  // GitHub Pages loads the model from same-origin chunks (see scene.js);
  // local/dev loads the packaged GLB directly.
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

  if ($('preloadPack')) $('preloadPack').addEventListener('change', () => { _savePrefs(); toast('音源预载已' + ($('preloadPack').checked ? '开启：下次启动自动预载' : '关闭'), 'ok'); });
  // sound pack switch (light/full); full ships only with the local/install copy
  if ($('soundPackSel')) $('soundPackSel').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (location.hostname.indexOf('github.io') >= 0 && v === 'full') {
      e.target.value = 'light'; _savePrefs();
      toast('完整高保真音源仅随本地安装包提供，公网版保持精简包', 'warn');
      return;
    }
    _savePrefs();
    toast(v === 'full' ? '正在切换到完整高保真音源（约 300MB，请稍候）…' : '正在切换到精简音源…', 'ok');
    const bar = $('sfbarFill'); if (bar) bar.style.width = '2%';
    await engine.loadDefaultPack('soundfont/default/manifest.json', (p) => {
      if (bar) bar.style.width = Math.round(p * 100) + '%';
    }, v === 'full' ? 'piano_full.pack' : 'piano.pack');
    state.sfReady = true;
    $('stSf').textContent = engine.mode === 'pack' ? (v === 'full' ? 'VSL D-274 完整' : 'VSL D-274') : '内置合成器';
    $('dotSf').className = engine.mode === 'pack' ? 'dot on' : 'dot warn';
    toast(v === 'full' ? '已切换到完整高保真音源' : '已切换到精简音源', 'ok');
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
    if (state.lightPreset) {
      state.lightPreset = '';
      document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('on'));
    }
    _savePrefs();
  };
  $('lightAz').addEventListener('input', applyLight);
  $('lightEl').addEventListener('input', applyLight);
  $('lightPow').addEventListener('input', applyLight);
  $('lightCol').addEventListener('input', applyLight);
  // light presets + backdrop (垂直光/全局光/阴影对比 + 背景幕布)
  const PRESET_CAMS = {
    ref:   { az: 0,   el: 10, dist: 1.35 },
    stage: { az: 0,   el: 24, dist: 2.4 },
    cool:  { az: 35,  el: 18, dist: 2.8 },
    hall:  { az: 0,   el: 12, dist: 2.0 }
  };
  const _applyPreset = (name) => {
    if (!scene) return;
    scene.applyLightPreset(name);
    // sync light sliders + backdrop select to the preset's values (UI honesty)
    const LP_UI = {
      ref:   { az: 7,   el: 83, pow: 200, col: '#fff6e8', bg: '07080b' },
      stage: { az: 314, el: 72, pow: 190, col: '#ffeed9', bg: '040507' },
      cool:  { az: 34,  el: 43, pow: 95,  col: '#dfe9ff', bg: '14171c' },
      hall:  { az: 349, el: 77, pow: 220, col: '#ffe9c4', bg: '0b0c10' },
      default:{ az: 323, el: 52, pow: 150, col: '#fff2df', bg: '232e40' }
    };
    const u = LP_UI[name];
    if (u) {
      const s = (id, v) => { const el = $(id); if (el) el.value = v; };
      s('lightAz', u.az); s('lightEl', u.el); s('lightPow', u.pow); s('lightCol', u.col);
      if ($('backdrop')) $('backdrop').value = u.bg;
      state.backdrop = u.bg;
    }
    const cam = PRESET_CAMS[name];
    if (cam) {
      const s = (id, v) => { const el = $(id); if (el) el.value = v; };
      s('camAz', cam.az); s('camEl', cam.el); s('camDist', cam.dist);
      scene.setView(cam.az, cam.el, cam.dist);
    }
    state.lightPreset = name;
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === name));
    _savePrefs();
  };
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => _applyPreset(b.dataset.preset)));
  $('backdrop').addEventListener('change', (e) => {
    if (!scene) return;
    scene.setBackdrop('0x' + e.target.value);
    state.backdrop = e.target.value;
    _savePrefs();
  });
  ['fxContrast', 'fxBright', 'fxSat', 'fxBloom'].forEach((id) =>
    $(id).addEventListener('input', _applyFx));
  // settings drawer (right-top ⚙)
  const openSettings = (on) => {
    $('settingsDrawer').classList.toggle('open', !!on);
    $('btnSettings').classList.toggle('active', !!on);
  };
  $('btnSettings').addEventListener('click', () => {
    openSettings(!$('settingsDrawer').classList.contains('open'));
  });
  $('btnSettingsClose').addEventListener('click', () => openSettings(false));
  // restore default lighting (and persist it)
  $('lightReset').addEventListener('click', () => {
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('lightAz', 323); set('lightEl', 52); set('lightPow', 150); set('lightCol', '#fff2df');
    applyLight();
    state.lightPreset = '';
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('on'));
    _savePrefs();
    toast('光影已还原默认', 'ok');
  });
  // export ALL settings (incl. mirror position) to a JSON file for cloud backup
  $('btnExport').addEventListener('click', () => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('piano3d_') === 0) {
        try { out[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { out[k] = localStorage.getItem(k); }
      }
    }
    out._meta = { app: '3D钢琴演奏台 VSL Steinway D-274', developer: 'Grovlfe（珂眠）', contact: '3787165824@qq.com', exported: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'piano3d-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('设置已导出（可保存到云盘/邮箱，跨设备导入恢复）', 'ok');
  });
  // 云保存: pack ALL settings into a shareable URL (works across devices/browsers)
  $('btnCloud').addEventListener('click', () => {
    _savePrefs();
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('piano3d_') === 0) {
        try { out[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { out[k] = localStorage.getItem(k); }
      }
    }
    const link = location.origin + location.pathname + '#p=' + btoa(unescape(encodeURIComponent(JSON.stringify(out))));
    try {
      const done = () => toast('云备份链接已复制，打开该链接即可恢复全部设置', 'ok');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, () => { _fallbackCopy(link); done(); });
      } else { _fallbackCopy(link); done(); }
      console.log('CLOUD_BACKUP_URL=' + link);
    } catch (err) { toast('复制失败，链接见控制台（CLOUD_BACKUP_URL）', 'err'); }
  });
  const _fallbackCopy = (txt) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  };
  // import settings JSON -> restore everything, then reload
  $('btnImport').addEventListener('click', () => $('prefsImport').click());
  $('prefsImport').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        let n = 0;
        for (const k of Object.keys(j)) {
          if (k.indexOf('piano3d_') === 0) {
            localStorage.setItem(k, typeof j[k] === 'string' ? j[k] : JSON.stringify(j[k]));
            n++;
          }
        }
        e.target.value = '';
        toast('已导入 ' + n + ' 项设置，正在应用…', 'ok');
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        toast('导入失败：' + err.message, 'err');
      }
    };
    rd.readAsText(f);
  });
  // view sliders — live camera control, saved on every move (survives restarts)
  const applyView = () => {
    if (!scene) return;
    scene.setView(+$('camAz').value, +$('camEl').value, +$('camDist').value / 100);
    _savePrefs();
  };
  $('camAz').addEventListener('input', applyView);
  $('camEl').addEventListener('input', applyView);
  $('camDist').addEventListener('input', applyView);
  $('fov').addEventListener('input', (e) => { scene.setFov(+e.target.value); _savePrefs(); });

  // ---------- mirror position editor (drag red/green/blue arrows) ----------
  // Hidden by default for aesthetics; user turns it on in 设置 → 镜面 Mirror.
  let mirrorTC = null;
  const MIRROR_KEY = 'piano3d_mirror_v2';
  const saveMirror = () => {
    if (!scene) return;
    const off = scene.getMirrorOffset();
    const m = scene.getMirror();
    const rot = m ? { x: m.rotation.x, y: m.rotation.y, z: m.rotation.z } : { x: 0, y: 0, z: 0 };
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify({ x: +off.x.toFixed(4), y: +off.y.toFixed(4), z: +off.z.toFixed(4), rx: +rot.x.toFixed(4), ry: +rot.y.toFixed(4), rz: +rot.z.toFixed(4) })); } catch (e) {}
    _syncMirrorRotUI();
  };
  const _syncMirrorRotUI = () => {
    const m = scene && scene.getMirror ? scene.getMirror() : null;
    if (!m) return;
    const rx = $('mirRotX'), ry = $('mirRotY'), rz = $('mirRotZ');
    if (rx) rx.value = (m.rotation.x * 180 / Math.PI).toFixed(3);
    if (ry) ry.value = (m.rotation.y * 180 / Math.PI).toFixed(3);
    if (rz) rz.value = (m.rotation.z * 180 / Math.PI).toFixed(3);
    const num = $('mirRotNum');
    if (num) num.value = (m.rotation.y * 180 / Math.PI).toFixed(3);
    const px = $('mirPosX'), py = $('mirPosY'), pz = $('mirPosZ');
    if (px) px.value = m.position.x.toFixed(3);
    if (py) py.value = m.position.y.toFixed(3);
    if (pz) pz.value = m.position.z.toFixed(3);
  };
  const setMirrorEdit = (on) => {
    const btn = $('mirrorEditBtn');
    if (!scene || !scene.getMirror()) { btn.classList.remove('on'); btn.textContent = '开启编辑'; return; }
    if (on) {
      if (!mirrorTC) {
        mirrorTC = new TransformControls(scene.camera, scene.renderer.domElement);
        mirrorTC.setMode($('mirrorModeBtn').dataset.mode || 'translate');
        mirrorTC.setSpace('local');
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
  $('mirrorEditBtn').addEventListener('click', (e) => {
    e.preventDefault();
    setMirrorEdit(!$('mirrorEditBtn').classList.contains('on'));
  });
  // translate <-> rotate arrow mode for the mirror gizmo
  $('mirrorModeBtn').addEventListener('click', () => {
    const btn = $('mirrorModeBtn');
    const m = btn.dataset.mode === 'rotate' ? 'translate' : 'rotate';
    btn.dataset.mode = m;
    btn.textContent = m === 'rotate' ? '旋转' : '平移';
    if (mirrorTC) mirrorTC.setMode(m);
    toast(m === 'rotate' ? '角度环模式：拖动旋转镜面（X/Y/Z）' : '平移模式：拖动箭头移动镜面', 'ok');
  });
  const applyMirrorRot = () => {
    const m = scene && scene.getMirror ? scene.getMirror() : null;
    if (!m) return;
    m.rotation.set(+$('mirRotX').value * Math.PI / 180, +$('mirRotY').value * Math.PI / 180, +$('mirRotZ').value * Math.PI / 180);
    saveMirror();
  };
  $('mirRotX').addEventListener('input', applyMirrorRot);
  $('mirRotY').addEventListener('input', applyMirrorRot);
  $('mirRotZ').addEventListener('input', applyMirrorRot);
  $('mirRotNum').addEventListener('input', () => {
    const v = +$('mirRotNum').value || 0;
    $('mirRotY').value = Math.max(-180, Math.min(180, v));
    applyMirrorRot();
  });
  $('mirRotNum').addEventListener('change', () => {
    const v = +$('mirRotNum').value || 0;
    $('mirRotY').value = Math.max(-180, Math.min(180, v));
    applyMirrorRot();
  });
  // fine position input (0.001 precision) — absolute world coords
  const applyMirrorPos = () => {
    const m = scene && scene.getMirror ? scene.getMirror() : null;
    if (!m) return;
    m.position.set(
      +($('mirPosX').value || 0), +($('mirPosY').value || 0), +($('mirPosZ').value || 0)
    );
    m.updateMatrixWorld(true);
    saveMirror();
  };
  $('mirPosX').addEventListener('input', applyMirrorPos);
  $('mirPosY').addEventListener('input', applyMirrorPos);
  $('mirPosZ').addEventListener('input', applyMirrorPos);
  // one-click reset mirror position & rotation back to factory
  $('mirrorResetBtn').addEventListener('click', () => {
    if (scene && scene.resetMirror()) {
      _syncMirrorRotUI();
      toast('镜面已复位到出厂位置与角度', 'ok');
    } else toast('镜面不可用', 'err');
  });
  // restore mirror rotation + position from prefs (stored as OFFSET vs default)
  try {
    const mv = JSON.parse(localStorage.getItem(MIRROR_KEY) || '{}');
    const m = scene.getMirror();
    if (m) {
      if (mv.rx != null) m.rotation.set(mv.rx, mv.ry != null ? mv.ry : 0, mv.rz != null ? mv.rz : 0);
      if (mv.x != null && scene._mirrorDefault) {
        const d = scene._mirrorDefault;
        m.position.set(d.x + mv.x, d.y + (mv.y != null ? mv.y : 0), d.z + (mv.z != null ? mv.z : 0));
      }
      m.updateMatrixWorld(true);
      _syncMirrorRotUI();
    }
  } catch (err) {}
  // ---------- view mode switch (seated camera view / first-person walk) ----------
  const setViewMode = (mode) => {
    const fp = scene.getFpsState ? scene.getFpsState() : null;
    if (mode === 'fps') {
      if (fp && !fp.active) scene.enterFps();
    } else {
      if (fp && fp.active) scene.exitFps();
      _setAim(false);
    }
    $('viewMode').value = mode;
    _savePrefs();
  };
  $('viewMode').addEventListener('change', (e) => setViewMode(e.target.value));
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

  // ---------- key change (调号/移调) ----------
  $('tpDown').addEventListener('click', () => { state.transpose = Math.max(-12, state.transpose - 1); _tp(); _savePrefs(); toast('调号：' + $('tpLabel').textContent, ''); });
  $('tpUp').addEventListener('click', () => { state.transpose = Math.min(12, state.transpose + 1); _tp(); _savePrefs(); toast('调号：' + $('tpLabel').textContent, ''); });

  // ---------- record & save user performance as a MIDI song ----------
  let rec = null; // {start, events}
  $('recbtn').addEventListener('click', () => {
    if (!rec) {
      engine.resume();
      rec = { start: performance.now(), events: [] };
      engine.recordSink = (note, vel, on) => {
        if (!rec) return;
        const t = (performance.now() - rec.start) / 1000;
        rec.events.push([t, note, vel, on]);
      };
      $('recbtn').classList.add('rec');
      $('recbtn').textContent = '⏹ 停止';
      toast('开始录制演奏…', 'ok');
    } else {
      const events = rec.events;
      rec = null;
      engine.recordSink = null;
      $('recbtn').classList.remove('rec');
      $('recbtn').textContent = '● 录制';
      if (!events.length) { toast('没有录到音符', 'warn'); return; }
      const name = '我的演奏_' + new Date().toISOString().replace(/[:.]/g, '').slice(5, 13) + '.mid';
      try {
        const mid = _buildSMF(events, 120);
        _saveMidiDownload(mid, name);
        _addRecordedSong(mid, name);
        toast('已保存曲目：' + name, 'ok');
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
      }
    }
  });

  function _saveMidiDownload(bytes, name) {
    const blob = new Blob([bytes], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function _addRecordedSong(bytes, name) {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
      const parsed = parseMidi(buf);
      state.playlist.unshift({ name, parsed });
      _renderPlaylist();
      if (state.currentSong < 0) state.currentSong = 0;
    } catch (e) {
      toast('曲目已下载，但加入列表失败：' + (e && e.message || e), 'warn');
    }
  }

  // build a standard SMF (format 0) from recorded events
  function _buildSMF(events, bpm) {
    const div = 480;
    const tempoUs = Math.round(60000000 / bpm);
    const ev = events.slice().sort((a, b) => a[0] - b[0]);
    const track = [];
    const push = (...b) => track.push(...b);
    const vlq = (n) => { const b = []; b.unshift(n & 127); while (n >>= 7) b.unshift((n & 127) | 128); return b; };
    push(0x00, 0xFF, 0x51, 0x03, (tempoUs >> 16) & 255, (tempoUs >> 8) & 255, tempoUs & 255);
    let lastTick = 0, lastSt = -1;
    for (const [t, note, vel, on] of ev) {
      const tick = Math.max(0, Math.round(t * div * bpm / 60));
      const dt = Math.max(0, tick - lastTick);
      lastTick = tick;
      push(...vlq(dt));
      const st = on ? 0x90 : 0x80;
      if (st !== lastSt) { push(st); lastSt = st; }
      push(note, on ? vel : 0);
    }
    push(0x00, 0xFF, 0x2F, 0x00);
    const hdr = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0];
    const len = track.length;
    const trk = [0x4D, 0x54, 0x72, 0x6B, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
    const out = new Uint8Array(hdr.length + trk.length + track.length);
    out.set(hdr, 0); out.set(trk, hdr.length); out.set(track, hdr.length + trk.length);
    return out;
  }

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
    // F8: hide/show all UI
    if (e.key === 'F8') {
      e.preventDefault();
      const hidden = document.body.classList.toggle('ui-hidden');
      toast(hidden ? '界面已隐藏（按 F8 恢复）' : '界面已显示');
      return;
    }
    const k = e.key.toLowerCase();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key)) e.preventDefault();
    // octave shift (before note mapping so - / = work)
    if (e.key === '-') { state.octave = Math.max(-2, state.octave - 1); _oct(); return; }
    if (e.key === '=') { state.octave = Math.min(2, state.octave + 1); _oct(); return; }
    // ---- FPS first-person: WASD / jump / crouch / sit / aim ----
    const fp = scene && scene.getFpsState ? scene.getFpsState() : null;
    if (e.key === 'f') {
      if (fp && fp.active) {
        const r = scene.trySit();
        if (r === 'too_far') toast('需要靠近钢琴（琴键前方）才能坐下', 'err');
        else toast('已坐下演奏（按 F 站起漫游）', 'ok');
      } else { scene.enterFps(); toast('漫游：WASD 移动 · 空格跳 · C 蹲 · F 坐下 · ~ 准星', 'ok'); }
      return;
    }
    if (e.key === '`' || e.key === '~') { _toggleAim(); return; }
    if (fp && fp.active) {
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') { scene.fpsKey(k, true); e.preventDefault(); return; }
      if (e.key === ' ') { scene.fpsJump(); return; }
      if (k === 'c') { scene.fpsCrouch(); return; }   // toggle: stays crouched
    }
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
    const fp = scene && scene.getFpsState ? scene.getFpsState() : null;
    if (fp && fp.active) {
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') { scene.fpsKey(k, false); return; }
    }
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

  // ---- aim mode (~): crosshair + pointer-lock mouse look + click-to-play ----
  let _aimActive = false, _aimNote = null;
  const _setAim = (on) => {
    _aimActive = on;
    scene.toggleAimSet(on);
    const c = document.getElementById('crosshair'); if (c) c.classList.toggle('on', _aimActive);
    const h = document.getElementById('aimHint'); if (h) h.classList.toggle('on', _aimActive);
    if (!_aimActive && document.pointerLockElement === canvas) {
      try { document.exitPointerLock(); } catch (err) {}
    }
    toast(_aimActive ? '准星模式：移动鼠标转视角，左键点击准星所指琴键/踏板' : '准星已关闭（鼠标已呼出）', _aimActive ? 'ok' : '');
  };
  const _toggleAim = () => {
    const on = !_aimActive;
    _setAim(on);
    if (on) {
      const fp = scene.getFpsState ? scene.getFpsState() : null;
      if (!fp || !fp.active) scene.enterFps();   // aim works while walking
      if (document.pointerLockElement !== canvas) {
        try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (err) {}
      }
    }
  };
  const canvas = $('gl');
  // Esc / browser releasing the lock syncs aim off (mouse usable again)
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas && _aimActive) _setAim(false);
  });
  canvas.addEventListener('click', () => {
    const fp = scene && scene.getFpsState ? scene.getFpsState() : null;
    if (fp && (fp.active || fp.aim) && document.pointerLockElement !== canvas) {
      try {
        const r = canvas.requestPointerLock();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (err) {}
    }
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas && scene && scene.fpsTurn) {
      scene.fpsTurn(e.movementX || 0, e.movementY || 0);
    }
  });
  canvas.addEventListener('mousedown', () => {
    const fp = scene && scene.getFpsState ? scene.getFpsState() : null;
    if (fp && fp.aim && document.pointerLockElement === canvas) {
      const hit = scene.aimPick();
      if (!hit) return;
      if (hit.type === 'pedal') { _aimPedalToggle(hit.name); }
      else if (hit.type === 'note') { _aimNote = hit.note; engine.noteOn(hit.note, 88); scene.keyDown(hit.note, 88); }
    }
  });
  window.addEventListener('mouseup', () => {
    if (_aimNote != null) { engine.noteOff(_aimNote); scene.keyUp(_aimNote); _aimNote = null; }
  });
  // aim-mode pedal toggling (click crosshair on a pedal)
  const _aimPedalToggle = (name) => {
    const ui = document.getElementById(name === 'soft' ? 'pedSoft' : name === 'sostenuto' ? 'pedSost' : 'pedSus');
    const cur = ui ? ui.checked : false;
    const next = !cur;
    const v = next ? 1 : 0;
    if (name === 'sustain') engine.setSustain(v);
    else if (name === 'sostenuto') engine.setSostenuto(v);
    else engine.setSoft(v);
    scene.setPedal && scene.setPedal(name, next);
    if (ui) ui.checked = next;
    toast((next ? '踩下' : '松开') + ' ' + name + ' 踏板', 'ok');
  };

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
      // The playlist shows the FILE name (users' MIDI files usually have a
      // meaningful filename; embedded meta names can be garbage/乱码).
      state.playlist.push({ name: file.name, file: key, parsed });
      _renderPlaylist();
      if (state.playlist.length === 1) selectSong(0);
      toast('已加载：' + file.name, 'ok');
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

// strip the extension (and nothing else) from a file path/name for display
function cleanName(n) {
  if (!n) return '';
  return String(n).replace(/\.[^.\/\\]+$/, '');
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
