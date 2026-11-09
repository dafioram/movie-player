// Codec worker: decodes what Chrome can't (via avcore.wasm) and re-encodes it into something it can.
//   audio: AC-3, E-AC-3, DTS, TrueHD, MPEG audio, LPCM, AAC (from MPEG streams), Vorbis, PCM -> FLAC
//   video: MPEG-1/2 -> deinterlaced -> H.264 (WebCodecs VideoEncoder, hardware when available)
// Also decodes single frames for seek-bar thumbnails and probes streams for their parameters.

import { AvCore } from './avcore.js';
import { FlacEncoder } from './flac.js';

let core = null;
const sessions = new Map();

async function ensureCore(module) {
  if (!core) core = await AvCore.load(module);
  return core;
}

function reply(msg, transfer = []) {
  self.postMessage(msg, transfer);
}

/* ---------------- audio ---------------- */

const PCM_BYTES = { 'pcm-s16': 2, 'pcm-s16be': 2, 'pcm-s24': 3, 'pcm-s24be': 3, 'pcm-s32': 4, 'pcm-s32be': 4,
  'pcm-f32': 4, 'pcm-f32be': 4, 'pcm-f64': 8, 'pcm-f64be': 8, 'pcm-u8': 1, 'pcm-s8': 1 };

function pcmToPlanes(format, data, channels) {
  const bps = PCM_BYTES[format];
  const n = Math.floor(data.length / (bps * channels));
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = !format.endsWith('be');
  const planes = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bps;
      let s;
      switch (format.replace(/be$/, '')) {
        case 'pcm-s16': s = v.getInt16(o, le) / 32768; break;
        case 'pcm-s24': {
          const b0 = v.getUint8(o), b1 = v.getUint8(o + 1), b2 = v.getUint8(o + 2);
          let x = le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
          if (x & 0x800000) x -= 0x1000000;
          s = x / 8388608;
          break;
        }
        case 'pcm-s32': s = v.getInt32(o, le) / 2147483648; break;
        case 'pcm-f32': s = v.getFloat32(o, le); break;
        case 'pcm-f64': s = v.getFloat64(o, le); break;
        case 'pcm-u8': s = (v.getUint8(o) - 128) / 128; break;
        case 'pcm-s8': s = v.getInt8(o) / 128; break;
        default: s = 0;
      }
      planes[c][i] = s;
    }
  }
  return planes;
}

class AudioSession {
  constructor(spec) {
    this.spec = spec;
    this.flac = null;
    this.out = [];
    this.pendingDecoded = [];
    if (spec.backend === 'wasm') {
      this.dec = core.openDecoder(spec.codec, {
        extradata: spec.extradata, sampleRate: spec.sampleRate, channels: spec.channels, useParser: spec.useParser,
      });
    } else if (spec.backend === 'webcodecs') {
      this._makeWebCodecs();
    }
  }

  _makeWebCodecs() {
    this.wc = new AudioDecoder({
      output: (data) => {
        const ch = data.numberOfChannels, n = data.numberOfFrames;
        const planes = [];
        for (let c = 0; c < Math.min(ch, 8); c++) {
          const p = new Float32Array(n);
          data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          planes.push(p);
        }
        this.pendingDecoded.push({ planes, sampleRate: data.sampleRate, ptsUs: data.timestamp });
        data.close();
      },
      error: (e) => { this.error = e.message; },
    });
    const cfg = { codec: this.spec.wcCodec, sampleRate: this.spec.sampleRate, numberOfChannels: this.spec.channels };
    if (this.spec.extradata) cfg.description = this.spec.extradata;
    this.wc.configure(cfg);
  }

  _encode(planes, sampleRate, ptsUs) {
    if (!this.flac || this.flac.sampleRate !== sampleRate || this.flac.channels !== planes.length) {
      if (this.flac) this.out.push(...this.flac.flush().map((f) => ({ ...f, flac: this.flac })));
      this.flac = new FlacEncoder(sampleRate, planes.length);
      this.configChanged = true;
    }
    for (const f of this.flac.push(planes, ptsUs)) this.out.push({ ...f, flac: this.flac });
  }

