// Movie Player: the app controller. Wires intake, the movie model, the playback engines,
// subtitles, thumbnails and the interface together.

import { $, el, setIcon } from './ui/dom.js';
import { Notices, showDialog } from './ui/notices.js';
import { MenuHost } from './ui/menus.js';
import { buildDetails, trackTitle, audioMeta } from './ui/details.js';
import { expand, pickFiles, pickFolder, dropSources, companionsFor, requestAccess, canUseHandles } from './intake.js';
import { buildMovie, addCompanionItems, MovieError } from './movie.js';
import { RemuxEngine, DirectEngine } from './engine/remux.js';
import { CodecClient } from './codec/client.js';
import { SubtitleManager } from './subs/manager.js';
import { Thumbnailer } from './thumbs.js';
import { decodeReport, conversionReport } from './decoder-info.js';
import { formatTime, formatBytes, languageName, sameLanguage } from './names.js';
import * as store from './storage.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ASPECTS = [
  ['fit', 'Fit', 'Whole picture, black bars as needed'],
  ['fill', 'Fill', 'Fills the window, crops the edges'],
  ['stretch', 'Stretch', 'Fills the window, distorts the picture'],
  ['zoom', 'Zoom 1.33×', 'Crops letterbox bars from widescreen films'],
  ['4:3', 'Force 4:3', null],
  ['16:9', 'Force 16:9', null],
  ['2.35:1', 'Force 2.35:1', null],
];
const SIZES = [['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%']];
const COLORS = [['#ffffff', 'White'], ['#ffe14d', 'Yellow'], ['#9ff0ff', 'Cyan']];
const BACKGROUNDS = [['none', 'None'], ['box', 'Box'], ['dark', 'Dark box']];
const SCALES = [['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%']];

export class App {
  constructor() {
    this.root = $('#app');
    this.stage = $('#stage');
    this.video = $('#video');
    this.codec = new CodecClient();
    this.prefs = store.loadPrefs();
    this.notices = new Notices($('#notices'));
    this.menu = new MenuHost($('#menu'), this.root);
    this.subs = new SubtitleManager({ stage: this.stage, video: this.video, overlay: $('#overlay'), onNotice: (t) => this.notices.show(t) });
    this.subs.setStyle(this.prefs.subStyle);
    this.subs.setScale(this.prefs.subScale);
    this.subs.useLocalFonts = this.prefs.localFonts;
    this.movie = null;
    this.engine = null;
    this.audioTrack = null;
    this.userSub = null;
    this.subMain = null;
    this.subSecond = null;
    this.aspect = 'fit';
    this.showRemaining = false;
    this.loadToken = 0;
    this.video.volume = this.prefs.volume;
    this.video.muted = this.prefs.muted;
    this._bind();
    this._updateVolumeUi();
    this.refreshContinue();
    this.codec.preload();
  }

  /* =============== state =============== */

  setState(state) {
    this.root.dataset.state = state;
    this.root.classList.toggle('empty', state === 'empty');
    if (state === 'empty') {
      this.menu.close();
      $('#details').hidden = true;
      this.refreshContinue();
    }
  }

  spinner(text) {
    const s = $('#spinner');
    if (text === null) { s.hidden = true; return; }
    s.hidden = false;
    s.querySelector('.spinner-text').textContent = text || '';
  }

  /* =============== opening files =============== */

  async openSources(sources, opts = {}) {
    if (!sources || !sources.length) return;
    this.menu.close();
    const token = ++this.loadToken;
    const wasEmpty = !this.movie;
    if (wasEmpty) this.setState('loading');
    this.spinner('Reading files');
    let res;
    try {
      res = await expand(sources);
    } catch (e) {
      this.spinner(null);
      this._fail(new MovieError("Couldn't read the files", e.message));
      return;
    }
    if (token !== this.loadToken) return;
    const { items, notes, roots, zips } = res;
    // only companions dropped onto a playing movie: add them as tracks
    const media = items.filter((i) => i.kind !== 'other');
    if (this.movie && media.length && media.every((i) => ['sub', 'audio', 'font'].includes(i.kind))) {
      this.spinner(null);
      await this.addCompanions(media);
      return;
    }
    const videos = items.filter((i) => i.kind === 'video');
    if (!videos.length) {
      this.spinner(null);
      const blocking = notes.find((n) => n.blocking);
      if (blocking) this._fail(new MovieError("Couldn't open " + blocking.name, blocking.reason, /zip|compression/i.test(blocking.reason) ? 'zip' : null));
      else this._fail(new MovieError('No video file found', 'Choose a video file (MP4, MKV, WebM, MOV, VOB, MPG, TS or M2TS), a folder that contains one, or an uncompressed zip.'));
      return;
    }
    let video = videos[0];
    if (videos.length > 1) {
      this.spinner(null);
      video = await this._chooseVideo(videos);
      if (!video) { if (wasEmpty) this.setState('empty'); return; }
    }
    const companions = companionsFor(video, items);
    let zipStatus = null;
    if (zips.length) {
      const z = zips[0];
      zipStatus = z.problems ? `${z.entries} entries, ${z.problems} skipped (see below)` : `${z.entries} entries, all usable`;
    }
    for (const n of notes) if (!n.blocking) this.notices.show(n.name + ': ' + n.reason);
    await this.loadMovie(video, companions, { roots: canUseHandles ? roots : [], zipStatus, token });
  }

