// VobSub (DVD subpicture) decoder. Sources: .idx + .sub files, S_VOBSUB tracks in MKV, and
// subpicture streams inside VOB files. Output events {start, end, width, height, images}.

/** Parses an .idx file (or MKV CodecPrivate, which uses the same format). */
export function parseIdx(text) {
  const out = { width: 720, height: 480, palette: null, tracks: [], timestamps: [] };
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^size:\s*(\d+)x(\d+)/i.exec(line))) { out.width = +m[1]; out.height = +m[2]; }
    else if ((m = /^palette:\s*(.*)$/i.exec(line))) {
      out.palette = m[1].split(',').map((h) => {
        const v = parseInt(h.trim(), 16) || 0;
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      });
    } else if ((m = /^id:\s*([a-z]{2,3}|--)?\s*,\s*index:\s*(\d+)/i.exec(line))) {
      current = { lang: m[1] && m[1] !== '--' ? m[1] : null, index: +m[2] };
      out.tracks.push(current);
    } else if ((m = /^timestamp:\s*(\d+):(\d+):(\d+):(\d+),\s*filepos:\s*([0-9a-f]+)/i.exec(line)) && current) {
      out.timestamps.push({ index: current.index, time: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, pos: parseInt(m[5], 16) });
    }
  }
  if (!out.palette) {
    out.palette = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [0, 0, 0]];
    while (out.palette.length < 16) out.palette.push([128, 128, 128]);
  }
  return out;
}

/** Reads an SPU packet's control sequences (timing, colours, area). */
function parseControl(spu) {
  if (spu.length < 4) return null;
  const size = (spu[0] << 8) | spu[1];
  const ctrl = (spu[2] << 8) | spu[3];
  if (ctrl >= spu.length || size > spu.length + 4) return null;
  let colors = [0, 1, 2, 3], alpha = [0, 15, 15, 15];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, top = 0, bottom = 0;
  let start = 0, stop = null, forced = false;
  let pos = ctrl;
  const seen = new Set();
  while (pos + 4 <= spu.length && !seen.has(pos)) {
    seen.add(pos);
    const delay = ((spu[pos] << 8) | spu[pos + 1]) * 1024 / 90000;
    const next = (spu[pos + 2] << 8) | spu[pos + 3];
    let p = pos + 4;
    loop: while (p < spu.length) {
      const cmd = spu[p++];
      switch (cmd) {
        case 0x00: forced = true; start = delay; break;
        case 0x01: start = delay; break;
        case 0x02: stop = delay; break;
        case 0x03: colors = [spu[p + 1] & 15, spu[p + 1] >> 4, spu[p] & 15, spu[p] >> 4]; p += 2; break;
        case 0x04: alpha = [spu[p + 1] & 15, spu[p + 1] >> 4, spu[p] & 15, spu[p] >> 4]; p += 2; break;
        case 0x05:
          x1 = (spu[p] << 4) | (spu[p + 1] >> 4);
          x2 = ((spu[p + 1] & 15) << 8) | spu[p + 2];
          y1 = (spu[p + 3] << 4) | (spu[p + 4] >> 4);
          y2 = ((spu[p + 4] & 15) << 8) | spu[p + 5];
          p += 6;
          break;
        case 0x06:
          top = (spu[p] << 8) | spu[p + 1];
          bottom = (spu[p + 2] << 8) | spu[p + 3];
          p += 4;
          break;
        case 0x07: p += (spu[p] << 8) | spu[p + 1]; break;
        case 0xff: break loop;
        default: break loop;
      }
    }
    if (next === pos) break;
    pos = next;
  }
  return { colors, alpha, x1, x2, y1, y2, top, bottom, start, stop, forced };
}

