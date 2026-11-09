// Language codes, language names, and the tags people put in subtitle/audio file names
// (Movie.2019.es.forced.srt, Movie.English.SDH.srt, Movie.fre.commentary.m4a, ...).

// ISO 639-2 (bibliographic and terminology) -> ISO 639-1
const ISO2 = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl',
  swe: 'sv', nor: 'no', nob: 'nb', nno: 'nn', dan: 'da', fin: 'fi', ice: 'is', isl: 'is', pol: 'pl', cze: 'cs', ces: 'cs',
  slo: 'sk', slk: 'sk', slv: 'sl', hun: 'hu', rum: 'ro', ron: 'ro', bul: 'bg', hrv: 'hr', scr: 'hr', srp: 'sr', scc: 'sr',
  bos: 'bs', mac: 'mk', mkd: 'mk', alb: 'sq', sqi: 'sq', gre: 'el', ell: 'el', tur: 'tr', rus: 'ru', ukr: 'uk', bel: 'be',
  est: 'et', lav: 'lv', lit: 'lt', geo: 'ka', kat: 'ka', arm: 'hy', hye: 'hy', aze: 'az', kaz: 'kk', uzb: 'uz',
  ara: 'ar', heb: 'he', per: 'fa', fas: 'fa', urd: 'ur', hin: 'hi', ben: 'bn', pan: 'pa', guj: 'gu', mar: 'mr', tam: 'ta',
  tel: 'te', kan: 'kn', mal: 'ml', sin: 'si', nep: 'ne', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', fil: 'fil',
  tgl: 'tl', chi: 'zh', zho: 'zh', jpn: 'ja', kor: 'ko', mon: 'mn', bur: 'my', mya: 'my', khm: 'km', lao: 'lo',
  cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', wel: 'cy', cym: 'cy', gle: 'ga', gla: 'gd', bre: 'br', ltz: 'lb',
  afr: 'af', swa: 'sw', amh: 'am', som: 'so', yor: 'yo', ibo: 'ig', hau: 'ha', zul: 'zu', xho: 'xh', mlt: 'mt',
  lat: 'la', epo: 'eo', haw: 'haw', mao: 'mi', mri: 'mi', smo: 'sm', ton: 'to', fij: 'fj', yid: 'yi', kur: 'ku',
  pob: 'pt-BR', pus: 'ps', tat: 'tt', tib: 'bo', bod: 'bo', uig: 'ug', fao: 'fo', ido: 'io', roh: 'rm', sco: 'sco',
  cmn: 'zh', yue: 'yue', nan: 'nan',
};

// language names (English and native) found in file names
const WORDS = {
  english: 'en', french: 'fr', francais: 'fr', 'français': 'fr', german: 'de', deutsch: 'de', spanish: 'es', espanol: 'es',
  'español': 'es', castellano: 'es', latino: 'es-419', italian: 'it', italiano: 'it', portuguese: 'pt', portugues: 'pt',
  'português': 'pt', brazilian: 'pt-BR', dutch: 'nl', nederlands: 'nl', swedish: 'sv', svenska: 'sv', norwegian: 'no',
  norsk: 'no', danish: 'da', dansk: 'da', finnish: 'fi', suomi: 'fi', polish: 'pl', polski: 'pl', czech: 'cs',
  hungarian: 'hu', magyar: 'hu', romanian: 'ro', greek: 'el', turkish: 'tr', russian: 'ru', ukrainian: 'uk',
  arabic: 'ar', hebrew: 'he', persian: 'fa', farsi: 'fa', hindi: 'hi', thai: 'th', vietnamese: 'vi', indonesian: 'id',
  malay: 'ms', chinese: 'zh', mandarin: 'zh', cantonese: 'yue', japanese: 'ja', korean: 'ko', croatian: 'hr',
  serbian: 'sr', slovenian: 'sl', slovak: 'sk', bulgarian: 'bg', estonian: 'et', latvian: 'lv', lithuanian: 'lt',
  icelandic: 'is', catalan: 'ca', basque: 'eu', galician: 'gl', tagalog: 'tl', filipino: 'fil',
};

// two-letter codes that are also ordinary words in file names; only trusted next to a subtitle/audio extension
const ISO1 = new Set(('aa ab af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu ' +
  'fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko ' +
  'kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi ' +
  'pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ' +
  'ur uz ve vi vo wa wo xh yi yo za zh zu').split(' '));

