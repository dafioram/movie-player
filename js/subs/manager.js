// Subtitle manager: loads or streams subtitle tracks and draws them over the video.
// Renderers: our own text layer (SRT/VTT, and any text track used as the second track),
// libass via JASSUB (ASS/SSA), and a bitmap canvas (PGS, VobSub).

import { decodeText } from './encoding.js';
import { parseSrt, parseVtt, parseAssAsText, activeCues, markupToHtml, detectTextFormat } from './text.js';
import { PgsDecoder, pgsImages } from './pgs.js';
import { parseIdx, VobSubTrack, vobsubImages } from './vobsub.js';
import { fontFamilies, assFontNames } from './fontnames.js';
import { MkvSubtitleScanner } from '../demux/mkv.js';
import { scanStreams, walkPes, findOffset } from '../demux/mpeg.js';

const JASSUB_URL = new URL('../../lib/jassub/jassub.js', import.meta.url);

function insertSorted(list, item) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].start <= item.start) lo = m + 1; else hi = m; }
  list.splice(lo, 0, item);
}

/** Scans a VOB/MPG for subpicture streams, starting near the playhead. */
class MpegSubScanner {
  constructor(blob, info, keys, onPes) {
    this.blob = blob;
    this.info = info;
    this.keys = keys;
    this.onPes = onPes;
    this.window = 8 << 20;
    this.done = new Set();
    this.seen = new Set();
    this.focusOffset = 0;
    this.running = false;
    this.stopped = false;
  }
  async focus(time) {
    this.focusOffset = await findOffset(this.blob, this.info, time - 5).catch(() => 0);
    this.restart = true;
    if (!this.running) this._run();
  }
  stop() { this.stopped = true; }
  async _run() {
    this.running = true;
    const n = Math.ceil(this.blob.size / this.window);
    while (!this.stopped) {
      this.restart = false;
      const first = Math.floor(this.focusOffset / this.window);
      let any = false;
      for (let k = 0; k < n && !this.restart && !this.stopped; k++) {
        const w = (first + k) % n;
        if (this.done.has(w)) continue;
        any = true;
        const start = Math.max(0, w * this.window - 65536);
        await scanStreams(this.blob, this.info, this.keys, start, Math.min(this.blob.size, (w + 1) * this.window), (pes) => {
          const id = pes.key + ':' + pes.offset;
          if (this.seen.has(id)) return;
          this.seen.add(id);
          this.onPes(pes);
        });
        this.done.add(w);
        // stay gentle on the disk: the movie itself is being read at the same time
        await new Promise((r) => setTimeout(r, (this.window / 60e6) * 1000));
      }
      if (!this.restart && !any) break;
      if (!this.restart && this.done.size >= n) break;
    }
    this.running = false;
  }
}

export class SubtitleManager {
  constructor({ stage, video, overlay, onNotice }) {
    this.stage = stage;
    this.video = video;
    this.overlay = overlay;
    this.onNotice = onNotice || (() => {});
    this.mainText = overlay.querySelector('.sub-main');
    this.secondText = overlay.querySelector('.sub-second');
    this.bitmapCanvas = overlay.querySelector('.sub-bitmap');
    this.data = new Map();
    this.delays = new Map();
    this.main = null;
    this.second = null;
    this.style = { size: 1, color: '#ffffff', background: 'none', outline: true };
    this.scale = 1;
    this.useLocalFonts = false;
    this.rect = { x: 0, y: 0, w: 0, h: 0 };
    this.visible = { x: 0, y: 0, w: 0, h: 0 };
    this.liftPx = 0;
    this._raf = 0;
    this._lastMain = null;
    this._lastSecond = null;
    this._lastBitmap = null;
    this._tick = () => this._render();
    for (const ev of ['timeupdate', 'seeked', 'play', 'pause']) video.addEventListener(ev, () => this._schedule());
    video.addEventListener('play', () => this._loop());
  }

  /* ---------------- movie and tracks ---------------- */

  setMovie(movie) {
    this.reset();
    this.movie = movie;
    this.missingFonts = [];
    // embedded tracks are extracted in the background once one of them is shown
    for (const t of movie.subs) if (t.embedded && t.status === 'ok') this._initEmbedded(t);
  }

