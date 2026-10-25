// parse.js — SMF (Standard MIDI File) 解析器，支持 format 0/1/2、运行状态、变速
export function parseMidi(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  let pos = 0;

  function readStr(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[pos + i]);
    pos += n;
    return s;
  }
  function readU32() { const v = dv.getUint32(pos); pos += 4; return v; }
  function readU16() { const v = dv.getUint16(pos); pos += 2; return v; }
  function readVLV() {
    let v = 0, b;
    do {
      b = bytes[pos++];
      v = (v << 7) | (b & 0x7F);
    } while (b & 0x80);
    return v;
  }

  const header = readStr(4);
  if (header !== 'MThd') throw new Error('不是有效的 MIDI 文件（缺少 MThd）');
  const hlen = readU32();
  const format = readU16();
  const ntrks = readU16();
  const division = readU16();
  if (format > 2) throw new Error('不支持的 MIDI 格式: ' + format);
  pos += hlen - 6;

  const tracks = [];
  for (let t = 0; t < ntrks; t++) {
    const id = readStr(4);
    if (id !== 'MTrk') throw new Error('轨道头错误 @' + pos);
    const tlen = readU32();
    const end = pos + tlen;
    const events = [];
    let tick = 0;
    let running = 0;
    while (pos < end) {
      tick += readVLV();
      let b = bytes[pos];
      if (b >= 0x80) {
        running = b;
        pos++;
      }
      const status = running;
      if (status >= 0xF0) {
        if (status === 0xFF) {
          const mtype = bytes[pos++];
          const mlen = readVLV();
          const data = bytes.slice(pos, pos + mlen);
          pos += mlen;
          events.push({ tick, type: 'meta', meta: mtype, data });
        } else if (status === 0xF0 || status === 0xF7) {
          const mlen = readVLV();
          pos += mlen;
          events.push({ tick, type: 'sysex' });
        } else if (status === 0xF1 || status === 0xF2 || status === 0xF3) {
          // MIDI time code / song pos / song select
          pos += (status === 0xF2 ? 2 : 1);
        } else if (status === 0xF6 || status === 0xF8 || status === 0xFA ||
                   status === 0xFB || status === 0xFC || status === 0xFE || status === 0xFF) {
          // realtime; ignore
        }
        continue;
      }
      const ch = status & 0x0F;
      const kind = status & 0xF0;
      if (kind === 0x80 || kind === 0x90) {
        const note = bytes[pos++];
        const vel = bytes[pos++];
        if (kind === 0x90 && vel > 0) events.push({ tick, type: 'noteon', ch, note, vel });
        else events.push({ tick, type: 'noteoff', ch, note, vel });
      } else if (kind === 0xA0) {
        pos += 2; events.push({ tick, type: 'poly', ch });
      } else if (kind === 0xB0) {
        const cc = bytes[pos++];
        const val = bytes[pos++];
        events.push({ tick, type: 'cc', ch, cc, val });
      } else if (kind === 0xC0) {
        const prog = bytes[pos++];
        events.push({ tick, type: 'pc', ch, prog });
      } else if (kind === 0xD0) {
        pos += 1; events.push({ tick, type: 'chan', ch });
      } else if (kind === 0xE0) {
        const lsb = bytes[pos++];
        const msb = bytes[pos++];
        const v = ((msb << 7) | lsb) - 8192;
        events.push({ tick, type: 'pb', ch, val: v });
      }
    }
    tracks.push(events);
  }

  // extract tempo map & merge
  const tempoMap = []; // {tick, seconds(absolute), tempo}
  let tempo = 500000;
  tempoMap.push({ tick: 0, tempo });
  const all = [];
  let tpq = division;
  if (division & 0x8000) {
    // SMPTE: division = -24..-1 fps * 256
    const fps = 256 - (division >> 8);
    tpq = division & 0xFF;
    for (const ev of tracks) {
      for (const e of ev) {
        if (e.type === 'meta' && e.meta === 0x51) {
          const t = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
          tempoMap.push({ tick: e.tick, tempo: t });
        }
        all.push(e);
      }
    }
  } else {
    for (const ev of tracks) {
      for (const e of ev) {
        if (e.type === 'meta' && e.meta === 0x51 && e.data.length >= 3) {
          const t = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
          if (t > 0) tempoMap.push({ tick: e.tick, tempo: t });
        }
        all.push(e);
      }
    }
  }
  tempoMap.sort((a, b) => a.tick - b.tick);

  // absolute seconds per event
  const tickToSec = makeTickToSec(tempoMap, tpq);
  for (const e of all) e.sec = tickToSec(e.tick);

  // track names / song name — many Chinese MIDI files store the name in
  // GBK/GB2312; UTF-8-decode strictly first, fall back to GBK, then latin-1.
  const decoders = [
    () => new TextDecoder('utf-8', { fatal: true }),
    () => new TextDecoder('gbk'),
    () => new TextDecoder('latin1'),
  ];
  function decodeName(data) {
    for (const mk of decoders) {
      try {
        const s = mk().decode(data).replace(/\u0000/g, '').trim();
        if (s && !/[\uFFFD]/.test(s)) return s;
      } catch (e) { /* try next encoding */ }
    }
    return '';
  }
  let name = '';
  for (const ev of tracks) {
    for (const e of ev) {
      if (e.type === 'meta' && (e.meta === 0x03 || e.meta === 0x01) && e.data.length) {
        name = decodeName(e.data);
        if (name) break;
      }
    }
    if (name) break;
  }

  all.sort((a, b) => a.tick - b.tick || (a.sec - b.sec));
  let maxTick = 0;
  for (const e of all) if (e.tick > maxTick) maxTick = e.tick;
  const duration = all.length ? tickToSec(maxTick) : 0;

  return { format, ntrks, division: tpq, name, events: all, duration, tickToSec, tempoMap };
}

function makeTickToSec(tempoMap, tpq) {
  // precompute cumulative
  const points = [];
  let tick = 0, sec = 0;
  for (let i = 0; i < tempoMap.length; i++) {
    const tm = tempoMap[i];
    if (tm.tick < tick) continue;
    points.push({ tick: tm.tick, sec, tempo: tm.tempo });
    // advance to next tempo
    if (i + 1 < tempoMap.length) {
      const dt = tempoMap[i + 1].tick - tm.tick;
      sec += dt * tm.tempo / 1e6 / tpq;
    }
    tick = tm.tick;
  }
  const lastTempo = tempoMap[tempoMap.length - 1].tempo;
  const pts = points;
  // binary search over the precomputed tempo points (fast for huge MIDI files)
  return (t) => {
    if (t <= pts[0].tick) return pts[0].sec;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].tick <= t) lo = mid; else hi = mid - 1;
    }
    const p = pts[lo];
    if (lo === pts.length - 1) {
      return p.sec + (t - p.tick) * lastTempo / 1e6 / tpq;
    }
    return p.sec + (t - p.tick) * p.tempo / 1e6 / tpq;
  };
}
