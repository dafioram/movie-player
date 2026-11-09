// Remux engine: feeds Chrome's player through Media Source Extensions.
// Video and the selected audio track are read separately, wrapped into fragmented MP4 and appended
// around the playhead. Streams Chrome can't decode go through the codec worker first.

import { initSegment, mediaSegment, mimeFor } from './fmp4.js';
import { isAnnexB, toLengthPrefixed, avcCFromAnnexB, hvcCFromAnnexB } from './annexb.js';
import { EncodedPacketSink } from '../../lib/mediabunny/mediabunny.min.mjs';

const VIDEO_TS = 90000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANCELLED = new Error('cancelled');

function concat(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bufferedAround(sb, t) {
  try {
    const r = sb.buffered;
    for (let i = 0; i < r.length; i++) if (r.start(i) <= t + 0.3 && r.end(i) > t) return { start: r.start(i), end: r.end(i) };
  } catch { /* removed */ }
  return null;
}

/* ---------------- packet inputs ---------------- */

/** Packets of a Mediabunny track. pts in seconds on the file's own timeline. */
class MbInput {
  constructor(track, { verifyKeys = true } = {}) {
    this.sink = new EncodedPacketSink(track);
    this.track = track;
    this.verify = verifyKeys;
    this.cur = null;
  }
  async seek(t, video) {
    let p = video ? await this.sink.getKeyPacket(t, { verifyKeyPackets: this.verify }) : await this.sink.getPacket(t);
    if (!p) p = video ? await this.sink.getFirstKeyPacket() : await this.sink.getFirstPacket();
    this.cur = p;
  }
  async next() {
    const p = this.cur;
    if (!p) return null;
    this.cur = await this.sink.getNextPacket(p);
    return { data: p.data, pts: p.timestamp, dur: p.duration, key: p.type === 'key' };
  }
  peek() { return this.cur ? { pts: this.cur.timestamp, key: this.cur.type === 'key' } : null; }
}

/** PES payload chunks of an MPEG-PS/TS stream (not frame aligned). */
class MpegInput {
  constructor(reader) { this.reader = reader; }
  async seek(t, video) { await this.reader.seek(t, video ? 2.0 : 0.4); this.buffered = null; }
  async next() {
    if (this.buffered) { const b = this.buffered; this.buffered = null; return b; }
    const p = await this.reader.next();
    if (!p) return null;
    return { data: p.data, pts: p.pts, dur: 0, key: false };
  }
}

/* ---------------- segment sources ---------------- */

/** Passes a video track through unchanged (codecs Chrome decodes). */
class VideoPassthrough {
  constructor(track, origin) {
    this.t = track;
    this.origin = origin;
    this.input = new MbInput(track.mb);
    this.seq = 1;
    // transport streams carry H.264/HEVC in Annex B form: convert, and build avcC/hvcC from the stream
    this.annexB = !track.description && (track.codec === 'avc' || track.codec === 'hevc');
    this.init = this.annexB ? null : this._makeInit(track.description);
    this.mime = mimeFor({ kind: 'video', codecString: track.codecString });
    this.frameDur = track.fps ? 1 / track.fps : 1 / 25;
  }
  _makeInit(description) {
    const t = this.t;
    let fourcc = t.fourcc;
    if (this.annexB) fourcc = t.codec === 'avc' ? 'avc1' : 'hvc1';
    return initSegment({
      kind: 'video', fourcc, timescale: VIDEO_TS, description, codecString: t.codecString,
      width: t.codedWidth, height: t.codedHeight, displayWidth: t.displayWidth, displayHeight: t.displayHeight,
      sar: t.sar,
    });
  }
  async seek(t) { await this.input.seek(t + this.origin, true); }
  async next() {
    const pk = [];
    let bytes = 0;
    for (;;) {
      const peek = this.input.peek();
      if (!peek) break;
      if (pk.length && peek.key && (pk.length > 1 || bytes > 0)) break;
      const p = await this.input.next();
      pk.push(p);
      bytes += p.data.length;
      if (pk.length >= 900 || bytes > 24 << 20) break;
    }
    if (!pk.length) return null;
    if (this.annexB) {
      if (!this.init) {
        const key = pk.find((p) => p.key) || pk[0];
        const desc = this.t.codec === 'avc' ? avcCFromAnnexB(key.data) : hvcCFromAnnexB(key.data);
        if (!desc) throw new Error('Video parameter sets not found');
        this.init = this._makeInit(desc);
      }
      for (const p of pk) if (isAnnexB(p.data)) p.data = toLengthPrefixed(p.data);
    }
    const pts = pk.map((p) => Math.round((p.pts - this.origin) * VIDEO_TS));
    const sorted = [...pts].sort((a, b) => a - b);
    const fd = Math.round(this.frameDur * VIDEO_TS);
    const samples = pk.map((p, i) => ({
      data: p.data,
      duration: i + 1 < sorted.length ? sorted[i + 1] - sorted[i] : fd,
      cto: pts[i] - sorted[i],
      key: p.key,
    }));
    let base = sorted[0];
    if (base < 0) { for (const s of samples) s.cto += base; base = 0; }
    const data = mediaSegment(this.seq++, base, samples, true);
    return { init: this.init, data, start: sorted[0] / VIDEO_TS, end: (sorted[sorted.length - 1] + fd) / VIDEO_TS, bytes: data.length };
  }
  close() {}
}

/** Passes an audio track through unchanged (AAC, Opus, MP3, FLAC). */
class AudioPassthrough {
  constructor(track, origin) {
    this.t = track;
    this.origin = origin;
    this.input = new MbInput(track.mb, { verifyKeys: false });
    this.seq = 1;
    this.rate = track.sampleRate;
    const fourcc = track.codec === 'aac' ? 'mp4a' : track.codec === 'mp3' ? 'mp4a' : track.codec === 'opus' ? 'Opus' : 'fLaC';
    let description = track.description;
    if (fourcc === 'fLaC' && description && description[0] === 0x66 && description[1] === 0x4c) description = description.subarray(4);
    const desc = { kind: 'audio', fourcc, timescale: this.rate, description, sampleRate: this.rate, channels: track.channels,
      objectType: track.codec === 'mp3' ? 0x6b : 0x40, codecString: track.codecString };
    this.init = initSegment(desc);
    this.mime = mimeFor(desc);
  }
  async seek(t) { await this.input.seek(t + this.t.origin, false); this.expect = null; }
  async next() {
    const pk = [];
    let span = 0;
    for (;;) {
      const p = await this.input.next();
      if (!p) break;
      if (p.pts - this.t.origin < -0.001) continue; // priming before zero
      pk.push(p);
      span = p.pts - pk[0].pts;
      if (span > 1.5 || pk.length > 400) break;
    }
    if (!pk.length) return null;
    const segs = [];
    let run = [];
    let runStart = null;
    let cursor = null;
    const flush = () => {
      if (!run.length) return;
      segs.push(mediaSegment(this.seq++, runStart, run, false));
      run = [];
    };
    let lastDur = 1024 / this.rate;
    pk.forEach((p, i) => {
      // containers don't always store durations: fall back to the gap to the next packet
      if (!(p.dur > 0)) p.dur = pk[i + 1] ? Math.max(0, pk[i + 1].pts - p.pts) || lastDur : lastDur;
      lastDur = p.dur;
    });
    for (const p of pk) {
      const ticks = Math.round((p.pts - this.t.origin) * this.rate);
      const dur = Math.max(1, Math.round(p.dur * this.rate));
      if (cursor === null || Math.abs(ticks - cursor) > this.rate * 0.05) {
        flush();
        runStart = ticks;
        cursor = ticks;
      }
      run.push({ data: p.data, duration: dur, key: true });
      cursor += dur;
    }
    flush();
    const data = concat(segs);
    const start = (pk[0].pts - this.t.origin);
    return { init: this.init, data, start, end: start + span, bytes: data.length };
  }
  close() {}
}

/** Decodes audio in the codec worker and re-encodes it as FLAC. */
class AudioConvert {
  constructor(track, origin, codec) {
    this.t = track;
    this.origin = origin;
    this.input = track.mb ? new MbInput(track.mb, { verifyKeys: false }) : new MpegInput(track.makeReader());
    this.session = codec.audioSession(track.convertSpec);
    this.mime = 'audio/mp4; codecs="flac"';
    this.seq = 1;
    this.init = null;
    this.initKey = '';
    this.eof = false;
  }
  async seek(t) {
    await this.session.reset();
    await this.input.seek(t + this.t.origin, false);
    this.eof = false;
    this.minPts = t - 0.05;
  }
  async next(stale = () => false) {
    for (let guard = 0; guard < 50; guard++) {
      if (this.eof) return null;
      const pk = [];
      let bytes = 0, first = null, last = null;
      for (;;) {
        if (stale()) throw CANCELLED;
        const p = await this.input.next();
        if (!p) { this.eof = true; break; }
        if (p.pts !== null && p.pts !== undefined) { if (first === null) first = p.pts; last = p.pts; }
        pk.push({ data: p.data, ptsUs: p.pts === null || p.pts === undefined ? -1 : p.pts * 1e6, key: p.key });
        bytes += p.data.length;
        if ((first !== null && last - first > 1.5) || bytes > 768 << 10 || pk.length > 400) break;
      }
      if (stale()) throw CANCELLED;
      const r = await this.session.feed(pk, this.eof);
      if (stale()) throw CANCELLED;
      if (r.config) {
        const key = r.config.sampleRate + '/' + r.config.channels;
        if (key !== this.initKey) {
          this.initKey = key;
          this.rate = r.config.sampleRate;
          this.channels = r.config.channels;
          this.init = initSegment({ kind: 'audio', fourcc: 'fLaC', timescale: r.config.sampleRate, description: r.config.streamInfo,
            sampleRate: r.config.sampleRate, channels: r.config.channels });
        }
      }
      const frames = r.frames.filter((f) => f.ptsUs / 1e6 - this.t.origin >= this.minPts - 0.2);
      if (!frames.length) continue;
      const segs = [];
      let run = [], runStart = null, cursor = null;
      const flush = () => { if (run.length) segs.push(mediaSegment(this.seq++, runStart, run, false)); run = []; };
      for (const f of frames) {
        const ticks = Math.round((f.ptsUs / 1e6 - this.t.origin) * this.rate);
        if (ticks < 0) continue;
        if (cursor === null || Math.abs(ticks - cursor) > 2) { flush(); runStart = ticks; cursor = ticks; }
        run.push({ data: new Uint8Array(f.data), duration: f.samples, key: true });
        cursor += f.samples;
      }
      flush();
      if (!segs.length) continue;
      const data = concat(segs);
      const start = frames[0].ptsUs / 1e6 - this.t.origin;
      const end = frames[frames.length - 1].ptsUs / 1e6 - this.t.origin + frames[frames.length - 1].samples / this.rate;
      return { init: this.init, data, start, end, bytes: data.length };
    }
    return null;
  }
  close() { this.session.close(); }
}

/** Decodes MPEG-1/2 video in the codec worker and re-encodes it as H.264. */
class VideoConvert {
  constructor(track, origin, codec) {
    this.t = track;
    this.origin = origin;
    this.input = track.mb ? new MbInput(track.mb, { verifyKeys: false }) : new MpegInput(track.makeReader());
    this.session = codec.videoSession(track.convertSpec);
    this.mime = 'video/mp4; codecs="' + track.convertSpec.encoderCodec + '"';
    this.seq = 1;
    this.init = null;
    this.eof = false;
    this.stats = { mediaSeconds: 0, wallSeconds: 0 };
  }
  async seek(t) {
    await this.session.reset();
    await this.input.seek(t + this.origin, true);
    this.eof = false;
  }
  async next(stale = () => false) {
    for (let guard = 0; guard < 50; guard++) {
      if (this.eof) return null;
      const pk = [];
      let bytes = 0, first = null, last = null;
      for (;;) {
        if (stale()) throw CANCELLED;
        const p = await this.input.next();
        if (!p) { this.eof = true; break; }
        if (p.pts !== null && p.pts !== undefined) { if (first === null) first = p.pts; last = p.pts; }
        pk.push({ data: p.data, ptsUs: p.pts === null || p.pts === undefined ? -1 : p.pts * 1e6, key: p.key });
        bytes += p.data.length;
        if ((first !== null && last - first > 1.0) || bytes > 3 << 20 || pk.length > 120) break;
      }
      if (stale()) throw CANCELLED;
      const t0 = performance.now();
      const r = await this.session.feed(pk, this.eof);
      if (stale()) throw CANCELLED;
      const chunks = r.chunks;
      if (r.info) this.info = r.info;
      if (r.config && r.config.description && !this.init) {
        const c = r.config;
        const sar = c.sar && c.sar[0] > 0 ? c.sar : [1, 1];
        this.config = c;
        this.init = initSegment({
          kind: 'video', fourcc: 'avc1', timescale: VIDEO_TS, description: c.description, codecString: c.codec,
          width: c.width, height: c.height, displayWidth: Math.round((c.width * sar[0]) / sar[1]), displayHeight: c.height, sar,
        });
      }
      if (!chunks.length || !this.init) continue;
      const samples = chunks.map((c, i) => ({
        data: new Uint8Array(c.data),
        duration: Math.round(((i + 1 < chunks.length ? chunks[i + 1].ptsUs - c.ptsUs : c.durUs) / 1e6) * VIDEO_TS),
        cto: 0,
        key: c.key,
      }));
      const base = Math.round((chunks[0].ptsUs / 1e6 - this.origin) * VIDEO_TS);
      if (base < 0) continue;
      const data = mediaSegment(this.seq++, base, samples, false);
      const start = chunks[0].ptsUs / 1e6 - this.origin;
      const end = chunks[chunks.length - 1].ptsUs / 1e6 - this.origin + chunks[chunks.length - 1].durUs / 1e6;
      this.stats.mediaSeconds += end - start;
      this.stats.wallSeconds += (performance.now() - t0) / 1000;
      return { init: this.init, data, start, end, bytes: data.length };
    }
    return null;
  }
  close() { this.session.close(); }
}

/* ---------------- feeding a SourceBuffer ---------------- */

class Feeder {
  constructor(engine, sb, source, kind) {
    this.engine = engine;
    this.sb = sb;
    this.source = source;
    this.kind = kind;
    this.gen = 0;
    this.eof = false;
    this.bytesPerSec = kind === 'video' ? 1e6 : 64e3;
    this.lastInit = null;
    this.error = null;
    this.appendedAny = false;
    this.frontier = null;
  }

  get target() {
    // seconds of media to keep ahead of the playhead, bounded by memory
    const budget = this.kind === 'video' ? 90e6 : 9e6;
    return Math.max(6, Math.min(this.kind === 'video' ? 40 : 30, budget / this.bytesPerSec));
  }

  async _waitIdle() {
    while (this.sb.updating) await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
  }

  async _append(bytes, g) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (g !== this.gen || this.engine.destroyed) return false;
      await this._waitIdle();
      try {
        this.sb.appendBuffer(bytes);
        await new Promise((resolve, reject) => {
          const ok = () => { cleanup(); resolve(); };
          const bad = () => { cleanup(); reject(new Error('append failed')); };
          const cleanup = () => { this.sb.removeEventListener('updateend', ok); this.sb.removeEventListener('error', bad); };
          this.sb.addEventListener('updateend', ok);
          this.sb.addEventListener('error', bad);
        });
        this.appendedAny = true;
        return true;
      } catch (e) {
        if (e.name === 'QuotaExceededError') {
          await this._trim(2);
          await sleep(800);
          continue;
        }
        throw e;
      }
    }
    return false;
  }

  async _trim(keepBehind = 10) {
    const t = this.engine.video.currentTime;
    try {
      await this._waitIdle();
      const r = this.sb.buffered;
      if (r.length && r.start(0) < t - keepBehind) {
        this.sb.remove(0, Math.max(0, t - keepBehind));
        await this._waitIdle();
      }
      // drop data far ahead of a seek target that we will not reach soon
      for (let i = 0; i < this.sb.buffered.length; i++) {
        const s = this.sb.buffered.start(i);
        if (s > t + this.target + 30) {
          this.sb.remove(s, Infinity);
          await this._waitIdle();
          break;
        }
      }
    } catch { /* source buffer gone */ }
  }

  start(t) {
    const g = ++this.gen;
    this.eof = false;
    this.frontier = null;
    this.error = null;
    this.lastInit = null;
    // never let two loops use the same source at once: wait for the previous one to stop
    const prev = this.running;
    this.running = (async () => {
      if (prev) await prev;
      if (g !== this.gen) return;
      try {
        await this._loop(g, t);
      } catch (e) {
        if (e === CANCELLED || g !== this.gen || this.engine.destroyed) return;
        this.error = e;
        this.engine._feederFailed(this, e);
      }
    })();
  }

  stop() {
    this.gen++;
  }

  async _loop(g, t) {
    await this._waitIdle();
    if (g !== this.gen) return;
    try { if (this.engine.ms.readyState === 'open') this.sb.abort(); } catch { /* ignore */ }
    await this.source.seek(Math.max(0, t));
    if (g !== this.gen) return;
    let segments = 0;
    while (g === this.gen && !this.engine.destroyed) {
      const now = this.engine.video.currentTime;
      const range = bufferedAround(this.sb, now);
      const ahead = range ? range.end - now : 0;
      if (segments > 0 && ahead > this.target) {
        await this._trim(10);
        await sleep(500);
        continue;
      }
      const seg = await this.source.next(() => g !== this.gen || this.engine.destroyed);
      if (g !== this.gen || this.engine.destroyed) return;
      if (!seg) {
        this.eof = true;
        this.engine._checkEnd();
        return;
      }
      if (seg.init !== this.lastInit) {
        if (!(await this._append(seg.init, g))) return;
        this.lastInit = seg.init;
      }
      if (!(await this._append(seg.data, g))) return;
      this.frontier = seg.end;
      segments++;
      const span = Math.max(0.2, seg.end - seg.start);
      this.bytesPerSec = this.bytesPerSec * 0.7 + (seg.bytes / span) * 0.3;
      this.engine._progress(this, seg);
    }
  }
}