  _startScanners() {
    const movie = this.movie;
    const mkvTracks = movie.subs.filter((s) => s.embedded && s.embedded.type === 'mkv' && s.status === 'ok');
    if (mkvTracks.length && movie.mkv && !this.mkvScanner) {
      const byNumber = new Map(mkvTracks.map((s) => [s.embedded.number, s]));
      this.mkvScanner = new MkvSubtitleScanner(movie.mkv, mkvTracks.map((s) => s.embedded.track), (num, blocks) => {
        const s = byNumber.get(num);
        if (s) this._addBlocks(s, blocks);
      });
      this.mkvScanner.focus(this.video.currentTime || 0);
    }
    const mpegTracks = movie.subs.filter((s) => s.embedded && s.embedded.type === 'mpeg');
    if (mpegTracks.length && movie.mpeg && !this.mpegScanner) {
      const byKey = new Map(mpegTracks.map((s) => [s.embedded.key, s]));
      this.mpegScanner = new MpegSubScanner(movie.blob, movie.mpeg, [...byKey.keys()], (pes) => {
        const s = byKey.get(pes.key);
        if (!s) return;
        const d = this.data.get(s.id);
        d.vob.addPes(pes.pts === null ? null : pes.pts - movie.origin, pes.data);
        d.changed = true;
        this._schedule();
      });
      this.mpegScanner.focus(this.video.currentTime || 0);
    }
  }

  reset() {
    this.mkvScanner?.stop();
    this.mpegScanner?.stop();
    this.mkvScanner = null;
    this.mpegScanner = null;
    this._destroyAss();
    this.data.clear();
    this.delays.clear();
    this.main = null;
    this.second = null;
    this._clear();
  }

  /** Called after a seek so embedded tracks near the new position are read first. */
  focus(time) {
    this.mkvScanner?.focus(time);
    this.mpegScanner?.focus(time);
  }

  _initEmbedded(s) {
    const e = s.embedded;
    const d = { kind: null, ready: true, changed: true };
    if (s.format === 'srt' || s.format === 'vtt') { d.kind = 'text'; d.cues = []; }
    else if (s.format === 'ass') {
      d.kind = 'ass';
      d.header = e.codecPrivate ? new TextDecoder().decode(e.codecPrivate) : '';
      d.blocks = [];
      d.textCues = [];
    } else if (s.format === 'pgs') { d.kind = 'bitmap'; d.sub = 'pgs'; d.blocks = []; d.events = []; }
    else if (s.format === 'vobsub') {
      d.kind = 'bitmap';
      d.sub = 'vobsub';
      const idx = e.codecPrivate ? parseIdx(new TextDecoder().decode(e.codecPrivate)) : parseIdx('');
      if (s.noPalette || !e.codecPrivate) idx.palette = null;
      if (!e.codecPrivate && this.movie.video) { idx.width = this.movie.video.codedWidth || 720; idx.height = this.movie.video.codedHeight || 480; }
      d.idx = idx;
      d.vob = new VobSubTrack(idx);
    }
    this.data.set(s.id, d);
  }

  _addBlocks(s, blocks) {
    const d = this.data.get(s.id);
    const origin = this.movie.origin;
    for (const b of blocks) {
      const start = b.time - origin;
      const dur = b.duration && b.duration < 600 ? b.duration : null;
      if (d.kind === 'text') {
        let text = new TextDecoder().decode(b.data);
        if (s.format === 'vtt') text = text.replace(/<\d+:\d+[:.]\d+(?:\.\d+)?>/g, '');
        const { html, top } = markupToHtml(text);
        if (html) insertSorted(d.cues, { start, end: start + (dur || 4), html, top });
      } else if (d.kind === 'ass') {
        const text = new TextDecoder().decode(b.data);
        d.blocks.push({ text, start, dur: dur || 5 });
        if (d.jassub && d.jassub.renderer) Promise.resolve(d.jassub.renderer.processChunk(text, Math.round(start * 1000), Math.round((dur || 5) * 1000))).catch(() => {});
        const fields = text.split(',');
        const { html, top } = markupToHtml(fields.slice(8).join(','));
        if (html && !/\{[^}]*\\p[1-9]/.test(text)) insertSorted(d.textCues, { start, end: start + (dur || 5), html, top });
      } else if (d.sub === 'pgs') {
        d.blocks.push({ time: start, data: b.data });
        d.dirty = true;
      } else if (d.sub === 'vobsub') {
        d.vob.addPacket(start, b.data);
      }
    }
    d.changed = true;
    this._schedule();
  }

