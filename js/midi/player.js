// player.js — MIDI 文件播放器：前瞻调度、暂停/继续/跳转、变速
export class MidiPlayer {
  constructor(engine, visual, cb) {
    this.engine = engine;
    this.visual = visual;
    this.cb = cb || {};
    this.events = [];
    this.pos = 0;          // event index
    this.sec = 0;          // current playhead seconds
    this.rate = 1;
    this.playing = false;
    this.duration = 0;
    this._timer = null;
    this._lookahead = 0.18;
    this._active = new Map(); // note+ch -> count
    this._pressT = new Map(); // note -> sec (stuck-note watchdog)
  }

  load(parsed) {
    this.stop();
    this.events = parsed.events;
    this.duration = parsed.duration;
    this.name = parsed.name || '未命名';
    this.sec = 0;
    this.pos = 0;
    this.engine.allNotesOff();
    if (this.cb.onLoad) this.cb.onLoad(parsed);
  }

  setRate(r) {
    this.rate = r;
    if (this.cb.onRate) this.cb.onRate(r);
  }

  play() {
    if (!this.events.length || this.playing) return;
    this.playing = true;
    this.engine.resume();
    // restart from the top when the previous playback already ended
    if (this.sec >= this.duration - 1e-6 || this.pos >= this.events.length) {
      this.sec = 0;
      this.pos = 0;
    } else {
      this.pos = this._seekIndex(this.sec);
    }
    this._active.clear();
    this._timer = setInterval(() => this._tick(), 25);
    if (this.cb.onPlay) this.cb.onPlay();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._timer);
    this._timer = null;
    this._releaseAll();
    if (this.cb.onPause) this.cb.onPause();
  }

  stop() {
    const was = this.playing;
    this.playing = false;
    clearInterval(this._timer);
    this._timer = null;
    this.sec = 0;
    this.pos = 0;
    this._releaseAll();
    if (was && this.cb.onStop) this.cb.onStop();
    if (this.cb.onProgress) this.cb.onProgress(0, this.duration);
  }

  seek(s) {
    s = Math.max(0, Math.min(this.duration, s));
    this._releaseAll();
    this.sec = s;
    this.pos = this._seekIndex(s);
    if (!this.playing) {
      if (this.cb.onProgress) this.cb.onProgress(s, this.duration);
    }
  }

  _seekIndex(s) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].sec < s) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  _tick() {
    if (!this.playing) return;
    try {
      // advance wall-clock: count in real seconds
      const dt = 0.025 * this.rate;
      this.sec += dt;
      const horizon = this.sec + this._lookahead;
      const evs = this.events;
      while (this.pos < evs.length && evs[this.pos].sec <= horizon) {
        this._fire(evs[this.pos]);
        this.pos++;
      }
      // stuck-note watchdog: a noteOn without noteOff (bad MIDI, violent
      // glissandi, quick pedal flips) is force-released after 8 s so a note
      // can NEVER ring on forever. Rapid real playing never reaches this.
      for (const [n, t] of this._pressT) {
        if (this.sec - t > 8) {
          this.engine.noteOff(n);
          if (this.visual) this.visual.keyUp(n);
          this._pressT.delete(n);
          const k = n; // any channel — release all channels for that note
          for (const [key] of this._active) {
            if (key % 128 === n % 128) this._active.delete(key);
          }
        }
      }
    } catch (e) { /* never let a bad event kill the player */ }
    if (this.pos >= evs.length) {
      this.sec = this.duration;
      this.pause();
      if (this.cb.onEnded) this.cb.onEnded();
    }
    if (this.cb.onProgress) this.cb.onProgress(Math.min(this.sec, this.duration), this.duration);
  }

  _fire(e) {
    try {
      if (e.type === 'noteon') {
        const k = e.ch * 128 + e.note;
        this._active.set(k, (this._active.get(k) || 0) + 1);
        this._pressT.set(e.note, this.sec);
        this.engine.noteOn(e.note, Math.max(1, Math.min(127, e.vel)));
        if (this.visual) this.visual.keyDown(e.note, e.vel);
      } else if (e.type === 'noteoff') {
        const k = e.ch * 128 + e.note;
        const c = (this._active.get(k) || 0) - 1;
        if (c <= 0) {
          this._active.delete(k);
          this._pressT.delete(e.note);
          this.engine.noteOff(e.note);
          if (this.visual) this.visual.keyUp(e.note);
        } else {
          this._active.set(k, c);
        }
      } else if (e.type === 'cc') {
        if (e.cc === 64) {
          this.engine.setSustain(e.val >= 64);
          if (this.visual && this.visual.setPedal) this.visual.setPedal('sustain', e.val >= 64);
        } else if (e.cc === 66) {
          this.engine.setSostenuto(e.val >= 64);
          if (this.visual && this.visual.setPedal) this.visual.setPedal('sostenuto', e.val >= 64);
        } else if (e.cc === 67) {
          this.engine.setSoft(e.val >= 64);
          if (this.visual && this.visual.setPedal) this.visual.setPedal('soft', e.val >= 64);
          if (this.visual && this.visual.setUnaCorda) this.visual.setUnaCorda(e.val >= 64);
        } else if (e.cc === 123 || e.cc === 120) this.engine.allNotesOff();
      } else if (e.type === 'pb') {
        this.engine.setPitchBend(e.ch, (e.val - 8192) / 8192);
      }
    } catch (err) { /* never let a single bad event break playback */ }
  }

  _releaseAll() {
    this.engine.allNotesOff();
    this.engine.setSustain(false);
    this.engine.setSostenuto(false);
    this.engine.setSoft(false);
    if (this.visual) this.visual.allKeysUp();
    this._active.clear();
  }
}
