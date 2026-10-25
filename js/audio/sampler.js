// sampler.js — 基于样本的钢琴音频引擎：力度0-127、延音/持续/柔音踏板、混响、立体声、防爆音
import { Synth } from './synth.js';

const NOTE0 = 21, NOTE1 = 108;

export class Sampler {
  constructor(cb) {
    this.cb = cb || {};
    this.ctx = null;
    this.ready = false;
    this.pack = null;          // manifest
    this.cache = new Map();    // file -> AudioBuffer
    this.loading = new Map();  // file -> promise
    this.voices = new Map();   // key -> Set of voices
    this.allVoices = [];
    this.sustain = false;
    this.sostenuto = false;
    this.sostenutoNotes = new Set();
    this.soft = false;
    this.reverbSend = 0.24;
    this.masterVol = 0.8;
    this.velCurve = 1;
    this.fallback = new Synth();
    this.mode = 'none';        // 'pack' | 'synth' | 'imported'
    this.imported = null;      // {note: [{buffer, semi, cent, velLo, velHi, atten, loopS, loopE}]}
    this.pitchBend = new Map(); // channel -> bend (-1..1)
    this._bornAt = new Map();   // note -> ctx time of latest noteOn (race guard)
    this._releasedAt = new Map(); // note -> ctx time of latest noteOff
    this._init();
  }