  /** Loads an external subtitle file into this.data. */
  async _loadExternal(s) {
    if (this.data.has(s.id)) return this.data.get(s.id);
    const d = { kind: null, ready: false, changed: true };
    this.data.set(s.id, d);
    try {
      if (s.format === 'srt' || s.format === 'vtt' || s.format === 'ass') {
        const bytes = new Uint8Array(await (await s.item.getBlob()).arrayBuffer());
        const { text, encoding } = decodeText(bytes, s.lang);
        s.encoding = encoding;
        const fmt = detectTextFormat(text, s.fileName) || s.format;
        if (fmt === 'ass') {
          d.kind = 'ass';
          d.script = text;
          d.textCues = parseAssAsText(text);
        } else {
          d.kind = 'text';
          d.cues = fmt === 'vtt' ? parseVtt(text) : parseSrt(text);
          if (!d.cues.length) throw new Error('no subtitles found in the file');
        }
      } else if (s.format === 'pgs') {
        d.kind = 'bitmap';
        d.sub = 'pgs';
        d.events = PgsDecoder.parseSup(new Uint8Array(await (await s.item.getBlob()).arrayBuffer()));
        if (!d.events.length) throw new Error('no PGS subtitles found in the file');
      } else if (s.format === 'vobsub') {
        d.kind = 'bitmap';
        d.sub = 'vobsub';
        const idx = s.noPalette ? parseIdx('') : parseIdx(await (await s.item.getBlob()).text());
        if (s.noPalette) idx.palette = null;
        d.idx = idx;
        d.vob = new VobSubTrack(idx);
        const subBlob = await s.subItem.getBlob();
        const key = 'bd' + (0x20 + (s.idxIndex || 0)).toString(16);
        await walkPes(subBlob, { kind: 'ps' }, 0, subBlob.size, new Set([key]), (pes) => {
          d.vob.addPes(pes.pts === null ? null : pes.pts / 90000, pes.data);
        });
        if (!d.vob.events().length) throw new Error('no subtitles found for this language');
      }
      d.ready = true;
    } catch (e) {
      s.status = 'failed';
      s.reason = e.message;
      this.data.delete(s.id);
      throw e;
    }
    return d;
  }

  async _ensure(s) {
    if (!s) return null;
    if (s.source === 'embedded') {
      this._startScanners();
      return this.data.get(s.id);
    }
    return this._loadExternal(s);
  }

  /** Selects the main and second tracks (either may be null). */
  async select(main, second) {
    const prevMain = this.main;
    this.main = main;
    this.second = second;
    this._lastMain = this._lastSecond = this._lastBitmap = null;
    this._clear();
    try {
      if (main) await this._ensure(main);
      if (second) await this._ensure(second);
    } catch (e) {
      this.onNotice(`Subtitle track can't be shown: ${e.message}`);
      if (this.main && this.main.status === 'failed') this.main = null;
      if (this.second && this.second.status === 'failed') this.second = null;
    }
    const md = this.main ? this.data.get(this.main.id) : null;
    if (md && md.kind === 'ass') {
      if (prevMain !== this.main || !this.ass) await this._startAss(this.main, md);
    } else this._destroyAss();
    this._applyAssOptions();
    this._schedule();
  }

  /* ---------------- ASS via JASSUB ---------------- */

  async _fonts() {
    const fonts = [];
    const families = new Set();
    for (const f of this.movie.fonts) {
      try {
        const bytes = await f.read();
        fonts.push(bytes);
        for (const n of fontFamilies(bytes)) families.add(n);
      } catch { /* skip unreadable font */ }
    }
    return { fonts, families };
  }