  async feed(packets, end) {
    for (const p of packets) {
      const data = new Uint8Array(p.data);
      const ptsUs = p.ptsUs == null ? -1 : p.ptsUs;
      if (this.spec.backend === 'wasm') {
        this.dec.send(data, ptsUs, p.key);
        let f;
        while ((f = this.dec.receiveAudio())) this._encode(f.planes, f.sampleRate, f.ptsUs >= 0 ? f.ptsUs : null);
      } else if (this.spec.backend === 'webcodecs') {
        this.wc.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.max(0, ptsUs), data }));
      } else if (this.spec.backend === 'pcm') {
        this._encode(pcmToPlanes(this.spec.pcmFormat, data, this.spec.channels), this.spec.sampleRate, ptsUs >= 0 ? ptsUs : null);
      }
    }
    if (this.spec.backend === 'webcodecs') {
      await this.wc.flush();
      for (const d of this.pendingDecoded) this._encode(d.planes, d.sampleRate, d.ptsUs);
      this.pendingDecoded = [];
    }
    if (end) {
      if (this.dec) {
        this.dec.flushEnd();
        let f;
        while ((f = this.dec.receiveAudio())) this._encode(f.planes, f.sampleRate, f.ptsUs >= 0 ? f.ptsUs : null);
      }
      if (this.flac) this.out.push(...this.flac.flush().map((f) => ({ ...f, flac: this.flac })));
    }
    const frames = this.out;
    this.out = [];
    if (this.error) throw new Error(this.error);
    if (this.dec && this.dec.error && !frames.length && packets.length) {
      // keep going; errors on a few frames are normal after a seek
    }
    const result = { frames: frames.map((f) => ({ data: f.data, ptsUs: f.ptsUs, samples: f.samples })) };
    const last = frames.length ? frames[frames.length - 1].flac : this.flac;
    if (last) result.config = { sampleRate: last.sampleRate, channels: last.channels, streamInfo: last.streamInfoBlock() };
    return result;
  }

  reset() {
    if (this.dec) this.dec.reset();
    if (this.wc) { try { this.wc.reset(); } catch { /* closed */ } this._makeWebCodecs(); }
    if (this.flac) this.flac.reset();
    this.out = [];
    this.pendingDecoded = [];
  }

  close() {
    if (this.dec) this.dec.close();
    if (this.wc && this.wc.state !== 'closed') this.wc.close();
  }
}

/* ---------------- video ---------------- */

class VideoSession {
  constructor(spec) {
    this.spec = spec; // {codec, extradata, useParser, encoderCodec, bitrate, framerate, hardware}
    this.dec = core.openDecoder(spec.codec, { extradata: spec.extradata, useParser: spec.useParser, deinterlace: true });
    this.waitKey = true;
    this.lastPts = null;
    this.chunks = [];
    this.encoder = null;
    this.frameDur = spec.framerate ? 1e6 / spec.framerate : 40000;
    this.config = null;
  }

  _makeEncoder(w, h) {
    this.encW = w;
    this.encH = h;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.chunks.push({ data, ptsUs: chunk.timestamp, durUs: chunk.duration || this.frameDur, key: chunk.type === 'key' });
        if (meta && meta.decoderConfig) {
          const dc = meta.decoderConfig;
          this.config = { codec: dc.codec, description: dc.description ? new Uint8Array(dc.description.slice ? dc.description.slice(0) : dc.description) : null,
            width: dc.codedWidth || w, height: dc.codedHeight || h };
        }
      },
      error: (e) => { this.error = 'Video encoder: ' + e.message; },
    });
    this.encoder.configure({
      codec: this.spec.encoderCodec,
      width: w,
      height: h,
      bitrate: this.spec.bitrate,
      framerate: this.spec.framerate || 25,
      latencyMode: 'quality',
      hardwareAcceleration: this.spec.hardware || 'no-preference',
      avc: { format: 'avc' },
    });
  }

  async feed(packets, end) {
    let first = true;
    const frames = [];
    const take = () => {
      let f;
      while ((f = this.dec.receiveVideo())) {
        if (this.waitKey) {
          if (!f.key) continue;
          this.waitKey = false;
        }
        frames.push(f);
      }
    };
    for (const p of packets) {
      this.dec.send(new Uint8Array(p.data), p.ptsUs == null ? -1 : p.ptsUs, p.key);
      take();
    }
    if (end) { this.dec.flushEnd(); take(); }
    for (const f of frames) {
      let pts = f.ptsUs;
      if (pts < 0 || (this.lastPts !== null && pts <= this.lastPts)) pts = this.lastPts === null ? 0 : this.lastPts + this.frameDur;
      const dur = this.frameDur * (1 + (f.repeat || 0) / 2);
      this.lastPts = pts;
      if (!this.encoder || f.width !== this.encW || f.height !== this.encH) {
        if (this.encoder) { await this.encoder.flush(); this.encoder.close(); }
        this._makeEncoder(f.width, f.height);
        first = true;
      }
      this.sar = [f.sarNum || 1, f.sarDen || 1];
      const vf = new VideoFrame(f.data, { format: 'I420', codedWidth: f.width, codedHeight: f.height, timestamp: Math.round(pts), duration: Math.round(dur) });
      // keep the encoder from running too far ahead of us
      while (this.encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
      this.encoder.encode(vf, { keyFrame: first });
      vf.close();
      first = false;
    }
    if (this.encoder && frames.length) await this.encoder.flush();
    if (this.error) throw new Error(this.error);
    const chunks = this.chunks;
    this.chunks = [];
    const info = this.dec.info();
    return { chunks, config: this.config ? { ...this.config, sar: this.sar } : null, info, decoded: frames.length };
  }

  reset() {
    this.dec.reset();
    this.waitKey = true;
    this.lastPts = null;
    this.chunks = [];
  }

  close() {
    this.dec.close();
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
  }
}