  _chooseVideo(videos) {
    return new Promise((resolve) => {
      const sorted = [...videos].sort((a, b) => (b.size || 0) - (a.size || 0));
      let close = null;
      const list = el('div.choice-list', {}, ...sorted.map((v) => el('button', {
        onclick: () => { close(); resolve(v); },
      }, v.name, el('span.meta', { text: [formatBytes(v.size), v.path !== v.name ? v.path : null, v.problem].filter(Boolean).join(' · ') }))));
      close = showDialog({
        iconName: 'film', title: 'Which video?', body: [el('p.muted', { text: 'These files contain more than one video.' }), list],
        actions: [{ label: 'Cancel', onClick: () => resolve(null) }],
      });
    });
  }

  async addCompanions(items) {
    const m = this.movie;
    const beforeAudio = m.audio.length, beforeSubs = m.subs.length;
    this.spinner('Adding tracks');
    try {
      await addCompanionItems(m, items, this.codec);
    } finally {
      this.spinner(null);
    }
    const newAudio = m.audio.slice(beforeAudio), newSubs = m.subs.slice(beforeSubs);
    const parts = [];
    if (newAudio.length) parts.push(`${newAudio.length} audio track${newAudio.length > 1 ? 's' : ''}`);
    if (newSubs.length) parts.push(`${newSubs.length} subtitle track${newSubs.length > 1 ? 's' : ''}`);
    this.notices.show(parts.length ? 'Added ' + parts.join(' and ') : 'Nothing new to add from those files', { level: 'info', duration: 4000 });
    for (const s of newSubs) if (s.status === 'ok' && !this.userSub) { await this.selectSub(s); break; }
    if (newAudio.length && this.engine instanceof DirectEngine) {
      // external audio needs the remux path
      m.direct = false;
      m.remuxReason = 'external audio';
      await this.restartEngine();
    }
    this._saveLast();
  }

  async loadMovie(video, companions, { roots = [], zipStatus = null, resumeAt = null, restore = null, token = this.loadToken } = {}) {
    this._teardown();
    this.setState(this.root.dataset.state === 'empty' ? 'loading' : this.root.dataset.state);
    this.spinner('Reading the file');
    let movie;
    try {
      movie = await buildMovie(video, companions, this.codec, (t) => { if (token === this.loadToken) this.spinner(t); });
    } catch (e) {
      if (token !== this.loadToken) return;
      this.spinner(null);
      this._fail(e instanceof MovieError ? e : new MovieError("This file can't be played", e.message));
      return;
    }
    if (token !== this.loadToken) return;
    this.movie = movie;
    this.zipStatus = zipStatus;
    this.roots = roots;
    this.companionPaths = companions.map((c) => c.path);
    this.key = store.movieKey(movie);
    this.decoderReport = null;
    this.forceRemux = false;
    this.notices.clear();
    $('#title').textContent = movie.title || movie.name;
    document.title = (movie.title || movie.name) + ' — Movie Player';
    this.subs.setMovie(movie);
    this.thumbs = new Thumbnailer(movie, this.codec);
    this._renderChapters();
    $('#btn-chapters').hidden = !movie.chapters.length;
    $('#btn-pip').disabled = !document.pictureInPictureEnabled;

    // tracks
    this.audioTrack = (restore && this._findTrack(movie.audio, restore.audio)) || this._pickAudio();
    const restoredSub = restore ? this._findTrack(movie.subs, restore.sub) : undefined;
    this.userSub = restore ? restoredSub || null : this._pickSub();
    this.subSecond = (restore && this._findTrack(movie.subs, restore.sub2)) || this._pickSub2();
    for (const t of movie.ignored) if (/zip/.test(t.reason)) this.notices.show(`${t.name}: ${t.reason}`);
    if (!movie.audio.length) this.notices.show('This movie has no audio track.', { level: 'info' });
    else if (!this.audioTrack) this.notices.show('No playable audio track. Playing without sound.');

    const saved = store.getPosition(this.key);
    const start = resumeAt != null ? resumeAt : 0;
    this.setState('playing');
    try {
      await this._startEngine(start);
    } catch (e) {
      this.spinner(null);
      this._fail(new MovieError("This file can't be played", e.message));
      return;
    }
    this.spinner(null);
    this._applySubs();
    this._layout();
    this._mediaSession();
    this._statusLine();
    this._decoderReport();
    if (resumeAt == null && saved && saved.t > 30) {
      const close = showDialog({
        iconName: 'play', title: `Resume from ${formatTime(saved.t, saved.t >= 3600)}?`, dismissable: false,
        body: [el('p.muted', { text: movie.name })],
        actions: [
          { label: 'Start over', onClick: () => this.play() },
          { label: 'Resume', primary: true, onClick: () => { this.seek(saved.t); this.play(); this.flashStatus('Resumed at ' + formatTime(saved.t, saved.t >= 3600)); } },
        ],
      });
      void close;
    } else if (resumeAt != null) {
      // reopened from the card: open paused at the saved position
      this.video.pause();
      this._showBigPlay(true);
      if (resumeAt > 0) this.flashStatus('Resumed at ' + formatTime(resumeAt, resumeAt >= 3600));
    } else {
      this.play();
    }
    this._saveLast();
  }

  _teardown() {
    if (this.movie) this._savePosition();
    this.engine?.destroy();
    this.engine = null;
    this.thumbs?.destroy();
    this.thumbs = null;
    this.subs.reset();
    this.movie?.mb?.dispose?.();
    this.movie = null;
    this.audioTrack = null;
    this.userSub = this.subMain = this.subSecond = null;
    clearTimeout(this._watchdog);
    this.menu.close();
    this._showBigPlay(false);
  }

