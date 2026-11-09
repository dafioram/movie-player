// Minimal FLAC encoder used to hand decoded audio (AC-3, DTS, TrueHD, ...) to Chrome losslessly.
// Fixed block size of 4096 samples, 16-bit, FIXED predictors (order 0-4) with Rice-coded residuals.
// Each output frame becomes one sample in a fragmented MP4 ('fLaC' sample entry).

const BLOCK = 4096;
const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

const RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

class BitWriter {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.pos = 0; // byte position
    this.acc = 0; // pending bits (up to 31)
    this.n = 0;
  }
  ensure(extra) {
    if (this.pos + extra + 8 > this.buf.length) {
      const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra + 1024));
      b.set(this.buf.subarray(0, this.pos));
      this.buf = b;
    }
  }
  write(value, bits) {
    // bits <= 24 per call
    if (this.pos + 8 >= this.buf.length) this.ensure(1024);
    this.acc = (this.acc << bits) | (value & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }
  writeLong(value, bits) {
    if (bits > 24) {
      this.write(Math.floor(value / 2 ** 24), bits - 24);
      this.write(value % 2 ** 24, 24);
    } else this.write(value, bits);
  }
  unary(q) {
    // q zeros followed by a one
    while (q >= 24) { this.write(0, 24); q -= 24; }
    this.write(1, q + 1);
  }
  align() {
    if (this.n) this.write(0, 8 - this.n);
  }
}

function utf8Number(n) {
  if (n < 0x80) return [n];
  const out = [];
  let bytes = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
  for (let i = bytes - 1; i > 0; i--) {
    out.unshift(0x80 | (n & 0x3f));
    n = Math.floor(n / 64);
  }
  const lead = [0, 0, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc][bytes];
  out.unshift(lead | n);
  return out;
}

function residualOrder(x, order, out) {
  const n = x.length;
  for (let i = order; i < n; i++) {
    let r;
    switch (order) {
      case 0: r = x[i]; break;
      case 1: r = x[i] - x[i - 1]; break;
      case 2: r = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: r = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: r = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    out[i - order] = r;
  }
  return n - order;
}

function riceCost(res, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = res[i];
    sum += v >= 0 ? v * 2 : -v * 2 - 1;
  }
  const count = end - start;
  if (!count) return { k: 0, bits: 0 };
  const mean = sum / count;
  let k = mean > 0 ? Math.max(0, Math.floor(Math.log2(mean))) : 0;
  if (k > 14) k = 14;
  const bits = count * (k + 1) + Math.floor(sum / 2 ** k);
  return { k, bits };
}

export class FlacEncoder {
  constructor(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.frameNumber = 0;
    this.pending = []; // per-channel Int16Array chunks
    this.pendingLen = 0;
    this.ptsUs = null; // pts of first pending sample
    this.res = new Int32Array(BLOCK);
    this.tmp = new Int32Array(BLOCK);
    this.dither = 0;
  }

  /** Bytes of the 'dfLa' box payload (after version/flags): a STREAMINFO metadata block. */
  streamInfoBlock() {
    const b = new Uint8Array(4 + 34);
    b[0] = 0x80; // last metadata block, type 0 (STREAMINFO)
    b[3] = 34;
    const v = new DataView(b.buffer);
    v.setUint16(4, 16);
    v.setUint16(6, BLOCK);
    // min/max frame size unknown (0)
    const sr = this.sampleRate, ch = this.channels - 1, bps = 15;
    b[14] = (sr >> 12) & 0xff;
    b[15] = (sr >> 4) & 0xff;
    b[16] = ((sr & 0xf) << 4) | (ch << 1) | (bps >> 4);
    b[17] = (bps & 0xf) << 4; // total samples unknown
    return b;
  }

