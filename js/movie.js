// Probes the chosen video and its companion files and builds the "movie" model the rest of the
// app works from: tracks, how each one will be played (native / convert / unsupported), chapters,
// fonts, and whether Chrome can play the file directly.

import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from '../lib/mediabunny/mediabunny.min.mjs';
import { MkvFile, readMp4Chapters } from './demux/mkv.js';
import { probeMpeg, MpegStreamReader } from './demux/mpeg.js';
import { normalizeLang, parseCompanionTags, extension, baseName, UNSUPPORTED_VIDEO } from './names.js';

export class MovieError extends Error {
  constructor(title, detail, fix = null) {
    super(title);
    this.title = title;
    this.detail = detail;
    this.fix = fix;
  }
}

const AUDIO_LABEL = {
  aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC3', eac3: 'E-AC3', dts: 'DTS', truehd: 'TrueHD',
  mp2: 'MP2', mp1: 'MP1', pcm_dvd: 'LPCM', pcm_bluray: 'LPCM', aac_latm: 'AAC (LATM)', alac: 'ALAC',
};
const FFMPEG_AUDIO = { ac3: 'ac3', eac3: 'eac3', dts: 'dca', truehd: 'truehd', mp1: 'mp1', mp2: 'mp2', mp3: 'mp3', aac: 'aac',
  pcm_dvd: 'pcm_dvd', pcm_bluray: 'pcm_bluray' };
const VIDEO_LABEL = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1',
  prores: 'ProRes', h264: 'H.264', vc1: 'VC-1', mpeg4: 'MPEG-4 Part 2 (DivX/Xvid)', vfw: 'Video for Windows (VC-1, DivX or similar)',
  theora: 'Theora', real: 'RealVideo', mp4v: 'MPEG-4 Part 2 (DivX/Xvid)', wmv: 'Windows Media Video' };
const MKV_VIDEO_IDS = {
  V_MPEG2: 'mpeg2video', V_MPEG1: 'mpeg1video', 'V_MPEG4/ISO/ASP': 'mpeg4', 'V_MPEG4/ISO/SP': 'mpeg4', 'V_MPEG4/ISO/AP': 'mpeg4',
  'V_MS/VFW/FOURCC': 'vfw', V_REAL: 'real', V_THEORA: 'theora', 'V_MPEGH/ISO/HEVC': 'hevc',
};
const MKV_SUBS = {
  'S_TEXT/UTF8': 'srt', 'S_TEXT/ASCII': 'srt', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ass', S_ASS: 'ass', S_SSA: 'ass',
  'S_TEXT/WEBVTT': 'vtt', 'S_HDMV/PGS': 'pgs', S_VOBSUB: 'vobsub',
};
const SUB_LABEL = { srt: 'SRT', vtt: 'WebVTT', ass: 'ASS', pgs: 'PGS', vobsub: 'VobSub' };

function mse(mime) {
  try { return MediaSource.isTypeSupported(mime); } catch { return false; }
}

/** Describes a video codec string: profile, level, bit depth. */
export function describeVideoCodec(codec, codecString) {
  const out = { profile: null, level: null, bitDepth: 8 };
  if (!codecString) return out;
  const p = codecString.split('.');
  if (codec === 'avc' && p[1]) {
    const prof = parseInt(p[1].slice(0, 2), 16), lvl = parseInt(p[1].slice(4, 6), 16);
    out.profile = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' }[prof] || 'Profile ' + prof;
    out.level = (lvl / 10).toFixed(1);
    if (prof === 110 || prof === 122 || prof === 244) out.bitDepth = 10;
  } else if (codec === 'hevc' && p[1]) {
    const prof = parseInt(p[1].replace(/\D/g, ''), 10);
    out.profile = { 1: 'Main', 2: 'Main 10', 3: 'Main Still', 4: 'Range extensions' }[prof] || 'Profile ' + prof;
    const l = p.find((x) => /^[LH]\d+$/.test(x));
    if (l) out.level = (parseInt(l.slice(1), 10) / 30).toFixed(1);
    if (prof === 2) out.bitDepth = 10;
  } else if (codec === 'av1' && p[1]) {
    out.profile = { 0: 'Main', 1: 'High', 2: 'Professional' }[parseInt(p[1], 10)] || null;
    out.bitDepth = parseInt(p[3], 10) || 8;
  } else if (codec === 'vp9' && p[1]) {
    out.profile = 'Profile ' + parseInt(p[1], 10);
    out.bitDepth = parseInt(p[3], 10) || 8;
  }
  return out;
}

