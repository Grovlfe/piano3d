// device.js — Web MIDI 外设连接（自动重连、力度/踏板/弯音）
export class MidiDevice {
  constructor(engine, visual, cb) {
    this.engine = engine;
    this.visual = visual;
    this.cb = cb || {};
    this.access = null;
    this.inputs = [];
    this.selectedId = null;
    this.currentInput = null;
    this.supported = 'requestMIDIAccess' in navigator;
  }

  async init() {
    if (!this.supported) {
      if (this.cb.onError) this.cb.onError('当前浏览器不支持 Web MIDI。请使用 Chrome / Edge。');
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      if (this.cb.onError) this.cb.onError('无法访问 MIDI 设备：' + e.message);
      return;
    }
    this.access.onstatechange = () => this._refresh();
    this._refresh();
    if (this.cb.onReady) this.cb.onReady(this.inputs);
  }

  _refresh() {
    this.inputs = [];
    const it = this.access.inputs.values();
    for (let i = it.next(); !i.done; i = it.next()) {
      this.inputs.push(i.value);
    }
    if (this.cb.onInputs) this.cb.onInputs(this.inputs.map(x => ({ id: x.id, name: x.name, state: x.state })));
    // if selected device disappeared, reconnect automatically to first available
    let keep = null;
    for (const inp of this.inputs) if (inp.id === this.selectedId) keep = inp;
    if (!keep && this.inputs.length) {
      this._select(this.inputs[0]);
    } else if (!this.inputs.length) {
      this._detach();
    }
  }

  _detach() {
    if (this.currentInput) {
      try { this.currentInput.onmidimessage = null; } catch (e) {}
      this.currentInput = null;
    }
    if (this.cb.onConnect) this.cb.onConnect(null);
  }

  _select(input) {
    this.selectedId = input.id;
    if (this.currentInput) {
      try { this.currentInput.onmidimessage = null; } catch (e) {}
    }
    this.currentInput = input;
    input.onmidimessage = (e) => this._onMessage(e.data);
    if (this.cb.onConnect) this.cb.onConnect({ id: input.id, name: input.name });
  }

  select(id) {
    for (const inp of this.inputs) {
      if (inp.id === id) { this._select(inp); return; }
    }
  }

  _onMessage(data) {
    if (!data || data.length < 1) return;
    // live event mirror for external verification (real device input)
    try { document.body.setAttribute('data-midi', data[0].toString(16) + '-' + data[1] + '-' + (data[2] !== undefined ? data[2] : '')); } catch (e) {}
    const status = data[0] & 0xF0;
    const ch = data[0] & 0x0F;
    if (status === 0x90 && data[2] > 0) {
      const vel = data[2];
      this.engine.noteOn(data[1], vel);
      if (this.visual) this.visual.keyDown(data[1], vel);
    } else if (status === 0x80 || (status === 0x90 && data[2] === 0)) {
      this.engine.noteOff(data[1]);
      if (this.visual) this.visual.keyUp(data[1]);
    } else if (status === 0xB0) {
      const cc = data[1], val = data[2];
      if (cc === 64) {
        this.engine.setSustain(val >= 64);
        if (this.visual) this.visual.setPedal('sustain', val >= 64);
      } else if (cc === 66) {
        this.engine.setSostenuto(val >= 64);
        if (this.visual) this.visual.setPedal('sostenuto', val >= 64);
      } else if (cc === 67) {
        this.engine.setSoft(val >= 64);
        if (this.visual) { this.visual.setPedal('soft', val >= 64); this.visual.setUnaCorda(val >= 64); }
      } else if (cc === 123 || cc === 120) this.engine.allNotesOff();
    } else if (status === 0xE0 && data.length >= 3) {
      const v = ((data[2] << 7) | data[1]) - 8192;
      this.engine.setPitchBend(ch, v / 8192);
    } else if (status === 0xC0) {
      // program change: ignore (single piano sound)
    }
  }
}
