// Fragmented MP4 writer for Media Source Extensions: one track per init segment, one
// moof+mdat per media segment. Only what Chrome's MSE parser needs.

const enc = new TextEncoder();

function u8(n) { return [n & 0xff]; }
function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function u64(n) {
  const hi = Math.floor(n / 2 ** 32), lo = n >>> 0;
  return [...u32(hi), ...u32(lo)];
}
function str(s) { return [...enc.encode(s)]; }

function box(type, ...parts) {
  let len = 8;
  const flat = [];
  for (const p of parts) {
    if (p instanceof Uint8Array) { flat.push(p); len += p.length; }
    else { const a = Uint8Array.from(p); flat.push(a); len += a.length; }
  }
  const out = new Uint8Array(len);
  out.set(u32(len), 0);
  out.set(str(type), 4);
  let o = 8;
  for (const a of flat) { out.set(a, o); o += a.length; }
  return out;
}

function fullBox(type, version, flags, ...parts) {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);
}

const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

function descriptor(tag, payload) {
  const len = payload.length;
  // 4-byte length form keeps it simple
  return [tag, 0x80 | ((len >> 21) & 0x7f), 0x80 | ((len >> 14) & 0x7f), 0x80 | ((len >> 7) & 0x7f), len & 0x7f, ...payload];
}

function esds(objectType, asc, bitrate = 0) {
  const dsi = asc && asc.length ? descriptor(5, [...asc]) : [];
  const dcd = descriptor(4, [objectType, 0x15, 0, 0, 0, ...u32(bitrate), ...u32(bitrate), ...dsi]);
  const es = descriptor(3, [...u16(1), 0, ...dcd, ...descriptor(6, [2])]);
  return fullBox('esds', 0, 0, es);
}

function dOps(opusHead, channels, sampleRate) {
  // OpusHead (little endian, 'OpusHead' magic) -> dOps (big endian)
  let outCh = channels, preSkip = 312, rate = sampleRate || 48000, gain = 0, family = 0, mapping = [];
  if (opusHead && opusHead.length >= 19) {
    const v = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
    outCh = opusHead[9];
    preSkip = v.getUint16(10, true);
    rate = v.getUint32(12, true);
    gain = v.getInt16(16, true);
    family = opusHead[18];
    if (family !== 0) mapping = [...opusHead.subarray(19, 21 + outCh)];
  }
  return box('dOps', [0, outCh, ...u16(preSkip), ...u32(rate), ...u16(gain & 0xffff), family, ...mapping]);
}

function vpcC(codecString) {
  // vp09.PP.LL.DD[.CC.cp.tc.mc.FF]
  const p = (codecString || 'vp09.00.10.08').split('.').map((x) => parseInt(x, 10));
  const profile = p[1] || 0, level = p[2] || 10, depth = p[3] || 8;
  const chroma = isNaN(p[4]) ? 1 : p[4];
  const primaries = isNaN(p[5]) ? 1 : p[5], transfer = isNaN(p[6]) ? 1 : p[6], matrix = isNaN(p[7]) ? 1 : p[7];
  const full = isNaN(p[8]) ? 0 : p[8];
  return fullBox('vpcC', 1, 0, [profile, level, (depth << 4) | (chroma << 1) | full, primaries, transfer, matrix, 0, 0]);
}

function videoSampleEntry(t) {
  const fourcc = t.fourcc;
  let config;
  if (fourcc === 'avc1' || fourcc === 'avc3') config = box('avcC', t.description);
  else if (fourcc === 'hvc1' || fourcc === 'hev1') config = box('hvcC', t.description);
  else if (fourcc === 'av01') config = box('av1C', t.description);
  else if (fourcc === 'vp09') config = vpcC(t.codecString);
  else throw new Error('Unsupported video sample entry ' + fourcc);
  const children = [config];
  if (t.sar && t.sar[0] > 0 && t.sar[1] > 0 && t.sar[0] !== t.sar[1]) {
    children.push(box('pasp', u32(t.sar[0]), u32(t.sar[1])));
  }
  const name = new Array(32).fill(0);
  return box(fourcc,
    [0, 0, 0, 0, 0, 0, ...u16(1), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...u32(0),
      ...u16(t.width), ...u16(t.height), ...u32(0x00480000), ...u32(0x00480000), ...u32(0), ...u16(1),
      ...name, ...u16(0x18), ...u16(0xffff)],
    ...children);
}

