// H.264/HEVC from transport streams arrives in Annex B form (start codes). MP4 needs NAL units
// with length prefixes and a decoder configuration record (avcC / hvcC) built from SPS/PPS.

/** Splits an Annex B buffer into NAL units (without start codes). */
export function nalUnits(data) {
  const out = [];
  let i = 0, start = -1;
  const n = data.length;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && data[end - 1] === 0) end--; // 4-byte start code
        out.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < n) out.push(data.subarray(start, n));
  return out.filter((u) => u.length);
}

export function isAnnexB(data) {
  return data.length > 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
}

/** Converts Annex B to 4-byte length-prefixed NAL units. */
export function toLengthPrefixed(data) {
  const units = nalUnits(data);
  const len = units.reduce((a, u) => a + 4 + u.length, 0);
  const out = new Uint8Array(len);
  const v = new DataView(out.buffer);
  let o = 0;
  for (const u of units) {
    v.setUint32(o, u.length);
    out.set(u, o + 4);
    o += 4 + u.length;
  }
  return out;
}

function unescape(nal) {
  // remove emulation prevention bytes (00 00 03)
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

/** Builds an avcC record from the SPS/PPS found in a key frame. */
export function avcCFromAnnexB(data) {
  const units = nalUnits(data);
  const sps = units.filter((u) => (u[0] & 0x1f) === 7);
  const pps = units.filter((u) => (u[0] & 0x1f) === 8);
  if (!sps.length || !pps.length) return null;
  const s = sps[0];
  const parts = [1, s[1], s[2], s[3], 0xff, 0xe0 | sps.length];
  for (const x of sps) parts.push(x.length >> 8, x.length & 0xff, ...x);
  parts.push(pps.length);
  for (const x of pps) parts.push(x.length >> 8, x.length & 0xff, ...x);
  return Uint8Array.from(parts);
}

/** Builds an hvcC record from the VPS/SPS/PPS found in a key frame. */
export function hvcCFromAnnexB(data) {
  const units = nalUnits(data);
  const type = (u) => (u[0] >> 1) & 0x3f;
  const vps = units.filter((u) => type(u) === 32);
  const sps = units.filter((u) => type(u) === 33);
  const pps = units.filter((u) => type(u) === 34);
  if (!vps.length || !sps.length || !pps.length) return null;
  const r = unescape(sps[0]);
  // general profile/tier/level: 12 bytes starting after the 2-byte NAL header and 1 byte of flags
  const ptl = r.subarray(3, 15);
  const profile = ptl[0] & 0x1f;
  const depth = profile === 2 ? 2 : 0; // Main 10
  const parts = [1, ...ptl.subarray(0, 12), 0xf0, 0x00, 0xfc, 0xfd, 0xf8 | depth, 0xf8 | depth, 0, 0, 0x0f, 3];
  for (const [t, list] of [[32, vps], [33, sps], [34, pps]]) {
    parts.push(0x80 | t, list.length >> 8, list.length & 0xff);
    for (const x of list) parts.push(x.length >> 8, x.length & 0xff, ...x);
  }
  return Uint8Array.from(parts);
}