  closeMovie() {
    this.loadToken++;
    this._teardown();
    $('#title').textContent = '';
    document.title = 'Movie Player';
    this.setState('empty');
  }

  _fail(err) {
    const fixes = {
      convert: ['Convert the video to H.264 with HandBrake (preset "Fast 1080p30"), or with ffmpeg:', 'ffmpeg -i "input" -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k "output.mp4"'],
      remux: ['If the codecs are supported, repackaging into MKV or MP4 without re-encoding is enough:', 'ffmpeg -i "input" -map 0 -c copy "output.mkv"'],
      zip: ['Create the zip without compression, for example:', 'zip -0 -r "movie.zip" "Movie folder"'],
    };
    const body = [err.detail];
    const fix = fixes[err.fix];
    if (fix) body.push(el('p.muted', { text: fix[0] }), el('pre', { text: fix[1] }));
    showDialog({
      title: err.title, body,
      actions: [
        { label: 'Help', onClick: () => window.open('help.html', '_blank', 'noopener') },
        { label: 'Open another file', primary: true, onClick: () => this.openFile() },
      ],
    });
    if (!this.movie) this.setState('empty');
  }

  async openFile() {
    try {
      const s = await pickFiles();
      if (s) await this.openSources(s);
    } catch (e) {
      this.notices.show('Could not open the file picker: ' + e.message);
    }
  }

  async openFolder() {
    try {
      const s = await pickFolder();
      if (s) await this.openSources(s);
    } catch (e) {
      this.notices.show('Could not open the folder picker: ' + e.message);
    }
  }

  /* =============== engines =============== */

  async _startEngine(time) {
    const m = this.movie;
    this.engine?.destroy();
    this.engine = null;
    const direct = m.direct && !this.forceRemux && (this.audioTrack === m.audio[0] || (!this.audioTrack && !m.audio.length));
    const engine = direct ? new DirectEngine(this.video, m) : new RemuxEngine(this.video, m, this.codec);
    engine.addEventListener('trackerror', (e) => this._onTrackError(e.detail));
    this.engine = engine;
    this.video.playbackRate = this.speed || 1;
    await engine.start(time, this.audioTrack);
    this._armWatchdog();
  }

  async restartEngine() {
    const t = this.video.currentTime;
    const playing = !this.video.paused;
    await this._startEngine(t);
    if (playing) this.play();
  }

  _onTrackError({ kind, error, track }) {
    if (kind === 'audio') this._audioFailed(track, error.message);
    else this._videoFailed(error.message);
  }

  async _audioFailed(track, reason) {
    if (!track || track.status === 'failed' || track !== this.audioTrack) return;
    track.status = 'failed';
    track.failReason = reason;
    const next = this._pickAudio();
    if (next) {
      this.notices.show(`${trackTitle(track)} (${track.codecLabel}) couldn't be played: ${reason}. Switched to ${trackTitle(next)}.`);
      this.audioTrack = next;
    } else {
      this.notices.show(`${trackTitle(track)} couldn't be played: ${reason}. No other audio track works, so the movie plays without sound.`);
      this.audioTrack = null;
    }
    await this.restartEngine();
    this._applySubs();
  }

  async _videoFailed(reason) {
    if (this.engine instanceof DirectEngine && this.movie && !this.movie.video.directOnly && !this.forceRemux) {
      // Chrome refused the file: try the remux path once
      this.forceRemux = true;
      this.movie.remuxReason = 'Chrome could not play the file directly';
      await this.restartEngine();
      return;
    }
    this._teardown();
    this._fail(new MovieError("The video can't be played", reason, 'convert'));
  }

  _armWatchdog() {
    clearTimeout(this._watchdog);
    this._watchStart = null;
  }

  _checkWatchdog() {
    // audio selected, video has played for a few seconds, yet Chrome decoded no audio at all
    if (!this.audioTrack || this.video.paused || !this.engine) return;
    if (this._watchStart === null) { this._watchStart = this.video.currentTime; return; }
    if (this.video.currentTime - this._watchStart < 4) return;
    if (this.video.webkitAudioDecodedByteCount === 0) {
      const info = this.engine.info();
      if (this.engine instanceof RemuxEngine && !info.audioAppended) return; // still preparing
      this._watchStart = Infinity;
      this._audioFailed(this.audioTrack, 'no sound was decoded');
    } else this._watchStart = Infinity;
  }

  /* =============== tracks =============== */

  _playableAudio() {
    return this.movie.audio.filter((t) => t.mode !== 'unsupported' && t.status !== 'failed');
  }

  _pickAudio() {
    const list = this._playableAudio();
    const embedded = list.filter((t) => t.source === 'embedded');
    const pref = this.prefs.audioLang;
    return (pref && list.find((t) => sameLanguage(t.lang, pref) && !t.commentary))
      || embedded.find((t) => t.default && !t.commentary)
      || embedded.find((t) => !t.commentary)
      || list[0] || null;
  }

  _pickSub() {
    const list = this.movie.subs.filter((t) => t.status !== 'unsupported' && !t.forced);
    if (this.prefs.subOff) return null;
    if (this.prefs.subLang) {
      const m = list.find((t) => sameLanguage(t.lang, this.prefs.subLang) && !t.sdh) || list.find((t) => sameLanguage(t.lang, this.prefs.subLang));
      if (m) return m;
    }
    return list.find((t) => t.default) || null;
  }