async function pickEncoderCodec(width, height, fps) {
  const sd = width * height <= 720 * 576;
  const candidates = sd ? ['avc1.64001f', 'avc1.4d401f', 'avc1.42e01f'] : ['avc1.640028', 'avc1.4d4028', 'avc1.42e028', 'avc1.640032'];
  for (const codec of candidates) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: sd ? 6e6 : 14e6, framerate: fps || 25, avc: { format: 'avc' } });
      if (r.supported && mse(`video/mp4; codecs="${codec}"`)) return codec;
    } catch { /* try next */ }
  }
  return null;
}

/* ---------------- audio track descriptions ---------------- */

function audioMode(t) {
  // decides how an audio track is played
  const c = t.codec;
  if (c === 'aac' && t.mb) {
    if (mse(`audio/mp4; codecs="${t.codecString || 'mp4a.40.2'}"`)) return { mode: 'native' };
  }
  if (c === 'opus' && t.mb && mse('audio/mp4; codecs="opus"')) return { mode: 'native' };
  if (c === 'mp3' && t.mb && mse('audio/mp4; codecs="mp4a.6B"')) return { mode: 'native' };
  if (c === 'flac' && t.mb && mse('audio/mp4; codecs="flac"')) return { mode: 'native' };
  if (FFMPEG_AUDIO[c]) {
    return { mode: 'convert', convertSpec: { backend: 'wasm', codec: FFMPEG_AUDIO[c], extradata: t.description || null,
      sampleRate: t.sampleRate || 0, channels: t.channels || 0, useParser: !t.mb } };
  }
  if (c === 'vorbis') {
    return { mode: 'convert', convertSpec: { backend: 'webcodecs', wcCodec: 'vorbis', extradata: t.description, sampleRate: t.sampleRate, channels: t.channels } };
  }
  if (c && c.startsWith('pcm-') && c !== 'pcm-u8' && c !== 'pcm-s8') {
    return { mode: 'convert', convertSpec: { backend: 'pcm', pcmFormat: c, sampleRate: t.sampleRate, channels: t.channels } };
  }
  return { mode: 'unsupported', reason: `${t.codecLabel || 'This audio format'} is not supported` };
}

function finishAudio(t) {
  t.codecLabel = t.codecLabel || AUDIO_LABEL[t.codec] || (t.codec ? t.codec.toUpperCase() : 'Unknown');
  Object.assign(t, audioMode(t));
  t.status = t.mode === 'unsupported' ? 'unsupported' : 'ok';
  return t;
}