/** Normalises any language code (ISO 639-1/2, BCP 47) to a BCP 47 tag, or null if undetermined. */
export function normalizeLang(code) {
  if (!code) return null;
  let c = String(code).trim().replace(/_/g, '-');
  const lower = c.toLowerCase();
  if (['und', 'zxx', 'mis', 'mul', 'qaa', ''].includes(lower)) return null;
  const [base, ...rest] = lower.split('-');
  let b = base;
  if (b.length === 3 && ISO2[b]) b = ISO2[b];
  try {
    const tag = [b, ...rest].join('-');
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return null;
  }
}

let displayNames = null;
/** Human name for a language tag in the user's language ("Spanish", "Portuguese (Brazil)"). */
export function languageName(tag) {
  if (!tag) return null;
  try {
    if (!displayNames) displayNames = new Intl.DisplayNames(typeof navigator !== 'undefined' ? navigator.languages : ['en'], { type: 'language' });
    const n = displayNames.of(tag);
    return n && n !== tag ? n.charAt(0).toUpperCase() + n.slice(1) : tag;
  } catch {
    return tag;
  }
}

/** True if two language tags refer to the same base language. */
export function sameLanguage(a, b) {
  if (!a || !b) return false;
  return a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
}

export function baseName(name) {
  return name.replace(/\.[^./\\]+$/, '');
}

export function extension(name) {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Reads tags from a companion file's name. `videoBase` is the movie's name without extension.
 * Returns {lang, forced, sdh, commentary, extra} where extra holds unrecognised words.
 */
export function parseCompanionTags(fileName, videoBase) {
  let stem = baseName(fileName);
  if (videoBase && stem.toLowerCase().startsWith(videoBase.toLowerCase())) stem = stem.slice(videoBase.length);
  const tokens = stem.split(/[.\-_\s[\]()]+/).filter(Boolean);
  const out = { lang: null, forced: false, sdh: false, commentary: false, default: false, extra: [] };
  // walk from the end: tags usually trail the name
  for (let i = tokens.length - 1; i >= 0; i--) {
    const raw = tokens[i];
    const t = raw.toLowerCase();
    if (t === 'forced' || t === 'foreign') { out.forced = true; continue; }
    if (t === 'sdh' || t === 'cc' || t === 'hi' || t === 'hoh') { out.sdh = true; continue; }
    if (t === 'commentary' || t === 'comment' || t === 'comm') { out.commentary = true; continue; }
    if (t === 'default') { out.default = true; continue; }
    if (!out.lang) {
      if (WORDS[t]) { out.lang = normalizeLang(WORDS[t]); continue; }
      if (t.length === 3 && ISO2[t]) { out.lang = normalizeLang(t); continue; }
      if (t.length === 2 && ISO1.has(t)) {
        // a region may follow: pt.BR / pt-BR
        const next = tokens[i + 1];
        if (next && /^[A-Z]{2}$/.test(next)) out.lang = normalizeLang(t + '-' + next);
        else out.lang = normalizeLang(t);
        continue;
      }
      if (/^[a-z]{2}-[a-z]{2}$/i.test(raw)) { out.lang = normalizeLang(raw); continue; }
    }
    if (/^[A-Z]{2}$/.test(raw) && i > 0 && ISO1.has(tokens[i - 1].toLowerCase())) continue; // region part
    out.extra.unshift(raw);
  }
  return out;
}

export const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'mpg', 'mpeg', 'vob', 'ts', 'm2ts', 'mts', 'm2t', 'm2v', 'avi', 'wmv', 'flv', 'ogv', '3gp']);
export const AUDIO_EXT = new Set(['m4a', 'aac', 'mka', 'opus', 'ogg', 'oga', 'mp3', 'flac', 'wav', 'ac3', 'eac3', 'ec3', 'dts', 'mp2', 'mpa', 'thd', 'weba']);
export const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa', 'sup', 'idx', 'sub']);
export const FONT_EXT = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);
export const UNSUPPORTED_VIDEO = new Set(['avi', 'wmv', 'flv', '3gp']);

export function classify(name) {
  const e = extension(name);
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (SUB_EXT.has(e)) return 'sub';
  if (FONT_EXT.has(e)) return 'font';
  if (e === 'zip') return 'zip';
  if (['rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'r00', 'z01'].includes(e)) return 'archive';
  return 'other';
}

export function formatTime(t, forceHours = false) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h || forceHours ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n) {
  if (!isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n) + ' ' + u[i];
}

export function formatBitrate(bps) {
  if (!bps || !isFinite(bps)) return '';
  return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' Mb/s' : Math.round(bps / 1e3) + ' kb/s';
}

export function channelLabel(n) {
  return { 1: 'mono', 2: 'stereo', 3: '2.1', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1' }[n] || (n ? n + ' ch' : '');
}