/* ---------------- thumbnails and probing ---------------- */

async function thumbnail({ codec, extradata, useParser, packets, width }) {
  const dec = core.openDecoder(codec, { extradata, useParser, deinterlace: true });
  try {
    let frame = null;
    for (const p of packets) {
      dec.send(new Uint8Array(p.data), p.ptsUs == null ? -1 : p.ptsUs, true);
      let f;
      while ((f = dec.receiveVideo())) if (!frame && f.key) frame = f;
      if (frame) break;
    }
    if (!frame) {
      dec.flushEnd();
      let f;
      while ((f = dec.receiveVideo())) if (!frame) frame = f;
    }
    if (!frame) return null;
    const sar = frame.sarNum > 0 && frame.sarDen > 0 ? frame.sarNum / frame.sarDen : 1;
    const vf = new VideoFrame(frame.data, { format: 'I420', codedWidth: frame.width, codedHeight: frame.height, timestamp: 0 });
    const h = Math.round((width * frame.height) / (frame.width * sar));
    const bmp = await createImageBitmap(vf, { resizeWidth: width, resizeHeight: Math.max(2, h), resizeQuality: 'medium' });
    vf.close();
    return { bitmap: bmp, ptsUs: frame.ptsUs };
  } finally {
    dec.close();
  }
}

function probe({ kind, codec, extradata, useParser, sample }) {
  const dec = core.openDecoder(codec, { extradata, useParser, deinterlace: false });
  try {
    const data = new Uint8Array(sample);
    const step = 16384;
    let got = null;
    for (let i = 0; i < data.length && !got; i += step) {
      dec.send(data.subarray(i, i + step), i === 0 ? 0 : -1, true);
      got = kind === 'audio' ? dec.receiveAudio() : dec.receiveVideo();
    }
    if (!got) { dec.flushEnd(); got = kind === 'audio' ? dec.receiveAudio() : dec.receiveVideo(); }
    if (!got) return { ok: false, error: dec.error || 'no frames decoded' };
    if (kind === 'audio') return { ok: true, channels: got.channels, sampleRate: got.sampleRate };
    const info = dec.info();
    return { ok: true, width: got.width, height: got.height, sar: [got.sarNum, got.sarDen], fps: info.fpsNum && info.fpsDen ? info.fpsNum / info.fpsDen : null,
      interlaced: info.interlaced, profile: info.profile };
  } finally {
    dec.close();
  }
}

/* ---------------- dispatch ---------------- */

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        await ensureCore(m.module);
        reply({ id: m.id, ok: true });
        break;
      case 'open': {
        const s = m.spec.kind === 'video' ? new VideoSession(m.spec) : new AudioSession(m.spec);
        sessions.set(m.sid, s);
        reply({ id: m.id, ok: true });
        break;
      }
      case 'feed': {
        const s = sessions.get(m.sid);
        if (!s) throw new Error('session closed');
        const r = await s.feed(m.packets, m.end);
        const transfer = [];
        for (const f of r.frames || r.chunks) transfer.push(f.data.buffer);
        reply({ id: m.id, ok: true, result: r }, transfer);
        break;
      }
      case 'reset':
        sessions.get(m.sid)?.reset();
        reply({ id: m.id, ok: true });
        break;
      case 'close':
        sessions.get(m.sid)?.close();
        sessions.delete(m.sid);
        reply({ id: m.id, ok: true });
        break;
      case 'thumb': {
        const r = await thumbnail(m);
        reply({ id: m.id, ok: true, result: r }, r ? [r.bitmap] : []);
        break;
      }
      case 'probe':
        reply({ id: m.id, ok: true, result: probe(m) });
        break;
      default:
        throw new Error('unknown message ' + m.type);
    }
  } catch (err) {
    reply({ id: m.id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