async function mbAudioTrack(track, extra = {}) {
  const codec = await track.getCodec();
  const cfg = await track.getDecoderConfig().catch(() => null);
  let c = codec;
  if (!c) {
    const internal = String(await track.getInternalCodecId());
    if (/A_MPEG\/L2|^4$|^3$/.test(internal)) c = 'mp2';
    else if (/A_MPEG\/L1/.test(internal)) c = 'mp1';
    else c = null;
  }
  const t = {
    mb: track,
    codec: c,
    codecString: await track.getCodecParameterString().catch(() => null),
    channels: await track.getNumberOfChannels(),
    sampleRate: await track.getSampleRate(),
    lang: normalizeLang(await track.getLanguageCode()),
    name: await track.getName(),
    bitrate: await track.getAverageBitrate().catch(() => null),
    description: cfg && cfg.description ? new Uint8Array(cfg.description.buffer ? cfg.description.buffer.slice(cfg.description.byteOffset || 0, (cfg.description.byteOffset || 0) + cfg.description.byteLength) : cfg.description) : null,
    ...extra,
  };
  const d = await track.getDisposition();
  t.default = d.default;
  t.forced = d.forced;
  t.commentary = d.commentary;
  t.sdh = d.hearingImpaired;
  if (c === 'mp3') {
    // MPEG audio labelled as MP3 can really be layer II (common in TV recordings)
    const p = await new EncodedPacketSink(track).getFirstPacket().catch(() => null);
    if (p && p.data.length > 2 && p.data[0] === 0xff) {
      const layer = 4 - ((p.data[1] >> 1) & 3);
      if (layer !== 3) t.codec = 'mp' + layer;
    }
  }
  return t;
}

/* ---------------- main ---------------- */

/**
 * Builds the movie. `video` and `companions` are intake items.
 * codec: CodecClient (used to probe streams the browser can't read itself).
 */
export async function buildMovie(video, companions, codec, onProgress = () => {}) {
  const ext = extension(video.name);
  if (UNSUPPORTED_VIDEO.has(ext)) {
    throw new MovieError(`${ext.toUpperCase()} files are not supported`, `${video.name} uses the ${ext.toUpperCase()} container, which this player cannot read.`,
      'remux');
  }
  if (video.problem) throw new MovieError("This video can't be played", video.problem, video.problem.includes('zip') ? 'zip' : null);
  const blob = await video.getBlob();
  const movie = {
    name: video.name, path: video.path, size: blob.size, lastModified: video.lastModified, item: video, blob,
    source: video.source, zipName: video.zipName || null,
    video: null, audio: [], subs: [], chapters: [], fonts: [], ignored: [], origin: 0, duration: 0,
  };
  onProgress('Reading the file');

  // MPEG program/transport streams: decide between Mediabunny (H.264/HEVC in TS) and our demuxer
  let mpeg = null;
  if (['mpg', 'mpeg', 'vob', 'ts', 'm2ts', 'mts', 'm2t', 'm2v'].includes(ext)) {
    mpeg = await probeMpeg(blob, video.name).catch(() => null);
    if (mpeg && mpeg.kind === 'ts') {
      const v = mpeg.streams.find((s) => s.kind === 'video');
      if (v && (v.codec === 'h264' || v.codec === 'hevc')) mpeg.useMediabunny = true;
    }
  }

  if (mpeg && !mpeg.useMediabunny) await fromMpeg(movie, mpeg, codec);
  else await fromMediabunny(movie, blob, mpeg, codec);

  if (!movie.video) {
    throw new MovieError('No video track found', `${video.name} has no video track this player can find.`);
  }
  onProgress('Reading companion files');
  await addCompanions(movie, companions, codec);

  // number and label tracks
  movie.audio.forEach((t, i) => { t.id = 'a' + (i + 1); t.number = i + 1; });
  movie.subs.forEach((t, i) => { t.id = 's' + (i + 1); t.number = i + 1; });

  // direct play or remux?
  const reasons = [];
  const playable = movie.audio.filter((a) => a.mode !== 'unsupported');
  if (!['MP4', 'QuickTime', 'WebM'].includes(movie.container)) reasons.push(`${movie.containerLabel} container`);
  if (movie.video.mode === 'convert') reasons.push(`${movie.video.codecLabel} video needs converting`);
  if (movie.audio.filter((a) => a.source === 'embedded').length > 1) reasons.push(`${movie.audio.length} audio tracks`);
  if (movie.audio.some((a) => a.source === 'external')) reasons.push('external audio');
  const conv = movie.audio.find((a) => a.mode === 'convert');
  if (conv) reasons.push(`${conv.codecLabel} audio needs converting`);
  movie.direct = !reasons.length && movie.video.mode === 'native' && playable.length <= 1 && canPlayDirect(movie);
  if (movie.video.directOnly) {
    movie.direct = true;
    if (reasons.length) movie.ignored.push({ name: 'Audio tracks', reason: 'This video can only be played directly, so only the first audio track is available' });
  }
  if (!movie.direct && !reasons.length) reasons.push('Chrome cannot play this file as is');
  movie.remuxReason = reasons.join(', ');
  movie.overallBitrate = movie.duration ? (movie.size * 8) / movie.duration : null;
  return movie;
}