/** Decodes one SPU packet. Returns null if empty. Times are relative to the packet's pts. */
export function decodeSpu(spu, palette) {
  const c = parseControl(spu);
  if (!c) return null;
  const { colors, alpha, x1, x2, y1, y2, top, bottom, start, stop, forced } = c;
  const w = x2 - x1 + 1, h = y2 - y1 + 1;
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null;
  // without the DVD's palette (VOB files carry it in the IFO), use white text with a dark outline
  const fallback = [[0, 0, 0], [240, 240, 240], [16, 16, 16], [160, 160, 160]];
  const rgbaPal = [0, 1, 2, 3].map((i) => {
    const c = palette ? palette[colors[i]] || [0, 0, 0] : fallback[i];
    return [c[0], c[1], c[2], Math.round((alpha[i] * 255) / 15)];
  });
  const rgba = new Uint8ClampedArray(w * h * 4);
  decodeField(spu, top, rgba, w, h, 0, rgbaPal);
  decodeField(spu, bottom, rgba, w, h, 1, rgbaPal);
  return { start, stop, forced, image: { x: x1, y: y1, w, h, rgba } };
}

function decodeField(spu, offset, rgba, w, h, firstLine, pal) {
  let nib = offset * 2; // nibble position
  const getNib = () => {
    const b = spu[nib >> 1];
    const v = nib & 1 ? b & 15 : b >> 4;
    nib++;
    return v || 0;
  };
  for (let y = firstLine; y < h; y += 2) {
    let x = 0;
    while (x < w) {
      let v = getNib();
      if (v < 0x4) { v = (v << 4) | getNib(); if (v < 0x10) { v = (v << 4) | getNib(); if (v < 0x40) v = (v << 4) | getNib(); } }
      const color = v & 3;
      let run = v >> 2;
      if (run === 0) run = w - x;
      const c = pal[color];
      for (let k = 0; k < run && x < w; k++, x++) {
        const o = (y * w + x) * 4;
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
      }
      if (nib >> 1 >= spu.length) return;
    }
    if (nib & 1) nib++; // lines are byte aligned
  }
}

/**
 * Collects SPU packets (which may span several PES packets) and turns them into events.
 * Feed with add(pts, payload) in any order per stream; call events() to get the sorted list.
 */
export class VobSubTrack {
  constructor(info) {
    this.info = info; // {width, height, palette}
    this.packets = []; // {time, data}
    this.assembling = null;
    this.dirty = true;
    this._events = [];
  }

  /** Adds one PES payload of the subpicture stream (from a .sub file or VOB). */
  addPes(time, data) {
    if (this.assembling && time === null) {
      this._append(data);
      return;
    }
    if (this.assembling && this.assembling.size > this.assembling.got) {
      // a new packet started before the old one completed: keep appending unless this looks like a start
      if (time === null) { this._append(data); return; }
    }
    if (data.length < 2) return;
    const size = (data[0] << 8) | data[1];
    this.assembling = { time, size, got: 0, buf: new Uint8Array(size) };
    this._append(data);
  }

  _append(data) {
    const a = this.assembling;
    const n = Math.min(data.length, a.size - a.got);
    a.buf.set(data.subarray(0, n), a.got);
    a.got += n;
    if (a.got >= a.size) {
      this.addPacket(a.time, a.buf);
      this.assembling = null;
    }
  }

  /** Adds one complete SPU packet (MKV blocks are complete). */
  addPacket(time, spu) {
    if (time === null || time === undefined) return;
    this.packets.push({ time, data: spu });
    this.dirty = true;
  }

  events() {
    if (!this.dirty) return this._events;
    this.packets.sort((a, b) => a.time - b.time);
    // drop duplicates (overlapping scans)
    const uniq = [];
    for (const p of this.packets) if (!uniq.length || uniq[uniq.length - 1].time !== p.time) uniq.push(p);
    this.packets = uniq;
    const evs = [];
    for (let i = 0; i < uniq.length; i++) {
      const p = uniq[i];
      const next = uniq[i + 1];
      const c = parseControl(p.data);
      if (!c) continue;
      const start = p.time + c.start;
      let end = next ? next.time : start + 5;
      if (c.stop !== null && c.stop > c.start) end = Math.min(end, p.time + c.stop);
      if (end <= start) continue;
      evs.push({ start, end, packet: p.data, width: this.info.width, height: this.info.height, images: null, forced: c.forced });
    }
    this._events = evs;
    this.dirty = false;
    return evs;
  }
}

/** Decodes an event's bitmap on first use. */
export function vobsubImages(ev, palette) {
  if (ev.images) return ev.images;
  const d = decodeSpu(ev.packet, palette);
  ev.images = d ? [d.image] : [];
  return ev.images;
}
