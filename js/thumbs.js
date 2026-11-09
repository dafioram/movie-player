// Seek-bar thumbnails: decodes the keyframe nearest (before) the hovered time with a separate
// decoder, so playback is never disturbed. Only the latest request is worked on.

import { EncodedPacketSink } from '../lib/mediabunny/mediabunny.min.mjs';
import { MpegStreamReader } from './demux/mpeg.js';

const WIDTH = 160;

export class Thumbnailer {
  constructor(movie, codec) {
    this.movie = movie;
    this.codec = codec;
    this.cache = new Map();
    this.busy = false;
    this.pending = null;
    this.disabled = false;
    const v = movie.video;
    if (!v) this.disabled = true;
    else if (v.mode === 'native' && v.mb) this.kind = 'webcodecs';
    else if (v.mode === 'convert') this.kind = v.mb ? 'wasm-packets' : 'wasm-mpeg';
    else this.disabled = true;
  }

  /** Requests a thumbnail; resolves with {bitmap, time} or null. Older pending requests resolve null. */
  request(time) {
    if (this.disabled) return Promise.resolve(null);
    const bucket = this._bucket(time);
    if (this.cache.has(bucket)) return Promise.resolve(this.cache.get(bucket));
    return new Promise((resolve) => {
      if (this.pending) this.pending.resolve(null);
      this.pending = { time, resolve };
      this._pump();
    });
  }

  _bucket(time) {
    return Math.round(time / 2);
  }

  async _pump() {
    if (this.busy || !this.pending) return;
    this.busy = true;
    const { time, resolve } = this.pending;
    this.pending = null;
    let result = null;
    try {
      result = await this._make(time);
    } catch (e) {
      if (!this.warned) { this.warned = true; console.warn('Thumbnails unavailable:', e); }
      this.failures = (this.failures || 0) + 1;
      if (this.failures > 3) this.disabled = true;
    }
    if (result) this.cache.set(this._bucket(time), result);
    resolve(result);
    this.busy = false;
    this._pump();
  }

  async _make(time) {
    const m = this.movie, v = m.video;
    if (this.kind === 'webcodecs') {
      if (!this.sink) {
        this.sink = new EncodedPacketSink(v.mb);
        this.config = await v.mb.getDecoderConfig();
        const support = await VideoDecoder.isConfigSupported(this.config).catch(() => ({ supported: false }));
        if (!support.supported) { this.disabled = true; return null; }
      }
      const p = await this.sink.getKeyPacket(time + m.origin, { verifyKeyPackets: true });
      if (!p) return null;
      const key = 'k' + p.timestamp;
      if (this.cache.has(key)) return this.cache.get(key);
      const frame = await new Promise((resolve, reject) => {
        let got = null;
        const dec = new VideoDecoder({ output: (f) => { if (!got) got = f; else f.close(); }, error: reject });
        dec.configure(this.config);
        dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(p.timestamp * 1e6), data: p.data }));
        dec.flush().then(() => { dec.close(); resolve(got); }, reject);
      });
      if (!frame) return null;
      const ratio = frame.displayHeight / frame.displayWidth;
      const bitmap = await createImageBitmap(frame, { resizeWidth: WIDTH, resizeHeight: Math.max(2, Math.round(WIDTH * ratio)), resizeQuality: 'medium' });
      frame.close();
      const r = { bitmap, time: p.timestamp - m.origin };
      this.cache.set(key, r);
      return r;
    }
    if (this.kind === 'wasm-packets') {
      if (!this.sink) this.sink = new EncodedPacketSink(v.mb);
      const p = await this.sink.getKeyPacket(time + m.origin);
      if (!p) return null;
      const r = await this.codec.thumb(v.codec, [{ data: p.data, ptsUs: p.timestamp * 1e6 }], { extradata: v.extradata, useParser: false, width: WIDTH });
      return r ? { bitmap: r.bitmap, time: p.timestamp - m.origin } : null;
    }
    // MPEG program/transport stream: read a little from just before the time
    const reader = new MpegStreamReader(m.blob, m.mpeg, v.key);
    await reader.seek(time + m.origin, 0.6);
    const packets = [];
    let bytes = 0;
    while (bytes < 900000) {
      const p = await reader.next();
      if (!p) break;
      packets.push({ data: p.data, ptsUs: p.pts == null ? -1 : p.pts * 1e6 });
      bytes += p.data.length;
    }
    if (!packets.length) return null;
    const r = await this.codec.thumb(v.codec, packets, { useParser: true, width: WIDTH });
    return r ? { bitmap: r.bitmap, time: r.ptsUs >= 0 ? r.ptsUs / 1e6 - m.origin : time } : null;
  }

  destroy() {
    this.disabled = true;
    for (const r of this.cache.values()) r && r.bitmap && r.bitmap.close();
    this.cache.clear();
  }
}
