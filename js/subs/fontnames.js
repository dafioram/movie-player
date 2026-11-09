// Reads family names from TrueType/OpenType fonts (the 'name' table), so the app can tell which
// fonts an ASS script asks for that aren't available.

function readName(b, off) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = v.getUint16(off + 2), strOff = off + v.getUint16(off + 4);
  const names = new Set();
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    const platform = v.getUint16(r), nameId = v.getUint16(r + 6), len = v.getUint16(r + 8), o = v.getUint16(r + 10);
    if (nameId !== 1 && nameId !== 4 && nameId !== 16) continue;
    const bytes = b.subarray(strOff + o, strOff + o + len);
    let s;
    if (platform === 3 || platform === 0) {
      s = '';
      for (let j = 0; j + 1 < bytes.length; j += 2) s += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
    } else s = String.fromCharCode(...bytes);
    if (s) names.add(s.toLowerCase());
  }
  return names;
}

function sfntNames(b, base = 0) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const numTables = v.getUint16(base + 4);
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + i * 16;
    const tag = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]);
    if (tag === 'name') return readName(b, v.getUint32(r + 8));
  }
  return new Set();
}

/** Returns the lower-case family/full names in a font file (empty for WOFF/WOFF2). */
export function fontFamilies(bytes) {
  try {
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (tag === 'ttcf') {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = v.getUint32(8);
      const all = new Set();
      for (let i = 0; i < n; i++) for (const x of sfntNames(bytes, v.getUint32(12 + i * 4))) all.add(x);
      return all;
    }
    if (tag === 'wOFF' || tag === 'wOF2') return new Set();
    return sfntNames(bytes);
  } catch {
    return new Set();
  }
}

/** Font names an ASS script uses (styles and \fn overrides), as a map lower-case -> as written. */
export function assFontNames(script) {
  const names = new Map();
  const add = (n) => { n = n.trim().replace(/^@/, ''); if (n && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), n); };
  let format = null, inStyles = false;
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[/.test(line)) { inStyles = /styles\]/i.test(line); format = null; continue; }
    if (inStyles && /^format\s*:/i.test(line)) format = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase());
    else if (inStyles && /^style\s*:/i.test(line) && format) {
      const f = line.slice(line.indexOf(':') + 1).split(',');
      add(f[format.indexOf('fontname')] || '');
    }
  }
  for (const m of script.matchAll(/\\fn([^\\}]+)/g)) add(m[1]);
  return names;
}