  /** Adds planar float samples. Returns finished FLAC frames [{data, ptsUs, samples}]. */
  push(planes, ptsUs) {
    const n = planes[0].length;
    const ints = planes.map((p) => {
      const o = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let s = p[i] * 32767;
        s = s > 32767 ? 32767 : s < -32768 ? -32768 : Math.round(s);
        o[i] = s;
      }
      return o;
    });
    const out = [];
    if (this.ptsUs != null && ptsUs != null && ptsUs >= 0) {
      const expected = this.ptsUs + (this.pendingLen / this.sampleRate) * 1e6;
      if (Math.abs(ptsUs - expected) > 60000) {
        // timestamp jump: finish what we have and restart the clock
        out.push(...this.flush());
      }
    }
    if (this.ptsUs == null) this.ptsUs = ptsUs != null && ptsUs >= 0 ? ptsUs : 0;
    this.pending.push(ints);
    this.pendingLen += n;
    while (this.pendingLen >= BLOCK) out.push(this._emit(BLOCK));
    return out;
  }

  /** Emits whatever is pending as a final short frame. */
  flush() {
    const out = [];
    if (this.pendingLen > 0) out.push(this._emit(this.pendingLen));
    this.ptsUs = null;
    return out;
  }

  reset() {
    this.pending = [];
    this.pendingLen = 0;
    this.ptsUs = null;
  }

  _take(count) {
    const chans = [];
    for (let c = 0; c < this.channels; c++) chans.push(new Int32Array(count));
    let filled = 0;
    while (filled < count) {
      const chunk = this.pending[0];
      const avail = chunk[0].length;
      const use = Math.min(avail, count - filled);
      for (let c = 0; c < this.channels; c++) {
        const src = chunk[c] || chunk[0];
        for (let i = 0; i < use; i++) chans[c][filled + i] = src[i];
      }
      filled += use;
      if (use === avail) this.pending.shift();
      else this.pending[0] = chunk.map((a) => a.subarray(use));
    }
    this.pendingLen -= count;
    return chans;
  }

  _emit(count) {
    const chans = this._take(count);
    const pts = this.ptsUs;
    this.ptsUs += (count / this.sampleRate) * 1e6;
    const w = new BitWriter(count * this.channels * 2 + 64);
    // frame header
    w.write(0x3ffe, 14); // sync
    w.write(0, 1);
    w.write(0, 1); // fixed block size
    const fullBlock = count === BLOCK;
    w.write(fullBlock ? 12 : 7, 4); // 4096, or 16-bit (blocksize-1) at end of header
    const rc = RATE_CODES[this.sampleRate] || 0;
    w.write(rc, 4);
    w.write(this.channels - 1, 4); // independent channels
    w.write(4, 3); // 16 bits per sample
    w.write(0, 1);
    for (const byte of utf8Number(this.frameNumber++)) w.write(byte, 8);
    if (!fullBlock) w.write(count - 1, 16);
    let crc = 0;
    for (let i = 0; i < w.pos; i++) crc = CRC8[crc ^ w.buf[i]];
    w.write(crc, 8);
    for (let c = 0; c < this.channels; c++) this._subframe(w, chans[c], count);
    w.align();
    let crc16 = 0;
    for (let i = 0; i < w.pos; i++) crc16 = ((crc16 << 8) & 0xffff) ^ CRC16[(crc16 >> 8) ^ w.buf[i]];
    w.write(crc16, 16);
    return { data: w.buf.slice(0, w.pos), ptsUs: pts, samples: count };
  }

  _subframe(w, x, n) {
    w.ensure(n * 3 + 64);
    // constant?
    let constant = true;
    for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
    if (constant) {
      w.write(0, 1);
      w.write(0, 6); // CONSTANT
      w.write(0, 1);
      w.write(x[0] & 0xffff, 16);
      return;
    }
    let best = null;
    const maxOrder = Math.min(4, n - 1);
    for (let order = 0; order <= maxOrder; order++) {
      const len = residualOrder(x, order, this.tmp);
      // choose partition order (0..4) minimising bits
      for (let po = 0; po <= 4; po++) {
        const parts = 1 << po;
        if (n % parts || n / parts <= order) break;
        const psize = n / parts;
        let bits = 0;
        const ks = [];
        for (let p = 0; p < parts; p++) {
          const start = p === 0 ? 0 : p * psize - order;
          const end = (p + 1) * psize - order;
          const { k, bits: b } = riceCost(this.tmp, start, end);
          ks.push(k);
          bits += 4 + b;
        }
        bits += order * 16;
        if (!best || bits < best.bits) best = { order, po, ks, bits, len };
      }
    }
    if (best.bits >= n * 16) {
      w.write(0, 1);
      w.write(1, 6); // VERBATIM
      w.write(0, 1);
      for (let i = 0; i < n; i++) w.write(x[i] & 0xffff, 16);
      return;
    }
    const { order, po, ks } = best;
    residualOrder(x, order, this.tmp);
    w.write(0, 1);
    w.write(8 | order, 6); // FIXED
    w.write(0, 1);
    for (let i = 0; i < order; i++) w.write(x[i] & 0xffff, 16);
    w.write(0, 2); // RICE, 4-bit parameters
    w.write(po, 4);
    const parts = 1 << po, psize = n / parts;
    for (let p = 0; p < parts; p++) {
      const k = ks[p];
      w.write(k, 4);
      const start = p === 0 ? 0 : p * psize - order;
      const end = (p + 1) * psize - order;
      for (let i = start; i < end; i++) {
        const v = this.tmp[i];
        const u = v >= 0 ? v * 2 : -v * 2 - 1;
        const q = Math.floor(u / 2 ** k);
        if (q > 100000) throw new Error('flac residual overflow');
        w.unary(q);
        if (k) w.write(u & ((1 << k) - 1), k);
      }
    }
  }
}