/* ---------------- engine ---------------- */

export class RemuxEngine extends EventTarget {
  constructor(video, movie, codec) {
    super();
    this.video = video;
    this.movie = movie;
    this.codec = codec;
    this.destroyed = false;
    this.audioTrack = null;
    this.path = 'Remux';
    this._onSeeking = () => this._seeking();
  }

  get reason() {
    return this.movie.remuxReason;
  }

  _makeVideoSource() {
    const v = this.movie.video;
    if (v.mode === 'native') return new VideoPassthrough(v, this.movie.origin);
    return new VideoConvert(v, this.movie.origin, this.codec);
  }

  _makeAudioSource(track) {
    if (track.mode === 'native') return new AudioPassthrough(track, track.origin);
    return new AudioConvert(track, track.origin, this.codec);
  }

  async start(time, audioTrack) {
    this.audioTrack = audioTrack;
    this.ms = new MediaSource();
    const url = URL.createObjectURL(this.ms);
    this.video.src = url;
    await new Promise((r) => this.ms.addEventListener('sourceopen', r, { once: true }));
    URL.revokeObjectURL(url);
    if (this.destroyed) return;
    this.ms.duration = this.movie.duration;
    this.vsrc = this._makeVideoSource();
    this.vsb = this.ms.addSourceBuffer(this.vsrc.mime);
    this.vfeed = new Feeder(this, this.vsb, this.vsrc, 'video');
    if (audioTrack) {
      this.asrc = this._makeAudioSource(audioTrack);
      this.asb = this.ms.addSourceBuffer(this.asrc.mime);
      this.afeed = new Feeder(this, this.asb, this.asrc, 'audio');
    }
    this.video.addEventListener('seeking', this._onSeeking);
    if (time > 0) this.video.currentTime = time;
    this.vfeed.start(time);
    if (this.afeed) this.afeed.start(time);
  }