function canPlayDirect(movie) {
  const v = document.createElement('video');
  const a = movie.audio[0];
  const codecs = [movie.video.codecString, a && a.codecString].filter(Boolean).join(', ');
  const type = movie.container === 'WebM' ? 'video/webm' : 'video/mp4';
  return v.canPlayType(`${type}; codecs="${codecs}"`) !== '';
}

async function fromMediabunny(movie, blob, mpeg, codec) {
  let input;
  try {
    input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const fmt = await input.getFormat();
    movie.container = fmt.name === 'Matroska' && /\.webm$/i.test(movie.name) ? 'WebM' : fmt.name;
  } catch (e) {
    throw new MovieError("This file's container isn't recognised", `${movie.name} is not a format this player can read (${e.message}).`, 'remux');
  }
  movie.mb = input;
  movie.containerLabel = { Matroska: 'MKV', 'MPEG Transport Stream': 'MPEG-TS', QuickTime: 'MOV' }[movie.container] || movie.container;
  const isMkv = movie.container === 'Matroska' || movie.container === 'WebM';
  let mkv = null;
  if (isMkv) {
    mkv = await MkvFile.open(blob).catch(() => null);
    movie.mkv = mkv;
    if (mkv) movie.title = mkv.title || null;
  }
  const tracks = await input.getTracks();
  const videoTracks = tracks.filter((t) => t.isVideoTrack());
  const vt = (await input.getPrimaryVideoTrack()) || videoTracks[0];
  if (vt) {
    let c = await vt.getCodec();
    let internal = String(await vt.getInternalCodecId());
    if (!c && MKV_VIDEO_IDS[internal]) c = MKV_VIDEO_IDS[internal];
    if (!c && internal === 'mp4v') c = 'mpeg4';
    const codecString = await vt.getCodecParameterString().catch(() => null);
    const cfg = await vt.getDecoderConfig().catch(() => null);
    const stats = await vt.computePacketStats(120).catch(() => null);
    const v = {
      mb: vt, codec: c, codecString, codecLabel: VIDEO_LABEL[c] || (internal ? internal.replace(/^V_/, '') : 'Unknown'),
      codedWidth: await vt.getCodedWidth(), codedHeight: await vt.getCodedHeight(),
      displayWidth: await vt.getDisplayWidth(), displayHeight: await vt.getDisplayHeight(),
      fps: stats ? stats.averagePacketRate : null, bitrate: stats ? stats.averageBitrate : null,
      hdr: await vt.hasHighDynamicRange().catch(() => false), colorSpace: await vt.getColorSpace().catch(() => null),
      description: cfg && cfg.description ? toU8(cfg.description) : null,
    };
    const par = await vt.getPixelAspectRatio().catch(() => null);
    v.sar = par && par.num && par.den ? [par.num, par.den] : [1, 1];
    Object.assign(v, describeVideoCodec(c, codecString));
    v.fourcc = codecString ? codecString.slice(0, 4) : null;
    if (v.fourcc === 'avc3') v.fourcc = 'avc1';
    if (v.fourcc === 'hev1' && v.description) v.fourcc = 'hvc1';
    if (['avc', 'hevc', 'vp9', 'av1', 'vp8'].includes(c)) {
      const mime = `video/mp4; codecs="${codecString}"`;
      if (mse(mime)) {
        v.mode = 'native';
      } else if (['MP4', 'QuickTime', 'WebM'].includes(movie.container) && document.createElement('video').canPlayType(
        `${movie.container === 'WebM' ? 'video/webm' : 'video/mp4'}; codecs="${codecString}"`)) {
        // Chrome plays it from the file but not through MSE (e.g. VP8): direct play only
        v.mode = 'native';
        v.directOnly = true;
      } else {
        v.mode = 'unsupported';
        v.reason = c === 'hevc'
          ? "This HEVC video can't be played: Chrome only decodes HEVC with a hardware decoder, and none is available for this profile."
          : `Chrome can't decode this ${v.codecLabel} video (${codecString}).`;
      }
    } else if (c === 'mpeg2video' || c === 'mpeg1video') {
      v.mode = 'convert';
      const mkvTrack = mkv && mkv.tracks.find((t) => t.number === vt.id);
      v.extradata = mkvTrack && mkvTrack.codecPrivate ? mkvTrack.codecPrivate : null;
      const probe = await probeMpegVideoPackets(vt, v.extradata, c, codec);
      if (probe) Object.assign(v, { interlaced: probe.interlaced, fps: probe.fps || v.fps, sar: probe.sar && probe.sar[0] ? probe.sar : v.sar,
        codedWidth: probe.width, codedHeight: probe.height });
      v.profile = c === 'mpeg2video' ? 'Main' : null;
      await setConvertSpec(v, false);
    } else {
      v.mode = 'unsupported';
      v.reason = `${v.codecLabel} video is not supported. Convert it to H.264 with HandBrake or ffmpeg.`;
    }
    if (v.mode === 'unsupported') {
      throw new MovieError("This video's codec can't be played", v.reason, 'convert');
    }
    movie.video = v;
  }

  // timeline origin: zero for MP4/MKV; the first video timestamp for transport streams
  const firstTs = vt ? await vt.getFirstTimestamp().catch(() => 0) : 0;
  movie.origin = movie.container === 'MPEG Transport Stream' ? firstTs : 0;
  const av = tracks.filter((t) => t.isVideoTrack() || t.isAudioTrack());
  let end = await input.computeDuration(vt ? [vt] : av).catch(() => null);
  if (!end) end = await input.getDurationFromMetadata().catch(() => null);
  movie.duration = Math.max(0.1, (end || 0) - movie.origin);

  // audio tracks
  const mkvByNum = new Map(mkv ? mkv.tracks.map((t) => [t.number, t]) : []);
  for (const at of tracks.filter((t) => t.isAudioTrack())) {
    const t = await mbAudioTrack(at, { source: 'embedded', origin: movie.origin });
    const mt = mkvByNum.get(at.id);
    if (mt) {
      t.lang = normalizeLang(mt.bcp47 || mt.language) || t.lang;
      t.name = mt.name || t.name;
      t.default = mt.default; t.forced = mt.forced; t.commentary = mt.commentary || t.commentary; t.sdh = mt.hearingImpaired || t.sdh;
      if (mt.codecId === 'A_MPEG/L2') t.codec = 'mp2';
      if (mt.codecId === 'A_MPEG/L1') t.codec = 'mp1';
    }
    if (mpeg) {
      const s = mpeg.streams.find((x) => x.pid === at.id);
      if (s && s.lang) t.lang = normalizeLang(s.lang);
    }
    movie.audio.push(finishAudio(t));
  }
  // transport stream audio that Mediabunny doesn't read: use our own demuxer for it
  if (mpeg && mpeg.useMediabunny) {
    for (const s of mpeg.streams.filter((x) => x.kind === 'audio')) {
      if (tracks.some((t) => t.id === s.pid)) continue;
      const t = await mpegAudioTrack(movie, mpeg, s, codec, firstTs);
      if (t) movie.audio.push(t);
    }
    for (const s of mpeg.streams.filter((x) => x.kind === 'sub')) {
      movie.ignored.push({ name: `Subtitle stream ${s.pid}`, reason: `${s.codec === 'pgs' ? 'PGS' : s.codec === 'dvbsub' ? 'DVB' : 'Teletext'} subtitles in transport streams are not supported` });
    }
  }

  // subtitles, chapters and fonts from MKV
  if (mkv) {
    for (const st of mkv.tracks.filter((t) => t.type === 17)) {
      const format = MKV_SUBS[st.codecId];
      const sub = {
        source: 'embedded', lang: normalizeLang(st.bcp47 || st.language), name: st.name, forced: st.forced, default: st.default,
        sdh: st.hearingImpaired, format, formatLabel: SUB_LABEL[format] || st.codecId.replace(/^S_/, ''),
        embedded: { type: 'mkv', number: st.number, codecId: st.codecId, codecPrivate: st.codecPrivate, track: st },
      };
      if (!format) { sub.status = 'unsupported'; sub.reason = `${sub.formatLabel} subtitles are not supported`; } else sub.status = 'ok';
      movie.subs.push(sub);
    }
    movie.chapters = mkv.chapters;
    for (const a of mkv.attachments) {
      if (/font|truetype|opentype|sfnt/i.test(a.mime) || /\.(ttf|otf|ttc|woff2?)$/i.test(a.name)) movie.fonts.push({ name: a.name, source: 'attachment', read: a.read });
    }
  } else if (movie.container === 'MP4' || movie.container === 'QuickTime') {
    movie.chapters = await readMp4Chapters(blob).catch(() => []);
  }
}

