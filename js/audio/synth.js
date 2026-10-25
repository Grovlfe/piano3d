// synth.js — 内置合成钢琴（无音源时的兜底），加法合成+琴槌噪声
export class Synth {
  constructor() {
    this.voices = [];
  }

  noteOn(ctx, dry, reverb, reverbGain, note, vel, gVel, opts) {
    if (ctx.state !== 'running') return;
    const f0 = 440 * Math.pow(2, (note - 69) / 12);
    const now = ctx.currentTime;
    const pan = (note - 21) / 87 * 1.3 - 0.65;
    const dur = 2.6 + (108 - note) * 0.012;
    const g = ctx.createGain();
    const master = g;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    let gain = 0.30 * gVel;
    if (opts.soft) gain *= 0.6;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    const parts = [
      { mult: 1, amp: 1.0, type: 'sine' },
      { mult: 2, amp: 0.42, type: 'sine' },
      { mult: 3, amp: 0.18, type: 'sine' },
      { mult: 4.01, amp: 0.06, type: 'sine' },
      { mult: 0.5, amp: 0.10, type: 'triangle' },
    ];
    const out = ctx.createGain();
    out.gain.value = 1;
    for (const p of parts) {
      const o = ctx.createOscillator();
      o.type = p.type;
      o.frequency.value = f0 * p.mult;
      const og = ctx.createGain();
      og.gain.value = p.amp;
      o.connect(og);
      og.connect(out);
      o.start(now);
      o.stop(now + dur + 0.05);
    }
    // hammer noise burst
    const nb = this._noiseBuffer(ctx, 0.02);
    const nsrc = ctx.createBufferSource();
    nsrc.buffer = nb;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.5, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
    nsrc.connect(ng);
    nsrc.start(now);
    nsrc.stop(now + 0.03);
    ng.connect(out);

    out.connect(g);
    if (panner) { panner.pan.value = pan; g.connect(panner); panner.connect(dry); panner.connect(reverb); }
    else { g.connect(dry); g.connect(reverb); }

    const voice = { note, g, stopAt: now + dur };
    this.voices.push(voice);
    const i = this.voices.indexOf(voice);
    setTimeout(() => { if (i >= 0) this.voices.splice(i, 1); }, (dur + 0.1) * 1000);
  }

  _noiseBuffer(ctx, sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  allNotesOff(ctx) {
    const now = ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.g.gain.cancelScheduledValues(now);
        v.g.gain.setValueAtTime(Math.max(0.0001, v.g.gain.value), now);
        v.g.gain.linearRampToValueAtTime(0.0001, now + 0.02);
      } catch (e) {}
    }
    this.voices = [];
  }
}