  _seeking() {
    if (this.destroyed) return;
    const t = this.video.currentTime;
    for (const f of [this.vfeed, this.afeed]) {
      if (!f) continue;
      const r = bufferedAround(f.sb, t);
      if (r && r.end - t > 1) {
        if (r.end >= this.movie.duration - 0.5) continue; // everything to the end is here
        if (f.frontier !== null && Math.abs(r.end - f.frontier) < 1.5 && !f.eof) continue; // feeder is extending this range
        f.start(Math.max(0, r.end - 0.5)); // keep what we have, continue after it
        continue;
      }
      f.start(Math.max(0, t - (f === this.vfeed ? 0 : 0.2)));
    }
  }

  /** Switches audio. track = null is not supported here (the app restarts without audio). */
  async setAudio(track) {
    if (!this.afeed || !track) throw new Error('restart needed');
    this.afeed.stop();
    this.asrc.close();
    const t = this.video.currentTime;
    const src = this._makeAudioSource(track);
    await this.afeed._waitIdle();
    try {
      if (this.ms.readyState === 'ended') { /* appending reopens */ }
      this.asb.abort();
      this.asb.remove(0, Infinity);
      await this.afeed._waitIdle();
      if (src.mime !== this.asrc.mime && this.asb.changeType) this.asb.changeType(src.mime);
    } catch (e) {
      throw new Error('Could not switch audio: ' + e.message);
    }
    this.asrc = src;
    this.audioTrack = track;
    this.afeed.source = src;
    this.afeed.bytesPerSec = 64e3;
    this.afeed.start(Math.max(0, t - 0.2));
  }

