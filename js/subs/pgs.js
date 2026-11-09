// PGS (Blu-ray "HDMV Presentation Graphics") subtitle decoder.
// Input: display sets from a .sup file (segments with the "PG" header) or from MKV blocks
// (segments without it). Output: events {start, end, width, height, images: [{x, y, w, h, rgba}]}.

const PCS = 0x16, WDS = 0x17, PDS = 0x14, ODS = 0x15, END = 0x80;

function ycbcrToRgba(y, cr, cb, a, hd) {
  const yy = 1.164 * (y - 16);
  let r, g, b;
  if (hd) {
    r = yy + 1.793 * (cr - 128);
    g = yy - 0.213 * (cb - 128) - 0.533 * (cr - 128);
    b = yy + 2.112 * (cb - 128);
  } else {
    r = yy + 1.596 * (cr - 128);
    g = yy - 0.392 * (cb - 128) - 0.813 * (cr - 128);
    b = yy + 2.017 * (cb - 128);
  }
  const c = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  return [c(r), c(g), c(b), a];
}

function decodeRle(data, w, h, palette) {
  const out = new Uint8ClampedArray(w * h * 4);
  let x = 0, y = 0, i = 0;
  const put = (count, color) => {
    const p = palette[color] || [0, 0, 0, 0];
    for (let k = 0; k < count && x < w; k++, x++) {
      const o = (y * w + x) * 4;
      out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2]; out[o + 3] = p[3];
    }
  };
  while (i < data.length && y < h) {
    const b = data[i++];
    if (b !== 0) { put(1, b); continue; }
    const f = data[i++];
    if (f === 0) { x = 0; y++; continue; }
    const kind = f >> 6;
    let len = f & 0x3f;
    if (kind === 1 || kind === 3) len = (len << 8) | data[i++];
    const color = kind >= 2 ? data[i++] : 0;
    put(len, color);
  }
  return out;
}

/** Stateful decoder: feed display sets in time order. */
export class PgsDecoder {
  constructor() {
    this.events = [];
    this.palettes = new Map();
    this.objects = new Map();
    this.open = null;
  }

  /** Feeds segments (Uint8Array) belonging to one presentation time. */
  feed(time, bytes, withHeaders = false) {
    let p = 0;
    let comp = null;
    while (p + 3 <= bytes.length) {
      let t = time;
      if (withHeaders) {
        if (bytes[p] !== 0x50 || bytes[p + 1] !== 0x47) break; // "PG"
        t = ((bytes[p + 2] << 24) >>> 0 | (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5]) / 90000;
        p += 10;
      }
      const type = bytes[p], size = (bytes[p + 1] << 8) | bytes[p + 2];
      const d = bytes.subarray(p + 3, p + 3 + size);
      p += 3 + size;
      if (type === PCS) comp = this._pcs(t, d);
      else if (type === PDS) this._pds(d);
      else if (type === ODS) this._ods(d);
      else if (type === WDS) { /* windows only bound the drawing area */ }
      else if (type === END && comp) { this._finish(comp); comp = null; }
    }
  }

  /** Parses a whole .sup file. */
  static parseSup(bytes) {
    const dec = new PgsDecoder();
    dec.feed(0, bytes, true);
    dec.close();
    return dec.events;
  }

  _pcs(t, d) {
    const width = (d[0] << 8) | d[1], height = (d[2] << 8) | d[3];
    const state = d[7];
    const paletteId = d[9];
    const count = d[10];
    if (state & 0x80) { this.objects.clear(); this.palettes.clear(); }
    const objs = [];
    let o = 11;
    for (let i = 0; i < count; i++) {
      const id = (d[o] << 8) | d[o + 1];
      const flags = d[o + 3];
      const x = (d[o + 4] << 8) | d[o + 5], y = (d[o + 6] << 8) | d[o + 7];
      o += 8;
      let crop = null;
      if (flags & 0x80) {
        crop = { x: (d[o] << 8) | d[o + 1], y: (d[o + 2] << 8) | d[o + 3], w: (d[o + 4] << 8) | d[o + 5], h: (d[o + 6] << 8) | d[o + 7] };
        o += 8;
      }
      objs.push({ id, x, y, crop, forced: !!(flags & 0x40) });
    }
    return { t, width, height, paletteId, objs };
  }

  _pds(d) {
    const id = d[0];
    const pal = this.palettes.get(id) || new Array(256);
    for (let o = 2; o + 5 <= d.length; o += 5) pal[d[o]] = { y: d[o + 1], cr: d[o + 2], cb: d[o + 3], a: d[o + 4] };
    this.palettes.set(id, pal);
  }

  _ods(d) {
    const id = (d[0] << 8) | d[1];
    const seq = d[3];
    if (seq & 0x80) {
      // first fragment: length (3 bytes, includes 4 bytes of size), width, height
      const w = (d[7] << 8) | d[8], h = (d[9] << 8) | d[10];
      this.objects.set(id, { w, h, parts: [d.slice(11)] });
    } else {
      const obj = this.objects.get(id);
      if (obj) obj.parts.push(d.slice(4));
    }
  }

  _finish(comp) {
    if (this.open) {
      this.open.end = comp.t;
      this.open = null;
    }
    if (!comp.objs.length) return;
    const raw = this.palettes.get(comp.paletteId) || [];
    const hd = comp.height >= 720;
    const palette = raw.map((e) => (e ? ycbcrToRgba(e.y, e.cr, e.cb, e.a, hd) : null));
    const parts = [];
    for (const co of comp.objs) {
      const obj = this.objects.get(co.id);
      if (!obj) continue;
      if (!obj.rle) {
        const len = obj.parts.reduce((a, b) => a + b.length, 0);
        obj.rle = new Uint8Array(len);
        let o = 0;
        for (const part of obj.parts) { obj.rle.set(part, o); o += part.length; }
      }
      parts.push({ co, obj: { w: obj.w, h: obj.h, rle: obj.rle }, palette });
    }
    if (!parts.length) return;
    const ev = { start: comp.t, end: comp.t + 10, width: comp.width, height: comp.height, parts, images: null,
      forced: comp.objs.every((o) => o.forced) };
    this.events.push(ev);
    this.open = ev;
  }

  close() {
    if (this.open) this.open = null;
  }
}

/** Decodes an event's bitmaps on first use. */
export function pgsImages(ev) {
  if (ev.images) return ev.images;
  ev.images = ev.parts.map(({ co, obj, palette }) => {
    let rgba = decodeRle(obj.rle, obj.w, obj.h, palette);
    let w = obj.w, h = obj.h;
    if (co.crop) {
      const c = co.crop;
      const cropped = new Uint8ClampedArray(c.w * c.h * 4);
      for (let row = 0; row < c.h; row++) {
        const src = ((c.y + row) * obj.w + c.x) * 4;
        cropped.set(rgba.subarray(src, src + c.w * 4), row * c.w * 4);
      }
      rgba = cropped; w = c.w; h = c.h;
    }
    return { x: co.x, y: co.y, w, h, rgba };
  });
  ev.parts = null;
  return ev.images;
}
