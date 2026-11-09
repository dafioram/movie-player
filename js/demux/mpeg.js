// Demuxer for MPEG program streams (.mpg, .vob), transport streams (.ts, .m2ts) and raw audio
// elementary streams (.ac3, .eac3, .dts, .mp2). It hands out PES payloads per stream with their
// presentation times; the decoders run FFmpeg's parsers on them, so payloads need not be whole frames.

const READ = 1 << 20;
const WRAP = 2 ** 33;

export async function readBytes(blob, start, end) {
  start = Math.max(0, start);
  end = Math.min(blob.size, end);
  if (end <= start) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function readPts(b, o) {
  return ((b[o] >> 1) & 7) * 2 ** 30 + ((b[o + 1] << 7) | (b[o + 2] >> 1)) * 2 ** 15 + ((b[o + 3] << 7) | (b[o + 4] >> 1));
}

/** Parses a PES header at b[o] (which points at 00 00 01 xx). Returns {sid, pts, dts, payloadStart}. */
function parsePesHeader(b, o, end) {
  const sid = b[o + 3];
  let p = o + 6;
  let pts = null, dts = null;
  if (sid === 0xbe || sid === 0xbf || sid === 0xbc || sid === 0xf0 || sid === 0xf1 || sid === 0xff || sid === 0xf2 || sid === 0xf8) {
    return { sid, pts, dts, payloadStart: p };
  }
  if (p >= end) return null;
  if ((b[p] & 0xc0) === 0x80) {
    // MPEG-2 PES
    if (p + 3 > end) return null;
    const flags = b[p + 1] >> 6;
    const hlen = b[p + 2];
    if (flags & 2 && p + 8 <= end) pts = readPts(b, p + 3);
    if (flags === 3 && p + 13 <= end) dts = readPts(b, p + 8);
    return { sid, pts, dts, payloadStart: p + 3 + hlen };
  }
  // MPEG-1 PES
  while (p < end && b[p] === 0xff) p++;
  if (p < end && (b[p] & 0xc0) === 0x40) p += 2;
  if (p >= end) return null;
  if ((b[p] & 0xf0) === 0x20) { pts = readPts(b, p); p += 5; }
  else if ((b[p] & 0xf0) === 0x30) { pts = readPts(b, p); dts = readPts(b, p + 5); p += 10; }
  else p += 1;
  return { sid, pts, dts, payloadStart: p };
}

/** For a PS PES, returns the stream key and the offset where the elementary data starts. */
function psStreamKey(sid, b, payloadStart, end) {
  if (sid >= 0xe0 && sid <= 0xef) return { key: 'e' + sid.toString(16), skip: 0 };
  if (sid >= 0xc0 && sid <= 0xdf) return { key: 'a' + sid.toString(16), skip: 0 };
  if (sid === 0xbd && payloadStart < end) {
    const sub = b[payloadStart];
    if (sub >= 0x20 && sub <= 0x3f) return { key: 'bd' + sub.toString(16), skip: 1 };
    if (sub >= 0x80 && sub <= 0xaf) return { key: 'bd' + sub.toString(16), skip: 4 };
    if (sub >= 0xb0 && sub <= 0xbf) return { key: 'bd' + sub.toString(16), skip: 5 };
    if (sub >= 0xc0 && sub <= 0xcf) return { key: 'bd' + sub.toString(16), skip: 4 };
  }
  return null;
}

/* ---------------- container detection ---------------- */

function detectTs(b) {
  for (const size of [188, 192]) {
    const off = size === 192 ? 4 : 0;
    let ok = 0;
    for (let i = 0; i < 6; i++) {
      for (let s = 0; s < size; s++) {
        // allow a few junk bytes at the start
        if (b[s + off] === 0x47 && b[s + off + size] === 0x47 && b[s + off + size * 2] === 0x47) {
          return { packetSize: size, offset: s };
        }
      }
      ok++;
    }
  }
  return null;
}

function findStartCode(b, from, code) {
  for (let i = from; i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && b[i + 3] === code) return i;
  }
  return -1;
}