  _pickSub2() {
    if (!this.prefs.sub2Lang) return null;
    return this.movie.subs.find((t) => SubtitleManager.canBeSecond(t) && sameLanguage(t.lang, this.prefs.sub2Lang) && t !== this.userSub) || null;
  }

  _forcedFor(lang) {
    if (!lang) return null;
    return this.movie.subs.find((t) => t.forced && t.status !== 'unsupported' && sameLanguage(t.lang, lang)) || null;
  }

  _applySubs() {
    if (!this.movie) return;
    let main = this.userSub;
    this.autoForced = null;
    if (!main && this.audioTrack) {
      main = this._forcedFor(this.audioTrack.lang);
      this.autoForced = main;
    }
    if (this.subSecond === main) this.subSecond = null;
    this.subMain = main;
    $('#subs-dot').hidden = !main && !this.subSecond;
    this.subs.select(main, this.subSecond).then(() => this._refreshDetails());
  }

  async selectAudio(track) {
    if (!track || track === this.audioTrack || track.mode === 'unsupported' || track.status === 'failed') return;
    const playing = !this.video.paused;
    this.audioTrack = track;
    if (track.lang) { this.prefs.audioLang = track.lang; store.savePrefs(this.prefs); }
    let switched = false;
    if (this.engine instanceof RemuxEngine && this.engine.asb) {
      try { await this.engine.setAudio(track); switched = true; } catch { switched = false; }
    }
    if (!switched) await this.restartEngine();
    else if (playing) this.play();
    this._applySubs();
    this._saveLast();
  }

  async selectSub(track) {
    this.userSub = track;
    this.prefs.subOff = !track;
    if (track && track.lang) this.prefs.subLang = track.lang;
    store.savePrefs(this.prefs);
    this._applySubs();
    this._saveLast();
  }

  async selectSub2(track) {
    this.subSecond = track;
    this.prefs.sub2Lang = track ? track.lang : null;
    store.savePrefs(this.prefs);
    this._applySubs();
    this._saveLast();
  }

  _trackKey(list, t) {
    if (!t) return null;
    const same = list.filter((x) => x.source === t.source && (x.fileName || '') === (t.fileName || ''));
    return `${t.source}|${t.fileName || ''}|${same.indexOf(t)}`;
  }

  _findTrack(list, key) {
    if (!key) return null;
    return list.find((t) => this._trackKey(list, t) === key && t.status !== 'unsupported') || null;
  }

  /* =============== playback =============== */

  play() {
    this._showBigPlay(false);
    const p = this.video.play();
    if (p) p.catch(() => this._showBigPlay(true));
  }

  togglePlay() {
    if (!this.movie) return;
    if (this.video.paused || this.video.ended) this.play();
    else this.video.pause();
    this._flash(this.video.paused ? 'pause' : 'play');
  }

  seek(t) {
    if (!this.movie) return;
    t = Math.max(0, Math.min(this.movie.duration - 0.05, t));
    this.video.currentTime = t;
    this.subs.focus(t);
    this._updateTime();
  }

  _flash(name) {
    const f = $('#flash');
    setIcon(f, name);
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
  }

  _showBigPlay(on) {
    $('#big-play').hidden = !on;
  }