function toU8(d) {
  if (d instanceof Uint8Array) return d.slice();
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  return new Uint8Array(d.slice(0));
}

async function probeMpegVideoPackets(track, extradata, c, codec) {
  try {
    const sink = new EncodedPacketSink(track);
    let p = await sink.getFirstPacket();
    const parts = [];
    let size = 0;
    while (p && size < 600000) { parts.push(p.data); size += p.data.length; p = await sink.getNextPacket(p); }
    const sample = new Uint8Array(size);
    let o = 0;
    for (const x of parts) { sample.set(x, o); o += x.length; }
    const r = await codec.probe('video', c, sample, { extradata, useParser: true });
    return r && r.ok ? r : null;
  } catch {
    return null;
  }
}

async function setConvertSpec(v) {
  const enc = await pickEncoderCodec(v.codedWidth, v.codedHeight, v.fps);
  if (!enc) {
    v.mode = 'unsupported';
    v.reason = "This browser can't encode H.264, which is needed to play MPEG-2 video.";
    throw new MovieError("MPEG-2 video can't be converted here", v.reason, 'convert');
  }
  const sd = v.codedWidth * v.codedHeight <= 720 * 576;
  v.convertSpec = {
    codec: v.codec, extradata: v.extradata || null, useParser: !v.mb, encoderCodec: enc,
    bitrate: sd ? 6e6 : 14e6, framerate: v.fps || 25, hardware: 'no-preference',
  };
}