  _checkEnd() {
    if (this.vfeed.eof && (!this.afeed || this.afeed.eof)) {
      try {
        if (this.ms.readyState === 'open' && !this.vsb.updating && !(this.asb && this.asb.updating)) this.ms.endOfStream();
      } catch { /* ignore */ }
    }
  }

  _progress(feeder, seg) {
    if (feeder === this.vfeed && this.vsrc instanceof VideoConvert) {
      const s = this.vsrc.stats;
      this.conversionSpeed = s.wallSeconds > 0 ? s.mediaSeconds / s.wallSeconds : null;
    }
    this.dispatchEvent(new CustomEvent('progress', { detail: { kind: feeder.kind, seg } }));
  }

  _feederFailed(feeder, err) {
    this.dispatchEvent(new CustomEvent('trackerror', { detail: { kind: feeder.kind, error: err, track: feeder.kind === 'audio' ? this.audioTrack : this.movie.video } }));
  }

  info() {
    const out = { path: 'Remux', reason: this.movie.remuxReason };
    if (this.vsrc instanceof VideoConvert) out.videoConversion = { speed: this.conversionSpeed || null, config: this.vsrc.config, decoderInfo: this.vsrc.info };
    out.videoBytesPerSec = this.vfeed ? this.vfeed.bytesPerSec : null;
    out.audioBytesPerSec = this.afeed ? this.afeed.bytesPerSec : null;
    out.bufferedAhead = this.vsb ? (() => { const r = bufferedAround(this.vsb, this.video.currentTime); return r ? r.end - this.video.currentTime : 0; })() : 0;
    out.audioAppended = this.afeed ? this.afeed.appendedAny : false;
    return out;
  }

  destroy() {
    this.destroyed = true;
    this.video.removeEventListener('seeking', this._onSeeking);
    this.vfeed?.stop();
    this.afeed?.stop();
    this.vsrc?.close();
    this.asrc?.close();
    try { if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream(); } catch { /* ignore */ }
    this.video.removeAttribute('src');
    this.video.load();
  }
}

/** Plays the file directly with Chrome's own demuxer. */
export class DirectEngine extends EventTarget {
  constructor(video, movie) {
    super();
    this.video = video;
    this.movie = movie;
    this.path = 'Direct play';
    this.audioTrack = null;
  }
  async start(time, audioTrack) {
    this.audioTrack = audioTrack;
    this.url = URL.createObjectURL(this.movie.blob);
    this.video.src = this.url;
    if (time > 0) {
      await new Promise((r) => this.video.addEventListener('loadedmetadata', r, { once: true }));
      this.video.currentTime = time;
    }
  }
  async setAudio() { throw new Error('restart needed'); }
  info() { return { path: 'Direct play', reason: 'Chrome plays this file as is' }; }
  destroy() {
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