  flashStatus(text) {
    const s = $('#status-line');
    s.textContent = text;
    s.classList.add('show');
    this._showUi();
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => s.classList.remove('show'), 4500);
  }

  _statusLine() {
    const m = this.movie, v = m.video;
    const path = this.engine instanceof DirectEngine ? 'Direct play' : 'Remux';
    const codec = [v.codecLabel, v.bitDepth && v.bitDepth > 8 ? v.bitDepth + '-bit' : null].filter(Boolean).join(' ');
    this._statusBase = `${path} · ${codec}`;
    this.flashStatus(this._statusBase);
  }

  async _decoderReport() {
    const m = this.movie, v = m.video;
    const token = this.loadToken;
    let r;
    try {
      if (v.mode === 'convert') r = await conversionReport(v.convertSpec, v.codedWidth, v.codedHeight);
      else r = await decodeReport({ codec: v.codec, codecString: v.codecString, width: v.codedWidth, height: v.codedHeight, fps: v.fps, bitrate: v.bitrate, description: v.description });
    } catch {
      r = { hardware: null, label: 'Unknown', reason: null };
    }
    if (token !== this.loadToken || this.movie !== m) return;
    this.decoderReport = r;
    const short = v.mode === 'convert' ? 'Converted to H.264' : r.hardware ? 'Hardware decode' : r.hardware === false ? (/can't/i.test(r.label) ? "Can't decode" : 'Software decode') : r.label;
    if ($('#status-line').classList.contains('show')) this.flashStatus(`${this._statusBase} · ${short}`);
    this._refreshDetails();
  }

  _mediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: this.movie.title || this.movie.name });
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.video.pause());
    ms.setActionHandler('seekbackward', (d) => this.seek(this.video.currentTime - (d.seekOffset || 10)));
    ms.setActionHandler('seekforward', (d) => this.seek(this.video.currentTime + (d.seekOffset || 10)));
    ms.setActionHandler('seekto', (d) => this.seek(d.seekTime));
  }

  /* =============== saving =============== */

  _savePosition() {
    if (!this.movie || !this.key) return;
    const t = this.video.currentTime;
    if (!isFinite(t)) return;
    store.savePosition(this.key, t, this.movie.duration);
    if (this.lastSaved) store.updateLastMovie({ position: t, duration: this.movie.duration });
  }

  async _saveLast() {
    if (!this.movie || !this.roots || !this.roots.length) return;
    const m = this.movie;
    await store.saveLastMovie({
      roots: this.roots,
      videoPath: m.path,
      companionPaths: this.companionPaths,
      name: m.title || m.name,
      fileName: m.name,
      size: m.size,
      lastModified: m.lastModified,
      duration: m.duration,
      position: this.video.currentTime || 0,
      tracks: {
        audio: this._trackKey(m.audio, this.audioTrack),
        sub: this._trackKey(m.subs, this.userSub),
        sub2: this._trackKey(m.subs, this.subSecond),
      },
    });
    this.lastSaved = true;
  }

  async refreshContinue() {
    const rec = await store.loadLastMovie();
    const card = $('#continue');
    this.lastRecord = rec;
    if (!rec || !rec.roots || !rec.roots.length) { card.hidden = true; return; }
    card.hidden = false;
    $('#continue-title').textContent = rec.name;
    const pos = rec.position || 0;
    $('#continue-time').textContent = `${formatTime(pos, rec.duration >= 3600)} of ${formatTime(rec.duration, rec.duration >= 3600)}`;
    $('#continue-progress').style.width = rec.duration ? Math.min(100, (pos / rec.duration) * 100) + '%' : '0';
  }

  async reopenLast(fromStart) {
    const rec = this.lastRecord;
    if (!rec) return;
    let ok = false;
    try { ok = await requestAccess(rec.roots); } catch { ok = false; }
    if (!ok) { this.notices.show('Chrome needs permission to read the file again. Click Resume and choose Allow.'); return; }
    const token = ++this.loadToken;
    this.setState('loading');
    this.spinner('Finding the movie');
    let res;
    try {
      res = await expand(rec.roots);
    } catch {
      res = null;
    }
    if (token !== this.loadToken) return;
    const video = res && res.items.find((i) => i.path === rec.videoPath && i.kind === 'video');
    if (!video) {
      this.spinner(null);
      this.setState('empty');
      await store.clearLastMovie();
      this.refreshContinue();
      this.notices.show('Last movie not found at its previous location.');
      return;
    }
    const companions = res.items.filter((i) => rec.companionPaths.includes(i.path));
    const missing = rec.companionPaths.filter((p) => !res.items.some((i) => i.path === p));
    let resumeAt = fromStart ? 0 : rec.position || 0;
    const changed = video.size !== rec.size || video.lastModified !== rec.lastModified;
    await this.loadMovie(video, companions, { roots: rec.roots, resumeAt: changed ? 0 : resumeAt, restore: rec.tracks, token });
    if (changed) this.notices.show('The file has changed since last time, so it starts from the beginning.');
    if (missing.length) this.notices.show(`${missing.length} companion file${missing.length > 1 ? 's were' : ' was'} not found and skipped.`);
  }

  /* =============== layout =============== */

  _layout() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    const v = this.video;
    let ar = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : this.movie && this.movie.video ? (this.movie.video.displayWidth || 16) / (this.movie.video.displayHeight || 9) : 16 / 9;
    const forced = { '4:3': 4 / 3, '16:9': 16 / 9, '2.35:1': 2.35 }[this.aspect];
    if (forced) ar = forced;
    let w, h;
    if (this.aspect === 'stretch') { w = W; h = H; }
    else if (this.aspect === 'fill') { if (W / H > ar) { w = W; h = W / ar; } else { h = H; w = H * ar; } }
    else {
      if (W / H > ar) { h = H; w = H * ar; } else { w = W; h = W / ar; }
      if (this.aspect === 'zoom') { w *= 4 / 3; h *= 4 / 3; }
    }
    const x = (W - w) / 2, y = (H - h) / 2;
    Object.assign(v.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    const vis = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(W, x + w) - Math.max(0, x), h: Math.min(H, y + h) - Math.max(0, y) };
    const controls = $('#controls');
    const uiVisible = !this.root.classList.contains('hide-ui');
    const barTop = H - (uiVisible ? controls.offsetHeight - 24 : 0);
    const lift = uiVisible ? Math.max(0, vis.y + vis.h - barTop + 8) : 0;
    this.subs.layout({ x, y, w, h }, vis, lift);
  }

  setAspect(a) {
    this.aspect = a;
    this._layout();
  }

  /* =============== controls =============== */

  _bind() {
    const v = this.video;
    $('#open-file').addEventListener('click', () => this.openFile());
    $('#open-folder').addEventListener('click', () => this.openFolder());
    $('#continue-resume').addEventListener('click', () => this.reopenLast(false));
    $('#continue-restart').addEventListener('click', () => this.reopenLast(true));
    $('#continue-forget').addEventListener('click', async () => { await store.clearLastMovie(); this.refreshContinue(); });
    $('#big-play').addEventListener('click', () => this.play());
    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-mute').addEventListener('click', () => { v.muted = !v.muted; });
    $('#volume').addEventListener('input', (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; });
    $('#time').addEventListener('click', () => { this.showRemaining = !this.showRemaining; this._updateTime(); });
    $('#btn-info').addEventListener('click', () => this.toggleDetails());
    $('#details-close').addEventListener('click', () => this.toggleDetails(false));
    $('#details-copy').addEventListener('click', () => {
      navigator.clipboard.writeText($('#details-body').innerText).then(() => this.notices.show('Details copied', { level: 'info', duration: 2000 }));
    });
    $('#btn-pip').addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await v.requestPictureInPicture();
      } catch (e) { this.notices.show('Picture in picture is not available: ' + e.message); }
    });
    $('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      setIcon($('#btn-fullscreen'), document.fullscreenElement ? 'exit-fullscreen' : 'fullscreen');
      $('#btn-fullscreen').dataset.tip = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
      requestAnimationFrame(() => this._layout());
    });
    for (const b of document.querySelectorAll('[data-menu]')) {
      b.addEventListener('click', () => this.menu.toggle(b.dataset.menu, b, (m) => this._buildMenu(b.dataset.menu, m)));
    }
    this.menu.onClose = () => this._scheduleHide();
    $('#update-reload').addEventListener('click', () => this.onUpdateReload && this.onUpdateReload());

    // video events
    v.addEventListener('timeupdate', () => { this._updateTime(); this._checkWatchdog(); });
    v.addEventListener('durationchange', () => this._updateTime());
    v.addEventListener('progress', () => this._updateBuffered());
    v.addEventListener('loadedmetadata', () => this._layout());
    v.addEventListener('resize', () => this._layout());
    v.addEventListener('play', () => { this._updatePlayButton(); this._scheduleHide(); this._showBigPlay(false); });
    v.addEventListener('pause', () => { this._updatePlayButton(); this._showUi(); this._savePosition(); });
    v.addEventListener('ended', () => { this._updatePlayButton(); this._showUi(); store.savePosition(this.key, 0, this.movie?.duration); });
    v.addEventListener('waiting', () => {
      if (!this.movie) return;
      this._waitTimer = setTimeout(() => this.spinner(''), 350);
      // MPEG-2 conversion that can't keep up shows up as repeated stalls
      const info = this.engine && this.engine.info ? this.engine.info() : null;
      const speed = info && info.videoConversion ? info.videoConversion.speed : null;
      if (speed && speed < 1.05 && v.currentTime > 5) {
        this.notices.show(`This computer can't convert the ${this.movie.video.codecLabel} video fast enough for smooth playback (${speed.toFixed(2)}× real time). See the details panel.`, { key: 'slow' });
      }
    });
    for (const ev of ['playing', 'seeked', 'canplay', 'pause']) v.addEventListener(ev, () => { clearTimeout(this._waitTimer); if (this.movie) this.spinner(null); });
    v.addEventListener('seeking', () => this.subs.focus(v.currentTime));
    v.addEventListener('volumechange', () => {
      this._updateVolumeUi();
      this.prefs.volume = v.volume;
      this.prefs.muted = v.muted;
      store.savePrefs(this.prefs);
    });
    v.addEventListener('error', () => {
      if (!this.movie || !this.engine) return;
      const e = v.error;
      const msg = e ? (e.message || ['', 'aborted', 'network error', 'decode error', 'format not supported'][e.code]) : 'unknown error';
      this._videoFailed(msg);
    });
    v.addEventListener('enterpictureinpicture', () => $('#btn-pip').classList.add('active'));
    v.addEventListener('leavepictureinpicture', () => $('#btn-pip').classList.remove('active'));

    // clicking the picture toggles playback
    this.stage.addEventListener('click', (e) => {
      if (!this.movie || e.target.closest('button')) return;
      if (this.menu.openName) return;
      this.togglePlay();
    });

    // the space bar is the only keyboard shortcut
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (!$('#dialog').hidden) return;
      if (t && t.closest && (t.closest('input, select, textarea, [contenteditable]') || t.closest('#menu, #details, #empty'))) return;
      e.preventDefault();
      if (!e.repeat) this.togglePlay();
    });

    // auto-hide controls and cursor
    this.root.addEventListener('pointermove', () => this._showUi());
    this.root.addEventListener('pointerdown', () => this._showUi());
    $('#controls').addEventListener('pointerenter', () => { this.overControls = true; this._showUi(); });
    $('#controls').addEventListener('pointerleave', () => { this.overControls = false; this._scheduleHide(); });
    window.addEventListener('resize', () => this._layout());

    // drag and drop
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); depth++; $('#drop-hint').hidden = false; this.root.classList.add('dragging'); });
    window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { $('#drop-hint').hidden = true; this.root.classList.remove('dragging'); } });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      $('#drop-hint').hidden = true;
      this.root.classList.remove('dragging');
      const p = dropSources(e.dataTransfer);
      p.then((sources) => this.openSources(sources.filter(Boolean)));
    });

    // positions
    setInterval(() => { if (this.movie && !v.paused) this._savePosition(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this._savePosition(); });
    window.addEventListener('pagehide', () => this._savePosition());

    this._bindSeek();
    setInterval(() => { if (!$('#details').hidden) this._refreshDetails(); }, 1000);
  }

  _showUi() {
    this.root.classList.remove('hide-ui');
    if (this._uiHidden) { this._uiHidden = false; this._layout(); }
    this._scheduleHide();
  }

  _scheduleHide() {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      if (!this.movie || this.video.paused || this.menu.openName || this.overControls || this.seekDragging) return;
      this.root.classList.add('hide-ui');
      this._uiHidden = true;
      this._layout();
    }, 3000);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen().catch((e) => this.notices.show('Full screen is not available: ' + e.message));
  }

  toggleDetails(force) {
    const d = $('#details');
    const show = force === undefined ? d.hidden : force;
    d.hidden = !show;
    $('#btn-info').classList.toggle('active', show);
    if (show) this._refreshDetails();
  }

  _refreshDetails() {
    const d = $('#details');
    if (d.hidden) return;
    const body = $('#details-body');
    const scroll = body.scrollTop;
    const sel = window.getSelection();
    if (sel && sel.toString() && body.contains(sel.anchorNode)) return; // don't disturb a selection
    body.replaceChildren(...buildDetails(this));
    body.scrollTop = scroll;
  }

  _updatePlayButton() {
    const paused = this.video.paused;
    setIcon($('#btn-play'), paused ? 'play' : 'pause');
    $('#btn-play').setAttribute('aria-label', paused ? 'Play' : 'Pause');
    $('#btn-play').dataset.tip = (paused ? 'Play' : 'Pause') + ' (Space)';
  }

  _updateVolumeUi() {
    const v = this.video;
    const vol = v.muted ? 0 : v.volume;
    const r = $('#volume');
    r.value = vol;
    r.style.setProperty('--fill', vol * 100 + '%');
    setIcon($('#btn-mute'), vol === 0 ? 'mute' : 'volume');
    $('#btn-mute').dataset.tip = v.muted ? 'Unmute' : 'Mute';
  }

  _updateTime() {
    if (!this.movie) return;
    const d = this.movie.duration, t = this.seekDragging ? this.dragTime : this.video.currentTime;
    const long = d >= 3600;
    $('#time-cur').textContent = formatTime(t, long);
    $('#time-total').textContent = this.showRemaining ? '−' + formatTime(Math.max(0, d - t), long) : formatTime(d, long);
    const frac = d ? Math.min(1, t / d) : 0;
    $('#seek-played').style.width = frac * 100 + '%';
    $('#seek-thumb').style.left = frac * 100 + '%';
    this._updateBuffered();
  }

  _updateBuffered() {
    if (!this.movie) return;
    const b = this.video.buffered, t = this.video.currentTime, d = this.movie.duration;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > end) end = b.end(i);
    $('#seek-buffered').style.width = d ? Math.min(100, (end / d) * 100) + '%' : 0;
  }

  _renderChapters() {
    const c = $('#seek-chapters');
    c.replaceChildren();
    const m = this.movie;
    for (const ch of m.chapters) {
      if (ch.time <= 0.5 || ch.time >= m.duration) continue;
      c.append(el('span', { style: { left: (ch.time / m.duration) * 100 + '%' } }));
    }
  }

  _chapterAt(t) {
    const list = this.movie ? this.movie.chapters : [];
    let cur = null;
    for (const ch of list) if (ch.time <= t + 0.01) cur = ch;
    return cur;
  }

  _bindSeek() {
    const seek = $('#seek');
    const preview = $('#preview');
    const canvas = $('#preview-canvas');
    let lastReq = 0;
    const timeAt = (e) => {
      const r = seek.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      return { t: frac * (this.movie ? this.movie.duration : 0), x: e.clientX - r.left, w: r.width };
    };
    const show = (e) => {
      if (!this.movie) return;
      const { t, x, w } = timeAt(e);
      preview.hidden = false;
      const half = 86;
      preview.style.left = Math.max(half, Math.min(w - half, x)) + 'px';
      $('#preview-time').textContent = formatTime(t, this.movie.duration >= 3600);
      const ch = this._chapterAt(t);
      $('#preview-chapter').textContent = ch ? ch.title : '';
      if (this.thumbs && !this.thumbs.disabled) {
        const now = performance.now();
        if (now - lastReq > 90) {
          lastReq = now;
          this.thumbs.request(t).then((r) => {
            if (!r || preview.hidden) return;
            canvas.width = r.bitmap.width;
            canvas.height = r.bitmap.height;
            canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
            preview.classList.remove('no-thumb');
          });
        }
      } else preview.classList.add('no-thumb');
      if (this.seekDragging) { this.dragTime = t; this._updateTime(); }
    };
    seek.addEventListener('pointermove', show);
    seek.addEventListener('pointerenter', (e) => { preview.classList.toggle('no-thumb', !this.thumbs || this.thumbs.disabled); show(e); });
    seek.addEventListener('pointerleave', () => { if (!this.seekDragging) preview.hidden = true; });
    seek.addEventListener('pointerdown', (e) => {
      if (!this.movie || e.button !== 0) return;
      seek.setPointerCapture(e.pointerId);
      this.seekDragging = true;
      seek.classList.add('dragging');
      show(e);
    });
    const end = (e) => {
      if (!this.seekDragging) return;
      this.seekDragging = false;
      seek.classList.remove('dragging');
      const { t } = timeAt(e);
      this.seek(t);
      if (!seek.matches(':hover')) preview.hidden = true;
    };
    seek.addEventListener('pointerup', end);
    seek.addEventListener('pointercancel', () => { this.seekDragging = false; seek.classList.remove('dragging'); preview.hidden = true; });
  }

  /* =============== menus =============== */

  _buildMenu(name, m) {
    const mv = this.movie;
    if (!mv && name !== 'more') { m.hint('No movie loaded'); return; }
    if (name === 'audio') {
      m.heading('Audio');
      if (!mv.audio.length) m.hint('This movie has no audio tracks.');
      for (const t of mv.audio) {
        const bad = t.mode === 'unsupported' || t.status === 'failed';
        const sub = audioMeta(t) + (t.mode === 'convert' ? ' (converted)' : '') + (t.source === 'external' ? ' · external file' : '');
        m.item({
          label: trackTitle(t), sub: bad ? (t.failReason ? 'Failed: ' + t.failReason : t.reason) : sub,
          selected: t === this.audioTrack, disabled: bad, title: bad ? (t.failReason || t.reason) : null,
          onClick: () => this.selectAudio(t),
        });
      }
    } else if (name === 'subs') this._buildSubsMenu(m);
    else if (name === 'chapters') {
      m.heading('Chapters');
      const cur = this._chapterAt(this.video.currentTime);
      for (const ch of mv.chapters) {
        m.item({ label: ch.title || 'Chapter', aside: formatTime(ch.time, mv.duration >= 3600), selected: ch === cur, onClick: () => this.seek(ch.time) });
      }
    } else if (name === 'speed') {
      m.heading('Speed');
      for (const s of SPEEDS) m.item({ label: s === 1 ? 'Normal' : s + '×', selected: (this.speed || 1) === s, onClick: () => this.setSpeed(s) });
    } else if (name === 'aspect') {
      m.heading('Picture');
      for (const [k, label, sub] of ASPECTS) m.item({ label, sub, selected: this.aspect === k, onClick: () => this.setAspect(k) });
      m.hint('Applies to this movie only.');
    } else if (name === 'more') {
      m.item({ label: 'Open another movie…', onClick: () => this.openFile() });
      m.item({ label: 'Open folder…', onClick: () => this.openFolder() });
      if (mv) m.item({ label: 'Close movie', onClick: () => this.closeMovie() });
      m.separator();
      m.item({
        label: 'Clear history', sub: 'Forget saved positions and the last movie',
        onClick: async () => { store.clearPositions(); await store.clearLastMovie(); this.lastSaved = false; this.roots = []; this.notices.show('History cleared', { level: 'info', duration: 3000 }); },
      });
      m.item({ label: 'Help', onClick: () => window.open('help.html', '_blank', 'noopener') });
    }
  }

  _buildSubsMenu(m) {
    const mv = this.movie;
    const label = (t) => trackTitle(t);
    const meta = (t) => [t.formatLabel, t.forced ? 'Forced' : null, t.sdh ? 'SDH' : null, t.source === 'external' ? 'external' : null].filter(Boolean).join(' · ');
    m.heading('Subtitles');
    m.item({ label: 'Off', sub: this.autoForced ? `Forced ${languageName(this.autoForced.lang) || ''} subtitles shown` : null, selected: !this.userSub, onClick: () => this.selectSub(null) });
    for (const t of mv.subs) {
      const bad = t.status === 'unsupported' || t.status === 'failed';
      m.item({ label: label(t), sub: bad ? t.reason : meta(t), selected: t === this.userSub, disabled: bad, title: bad ? t.reason : null, onClick: () => this.selectSub(t) });
    }
    if (!mv.subs.length) m.hint('No subtitles. Drop .srt, .ass, .sup or .idx/.sub files onto the player to add some.');
    if (mv.subs.length) {
      m.heading('Second subtitles');
      m.item({ label: 'Off', selected: !this.subSecond, onClick: () => this.selectSub2(null) });
      for (const t of mv.subs) {
        const ok = SubtitleManager.canBeSecond(t) && t.status !== 'failed';
        m.item({
          label: label(t), sub: ok ? meta(t) + (t.format === 'ass' ? ' · as plain text' : '') : 'Only SRT, VTT or ASS can be the second track',
          selected: t === this.subSecond, disabled: !ok || t === this.subMain, onClick: () => this.selectSub2(t),
        });
      }
    }
    const fmt = (s) => (s > 0 ? '+' : s < 0 ? '−' : '') + Math.abs(s).toFixed(1) + ' s';
    if (this.subMain || this.subSecond) {
      m.separator();
      m.heading('Timing');
      if (this.subMain) {
        const d = this.subs.getDelay(this.subMain);
        m.row('Delay', m.stepper(fmt(d), () => this.subs.setDelay(this.subMain, d - 0.1), () => this.subs.setDelay(this.subMain, d + 0.1), 'Subtitle delay'));
      }
      if (this.subSecond) {
        const d2 = this.subs.getDelay(this.subSecond);
        m.row('Second delay', m.stepper(fmt(d2), () => this.subs.setDelay(this.subSecond, d2 - 0.1), () => this.subs.setDelay(this.subSecond, d2 + 0.1), 'Second subtitle delay'));
      }
    }
    m.separator();
    m.heading('Style');
    const st = this.prefs.subStyle;
    const save = () => { store.savePrefs(this.prefs); this.subs.setStyle(this.prefs.subStyle); };
    m.row('Text size', m.select(SIZES, String(st.size), (v) => { st.size = +v; save(); }, 'Text size'));
    m.row('Text colour', m.select(COLORS, st.color, (v) => { st.color = v; save(); }, 'Text colour'));
    m.row('Background', m.select(BACKGROUNDS, st.background, (v) => { st.background = v; save(); }, 'Background'));
    m.row('Outline', m.switch(st.outline, (on) => { st.outline = on; save(); }, 'Outline'));
    m.row('ASS, PGS, VobSub scale', m.select(SCALES, String(this.prefs.subScale), (v) => {
      this.prefs.subScale = +v; store.savePrefs(this.prefs); this.subs.setScale(+v);
    }, 'Scale'));
    m.row('Use installed fonts for ASS', m.switch(this.prefs.localFonts, (on) => {
      this.prefs.localFonts = on; store.savePrefs(this.prefs); this.subs.setLocalFonts(on);
    }, 'Use installed fonts'));
    m.hint('Text size, colour, background and outline apply to SRT and VTT.');
  }

  setSpeed(s) {
    this.speed = s;
    this.video.playbackRate = s;
    $('#speed-label').textContent = s === 1 ? '1×' : s + '×';
  }
}