async function fromMpeg(movie, mpeg, codec) {
  movie.mpeg = mpeg;
  movie.container = mpeg.kind === 'ts' ? 'MPEG Transport Stream' : mpeg.kind === 'ps' ? 'MPEG Program Stream' : 'Raw audio';
  movie.containerLabel = mpeg.kind === 'ts' ? 'MPEG-TS' : 'MPEG-PS';
  movie.origin = mpeg.firstPts;
  movie.duration = mpeg.duration;
  const blob = movie.blob;
  const vs = mpeg.streams.find((s) => s.kind === 'video');
  if (vs) {
    const v = { codec: vs.codec, codecLabel: VIDEO_LABEL[vs.codec] || vs.codec, makeReader: () => new MpegStreamReader(blob, mpeg, vs.key), key: vs.key };
    if (vs.codec !== 'mpeg2video' && vs.codec !== 'mpeg1video') {
      throw new MovieError("This video's codec can't be played", `${v.codecLabel} video in an MPEG stream is not supported.`, 'convert');
    }
    const r = await codec.probe('video', vs.codec, vs.sample, { useParser: true }).catch(() => null);
    if (!r || !r.ok) throw new MovieError("This video can't be decoded", `The ${v.codecLabel} video stream could not be read (${r ? r.error : 'probe failed'}).`);
    Object.assign(v, {
      codedWidth: r.width, codedHeight: r.height, sar: r.sar && r.sar[0] > 0 ? r.sar : [1, 1], fps: r.fps, interlaced: r.interlaced,
      profile: vs.codec === 'mpeg2video' ? 'Main' : null, bitDepth: 8,
    });
    v.displayWidth = Math.round((v.codedWidth * v.sar[0]) / v.sar[1]);
    v.displayHeight = v.codedHeight;
    v.mode = 'convert';
    await setConvertSpec(v);
    movie.video = v;
  }
  for (const s of mpeg.streams.filter((x) => x.kind === 'audio')) {
    const t = await mpegAudioTrack(movie, mpeg, s, codec, mpeg.firstPts);
    if (t) movie.audio.push(t);
  }
  let subIndex = 0;
  for (const s of mpeg.streams.filter((x) => x.kind === 'sub')) {
    if (s.codec === 'dvdsub') {
      movie.subs.push({
        source: 'embedded', lang: normalizeLang(s.lang), name: `Subtitle ${++subIndex}`, format: 'vobsub', formatLabel: 'VobSub', status: 'ok',
        embedded: { type: 'mpeg', key: s.key }, noPalette: true,
      });
    } else {
      movie.ignored.push({ name: `Subtitle stream ${s.pid || s.key}`, reason: `${s.codec === 'pgs' ? 'PGS' : s.codec === 'dvbsub' ? 'DVB' : 'Teletext'} subtitles in transport streams are not supported` });
    }
  }
}

