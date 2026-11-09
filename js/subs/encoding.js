// Text encoding detection for subtitle files (SRT, ASS, VTT). Old subtitle files are often in a
// legacy Windows code page rather than UTF-8; decoding them as UTF-8 turns accents into garbage.

const BY_LANGUAGE = {
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', mk: 'windows-1251', be: 'windows-1251',
  pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250', sl: 'windows-1250', hr: 'windows-1250',
  ro: 'windows-1250', bs: 'windows-1250',
  el: 'windows-1253', tr: 'windows-1254', he: 'windows-1255', ar: 'windows-1256', fa: 'windows-1256',
  lt: 'windows-1257', lv: 'windows-1257', et: 'windows-1257', vi: 'windows-1258', th: 'windows-874',
  ja: 'shift_jis', zh: 'gb18030', ko: 'euc-kr',
};


const LATIN = ['windows-1252', 'windows-1250', 'windows-1254', 'windows-1257'];
const OTHER = ['windows-1251', 'windows-1253', 'windows-1255', 'windows-1256'];
const CJK = ['shift_jis', 'gb18030', 'big5', 'euc-kr'];

/**
 * Plausibility score of decoded text. Penalises replacement/control characters, symbols wedged
 * between letters, words mixing ASCII letters with another script, and words with an upper-case
 * letter after a lower-case one (a typical sign of the wrong code page).
 */
function score(text) {
  let s = 0;
  const words = text.split(/[\s.,;:!?"'()\[\]<>{}\/\\0-9-]+/u);
  for (const w of words) {
    if (!w) continue;
    let ascii = 0, other = 0, lowerSeen = false, caseFlip = 0, wedged = 0;
    const chars = [...w];
    chars.forEach((ch, i) => {
      const c = ch.codePointAt(0);
      if (c === 0xfffd) s -= 20;
      else if (c < 32) s -= 10;
      else if (c >= 0x80 && c <= 0x9f) s -= 10;
      const isLetter = /\p{L}/u.test(ch);
      if (isLetter) {
        if (c < 128) ascii++;
        else if (!/\p{Script=Latin}/u.test(ch)) other++;
        const upper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
        if (upper && lowerSeen) caseFlip++;
        if (!upper) lowerSeen = true;
        s += 1;
      } else if (i > 0 && i < chars.length - 1 && c >= 128) wedged++;
    });
    if (ascii && other) s -= 6;
    s -= caseFlip * 4 + wedged * 4;
  }
  return s;
}

/** Decodes subtitle bytes to text, returning {text, encoding}. langHint is a BCP 47 code or null. */
export function decodeText(bytes, langHint = null) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16' };
  // UTF-16 without a BOM: lots of zero bytes in one lane
  const n = Math.min(bytes.length, 4000);
  let evenZero = 0, oddZero = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) (i & 1 ? oddZero++ : evenZero++);
  if (oddZero > n / 5) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16' };
  if (evenZero > n / 5) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch { /* not UTF-8 */ }
  const base = langHint ? langHint.split('-')[0].toLowerCase() : null;
  if (base && BY_LANGUAGE[base]) {
    const enc = BY_LANGUAGE[base];
    return { text: new TextDecoder(enc).decode(bytes), encoding: enc };
  }
  // Mostly ASCII letters with a few high bytes: a Latin-script language. Mostly high bytes: another script.
  let high = 0, asciiLetters = 0;
  const m = Math.min(bytes.length, 20000);
  for (let i = 0; i < m; i++) {
    const b = bytes[i];
    if (b >= 0x80) high++;
    else if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) asciiLetters++;
  }
  const ratio = high / Math.max(1, high + asciiLetters);
  const candidates = ratio < 0.4 ? LATIN : ratio > 0.8 && high > m * 0.3 ? [...CJK, ...OTHER] : OTHER;
  let best = null;
  for (const enc of candidates) {
    let text;
    try { text = new TextDecoder(enc).decode(bytes.subarray(0, 20000)); } catch { continue; }
    const sc = score(text) + (enc === 'windows-1252' || enc === 'windows-1251' ? 3 : 0);
    if (!best || sc > best.sc) best = { sc, enc };
  }
  return { text: new TextDecoder(best.enc).decode(bytes), encoding: best.enc };
}
