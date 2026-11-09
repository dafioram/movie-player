// The details panel: what the file is, how it's being played, and live playback stats.

import { el } from './dom.js';
import { formatBytes, formatBitrate, formatTime, languageName, channelLabel } from '../names.js';

function dl(rows) {
  const d = el('dl');
  for (const [k, v, cls] of rows) {
    if (v === null || v === undefined || v === '') continue;
    d.append(el('dt', { text: k }), el('dd' + (cls ? '.' + cls : ''), {}, v));
  }
  return d;
}

export function trackTitle(t) {
  const lang = t.lang ? languageName(t.lang) : null;
  const parts = [lang || (t.name ? null : 'Unknown language'), t.name].filter(Boolean);
  return parts.join(' · ') || 'Track ' + t.number;
}

export function audioMeta(t) {
  const bits = [t.codecLabel, channelLabel(t.channels), t.sampleRate ? (t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0) + ' kHz' : null];
  return bits.filter(Boolean).join(' ');
}

function fps(v) {
  return v ? (Math.abs(v - Math.round(v)) < 0.01 ? Math.round(v) : v.toFixed(3)) + ' fps' : null;
}

export function buildDetails(app) {
  const m = app.movie;
  const body = [];
  if (!m) return [el('p.note', { text: 'No movie loaded.' })];
  const info = app.engine ? app.engine.info() : {};

  body.push(el('h3', { text: 'Source' }), dl([
    ['File', m.name],
    ['Size', formatBytes(m.size)],
    ['Container', m.containerLabel || m.container],
    ['Duration', formatTime(m.duration, true)],
    ['Overall bitrate', formatBitrate(m.overallBitrate)],
    ['From', m.source === 'zip' ? `Zip: ${m.zipName}` : m.source === 'folder' ? 'Folder' : 'File'],
    ['Zip status', app.zipStatus || null],
  ]));

  body.push(el('h3', { text: 'Playback path' }), dl([
    ['Path', el('span', {}, info.path || '—', info.path === 'Remux' ? el('span.pill.accent', { text: 'MSE' }) : null)],
    ['Why', info.path === 'Remux' ? m.remuxReason : 'Chrome plays this file as is'],
  ]));

  const v = m.video;
  if (v) {
    const res = `${v.codedWidth}×${v.codedHeight}` + (v.displayWidth && (v.displayWidth !== v.codedWidth || v.displayHeight !== v.codedHeight) ? ` (shown as ${v.displayWidth}×${v.displayHeight})` : '');
    const color = v.hdr ? 'HDR' : 'SDR';
    body.push(el('h3', { text: 'Video' }), dl([
      ['Codec', [v.codecLabel, v.profile, v.level ? 'level ' + v.level : null].filter(Boolean).join(' · ')],
      ['Codec string', v.codecString ? el('code', { text: v.codecString }) : null],
      ['Resolution', res],
      ['Frame rate', fps(v.fps)],
      ['Scan', v.interlaced === undefined ? null : v.interlaced ? 'Interlaced (deinterlaced with bwdif)' : 'Progressive'],
      ['Bit depth', v.bitDepth ? v.bitDepth + '-bit' : null],
      ['Dynamic range', color],
      ['Bitrate', formatBitrate(v.bitrate)],
    ]));
    const dr = app.decoderReport;
    const rows = [];
    if (dr) {
      rows.push(['Decoder', dr.label, dr.hardware === true ? 'good' : dr.hardware === false && /can't/i.test(dr.label) ? 'bad' : null]);
      if (dr.reason) rows.push(['Why', dr.reason]);
      if (dr.encoder) rows.push(['Encoder', dr.encoder]);
      if (dr.playback) rows.push(['H.264 playback', dr.playback]);
    } else rows.push(['Decoder', 'Checking…']);
    if (info.videoConversion && info.videoConversion.speed) {
      const s = info.videoConversion.speed;
      rows.push(['Conversion speed', `${s.toFixed(1)}× real time`, s < 1.05 ? 'bad' : null]);
    }
    body.push(el('h3', { text: 'Decoder' }), dl(rows),
      el('p.note', {}, 'To see the decoder Chrome actually used, paste ', el('code', { text: 'chrome://media-internals' }), ' into the address bar.'));
  }

  body.push(el('h3', { text: `Audio tracks (${m.audio.length})` }));
  if (!m.audio.length) body.push(el('p.note', { text: 'No audio tracks.' }));
  for (const t of m.audio) {
    const playing = app.audioTrack === t;
    let status, cls = null;
    if (t.status === 'failed') { status = 'Failed: ' + (t.failReason || 'could not be played'); cls = 'bad'; }
    else if (t.mode === 'unsupported') { status = 'Unsupported: ' + t.reason; cls = 'bad'; }
    else status = (playing ? 'Playing' : 'Available') + (t.mode === 'convert' ? ' (converted in the browser)' : '');
    body.push(el('div.track', {},
      el('div.track-title', {}, trackTitle(t), t.default ? el('span.pill', { text: 'default' }) : null, t.commentary ? el('span.pill', { text: 'commentary' }) : null,
        t.source === 'external' ? el('span.pill', { text: 'external' }) : null),
      el('div.track-meta', { text: audioMeta(t) + (t.fileName ? ' · ' + t.fileName : '') }),
      el('div' + (cls ? '.' + cls : (playing ? '.good' : '.track-meta')), { text: status })));
  }

  body.push(el('h3', { text: `Subtitle tracks (${m.subs.length})` }));
  if (!m.subs.length) body.push(el('p.note', { text: 'No subtitle tracks.' }));
  for (const t of m.subs) {
    const shown = app.subMain === t ? 'Shown' : app.subSecond === t ? 'Shown as second track' : null;
    let status = shown || 'Available', cls = shown ? 'good' : null;
    if (t.status === 'failed') { status = 'Failed: ' + t.reason; cls = 'bad'; }
    if (t.status === 'unsupported') { status = 'Unsupported: ' + t.reason; cls = 'bad'; }
    body.push(el('div.track', {},
      el('div.track-title', {}, trackTitle(t), t.forced ? el('span.pill', { text: 'forced' }) : null, t.sdh ? el('span.pill', { text: 'SDH' }) : null,
        t.source === 'external' ? el('span.pill', { text: 'external' }) : null),
      el('div.track-meta', { text: [t.formatLabel, t.fileName, t.encoding ? 'encoding ' + t.encoding : null, t.noPalette ? 'no DVD palette, default colours' : null].filter(Boolean).join(' · ') }),
      el('div' + (cls ? '.' + cls : '.track-meta'), { text: status })));
  }
  if (app.subs && app.subs.missingFonts && app.subs.missingFonts.length) {
    body.push(el('p.note', { text: 'Missing ASS fonts: ' + app.subs.missingFonts.join(', ') }));
  }

  if (m.chapters.length) body.push(el('h3', { text: 'Chapters' }), dl([['Count', String(m.chapters.length)]]));

  if (m.ignored.length) {
    body.push(el('h3', { text: 'Skipped' }));
    for (const i of m.ignored) body.push(el('div.track', {}, el('div.track-title', { text: i.name }), el('div.track-meta', { text: i.reason })));
  }

  const q = app.video.getVideoPlaybackQuality ? app.video.getVideoPlaybackQuality() : null;
  const dropped = q ? q.droppedVideoFrames : 0, total = q ? q.totalVideoFrames : 0;
  body.push(el('h3', { text: 'Live' }), dl([
    ['Position', `${formatTime(app.video.currentTime, true)} / ${formatTime(m.duration, true)}`],
    ['Dropped frames', total ? `${dropped} of ${total} (${((dropped / total) * 100).toFixed(1)}%)` : '—', total && dropped / total > 0.02 ? 'bad' : null],
    ['Buffered ahead', info.bufferedAhead !== undefined ? info.bufferedAhead.toFixed(1) + ' s' : bufferedAhead(app.video)],
    ['Video data rate', info.videoBytesPerSec ? formatBitrate(info.videoBytesPerSec * 8) : null],
    ['Audio data rate', info.audioBytesPerSec ? formatBitrate(info.audioBytesPerSec * 8) : null],
    ['Speed', app.video.playbackRate !== 1 ? app.video.playbackRate + '×' : null],
  ]));

  if (app.notices.log.length) {
    body.push(el('h3', { text: 'Notices' }));
    for (const n of app.notices.log) body.push(el('div.track', {}, el('div.track-meta', { text: n.at.toLocaleTimeString() }), el('div', { text: n.text })));
  }
  return body;
}

function bufferedAhead(video) {
  const b = video.buffered, t = video.currentTime;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t && b.end(i) > t) return (b.end(i) - t).toFixed(1) + ' s';
  return '0 s';
}