async function mpegAudioTrack(movie, mpeg, s, codec, origin) {
  const blob = mpeg.blob || movie.blob;
  const t = {
    source: 'embedded', codec: s.codec === 'dca' ? 'dts' : s.codec, lang: normalizeLang(s.lang), name: null,
    makeReader: () => new MpegStreamReader(blob, mpeg, s.key), origin, key: s.key, default: false,
  };
  if (s.codec === 'aac_latm') return finishAudio(t);
  const ff = FFMPEG_AUDIO[t.codec];
  if (ff && s.sample && s.sample.length) {
    const r = await codec.probe('audio', ff, s.sample, { useParser: s.codec !== 'pcm_dvd' && s.codec !== 'pcm_bluray' }).catch(() => null);
    if (r && r.ok) { t.channels = r.channels; t.sampleRate = r.sampleRate; }
  }
  finishAudio(t);
  if (t.convertSpec) t.convertSpec.useParser = !['pcm_dvd', 'pcm_bluray'].includes(t.codec);
  return t;
}

/* ---------------- companion files ---------------- */

/** Adds companion files to a loaded movie (files dropped while it plays). */
export async function addCompanionItems(movie, items, codec) {
  const a = movie.audio.length, s = movie.subs.length;
  await addCompanions(movie, items, codec);
  movie.audio.slice(a).forEach((t, i) => { t.id = 'a' + (a + i + 1); t.number = a + i + 1; });
  movie.subs.slice(s).forEach((t, i) => { t.id = 's' + (s + i + 1); t.number = s + i + 1; });
}