const AC3_RATES = [48000, 44100, 32000];
const AC3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
const MPA_BITRATES = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const MPA_RATES = [44100, 48000, 32000];

/** Recognises raw audio elementary streams and works out their byte rate. */
function detectRawAudio(b) {
  for (let i = 0; i < Math.min(b.length - 16, 4096); i++) {
    if (b[i] === 0x0b && b[i + 1] === 0x77) {
      const bsid = b[i + 5] >> 3;
      if (bsid <= 10) {
        const fscod = b[i + 4] >> 6, frmsizecod = b[i + 4] & 0x3f;
        if (fscod === 3 || frmsizecod > 37) continue;
        const kbps = AC3_BITRATES[frmsizecod >> 1];
        return { codec: 'ac3', offset: i, bytesPerSec: (kbps * 1000) / 8 };
      }
      if (bsid > 10 && bsid <= 16) {
        const frmsiz = (((b[i + 2] & 7) << 8) | b[i + 3]) + 1;
        const fscod = b[i + 4] >> 6;
        const numblk = fscod === 3 ? 6 : [1, 2, 3, 6][(b[i + 4] >> 4) & 3];
        const rate = fscod === 3 ? [24000, 22050, 16000][(b[i + 4] >> 4) & 3] : AC3_RATES[fscod];
        return { codec: 'eac3', offset: i, bytesPerSec: (frmsiz * 2 * rate) / (numblk * 256) };
      }
    }
    if (b[i] === 0x7f && b[i + 1] === 0xfe && b[i + 2] === 0x80 && b[i + 3] === 0x01) {
      const nblks = ((b[i + 4] & 1) << 6) | (b[i + 5] >> 2);
      const fsize = (((b[i + 5] & 3) << 12) | (b[i + 6] << 4) | (b[i + 7] >> 4)) + 1;
      const sfreq = (b[i + 8] >> 2) & 0xf;
      const rate = [0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000][sfreq] || 48000;
      return { codec: 'dca', offset: i, bytesPerSec: (fsize * rate) / ((nblks + 1) * 32) };
    }
    if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) {
      const ver = (b[i + 1] >> 3) & 3, layerBits = (b[i + 1] >> 1) & 3;
      const br = b[i + 2] >> 4, sr = (b[i + 2] >> 2) & 3;
      if (ver !== 3 || layerBits === 0 || br === 0 || br === 15 || sr === 3) continue;
      const layer = 4 - layerBits;
      const next = layer === 1 ? 0 : 0;
      void next;
      return { codec: 'mp' + layer, offset: i, bytesPerSec: (MPA_BITRATES[layer][br] * 1000) / 8, sampleRate: MPA_RATES[sr] };
    }
  }
  return null;
}

/* ---------------- PES iteration ---------------- */

/**
 * Walks a PS or TS file from `start`, calling onPes({key, pts, data, offset}) for every PES
 * of the wanted keys (all if keys is null). Stops when onPes returns false or at `end`.
 */
export async function walkPes(blob, info, start, end, keys, onPes, signal) {
  if (info.kind === 'ps') return walkPs(blob, start, end, keys, onPes, signal);
  return walkTs(blob, info, start, end, keys, onPes, signal);
}