  _init() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      if (this.cb.onError) this.cb.onError('无法创建 AudioContext：' + e.message);
      return;
    }
    // master chain: master -> compressor -> dest
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVol;
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp);
    this.comp.connect(this.ctx.destination);

    // reverb
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(2.6, 2.2);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = this.reverbSend;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);
    this.dry = this.ctx.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.master);
  }

  _makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
      // early reflections
      const early = [0.004, 0.009, 0.017, 0.028, 0.043];
      for (const d of early) {
        const idx = Math.floor(d * rate);
        if (idx < len) data[idx] += (Math.random() * 2 - 1) * 0.18;
      }
    }
    return buf;
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) {}
    }
  }

  setVolume(v) { this.masterVol = v; if (this.master) this.master.gain.value = v; }
  setReverb(v) { this.reverbSend = v; if (this.reverbGain) this.reverbGain.gain.value = v; }
  setVelCurve(c) { this.velCurve = c; }
  setMode(m) { this.mode = m; }
  setImported(notes) { this.imported = notes; }

  // ---------- soundfont pack loading (default VSL OGG pack) ----------
  async loadDefaultPack(manifestUrl, onProgress) {
    try {
      const resp = await fetch(manifestUrl);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const manifest = await resp.json();
      this.pack = manifest;
      this.mode = 'pack';
      if (this.cb.onStatus) this.cb.onStatus('默认音源 VSL Steinway D-274（来自你提供的 SF2）已就绪');
      // preload common middle range
      const pre = [48, 52, 55, 60, 64, 67, 72, 76, 79];
      let done = 0;
      for (const n of pre) {
        const layers = this.pack.notes[String(n)];
        if (layers) {
          for (const l of layers) {
            try { await this._getBuffer(l.f); } catch (e) {}
          }
        }
        done++;
        if (onProgress) onProgress(done / pre.length);
      }
      this.ready = true;
      if (this.cb.onReady) this.cb.onReady();
    } catch (e) {
      if (this.cb.onError) this.cb.onError('默认音源加载失败：' + e.message + '，已切换内置合成器。');
      this.mode = 'synth';
      this.ready = true;
    }
  }

  async _getBuffer(file) {
    if (this.cache.has(file)) return this.cache.get(file);
    if (this.loading.has(file)) return this.loading.get(file);
    const p = (async () => {
      const resp = await fetch('soundfont/default/' + file);
      if (!resp.ok) throw new Error(file + ' HTTP ' + resp.status);
      const ab = await resp.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(ab);
      this.cache.set(file, buf);
      return buf;
    })();
    this.loading.set(file, p);
    try { return await p; } finally { this.loading.delete(file); }
  }

  _layerKey(note) {
    return String(note);
  }

  // ---------- notes ----------
  noteOn(note, vel, opts) {
    opts = opts || {};
    if (note < NOTE0 || note > NOTE1) return;
    vel = Math.max(1, Math.min(127, Math.round(vel)));
    // velocity curve
    let g = vel / 127;
    if (this.velCurve === 1) g = Math.pow(g, 1.5);
    else if (this.velCurve === 2) g = Math.pow(g, 0.75);

    if (this.mode === 'pack' && this.pack) {
      const layers = this.pack.notes[String(note)];
      if (layers && layers.length) {
        this._playSample(note, vel, g, layers, opts);
        return;
      }
    }
    if (this.mode === 'imported' && this.imported && this.imported[note] && this.imported[note].length) {
      this._playImported(note, vel, g, this.imported[note], opts);
      return;
    }
    // fallback synth
    this.fallback.noteOn(this.ctx, this.dry, this.reverb, this.reverbGain, note, vel, g, opts);
  }

  _playImported(note, vel, gVel, layers, opts) {
    const now = this.ctx.currentTime;
    let use = layers.filter(l => vel >= l.velLo && vel <= l.velHi);
    if (!use.length) {
      let best = layers[0], bd = 1e9;
      for (const l of layers) {
        const d = vel < l.velLo ? l.velLo - vel : (vel > l.velHi ? vel - l.velHi : 0);
        if (d < bd) { bd = d; best = l; }
      }
      use = [best];
    }
    if (use.length > 2) use = [use[0], use[use.length - 1]];
    const pan = (note - NOTE0) / (NOTE1 - NOTE0) * 1.3 - 0.65;
    for (const l of use) {
      const rate = l.rate || this.ctx.sampleRate;
      this._spawnVoice(note, l.buffer, l, vel, gVel, pan, opts, now, rate);
    }
  }

  async _playSample(note, vel, gVel, layers, opts) {
    const now = this.ctx.currentTime;
    this._bornAt.set(note, now);
    // Re-trigger hygiene: quickly damp any OLD voices of the SAME note before
    // sounding a new one. Prevents layered "echo" artifacts when a note is
    // repeated rapidly (violent playing / repeated trills).
    const oldSet = this.voices.get(note);
    if (oldSet) {
      for (const v of [...oldSet]) this._killVoice(v, now);
    }
    // pick layers: find layers covering vel, blend nearest two
    let use = [];
    for (const l of layers) {
      if (vel >= l.velLo && vel <= l.velHi) use.push(l);
    }
    if (!use.length) {
      let best = null, bestD = 1e9;
      for (const l of layers) {
        const d = vel < l.velLo ? l.velLo - vel : (vel > l.velHi ? vel - l.velHi : 0);
        if (d < bestD) { bestD = d; best = l; }
      }
      if (best) use = [best];
    }
    if (use.length > 2) use = [use[0], use[use.length - 1]];

    const pan = (note - NOTE0) / (NOTE1 - NOTE0) * 1.3 - 0.65;

    const bufs = await Promise.all(use.map(l => this._getBuffer(l.f).catch(() => null)));
    if (this._dead) return;
    const relAt = this._releasedAt.get(note) || -1;
    const quick = relAt > now - 0.05; // key released before samples became ready -> short tap
    for (let i = 0; i < use.length; i++) {
      const buf = bufs[i];
      if (!buf) continue;
      if (quick && this.sustain) break; // pedal caught it
      this._spawnVoice(note, buf, use[i], vel, gVel, pan, { ...opts, quick }, now);
    }
  }

  _spawnVoice(note, buf, l, vel, gVel, pan, opts, now) {
    const ctx = this.ctx;
    const rate = l.rate || buf.sampleRate || ctx.sampleRate;
    const semi = (l.semi || 0) + this._bendSemis();
    const pb = Math.pow(2, (semi + (l.cent || 0) / 100) / 12);
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = pb;

    // NO source.loop: looping a sampled sustain can make short repeating
    // artifacts (短促重复) when the loop region re-enters too early. A piano
    // string decays naturally — the sample plays through to its tail and the
    // long fade envelope below handles the sustained-pedal case. If the sample
    // is genuinely short (< ~2s) the natural decay is still realistic.
    const hasLoop = false;

    const g = ctx.createGain();
    let peak = gVel;
    if (l.atten) peak *= Math.pow(10, -(l.atten) / 200);
    if (this.soft) peak *= 0.48;
    // attack
    const atk = 0.0035;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + atk);

    if (opts.quick) {
      // key was already released while the sample loaded: play a short tap
      g.gain.linearRampToValueAtTime(0.0001, now + 0.055);
      source.start(now);
      source.stop(now + 0.09);
      this._bornAt.delete(note);
      return;
    }

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    let chain = source;
    if (opts.soft || this.soft) {
      // soft pedal: clearly darker, more felted tone (user: 柔音要体现)
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 4800;
      chain.connect(filt);
      chain = filt;
    }
    chain.connect(g);
    if (panner) {
      panner.pan.value = pan;
      g.connect(panner);
      panner.connect(this.dry);
      const rg = ctx.createGain();
      rg.gain.value = 0.9;
      panner.connect(rg);
      rg.connect(this.reverb);
    } else {
      g.connect(this.dry);
      g.connect(this.reverb);
    }

    const voice = {
      note, source, g, vel, l, now, sustained: false, releaseT: 0,
      loopOk: hasLoop, buf,
    };
    if (!this.voices.has(note)) this.voices.set(note, new Set());
    this.voices.get(note).add(voice);
    this.allVoices.push(voice);
    this._prune();

    source.onended = () => {
      this._removeVoice(voice);
      // NO restart on ended: a piano string decays naturally; looping from the
      // attack would make the note "come back" later (the echo bug). The loop
      // region (if present) already sustains via source.loop.
    };

    // stop point: full sample duration; the decay loop keeps it alive while
    // sustained. If not sustained (no pedal), it simply dies out naturally.
    const dur = buf.duration / pb;
    const stopAt = now + dur + 0.05;
    source.start(now);
    source.stop(stopAt);
    voice.deadline = stopAt;

    // KEY FIX: noteOff arrived AFTER this noteOn (rapid runs / glissando /
    // samples still loading when the finger lifted). Without this the voice
    // plays the whole long piano sample to its tail — lingering notes with NO
    // sustain pedal (reported bug: 不踩延音踏板部分音还延音 / 刮奏多个音延音).
    const relAt = this._releasedAt.get(note) || -1;
    const held = this.sustain || (this.sostenuto && this.sostenutoNotes.has(note));
    if (relAt > now && !held) {
      this._releaseVoice(voice, now, 0.07);
      return;
    }

    // natural long decay envelope during sustain (real piano: the pedal lifts
    // the dampers but the string still fades out over several seconds)
    if (this.sustain || (this.sostenuto && this.sostenutoNotes.has(note))) {
      voice.sustained = true;
      const end = Math.max(stopAt, now + 7.5);
      try {
        g.gain.cancelScheduledValues(atk + 0.01);
        g.gain.setValueAtTime(peak, atk + 0.01);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.02), now + 7.5);
        if (end > now + 7.5) g.gain.linearRampToValueAtTime(0.0001, end + 0.02);
      } catch (e) {}
    }
  }

  _restartLoopVoice(voice, l, pan, pb, now, peak) {
    // Kept for API compatibility; the sustain engine no longer restarts voices
    // from the attack (that caused the "note comes back" echo). A sustained
    // voice now dies out naturally through its loop + decay envelope.
    if (this._dead) return;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = voice.buf;
    source.playbackRate.value = pb;
    if (voice.loopOk && voice.l.ls >= 0) {
      source.loop = true;
      source.loopStart = voice.l.ls / (voice.l.rate || voice.buf.sampleRate || ctx.sampleRate);
      source.loopEnd = voice.l.le / (voice.l.rate || voice.buf.sampleRate || ctx.sampleRate);
    }
    const g = ctx.createGain();
    const decay = Math.pow(0.62, voice.restarts);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak * decay, now + 0.012);
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    source.connect(g);
    if (panner) { panner.pan.value = pan; g.connect(panner); panner.connect(this.dry); panner.connect(this.reverb); }
    else { g.connect(this.dry); g.connect(this.reverb); }
    const v = { ...voice, source, g, restarts: voice.restarts };
    source.onended = () => { this._removeVoice(v); };
    source.start(now);
    const dur = voice.buf.duration / pb;
    source.stop(now + dur + 0.02);
  }

  noteOff(note) {
    if (note < NOTE0 || note > NOTE1) return;
    this._releasedAt.set(note, this.ctx.currentTime);
    const set = this.voices.get(note);
    if (!set) return;
    const now = this.ctx.currentTime;
    const hold = this.sustain || (this.sostenuto && this.sostenutoNotes.has(note));
    for (const v of [...set]) {
      if (v.sustained) continue;
      if (hold) {
        v.sustained = true;
        continue;
      }
      this._releaseVoice(v, now, 0.07); // fast damper — crisp, no lingering tail
    }
  }

  _killVoice(v, now) {
    // instant damping of an old same-note voice (damper re-hit behaviour)
    v.sustained = false;
    try {
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setValueAtTime(Math.max(0.0001, v.g.gain.value), now);
      v.g.gain.linearRampToValueAtTime(0.0001, now + 0.015);
      if (v.source && v.source.stop) v.source.stop(now + 0.03);
    } catch (e) {}
    this._removeVoice(v);
  }

  _releaseVoice(v, now, sec) {
    v.sustained = false;
    try {
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setValueAtTime(Math.max(0.0001, v.g.gain.value), now);
      v.g.gain.linearRampToValueAtTime(0.0001, now + sec);
      v.source.stop(now + sec + 0.03);
    } catch (e) {}
    v.releaseT = now + sec;
    // Safety: if the AudioContext stalls (auto-play policy before any user
    // gesture, tab hidden), onended may never fire and the voice would linger
    // in the pool forever. Force-remove it after the release ramp regardless
    // of the context state — keeps 88-key slams and rapid pedal flips clean.
    if (v._rmTimer) clearTimeout(v._rmTimer);
    v._rmTimer = setTimeout(() => this._removeVoice(v), (sec + 0.4) * 1000);
  }

  pruneStale() {
    // Periodic sweep (called from the HUD timer): drop voices whose release
    // ramp or natural deadline passed a while ago, even if onended never
    // fired. Idempotent — _removeVoice on an already-removed voice is a no-op.
    const now = this.ctx.currentTime;
    for (const v of [...this.allVoices]) {
      if (v.releaseT > 0 && now > v.releaseT + 0.6) {
        if (v._rmTimer) { clearTimeout(v._rmTimer); v._rmTimer = null; }
        this._removeVoice(v);
      } else if (v.deadline && !v.sustained && now > v.deadline + 1.2) {
        if (v._rmTimer) { clearTimeout(v._rmTimer); v._rmTimer = null; }
        this._removeVoice(v);
      }
    }
  }

  _removeVoice(v) {
    const set = this.voices.get(v.note);
    if (set) set.delete(v);
    const i = this.allVoices.indexOf(v);
    if (i >= 0) this.allVoices.splice(i, 1);
  }

  _prune() {
    if (this.allVoices.length <= 160) return;
    const now = this.ctx.currentTime;
    const candidates = this.allVoices
      .filter(v => !v.sustained || v.releaseT > 0)
      .sort((a, b) => a.releaseT - b.releaseT);
    while (this.allVoices.length > 140 && candidates.length) {
      const v = candidates.shift();
      if (v) { this._releaseVoice(v, now, 0.015); }
    }
  }

  _bendSemis() {
    let total = 0;
    for (const b of this.pitchBend.values()) total += b * 2.0;
    return total / Math.max(1, this.pitchBend.size);
  }

  // ---------- pedals ----------
  setSustain(down) {
    if (this.sustain === down) return;
    this.sustain = down;
    if (!down) {
      const now = this.ctx.currentTime;
      for (const set of this.voices.values()) {
        for (const v of [...set]) {
          if (v.sustained && !this.sostenutoNotes.has(v.note)) {
            this._releaseVoice(v, now, 0.16); // crisp pedal lift — no lingering echo
          }
        }
      }
    }
    if (this.cb.onPedal) this.cb.onPedal('sustain', down);
  }

  setSostenuto(down) {
    if (this.sostenuto === down) return;
    this.sostenuto = down;
    if (down) {
      // capture currently sounding notes
      this.sostenutoNotes.clear();
      for (const [n, set] of this.voices) {
        if (set.size) this.sostenutoNotes.add(n);
      }
    } else {
      const now = this.ctx.currentTime;
      for (const n of this.sostenutoNotes) {
        const set = this.voices.get(n);
        if (set) for (const v of [...set]) {
          if (v.sustained && !this.sustain) this._releaseVoice(v, now, 0.16);
        }
      }
      this.sostenutoNotes.clear();
    }
    if (this.cb.onPedal) this.cb.onPedal('sostenuto', down);
  }

  setSoft(down) {
    this.soft = down;
    if (this.cb.onPedal) this.cb.onPedal('soft', down);
  }

  setPitchBend(channel, bend) { // bend -1..1
    if (bend === 0) this.pitchBend.delete(channel);
    else this.pitchBend.set(channel, bend);
  }

  allNotesOff() {
    const now = this.ctx.currentTime;
    for (const set of this.voices.values()) {
      for (const v of [...set]) this._releaseVoice(v, now, 0.03);
    }
    this.sostenutoNotes.clear();
    this.fallback.allNotesOff(this.ctx);
  }
}