function audioSampleEntry(t) {
  const rate = Math.min(t.sampleRate, 65535);
  const head = [0, 0, 0, 0, 0, 0, ...u16(1), ...u32(0), ...u32(0), ...u16(t.channels), ...u16(16), ...u16(0), ...u16(0), ...u32(rate * 65536)];
  switch (t.fourcc) {
    case 'mp4a': return box('mp4a', head, esds(t.objectType || 0x40, t.description));
    case 'Opus': return box('Opus', head, dOps(t.description, t.channels, t.sampleRate));
    case 'fLaC': return box('fLaC', head, fullBox('dfLa', 0, 0, t.description));
    default: throw new Error('Unsupported audio sample entry ' + t.fourcc);
  }
}

/**
 * t: { kind: 'video'|'audio', fourcc, timescale, description, codecString,
 *      width, height, displayWidth, displayHeight, sar, sampleRate, channels, objectType }
 */
export function initSegment(t) {
  const video = t.kind === 'video';
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('mp41'));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100),
    new Array(10).fill(0), MATRIX, new Array(24).fill(0), u32(2));
  const dw = video ? (t.displayWidth || t.width) : 0, dh = video ? (t.displayHeight || t.height) : 0;
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), new Array(8).fill(0),
    u16(0), u16(0), u16(video ? 0 : 0x0100), u16(0), MATRIX, u32(dw * 65536), u32(dh * 65536));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), str(video ? 'vide' : 'soun'), new Array(12).fill(0), str(video ? 'Video' : 'Sound'), [0]);
  const xmhd = video ? fullBox('vmhd', 0, 1, new Array(8).fill(0)) : fullBox('smhd', 0, 0, new Array(4).fill(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const entry = video ? videoSampleEntry(t) : audioSampleEntry(t);
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf', xmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  const moov = box('moov', mvhd, trak, mvex);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  return out;
}

/**
 * samples: [{ data: Uint8Array, duration (ticks), cto (ticks, may be negative), key }]
 * baseDts: decode time of the first sample in ticks.
 */
export function mediaSegment(seq, baseDts, samples, withCto) {
  const n = samples.length;
  const flags = 0x001 | 0x100 | 0x200 | 0x400 | (withCto ? 0x800 : 0);
  const per = 12 + (withCto ? 4 : 0);
  const trunLen = 12 + 8 + n * per;
  const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
  const tfdt = fullBox('tfdt', 1, 0, u64(Math.max(0, Math.round(baseDts))));
  const mfhd = fullBox('mfhd', 0, 0, u32(seq));
  const trafLen = 8 + tfhd.length + tfdt.length + trunLen;
  const moofLen = 8 + mfhd.length + trafLen;
  let dataLen = 0;
  for (const s of samples) dataLen += s.data.length;
  const out = new Uint8Array(moofLen + 8 + dataLen);
  const v = new DataView(out.buffer);
  let o = 0;
  v.setUint32(o, moofLen); out.set(str('moof'), o + 4); o += 8;
  out.set(mfhd, o); o += mfhd.length;
  v.setUint32(o, trafLen); out.set(str('traf'), o + 4); o += 8;
  out.set(tfhd, o); o += tfhd.length;
  out.set(tfdt, o); o += tfdt.length;
  v.setUint32(o, trunLen); out.set(str('trun'), o + 4);
  v.setUint32(o + 8, (1 << 24) | flags); // version 1: signed composition offsets
  v.setUint32(o + 12, n);
  v.setUint32(o + 16, moofLen + 8); // data offset from moof start
  o += 20;
  for (const s of samples) {
    v.setUint32(o, Math.max(0, Math.round(s.duration))); o += 4;
    v.setUint32(o, s.data.length); o += 4;
    v.setUint32(o, s.key ? 0x02000000 : 0x01010000); o += 4;
    if (withCto) { v.setInt32(o, Math.round(s.cto || 0)); o += 4; }
  }
  v.setUint32(o, 8 + dataLen); out.set(str('mdat'), o + 4); o += 8;
  for (const s of samples) { out.set(s.data, o); o += s.data.length; }
  return out;
}

/** The MSE MIME type for a track description used with initSegment. */
export function mimeFor(t) {
  if (t.kind === 'video') return `video/mp4; codecs="${t.codecString}"`;
  if (t.fourcc === 'fLaC') return 'audio/mp4; codecs="flac"';
  if (t.fourcc === 'Opus') return 'audio/mp4; codecs="opus"';
  if (t.objectType === 0x6b || t.objectType === 0x69) return 'audio/mp4; codecs="mp4a.6B"';
  return `audio/mp4; codecs="${t.codecString || 'mp4a.40.2'}"`;
}