async function walkPs(blob, start, end, keys, onPes, signal) {
  let off = start;
  let buf = new Uint8Array(0);
  let bufStart = start;
  let pos = 0;
  end = Math.min(end, blob.size);
  for (;;) {
    if (signal && signal.aborted) return;
    if (pos + 16 > buf.length) {
      if (bufStart + buf.length >= end) return bufStart + pos;
      const more = await readBytes(blob, bufStart + buf.length, Math.min(end, bufStart + buf.length + READ));
      const nb = new Uint8Array(buf.length - pos + more.length);
      nb.set(buf.subarray(pos));
      nb.set(more, buf.length - pos);
      bufStart += pos;
      buf = nb;
      pos = 0;
      if (buf.length < 16) return bufStart + pos;
    }
    if (!(buf[pos] === 0 && buf[pos + 1] === 0 && buf[pos + 2] === 1)) {
      // resync to the next pack header
      const n = findStartCode(buf, pos + 1, 0xba);
      if (n < 0) { pos = Math.max(pos, buf.length - 3); continue; }
      pos = n;
      continue;
    }
    const code = buf[pos + 3];
    if (code === 0xba) {
      const mpeg2 = (buf[pos + 4] & 0xc0) === 0x40;
      pos += mpeg2 ? 14 + (buf[pos + 13] & 7) : 12;
      continue;
    }
    if (code === 0xb9) { pos += 4; continue; } // program end
    if (code < 0xbb) { pos += 4; continue; }
    const len = (buf[pos + 4] << 8) | buf[pos + 5];
    const total = 6 + len;
    if (pos + total > buf.length) {
      if (bufStart + buf.length >= end) return bufStart + pos;
      // need more data: force a refill on the next pass
      const more = await readBytes(blob, bufStart + buf.length, Math.min(end, bufStart + buf.length + Math.max(READ, total)));
      if (!more.length) return bufStart + pos;
      const nb = new Uint8Array(buf.length - pos + more.length);
      nb.set(buf.subarray(pos));
      nb.set(more, buf.length - pos);
      bufStart += pos;
      buf = nb;
      pos = 0;
      continue;
    }
    if (code !== 0xbb) {
      const h = parsePesHeader(buf, pos, pos + total);
      if (h) {
        const k = psStreamKey(code, buf, h.payloadStart, pos + total);
        if (k && (!keys || keys.has(k.key))) {
          const data = buf.slice(h.payloadStart + k.skip, pos + total);
          const r = onPes({ key: k.key, pts: h.pts, dts: h.dts, data, offset: bufStart + pos });
          if (r === false) return;
        }
      }
    }
    pos += total;
    off = bufStart + pos;
  }
}

async function walkTs(blob, info, start, end, keys, onPes, signal) {
  const ps = info.packetSize, sync = ps === 192 ? 4 : 0;
  // align to a packet boundary
  const head = await readBytes(blob, start, start + ps * 8);
  let align = 0;
  for (let i = 0; i < ps; i++) {
    if (head[i + sync] === 0x47 && head[i + sync + ps] === 0x47) { align = i; break; }
  }
  let off = start + align;
  end = Math.min(end, blob.size);
  const pending = new Map(); // pid -> {parts, size, pts, offset}
  const emit = (pid) => {
    const p = pending.get(pid);
    if (!p) return true;
    pending.delete(pid);
    const all = new Uint8Array(p.size);
    let o = 0;
    for (const part of p.parts) { all.set(part, o); o += part.length; }
    if (all.length < 9 || all[0] !== 0 || all[1] !== 0 || all[2] !== 1) return true;
    const h = parsePesHeader(all, 0, all.length);
    if (!h) return true;
    return onPes({ key: 'pid' + pid, pts: h.pts, dts: h.dts, data: all.subarray(h.payloadStart), offset: p.offset });
  };
  const chunk = ps * 4096;
  while (off + ps <= end) {
    if (signal && signal.aborted) return;
    const b = await readBytes(blob, off, Math.min(end, off + chunk));
    let i = 0;
    for (; i + ps <= b.length; i += ps) {
      const p = i + sync;
      if (b[p] !== 0x47) {
        // lost sync: search forward
        let j = p + 1;
        while (j + ps < b.length && !(b[j] === 0x47 && b[j + ps] === 0x47)) j++;
        i = j - sync - ps;
        continue;
      }
      const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
      const key = 'pid' + pid;
      if (keys && !keys.has(key)) continue;
      if (!info.pidSet.has(pid)) continue;
      const pusi = b[p + 1] & 0x40;
      const afc = (b[p + 3] >> 4) & 3;
      let q = p + 4;
      if (afc === 2 || afc === 0) continue;
      if (afc === 3) q += 1 + b[p + 4];
      if (q >= p + 188) continue;
      const payload = b.subarray(q, p + 188);
      if (pusi) {
        if (emit(pid) === false) return;
        pending.set(pid, { parts: [payload.slice()], size: payload.length, offset: off + i });
      } else {
        const cur = pending.get(pid);
        if (cur) { cur.parts.push(payload.slice()); cur.size += payload.length; }
      }
    }
    off += i;
    if (i === 0) break;
  }
  if (end < blob.size) {
    let resume = off;
    for (const p of pending.values()) resume = Math.min(resume, p.offset);
    return resume;
  }
  for (const pid of [...pending.keys()]) if (emit(pid) === false) return;
  return blob.size;
}