  async _startAss(track, d) {
    this._destroyAss();
    const { default: JASSUB } = await import(JASSUB_URL.href);
    const { fonts, families } = await this._fonts();
    const script = d.script || d.header || '';
    const wanted = assFontNames(script + '\n' + (d.blocks || []).map((b) => b.text).join('\n'));
    const missing = [...wanted].filter(([lower]) => !families.has(lower)).map(([, name]) => name);
    this.missingFonts = this.useLocalFonts ? [] : missing;
    const canvas = document.createElement('canvas');
    canvas.className = 'sub-ass';
    this.video.insertAdjacentElement('afterend', canvas);
    const jassub = new JASSUB({
      video: this.video,
      canvas,
      subContent: script || '[Script Info]\nScriptType: v4.00+\n',
      fonts,
      queryFonts: this.useLocalFonts ? 'local' : false,
      timeOffset: -(this.delays.get(track.id) || 0),
    });
    this.ass = { jassub, canvas, track };
    d.jassub = jassub;
    try {
      await jassub.ready;
    } catch (e) {
      this.onNotice('The ASS subtitle renderer could not start: ' + e.message);
      this._destroyAss();
      return;
    }
    if (this.ass?.jassub !== jassub) return;
    // embedded tracks: replay what has been read so far
    if (d.blocks) for (const b of d.blocks) jassub.renderer.processChunk(b.text, Math.round(b.start * 1000), Math.round(b.dur * 1000));
    if (missing.length && !this.useLocalFonts) {
      this.onNotice(`ASS font${missing.length > 1 ? 's' : ''} not found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}. Using a fallback font.`);
    }
    this._applyAssOptions();
  }

  _destroyAss() {
    if (!this.ass) return;
    const { jassub, canvas } = this.ass;
    for (const d of this.data.values()) if (d.jassub === jassub) d.jassub = null;
    jassub.destroy().catch(() => {});
    canvas.remove();
    this.ass = null;
  }

  _applyAssOptions(resize = true) {
    if (!this.ass) return;
    this.ass.jassub.timeOffset = -(this.delays.get(this.ass.track.id) || 0);
    this.ass.canvas.style.transformOrigin = '50% 100%';
    // move the whole picture up while the control bar shows, and apply the user's scale
    const parts = [];
    if (this.liftPx) parts.push(`translateY(${-Math.round(this.liftPx)}px)`);
    if (this.scale !== 1) parts.push(`scale(${this.scale})`);
    this.ass.canvas.style.transform = parts.join(' ');
    this.ass.canvas.style.transition = 'transform 0.18s ease';
    if (resize) this.ass.jassub.resize?.(true).catch(() => {});
  }

  /* ---------------- settings ---------------- */

  setDelay(track, seconds) {
    if (!track) return;
    this.delays.set(track.id, Math.round(seconds * 10) / 10);
    this._lastMain = this._lastSecond = this._lastBitmap = null;
    this._applyAssOptions();
    this._schedule();
  }

  getDelay(track) {
    return track ? this.delays.get(track.id) || 0 : 0;
  }

  setStyle(style) {
    Object.assign(this.style, style);
    const o = this.overlay.style;
    o.setProperty('--sub-scale', this.style.size);
    o.setProperty('--sub-color', this.style.color);
    this.overlay.dataset.subBg = this.style.background;
    this.overlay.dataset.subOutline = this.style.outline ? 'on' : 'off';
  }

  setScale(s) {
    this.scale = s;
    this._lastBitmap = null;
    this._applyAssOptions();
    this._schedule();
  }

  setLocalFonts(on) {
    this.useLocalFonts = on;
    if (this.ass) {
      const d = this.data.get(this.ass.track.id);
      this._startAss(this.ass.track, d);
    }
  }

  /** Positions the overlay over the picture. rect: picture rectangle; visible: part of it on screen. */
  layout(rect, visible, liftPx) {
    this.rect = rect;
    this.visible = visible;
    this.liftPx = liftPx;
    const o = this.overlay.style;
    o.left = visible.x + 'px';
    o.top = visible.y + 'px';
    o.width = visible.w + 'px';
    o.height = visible.h + 'px';
    o.setProperty('--pic-h', rect.h + 'px');
    o.setProperty('--lift', liftPx + 'px');
    const dpr = window.devicePixelRatio || 1;
    this.bitmapCanvas.width = Math.round(visible.w * dpr);
    this.bitmapCanvas.height = Math.round(visible.h * dpr);
    this._lastBitmap = null;
    if (this.ass) this._applyAssOptions(false);
    this._schedule();
  }

  /* ---------------- rendering ---------------- */

