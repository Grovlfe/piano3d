// sf2worker.js — 在 Web Worker 中解析 SF2 文件，提取 88 键 × 力度层采样
// 兼容标准与 Polyphone 变体（phdr 32/38/40 字节条目自动探测）
const NOTE0 = 21, NOTE1 = 108;
const TARGET_RATE = 32000;

function u16(b, o) { return (b[o] | (b[o + 1] << 8)) & 0xFFFF; }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function walkRiff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  const chunks = {};
  const len = bytes.length;
  while (pos + 8 <= len) {
    const cid = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const csize = view.getUint32(pos + 4, true);
    if (cid === 'LIST') {
      const typ = String.fromCharCode(bytes[pos + 8], bytes[pos + 9], bytes[pos + 10], bytes[pos + 11]);
      chunks[typ] = { off: pos + 12, size: csize - 4 };
      pos += 12 + (csize - 4) + (csize & 1);
    } else {
      chunks[cid] = { off: pos + 8, size: csize };
      pos += 8 + csize + (csize & 1);
    }
  }
  return chunks;
}

function findEop(phdr, maxOff) {
  for (const stride of [32, 34, 36, 38, 40]) {
    for (let pos = 0; pos + stride <= maxOff; pos += stride) {
      let name = '';
      for (let i = 0; i < 20; i++) {
        const c = phdr[pos + i];
        if (c === 0) break;
        name += String.fromCharCode(c);
      }
      if (name === 'EOP') return { stride, eop: pos };
    }
  }
  return null;
}

function subchunks(data) {
  const subs = {};
  let pos = 0;
  while (pos + 8 <= data.length) {
    const cid = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
    const sz = u32(data, pos + 4);
    subs[cid] = { off: pos + 8, size: sz };
    pos += 8 + sz + (sz & 1);
  }
  return subs;
}

function resample(pcm, srcRate, dstRate) {
  if (srcRate === dstRate) return pcm;
  const outLen = Math.max(1, Math.floor(pcm.length * dstRate / srcRate));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const f = i * srcRate / dstRate;
    const i0 = Math.floor(f), i1 = Math.min(pcm.length - 1, i0 + 1);
    const frac = f - i0;
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac;
  }
  return out;
}

