// Text subtitle parsing: SRT, WebVTT, and ASS/SSA (as plain text, for the second track or when
// only the words are wanted). Produces cues {start, end, html, top} with safe, limited markup.

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseTime(t) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?\s*$/.exec(t);
  if (!m) return null;
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000;
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]+|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))$/i;

/**
 * Converts subtitle markup to safe HTML: keeps <i>, <b>, <u>, <s> and <font color>; drops all
 * other tags and ASS-style {\...} overrides. Returns {html, top} (top: \an7-9 alignment).
 */
export function markupToHtml(text) {
  let top = false;
  text = text.replace(/\{\\([^}]*)\}/g, (_, inner) => {
    const an = /an([789])/.exec(inner);
    if (an) top = true;
    if (/(^|\\)i1/.test(inner)) return '\u0001i';
    if (/(^|\\)i0/.test(inner)) return '\u0001/i';
    if (/(^|\\)b1/.test(inner)) return '\u0001b';
    if (/(^|\\)b0/.test(inner)) return '\u0001/b';
    return '';
  });
  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  let out = '';
  const open = [];
  const re = /<\s*(\/?)\s*([a-z]+)([^>]*)>|\u0001(\/?)([ib])/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = re.lastIndex;
    const closing = m[1] === '/' || m[4] === '/';
    const tag = (m[2] || m[5]).toLowerCase();
    if (!['i', 'b', 'u', 's', 'font'].includes(tag)) continue;
    if (closing) {
      const idx = open.lastIndexOf(tag);
      if (idx >= 0) {
        while (open.length > idx) {
          const t = open.pop();
          out += '</' + (t === 'font' ? 'span' : t) + '>';
        }
      }
      continue;
    }
    if (tag === 'font') {
      const cm = /color\s*=\s*["']?([^"'\s>]+)/i.exec(m[3] || '');
      const color = cm && COLOR_RE.test(cm[1]) ? cm[1] : null;
      out += color ? `<span style="color:${color}">` : '<span>';
      open.push('font');
    } else {
      out += '<' + tag + '>';
      open.push(tag);
    }
  }
  out += esc(text.slice(last));
  while (open.length) { const t = open.pop(); out += '</' + (t === 'font' ? 'span' : t) + '>'; }
  out = out.trim().replace(/\r/g, '').replace(/\n/g, '<br>');
  return { html: out, top };
}

export function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].includes('-->')) i++;
    if (i >= lines.length) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a), end = parseTime((b || '').trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    if (!body) continue;
    const { html, top } = markupToHtml(body);
    cues.push({ start, end, html, top });
  }
  return finish(cues);
}

export function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    if (/^(WEBVTT|NOTE|STYLE|REGION)/.test(block.trim())) continue;
    const lines = block.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].includes('-->')) i++;
    if (i >= lines.length) continue;
    const [a, rest] = lines[i].split('-->');
    const parts = (rest || '').trim().split(/\s+/);
    const start = parseTime(a), end = parseTime(parts[0]);
    if (start === null || end === null) continue;
    const settings = parts.slice(1).join(' ');
    let body = lines.slice(i + 1).join('\n').trim();
    body = body.replace(/<\d+:\d+[:.]\d+(?:\.\d+)?>/g, '').replace(/<\/?(c|v|lang|ruby|rt)(\.[^ >]*)?[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    if (!body) continue;
    const { html } = markupToHtml(body);
    const top = /line:\s*(0|[0-2]?\d%)\b/.test(settings) && !/line:\s*-/.test(settings);
    cues.push({ start, end, html, top });
  }
  return finish(cues);
}

/** Reads an ASS/SSA script's [Events] as plain-text cues. */
export function parseAssAsText(text) {
  const cues = [];
  let format = null, inEvents = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^\[/.test(line)) { inEvents = /^\[events\]/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) { format = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase()); continue; }
    if (!/^dialogue\s*:/i.test(line) || !format) continue;
    const fields = line.slice(line.indexOf(':') + 1).split(',');
    const textIdx = format.indexOf('text');
    const get = (name) => (fields[format.indexOf(name)] || '').trim();
    const body = fields.slice(textIdx).join(',');
    const start = parseTime(get('start')), end = parseTime(get('end'));
    if (start === null || end === null) continue;
    // drawings ({\p1}) are not text
    if (/\{[^}]*\\p[1-9]/.test(body)) continue;
    const { html, top } = markupToHtml(body);
    if (!html) continue;
    cues.push({ start, end, html, top });
  }
  return finish(cues);
}

/** Converts an MKV S_TEXT/ASS block ("ReadOrder,Layer,Style,...,Text") back into a Dialogue line. */
export function mkvAssBlockToDialogue(block, start, end) {
  const fields = block.split(',');
  // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  const layer = fields[1] || '0';
  const rest = fields.slice(2).join(',');
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${rest}`;
}

export function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function finish(cues) {
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/** Finds all cues active at time t (cues sorted by start). */
export function activeCues(cues, t) {
  // binary search for the last cue starting at or before t
  let lo = 0, hi = cues.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const out = [];
  // overlapping cues are rare; look back a little
  for (let i = idx; i >= 0 && i > idx - 20; i--) {
    if (cues[i].end > t) out.unshift(cues[i]);
  }
  return out;
}

/** Detects the format of a text subtitle file. */
export function detectTextFormat(text, name = '') {
  const head = text.slice(0, 2000);
  if (/^﻿?WEBVTT/.test(head)) return 'vtt';
  if (/\[script info\]/i.test(head) || /\[v4\+? styles\]/i.test(head) || /^dialogue:/im.test(head)) return 'ass';
  if (/-->/.test(head)) return /\.vtt$/i.test(name) ? 'vtt' : 'srt';
  return null;
}