async function addCompanions(movie, companions, codec) {
  const vbase = baseName(movie.name);
  const subFiles = companions.filter((c) => c.kind === 'sub');
  const idxNames = new Set(subFiles.filter((c) => extension(c.name) === 'idx').map((c) => baseName(c.name).toLowerCase()));
  for (const item of companions) {
    const tags = parseCompanionTags(item.name, vbase);
    if (item.problem) { movie.ignored.push({ name: item.name, reason: item.problem }); continue; }
    if (item.kind === 'font') {
      movie.fonts.push({ name: item.name, source: 'file', read: async () => new Uint8Array(await (await item.getBlob()).arrayBuffer()) });
    } else if (item.kind === 'audio') {
      const tracks = await externalAudio(item, tags, codec).catch((e) => {
        movie.ignored.push({ name: item.name, reason: 'Could not read this audio file: ' + e.message });
        return [];
      });
      movie.audio.push(...tracks);
    } else if (item.kind === 'sub') {
      const e = extension(item.name);
      if (e === 'sub' && idxNames.has(baseName(item.name).toLowerCase())) continue; // handled with its .idx
      const sub = {
        source: 'external', fileName: item.name, lang: tags.lang, forced: tags.forced, sdh: tags.sdh, default: tags.default,
        name: tags.extra.length ? tags.extra.join(' ') : null, item, status: 'ok',
      };
      if (e === 'srt') { sub.format = 'srt'; }
      else if (e === 'vtt') sub.format = 'vtt';
      else if (e === 'ass' || e === 'ssa') sub.format = 'ass';
      else if (e === 'sup') sub.format = 'pgs';
      else if (e === 'idx') {
        sub.format = 'vobsub';
        const subItem = subFiles.find((c) => extension(c.name) === 'sub' && baseName(c.name).toLowerCase() === baseName(item.name).toLowerCase());
        if (!subItem) { movie.ignored.push({ name: item.name, reason: 'its .sub file is missing' }); continue; }
        sub.subItem = subItem;
        // one track per language listed in the .idx
        const text = await (await item.getBlob()).text();
        const ids = [...text.matchAll(/^id:\s*([a-z]{2,3}|--)?\s*,\s*index:\s*(\d+)/gim)];
        if (ids.length > 1) {
          for (const m of ids) {
            movie.subs.push({ ...sub, idxIndex: +m[2], lang: normalizeLang(m[1]) || sub.lang, formatLabel: 'VobSub' });
          }
          continue;
        }
        sub.idxIndex = ids.length ? +ids[0][2] : 0;
        if (ids.length && ids[0][1] && ids[0][1] !== '--') sub.lang = normalizeLang(ids[0][1]) || sub.lang;
      } else if (e === 'sub') {
        const head = new Uint8Array(await (await item.getBlob()).slice(0, 4).arrayBuffer());
        if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0xba) {
          sub.format = 'vobsub';
          sub.subItem = item;
          sub.idxIndex = 0;
          sub.noPalette = true;
        } else {
          movie.ignored.push({ name: item.name, reason: 'MicroDVD text subtitles (.sub) are not supported; convert to SRT' });
          continue;
        }
      }
      sub.formatLabel = SUB_LABEL[sub.format];
      movie.subs.push(sub);
    }
  }
}

async function externalAudio(item, tags, codec) {
  const blob = await item.getBlob();
  const e = extension(item.name);
  const base = { source: 'external', fileName: item.name, origin: 0 };
  if (['ac3', 'eac3', 'ec3', 'dts', 'mp2', 'mpa'].includes(e)) {
    const info = await probeMpeg(blob, item.name);
    if (!info) throw new Error('unrecognised audio stream');
    info.blob = blob;
    const s = info.streams[0];
    const t = await mpegAudioTrack({ blob }, info, s, codec, 0);
    return [Object.assign(t, base, { lang: tags.lang, name: tags.extra.join(' ') || null, commentary: tags.commentary, default: tags.default })];
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const tracks = await input.getAudioTracks();
  if (!tracks.length) throw new Error('no audio track found');
  const out = [];
  for (const at of tracks) {
    const t = await mbAudioTrack(at, base);
    t.lang = tags.lang || t.lang;
    t.name = tags.extra.join(' ') || t.name;
    t.commentary = tags.commentary || t.commentary;
    t.default = tags.default;
    t.forced = false;
    out.push(finishAudio(t));
  }
  return out;
}