/* ---------------- PSI (transport streams) ---------------- */

const TS_TYPES = {
  0x01: ['video', 'mpeg1video'], 0x02: ['video', 'mpeg2video'], 0x1b: ['video', 'h264'], 0x24: ['video', 'hevc'],
  0x03: ['audio', 'mpa'], 0x04: ['audio', 'mpa'], 0x0f: ['audio', 'aac'], 0x11: ['audio', 'aac_latm'],
  0x80: ['audio', 'pcm_bluray'], 0x81: ['audio', 'ac3'], 0x82: ['audio', 'dca'], 0x83: ['audio', 'truehd'],
  0x84: ['audio', 'eac3'], 0x85: ['audio', 'dca'], 0x86: ['audio', 'dca'], 0x87: ['audio', 'eac3'],
  0xa1: ['audio', 'eac3'], 0xa2: ['audio', 'dca'], 0x90: ['sub', 'pgs'], 0xea: ['video', 'vc1'],
};

async function readPsi(blob, info) {
  const ps = info.packetSize, sync = ps === 192 ? 4 : 0;
  const b = await readBytes(blob, info.offset, info.offset + ps * 20000);
  let pmtPid = null;
  const streams = [];
  const sections = new Map();
  for (let i = 0; i + ps <= b.length; i += ps) {
    const p = i + sync;
    if (b[p] !== 0x47) continue;
    const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
    if (pid !== 0 && pid !== pmtPid) continue;
    if (!(b[p + 1] & 0x40)) continue;
    const afc = (b[p + 3] >> 4) & 3;
    let q = p + 4;
    if (afc === 3) q += 1 + b[p + 4];
    q += 1 + b[q]; // pointer field
    const tableId = b[q];
    const secLen = ((b[q + 1] & 0x0f) << 8) | b[q + 2];
    const sec = b.subarray(q, q + 3 + secLen);
    if (pid === 0 && tableId === 0 && pmtPid === null) {
      for (let j = 8; j + 4 <= sec.length - 4; j += 4) {
        const prog = (sec[j] << 8) | sec[j + 1];
        const ppid = ((sec[j + 2] & 0x1f) << 8) | sec[j + 3];
        if (prog !== 0) { pmtPid = ppid; break; }
      }
    } else if (pid === pmtPid && tableId === 2 && !sections.has(pid)) {
      sections.set(pid, true);
      const progInfoLen = ((sec[10] & 0x0f) << 8) | sec[11];
      let j = 12 + progInfoLen;
      while (j + 5 <= sec.length - 4) {
        const type = sec[j];
        const epid = ((sec[j + 1] & 0x1f) << 8) | sec[j + 2];
        const esLen = ((sec[j + 3] & 0x0f) << 8) | sec[j + 4];
        const desc = sec.subarray(j + 5, j + 5 + esLen);
        let kind = TS_TYPES[type] ? TS_TYPES[type][0] : null;
        let codec = TS_TYPES[type] ? TS_TYPES[type][1] : null;
        let lang = null;
        for (let d = 0; d + 2 <= desc.length; d += 2 + desc[d + 1]) {
          const tag = desc[d], dl = desc[d + 1];
          if (tag === 0x0a && dl >= 3) lang = String.fromCharCode(desc[d + 2], desc[d + 3], desc[d + 4]);
          if (type === 0x06) {
            if (tag === 0x6a) { kind = 'audio'; codec = 'ac3'; }
            else if (tag === 0x7a) { kind = 'audio'; codec = 'eac3'; }
            else if (tag === 0x7b) { kind = 'audio'; codec = 'dca'; }
            else if (tag === 0x59) { kind = 'sub'; codec = 'dvbsub'; }
            else if (tag === 0x56) { kind = 'sub'; codec = 'teletext'; }
          }
          if (tag === 0x05 && dl >= 4) {
            const reg = String.fromCharCode(desc[d + 2], desc[d + 3], desc[d + 4], desc[d + 5]);
            if (reg === 'AC-3') { kind = 'audio'; codec = codec === 'eac3' ? 'eac3' : 'ac3'; }
            if (reg.startsWith('DTS')) { kind = 'audio'; codec = 'dca'; }
          }
        }
        streams.push({ key: 'pid' + epid, pid: epid, streamType: type, kind: kind || 'other', codec: codec || 'unknown', lang });
        j += 5 + esLen;
      }
    }
    if (sections.size) break;
  }
  return streams;
}