  _clear() {
    this.mainText.innerHTML = '';
    this.secondText.innerHTML = '';
    const ctx = this.bitmapCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.bitmapCanvas.width, this.bitmapCanvas.height);
  }

  _schedule() {
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _loop() {
    const step = () => {
      if (this.video.paused || this.video.ended) return;
      this._render();
      this._loopRaf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this._loopRaf);
    this._loopRaf = requestAnimationFrame(step);
  }

  _textCues(track) {
    const d = this.data.get(track.id);
    if (!d || !d.ready) return null;
    if (d.kind === 'text') return d.cues;
    if (d.kind === 'ass') return d.textCues;
    return null;
  }

  _render() {
    const t = this.video.currentTime;
    // main track
    let mainHtml = '';
    let mainTop = false;
    let bitmap = null;
    if (this.main) {
      const d = this.data.get(this.main.id);
      const tt = t - (this.delays.get(this.main.id) || 0);
      if (d && d.ready && d.kind === 'text') {
        const cues = activeCues(d.cues, tt);
        mainHtml = cues.map((c) => c.html).join('<br>');
        mainTop = cues.some((c) => c.top);
      } else if (d && d.ready && d.kind === 'bitmap') {
        bitmap = this._bitmapAt(d, tt);
      }
    }
    const mainKey = mainHtml + (mainTop ? '|t' : '');
    if (mainKey !== this._lastMain) {
      this._lastMain = mainKey;
      this.mainText.innerHTML = mainHtml ? `<span class="cue">${mainHtml}</span>` : '';
      this.mainText.classList.toggle('top', mainTop);
    }
    // second track (always text, at the top)
    let secondHtml = '';
    if (this.second) {
      const cues = this._textCues(this.second);
      if (cues) secondHtml = activeCues(cues, t - (this.delays.get(this.second.id) || 0)).map((c) => c.html).join('<br>');
    }
    if (secondHtml !== this._lastSecond) {
      this._lastSecond = secondHtml;
      this.secondText.innerHTML = secondHtml ? `<span class="cue">${secondHtml}</span>` : '';
    }
    if (bitmap !== this._lastBitmap) {
      this._lastBitmap = bitmap;
      this._drawBitmap(bitmap);
    }
  }

  _bitmapAt(d, t) {
    let events;
    if (d.sub === 'pgs') {
      if (d.dirty) {
        d.blocks.sort((a, b) => a.time - b.time);
        const dec = new PgsDecoder();
        for (const b of d.blocks) dec.feed(b.time, b.data);
        d.events = dec.events;
        d.dirty = false;
      }
      events = d.events;
    } else events = d.vob.events();
    let lo = 0, hi = events.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (events[m].start <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
    if (idx < 0) return null;
    const ev = events[idx];
    if (ev.end <= t) return null;
    ev._kind = d.sub;
    ev._palette = d.idx ? d.idx.palette : null;
    return ev;
  }

  async _drawBitmap(ev) {
    const canvas = this.bitmapCanvas;
    const ctx = canvas.getContext('2d');
    if (!ev) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    const images = ev._kind === 'pgs' ? pgsImages(ev) : vobsubImages(ev, ev._palette);
    if (!ev._bitmaps) {
      ev._bitmaps = await Promise.all(images.map((im) => createImageBitmap(new ImageData(im.rgba, im.w, im.h))));
    }
    if (this._lastBitmap !== ev) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // picture rect relative to the visible area
    const r = this.rect, v = this.visible;
    const sx = r.w / ev.width, sy = r.h / ev.height;
    const s = this.scale;
    const cx = r.w / 2, by = r.h; // scale around the bottom centre of the picture
    ctx.imageSmoothingQuality = 'high';
    images.forEach((im, i) => {
      let x = im.x * sx, y = im.y * sy, w = im.w * sx, h = im.h * sy;
      if (s !== 1) { x = cx + (x - cx) * s; y = by + (y - by) * s; w *= s; h *= s; }
      // keep bottom subtitles clear of the control bar
      if (this.liftPx && y + h > r.h * 0.6) y -= Math.max(0, (r.y + y + h) - (v.y + v.h - this.liftPx));
      ctx.drawImage(ev._bitmaps[i], (r.x - v.x + x) * dpr, (r.y - v.y + y) * dpr, w * dpr, h * dpr);
    });
  }

  /** Text-capable tracks for the second-track menu. */
  static canBeSecond(track) {
    return track && track.status !== 'unsupported' && ['srt', 'vtt', 'ass'].includes(track.format);
  }
}