function parseAndExtract(bytes) {
  if (bytes.length < 16) throw new Error('文件过小');
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'RIFF') throw new Error('不是有效的 SF2 文件（缺少 RIFF 头）');
  const chunks = walkRiff(bytes);
  if (!chunks.pdta || !chunks.sdta) throw new Error('不是有效的 SF2 文件（缺少数据块）');
  const pdta = bytes.subarray(chunks.pdta.off, chunks.pdta.off + chunks.pdta.size);
  const subs = subchunks(pdta);
  const need = ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr'];
  for (const k of need) if (!subs[k]) throw new Error('SF2 结构缺少 ' + k);

  const phdr = pdta.subarray(subs.phdr.off, subs.phdr.off + subs.phdr.size);
  const pbag = pdta.subarray(subs.pbag.off, subs.pbag.off + subs.pbag.size);
  const pgen = pdta.subarray(subs.pgen.off, subs.pgen.off + subs.pgen.size);
  const inst = pdta.subarray(subs.inst.off, subs.inst.off + subs.inst.size);
  const ibag = pdta.subarray(subs.ibag.off, subs.ibag.off + subs.ibag.size);
  const igen = pdta.subarray(subs.igen.off, subs.igen.off + subs.igen.size);
  const shdr = pdta.subarray(subs.shdr.off, subs.shdr.off + subs.shdr.size);

  const eopInfo = findEop(phdr, phdr.length);
  const npres = eopInfo ? Math.floor(eopInfo.eop / eopInfo.stride) : 1;
  const stride = eopInfo ? eopInfo.stride : 38;
  const presets = [];
  for (let i = 0; i < Math.max(1, npres); i++) {
    const e = i * stride;
    let name = '';
    for (let j = 0; j < 20; j++) { const c = phdr[e + j]; if (!c) break; name += String.fromCharCode(c); }
    presets.push({ name, preset: u16(phdr, e + 20), bank: u16(phdr, e + 22), bagNdx: u16(phdr, e + 24) });
  }

  const npbag = Math.floor(pbag.length / 4);
  const npgen = Math.floor(pgen.length / 4);
  const ninst = Math.floor(inst.length / 22);
  const nshdr = Math.floor(shdr.length / 46);

  const samples = [];
  for (let i = 0; i < nshdr; i++) {
    const e = i * 46;
    samples.push({
      start: u32(shdr, e + 20), end: u32(shdr, e + 24),
      loopS: u32(shdr, e + 28), loopE: u32(shdr, e + 32),
      rate: u32(shdr, e + 36), key: shdr[e + 40], corr: shdr[e + 41] << 24 >> 24,
      type: u16(shdr, e + 44),
    });
  }

  // choose preset: bank0/prog0 else first real preset
  let target = presets.find(p => p.name !== 'EOP' && p.bank === 0 && p.preset === 0) ||
               presets.find(p => p.name !== 'EOP' && p.name !== 'EOI');
  if (!target) throw new Error('SF2 中无可用预设');
  const z1 = npbag - 1;
  const z0 = target.bagNdx < z1 ? target.bagNdx : 0;

  // preset zones -> velocity layers -> instruments
  const layers = [];
  for (let zi = z0; zi < z1; zi++) {
    const gi0 = u16(pbag, zi * 4), gi1 = u16(pbag, (zi + 1) * 4);
    let instIdx = null, velLo = 1, velHi = 127;
    for (let j = gi0; j < gi1; j++) {
      const oper = u16(pgen, j * 4), amt = u16(pgen, j * 4 + 2);
      if (oper === 41) instIdx = amt;
      else if (oper === 44) { velLo = amt & 0xFF; velHi = (amt >> 8) & 0xFF; }
    }
    if (instIdx != null && instIdx < ninst) layers.push({ velLo, velHi, inst: instIdx });
  }
  layers.sort((a, b) => a.velLo - b.velLo);
  if (!layers.length) throw new Error('SF2 预设无力度分层');

  // sample data
  const sd = chunks.sdta;
  const smplSize = u32(bytes, sd.off);
  const smplOff = sd.off + 8;
  const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset + smplOff, Math.min(smplSize, bytes.length - smplOff) >> 1);

  function resolveInst(idx) {
    const i0 = u16(inst, idx * 22 + 20);
    const i1 = (idx + 1 < ninst) ? u16(inst, (idx + 1) * 22 + 20) : Math.floor(ibag.length / 4);
    const out = [];
    for (let zi = i0; zi < i1; zi++) {
      const gi0 = u16(ibag, zi * 4), gi1 = (zi + 1 < Math.floor(ibag.length / 4)) ? u16(ibag, (zi + 1) * 4) : Math.floor(igen.length / 4);
      let sid = null, velLo = 1, velHi = 127, keyLo = 0, keyHi = 127, root = null, coarse = 0, fine = 0, atten = 0;
      for (let j = gi0; j < gi1; j++) {
        const oper = u16(igen, j * 4), amt = u16(igen, j * 4 + 2);
        if (oper === 53) sid = amt;
        else if (oper === 44) { velLo = amt & 0xFF; velHi = (amt >> 8) & 0xFF; }
        else if (oper === 43) { keyLo = amt & 0xFF; keyHi = (amt >> 8) & 0xFF; }
        else if (oper === 58) root = amt & 0xFF;
        else if (oper === 51) coarse = amt << 16 >> 16;
        else if (oper === 52) fine = amt << 16 >> 16;
        else if (oper === 48) atten = amt;
      }
      if (sid == null || sid >= samples.length) continue;
      const s = samples[sid];
      out.push({ sid, velLo, velHi, keyLo, keyHi, root: root != null ? root : s.key,
                 coarse, fine, atten, corr: s.corr, rate: s.rate, start: s.start, end: s.end,
                 loopS: s.loopS, loopE: s.loopE });
    }
    return out;
  }

  const MAXL = 4;
  const notesOut = {};
  for (let note = NOTE0; note <= NOTE1; note++) {
    const list = [];
    for (const L of layers) {
      const refs = resolveInst(L.inst);
      let m = null;
      for (const r of refs) {
        if (r.keyLo <= note && note <= r.keyHi && r.velLo <= L.velHi && r.velHi >= L.velLo) { m = r; break; }
      }
      if (m) list.push({ velLo: L.velLo, velHi: L.velHi, ref: m });
    }
    const seen = new Set(); const uniq = [];
    for (const it of list) {
      const k = it.velLo + ':' + it.velHi + ':' + it.ref.sid;
      if (!seen.has(k)) { seen.add(k); uniq.push(it); }
    }
    if (uniq.length > MAXL) {
      const idxs = [...new Set([0, Math.floor(uniq.length / 3), Math.floor(2 * uniq.length / 3), uniq.length - 1])].sort((a, b) => a - b);
      notesOut[note] = idxs.map(i => uniq[i]);
    } else notesOut[note] = uniq;
  }

  // extract samples (with reuse cache)
  const extracted = new Map();
  const total = new Set();
  for (const note in notesOut) for (const it of notesOut[note]) total.add(it.ref.sid);
  const totalN = total.size;

  let done = 0;
  const emit = (msg) => postMessage(msg);

  for (const note in notesOut) {
    const layersArr = [];
    for (const it of notesOut[note]) {
      const r = it.ref;
      let rec = extracted.get(r.sid);
      if (!rec) {
        rec = { data: null, rate: TARGET_RATE, loopS: -1, loopE: -1, ok: false };
        extracted.set(r.sid, rec);
        try {
          if (r.rate <= 0 || r.end <= r.start) { /* invalid */ }
          else {
            const start = Math.max(0, r.start), end = Math.min(pcm16.length, r.end);
            if (end > start + 64) {
              const raw = new Float32Array(end - start);
              for (let i = 0; i < raw.length; i++) raw[i] = pcm16[start + i] / 32768;
              let idx = 0;
              const step = Math.max(1, r.rate >> 8), win = 2048;
              while (idx < raw.length - win) {
                let peak = 0;
                for (let i = idx; i < idx + win; i++) { const a = Math.abs(raw[i]); if (a > peak) peak = a; }
                if (peak > 0.0006) break;
                idx += step;
              }
              idx = Math.max(0, idx - Math.floor(r.rate * 0.015));
              let data = resample(raw.subarray(idx), r.rate, TARGET_RATE);
              let loopS = Math.round((r.loopS - r.start - idx) * TARGET_RATE / r.rate);
              let loopE = Math.round((r.loopE - r.start - idx) * TARGET_RATE / r.rate);
              if (loopS < 0 || loopE > data.length || loopE - loopS < 64) { loopS = -1; loopE = -1; }
              rec.data = data; rec.loopS = loopS; rec.loopE = loopE; rec.ok = true;
            }
          }
        } catch (e) { /* invalid region */ }
        done++;
        if (done % 40 === 0 || done === totalN) emit({ type: 'progress', done, total: totalN });
      }
      if (!rec.ok || !rec.data) continue;
      // copy (or transfer original on first unique use)
      const dataCopy = new Float32Array(rec.data);
      layersArr.push({
        data: dataCopy.buffer, rate: rec.rate,
        semi: (r.root - note) + r.coarse,
        cent: r.fine + r.corr,
        velLo: it.velLo, velHi: it.velHi, atten: r.atten,
        loopS: rec.loopS, loopE: rec.loopE,
      });
    }
    if (layersArr.length) {
      emit({ type: 'note', note: +note, layers: layersArr });
    }
  }
  emit({ type: 'done', totalNotes: Object.keys(notesOut).length });
}

self.onmessage = (e) => {
  try {
    const bytes = new Uint8Array(e.data.arrayBuffer);
    parseAndExtract(bytes);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