/* ---------------- probing ---------------- */

function mpegVideoCodec(sample) {
  const seq = findStartCode(sample, 0, 0xb3);
  if (seq < 0) return null;
  const ext = findStartCode(sample, seq + 4, 0xb5);
  const nextPic = findStartCode(sample, seq + 4, 0x00);
  return ext >= 0 && (nextPic < 0 || ext < nextPic) ? 'mpeg2video' : 'mpeg1video';
}

function mpaLayer(sample) {
  for (let i = 0; i + 4 < sample.length; i++) {
    if (sample[i] === 0xff && (sample[i + 1] & 0xe0) === 0xe0) {
      const layerBits = (sample[i + 1] >> 1) & 3;
      if (layerBits) return 4 - layerBits;
    }
  }
  return 2;
}

function ac3Kind(sample) {
  for (let i = 0; i + 6 < sample.length; i++) {
    if (sample[i] === 0x0b && sample[i + 1] === 0x77) return (sample[i + 5] >> 3) > 10 ? 'eac3' : 'ac3';
  }
  return 'ac3';
}

/**
 * Probes a PS/TS/raw-audio file. Returns null if it is none of those.
 * Result: { kind, size, streams: [{key, kind, codec, lang, sample: Uint8Array, firstPts}],
 *           firstPts (raw seconds), duration (seconds) }
 */
export async function probeMpeg(blob, name = '') {
  const head = await readBytes(blob, 0, 65536);
  const lower = name.toLowerCase();
  const ts = detectTs(head);
  let info;
  if (ts && !/\.(ac3|eac3|ec3|dts|mp2|mpa)$/.test(lower)) {
    info = { kind: 'ts', packetSize: ts.packetSize, offset: ts.offset, size: blob.size };
    const psi = await readPsi(blob, info);
    info.streams = psi;
    info.pidSet = new Set(psi.map((s) => s.pid));
  } else if (findStartCode(head, 0, 0xba) >= 0 && findStartCode(head, 0, 0xba) < 4096) {
    info = { kind: 'ps', size: blob.size, streams: [] };
  } else {
    const raw = detectRawAudio(head);
    if (!raw) return null;
    const duration = (blob.size - raw.offset) / raw.bytesPerSec;
    return {
      kind: 'raw', size: blob.size, offset: raw.offset, bytesPerSec: raw.bytesPerSec, firstPts: 0, duration,
      streams: [{ key: 'raw', kind: 'audio', codec: raw.codec, lang: null, sample: head.subarray(raw.offset), firstPts: 0 }],
    };
  }

  // scan the beginning: collect samples and first timestamps per stream
  const found = new Map();
  const want = 400000;
  await walkPes(blob, info, info.kind === 'ts' ? info.offset : 0, Math.min(blob.size, 24 << 20), null, (pes) => {
    let s = found.get(pes.key);
    if (!s) {
      s = { key: pes.key, parts: [], size: 0, firstPts: null };
      found.set(pes.key, s);
    }
    if (s.firstPts === null && pes.pts !== null) s.firstPts = pes.pts;
    if (s.size < want) { s.parts.push(pes.data); s.size += pes.data.length; }
    // stop once every stream has enough
    let done = found.size > 0;
    for (const v of found.values()) if (v.size < want && !v.key.startsWith('bd2') && !v.key.startsWith('bd3')) done = false;
    return !done;
  });

  const streams = [];
  for (const s of found.values()) {
    const sample = new Uint8Array(s.size);
    let o = 0;
    for (const p of s.parts) { sample.set(p, o); o += p.length; }
    let kind = null, codec = null, lang = null, extra = {};
    if (info.kind === 'ts') {
      const meta = info.streams.find((x) => x.key === s.key);
      if (!meta) continue;
      ({ kind, codec, lang } = meta);
      extra = { pid: meta.pid, streamType: meta.streamType };
      if (codec === 'mpa') codec = 'mp' + mpaLayer(sample);
      if (codec === 'ac3' || codec === 'eac3') codec = ac3Kind(sample);
      if (codec === 'mpeg2video' || codec === 'mpeg1video') codec = mpegVideoCodec(sample) || codec;
    } else {
      const k = s.key;
      if (k.startsWith('e')) { kind = 'video'; codec = mpegVideoCodec(sample) || 'mpeg2video'; }
      else if (k.startsWith('a')) { kind = 'audio'; codec = 'mp' + mpaLayer(sample); }
      else if (k.startsWith('bd')) {
        const sub = parseInt(k.slice(2), 16);
        if (sub >= 0x20 && sub <= 0x3f) { kind = 'sub'; codec = 'dvdsub'; }
        else if (sub >= 0x80 && sub <= 0x87) { kind = 'audio'; codec = ac3Kind(sample); }
        else if (sub >= 0x88 && sub <= 0x8f) { kind = 'audio'; codec = 'dca'; }
        else if (sub >= 0xa0 && sub <= 0xa7) { kind = 'audio'; codec = 'pcm_dvd'; }
        else if (sub >= 0xb0 && sub <= 0xbf) { kind = 'audio'; codec = 'truehd'; }
        else if (sub >= 0xc0 && sub <= 0xcf) { kind = 'audio'; codec = 'eac3'; }
      }
    }
    if (!kind) continue;
    streams.push({ key: s.key, kind, codec, lang, sample, firstPts: s.firstPts, ...extra });
  }
  // TS streams that carried no data in the first megabytes still get listed
  if (info.kind === 'ts') {
    for (const meta of info.streams) {
      if (!streams.find((x) => x.key === meta.key) && (meta.kind === 'audio' || meta.kind === 'video' || meta.kind === 'sub')) {
        streams.push({ ...meta, sample: new Uint8Array(0), firstPts: null });
      }
    }
  }
  // order: video, audio by stream id, subtitles
  const order = { video: 0, audio: 1, sub: 2 };
  streams.sort((a, b) => order[a.kind] - order[b.kind] || a.key.localeCompare(b.key, undefined, { numeric: true }));

  const ref = streams.find((s) => s.kind === 'video' && s.firstPts !== null) || streams.find((s) => s.firstPts !== null);
  if (!ref) throw new Error('No timestamps found in this MPEG file');
  const timed = streams.filter((s) => s.firstPts !== null && s.kind !== 'sub');
  const firstRaw = Math.min(...(timed.length ? timed : streams.filter((s) => s.firstPts !== null)).map((s) => s.firstPts));
  info.firstPtsRaw = firstRaw;
  info.refKey = ref.key;
  info.streams = streams;
  info.pidSet = info.kind === 'ts' ? new Set(streams.map((s) => s.pid)) : null;
  for (const s of streams) s.firstPts = s.firstPts === null ? null : unwrap(info, s.firstPts);
  info.firstPts = unwrap(info, firstRaw);

  // last timestamp: scan the tail
  let lastPts = null;
  for (let back = 4 << 20; back <= 64 << 20 && lastPts === null; back *= 4) {
    const from = Math.max(0, blob.size - back);
    await walkPes(blob, info, from, blob.size, new Set([ref.key]), (pes) => {
      if (pes.pts !== null) lastPts = pes.pts;
    });
    if (from === 0) break;
  }
  const last = lastPts === null ? info.firstPts : unwrap(info, lastPts);
  info.duration = Math.max(0.1, last - info.firstPts);
  return info;
}

/** Converts a 33-bit 90 kHz timestamp into seconds, continuous across one wrap-around. */
export function unwrap(info, pts) {
  let d = (pts - info.firstPtsRaw) % WRAP;
  if (d < 0) d += WRAP;
  if (d > WRAP / 2) d -= WRAP;
  return (info.firstPtsRaw + d) / 90000;
}

/* ---------------- reading one stream ---------------- */

/**
 * Hands out PES payloads of one stream from a seek point. next() returns
 * {data, pts (seconds, raw timeline) | null} or null at the end.
 */
export class MpegStreamReader {
  constructor(blob, info, key) {
    this.blob = blob;
    this.info = info;
    this.key = key;
    this.queue = [];
    this.done = false;
    this.abort = null;
    this.pos = 0;
  }

  /** Positions the reader shortly before `time` (raw seconds). */
  async seek(time, lead = 1.0) {
    this._stop();
    this.queue = [];
    this.done = false;
    if (this.info.kind === 'raw') {
      const t = Math.max(0, time - this.info.firstPts);
      this.pos = Math.max(this.info.offset, Math.floor(this.info.offset + t * this.info.bytesPerSec));
      this.rawPts = (this.pos - this.info.offset) / this.info.bytesPerSec + this.info.firstPts;
      return;
    }
    this.pos = await findOffset(this.blob, this.info, time - lead, this.key);
  }

  _stop() {
    if (this.abort) this.abort.abort();
    this.abort = null;
    this.walking = null;
  }

  async next() {
    if (this.info.kind === 'raw') {
      if (this.pos >= this.blob.size) return null;
      const data = await readBytes(this.blob, this.pos, this.pos + 65536);
      const pts = this.rawPts;
      this.rawPts = null;
      this.pos += data.length;
      return { data, pts };
    }
    while (!this.queue.length) {
      if (this.done) return null;
      await this._fill();
    }
    return this.queue.shift();
  }

  async _fill() {
    // read a slice of the file and keep the PES payloads of our stream
    const start = this.pos;
    if (start >= this.blob.size) { this.done = true; return; }
    const span = 4 << 20;
    const end = Math.min(this.blob.size, start + span);
    const keys = new Set([this.key]);
    const resume = await walkPes(this.blob, this.info, start, end, keys, (pes) => {
      this.queue.push({ data: pes.data, pts: pes.pts === null ? null : unwrap(this.info, pes.pts) });
    });
    if (end >= this.blob.size) { this.done = true; this.pos = end; return; }
    this.pos = resume > start ? resume : end;
  }
}

/** Finds a byte offset whose reference-stream timestamp is at or just before `time` (raw seconds). */
export async function findOffset(blob, info, time, key = info.refKey) {
  if (time <= info.firstPts + 0.05) return info.kind === 'ts' ? info.offset : 0;
  const keys = new Set([key]);
  const ptsAt = async (offset) => {
    let found = null;
    await walkPes(blob, info, offset, Math.min(blob.size, offset + (3 << 20)), keys, (pes) => {
      if (pes.pts !== null) { found = unwrap(info, pes.pts); return false; }
    });
    return found;
  };
  let lo = 0, hi = blob.size;
  // first guess from the average byte rate
  for (let iter = 0; iter < 40 && hi - lo > (512 << 10); iter++) {
    const mid = Math.floor((lo + hi) / 2);
    const t = await ptsAt(mid);
    if (t === null || t > time) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Background scan helper for subtitle streams: calls onPes for the given keys over a byte range. */
export async function scanStreams(blob, info, keys, start, end, onPes, signal) {
  await walkPes(blob, info, start, end, new Set(keys), (pes) => {
    onPes({ key: pes.key, data: pes.data, pts: pes.pts === null ? null : unwrap(info, pes.pts), offset: pes.offset });
  }, signal);
}
