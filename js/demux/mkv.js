// Matroska/WebM metadata reader: tracks (including subtitle tracks), chapters, attachments (fonts)
// and the cue index. Also scans clusters for subtitle blocks, starting near the playhead.
// Audio and video packets are read by Mediabunny; this module only covers what it doesn't expose.

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, Title: 0x7ba9,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, FlagEnabled: 0xb9, FlagDefault: 0x88,
  FlagForced: 0x55aa, FlagHearingImpaired: 0x55ab, FlagCommentary: 0x55af, FlagOriginal: 0x55ae, Name: 0x536e,
  Language: 0x22b59c, LanguageBCP47: 0x22b59d, CodecID: 0x86, CodecPrivate: 0x63a2, CodecName: 0x258688,
  ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentEncodingType: 0x5033, ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, Video: 0xe0, Audio: 0xe1, PixelWidth: 0xb0, PixelHeight: 0xba,
  Channels: 0x9f, SamplingFrequency: 0xb5,
  Chapters: 0x1043a770, EditionEntry: 0x45b9, EditionFlagDefault: 0x45db, EditionFlagHidden: 0x45bd, ChapterAtom: 0xb6,
  ChapterTimeStart: 0x91, ChapterFlagHidden: 0x98, ChapterFlagEnabled: 0x4598, ChapterDisplay: 0x80, ChapString: 0x85,
  Attachments: 0x1941a469, AttachedFile: 0x61a7, FileName: 0x466e, FileMimeType: 0x4660, FileData: 0x465c,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
};

async function readBytes(blob, start, end) {
  start = Math.max(0, start);
  end = Math.min(blob.size, end);
  if (end <= start) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Reads an EBML variable-length integer. keepMarker: true for IDs. */
function vint(b, o, keepMarker) {
  const first = b[o];
  if (first === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || o + len > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[o + i];
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function header(b, o) {
  const id = vint(b, o, true);
  if (!id) return null;
  const size = vint(b, o + id.len, false);
  if (!size) return null;
  return { id: id.value, size: size.unknown ? Infinity : size.value, headerLen: id.len + size.len };
}

function* children(b, start, end) {
  let o = start;
  while (o < end) {
    const h = header(b, o);
    if (!h) return;
    const dataStart = o + h.headerLen;
    const dataEnd = h.size === Infinity ? end : Math.min(end, dataStart + h.size);
    yield { id: h.id, start: dataStart, end: dataEnd, offset: o };
    if (h.size === Infinity) return;
    o = dataEnd;
  }
}

function uint(b, s, e) { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; }
function float(b, s, e) {
  const v = new DataView(b.buffer, b.byteOffset + s, e - s);
  return e - s === 4 ? v.getFloat32(0) : e - s === 8 ? v.getFloat64(0) : 0;
}
const utf8 = new TextDecoder();
function string(b, s, e) { return utf8.decode(b.subarray(s, e)).replace(/\0+$/, ''); }

export class MkvFile {
  static async open(blob) {
    const m = new MkvFile(blob);
    await m._init();
    return m;
  }

  constructor(blob) {
    this.blob = blob;
    this.tracks = [];
    this.chapters = [];
    this.attachments = [];
    this.cues = []; // [{time (s), offset (absolute)}]
    this.timescale = 1e6;
    this.duration = null;
    this.firstClusterOffset = null;
  }

  async _init() {
    const head = await readBytes(this.blob, 0, 4096);
    const ebml = header(head, 0);
    if (!ebml || ebml.id !== ID.EBML) throw new Error('Not a Matroska file');
    let o = ebml.headerLen + ebml.size;
    const seg = header(head, o);
    if (!seg || seg.id !== ID.Segment) throw new Error('Matroska segment not found');
    this.segStart = o + seg.headerLen;
    this.segEnd = seg.size === Infinity ? this.blob.size : this.segStart + seg.size;
    const positions = new Map();
    // walk the top-level elements up to the first cluster
    let p = this.segStart;
    for (let guard = 0; guard < 64 && p < this.segEnd; guard++) {
      const hb = await readBytes(this.blob, p, p + 16);
      const h = header(hb, 0);
      if (!h) break;
      if (h.id === ID.Cluster) { this.firstClusterOffset = p; break; }
      if (!positions.has(h.id)) positions.set(h.id, p);
      if (h.id === ID.SeekHead) await this._readSeekHead(p, positions);
      if (h.size === Infinity) break;
      p += h.headerLen + h.size;
    }
    for (const [id, pos] of positions) {
      if (id === ID.Info) await this._readInfo(pos);
      else if (id === ID.Tracks) await this._readTracks(pos);
      else if (id === ID.Chapters) await this._readChapters(pos);
      else if (id === ID.Attachments) await this._readAttachments(pos);
      else if (id === ID.Cues) await this._readCues(pos);
    }
    if (this.firstClusterOffset === null && this.cues.length) this.firstClusterOffset = this.cues[0].offset;
  }

  async _element(pos, maxSize = 64 << 20) {
    const hb = await readBytes(this.blob, pos, pos + 16);
    const h = header(hb, 0);
    if (!h || h.size === Infinity || h.size > maxSize) return null;
    const data = await readBytes(this.blob, pos + h.headerLen, pos + h.headerLen + h.size);
    return { id: h.id, data };
  }

  async _readSeekHead(pos, positions, depth = 0) {
    const el = await this._element(pos);
    if (!el) return;
    const b = el.data;
    for (const s of children(b, 0, b.length)) {
      if (s.id !== ID.Seek) continue;
      let id = null, at = null;
      for (const c of children(b, s.start, s.end)) {
        if (c.id === ID.SeekID) id = uint(b, c.start, c.end);
        if (c.id === ID.SeekPosition) at = uint(b, c.start, c.end);
      }
      if (id === null || at === null) continue;
      const abs = this.segStart + at;
      if (id === ID.SeekHead && depth < 2 && abs !== pos) await this._readSeekHead(abs, positions, depth + 1);
      else if (!positions.has(id)) positions.set(id, abs);
    }
  }

  async _readInfo(pos) {
    const el = await this._element(pos);
    if (!el) return;
    const b = el.data;
    let dur = null;
    for (const c of children(b, 0, b.length)) {
      if (c.id === ID.TimestampScale) this.timescale = uint(b, c.start, c.end);
      if (c.id === ID.Duration) dur = float(b, c.start, c.end);
      if (c.id === ID.Title) this.title = string(b, c.start, c.end);
    }
    if (dur !== null) this.duration = (dur * this.timescale) / 1e9;
  }

  async _readTracks(pos) {
    const el = await this._element(pos);
    if (!el) return;
    const b = el.data;
    for (const t of children(b, 0, b.length)) {
      if (t.id !== ID.TrackEntry) continue;
      const tr = { number: 0, type: 0, codecId: '', name: null, language: 'eng', bcp47: null, default: true, forced: false,
        hearingImpaired: false, commentary: false, enabled: true, codecPrivate: null, encodings: [] };
      for (const c of children(b, t.start, t.end)) {
        switch (c.id) {
          case ID.TrackNumber: tr.number = uint(b, c.start, c.end); break;
          case ID.TrackType: tr.type = uint(b, c.start, c.end); break;
          case ID.CodecID: tr.codecId = string(b, c.start, c.end); break;
          case ID.Name: tr.name = string(b, c.start, c.end); break;
          case ID.Language: tr.language = string(b, c.start, c.end); break;
          case ID.LanguageBCP47: tr.bcp47 = string(b, c.start, c.end); break;
          case ID.FlagDefault: tr.default = !!uint(b, c.start, c.end); break;
          case ID.FlagForced: tr.forced = !!uint(b, c.start, c.end); break;
          case ID.FlagEnabled: tr.enabled = !!uint(b, c.start, c.end); break;
          case ID.FlagHearingImpaired: tr.hearingImpaired = !!uint(b, c.start, c.end); break;
          case ID.FlagCommentary: tr.commentary = !!uint(b, c.start, c.end); break;
          case ID.CodecPrivate: tr.codecPrivate = b.slice(c.start, c.end); break;
          case ID.ContentEncodings:
            for (const ce of children(b, c.start, c.end)) {
              if (ce.id !== ID.ContentEncoding) continue;
              const enc = { type: 0, algo: 0, settings: null };
              for (const x of children(b, ce.start, ce.end)) {
                if (x.id === ID.ContentEncodingType) enc.type = uint(b, x.start, x.end);
                if (x.id === ID.ContentCompression) {
                  for (const y of children(b, x.start, x.end)) {
                    if (y.id === ID.ContentCompAlgo) enc.algo = uint(b, y.start, y.end);
                    if (y.id === ID.ContentCompSettings) enc.settings = b.slice(y.start, y.end);
                  }
                }
              }
              tr.encodings.push(enc);
            }
            break;
        }
      }
      this.tracks.push(tr);
    }
  }

  async _readChapters(pos) {
    const el = await this._element(pos);
    if (!el) return;
    const b = el.data;
    const editions = [];
    for (const ed of children(b, 0, b.length)) {
      if (ed.id !== ID.EditionEntry) continue;
      const edition = { default: false, hidden: false, chapters: [] };
      const walk = (s, e) => {
        for (const c of children(b, s, e)) {
          if (c.id === ID.EditionFlagDefault) edition.default = !!uint(b, c.start, c.end);
          if (c.id === ID.EditionFlagHidden) edition.hidden = !!uint(b, c.start, c.end);
          if (c.id !== ID.ChapterAtom) continue;
          let time = 0, title = '', hidden = false, enabled = true;
          for (const x of children(b, c.start, c.end)) {
            if (x.id === ID.ChapterTimeStart) time = uint(b, x.start, x.end) / 1e9;
            if (x.id === ID.ChapterFlagHidden) hidden = !!uint(b, x.start, x.end);
            if (x.id === ID.ChapterFlagEnabled) enabled = !!uint(b, x.start, x.end);
            if (x.id === ID.ChapterDisplay && !title) {
              for (const y of children(b, x.start, x.end)) if (y.id === ID.ChapString) title = string(b, y.start, y.end);
            }
          }
          if (!hidden && enabled) edition.chapters.push({ time, title });
        }
      };
      walk(ed.start, ed.end);
      editions.push(edition);
    }
    const chosen = editions.find((e) => e.default) || editions[0];
    if (chosen) this.chapters = chosen.chapters.sort((a, b2) => a.time - b2.time);
  }

  async _readAttachments(pos) {
    // read element headers only; file data is read lazily
    const hb = await readBytes(this.blob, pos, pos + 16);
    const h = header(hb, 0);
    if (!h || h.size === Infinity) return;
    const start = pos + h.headerLen, end = start + h.size;
    let p = start;
    while (p < end) {
      const fh = header(await readBytes(this.blob, p, p + 16), 0);
      if (!fh) break;
      const fs = p + fh.headerLen, fe = fs + fh.size;
      if (fh.id === ID.AttachedFile) {
        const file = { name: '', mime: '', offset: 0, size: 0 };
        let q = fs;
        while (q < fe) {
          const ch = header(await readBytes(this.blob, q, q + 16), 0);
          if (!ch) break;
          const cs = q + ch.headerLen, ce = cs + ch.size;
          if (ch.id === ID.FileData) { file.offset = cs; file.size = ch.size; }
          else if (ch.size < 4096) {
            const v = await readBytes(this.blob, cs, ce);
            if (ch.id === ID.FileName) file.name = string(v, 0, v.length);
            if (ch.id === ID.FileMimeType) file.mime = string(v, 0, v.length);
          }
          q = ce;
        }
        const blob = this.blob;
        file.read = () => readBytes(blob, file.offset, file.offset + file.size);
        this.attachments.push(file);
      }
      p = fe;
    }
  }

  async _readCues(pos) {
    const el = await this._element(pos, 256 << 20);
    if (!el) return;
    const b = el.data;
    const seen = new Set();
    for (const cp of children(b, 0, b.length)) {
      if (cp.id !== ID.CuePoint) continue;
      let time = 0, offset = null;
      for (const c of children(b, cp.start, cp.end)) {
        if (c.id === ID.CueTime) time = uint(b, c.start, c.end);
        if (c.id === ID.CueTrackPositions) {
          for (const x of children(b, c.start, c.end)) if (x.id === ID.CueClusterPosition) offset = uint(b, x.start, x.end);
        }
      }
      if (offset === null) continue;
      const abs = this.segStart + offset;
      if (seen.has(abs)) continue;
      seen.add(abs);
      this.cues.push({ time: (time * this.timescale) / 1e9, offset: abs });
    }
    this.cues.sort((a, b2) => a.offset - b2.offset);
  }

  /** Reads one cluster at `offset`. Returns {time, next, blocks:[{track, time, duration, data, key}]} */
  async readCluster(offset, wantTracks) {
    const hb = await readBytes(this.blob, offset, offset + 16);
    const h = header(hb, 0);
    if (!h || h.id !== ID.Cluster) return null;
    const start = offset + h.headerLen;
    let size = h.size;
    if (size === Infinity || size > 256 << 20) size = Math.min(this.segEnd - start, 32 << 20);
    const b = await readBytes(this.blob, start, start + size);
    let clusterTime = 0;
    const blocks = [];
    let end = b.length;
    const ts = this.timescale / 1e9;
    for (const c of children(b, 0, b.length)) {
      if (h.size === Infinity && (c.id === ID.Cluster || c.id === ID.Cues)) { end = c.offset; break; }
      if (c.id === ID.Timestamp) clusterTime = uint(b, c.start, c.end);
      else if (c.id === ID.SimpleBlock || c.id === ID.BlockGroup) {
        let bs = c.start, be = c.end, duration = null;
        if (c.id === ID.BlockGroup) {
          bs = -1;
          for (const x of children(b, c.start, c.end)) {
            if (x.id === ID.Block) { bs = x.start; be = x.end; }
            if (x.id === ID.BlockDuration) duration = uint(b, x.start, x.end) * ts;
          }
          if (bs < 0) continue;
        }
        const tn = vint(b, bs, false);
        if (!tn || (wantTracks && !wantTracks.has(tn.value))) continue;
        const rel = ((b[bs + tn.len] << 8) | b[bs + tn.len + 1]) << 16 >> 16;
        const flags = b[bs + tn.len + 2];
        if (flags & 0x06) continue; // laced: never used for subtitles
        blocks.push({
          track: tn.value,
          time: (clusterTime + rel) * ts,
          duration,
          data: b.slice(bs + tn.len + 3, be),
          key: !!(flags & 0x80),
        });
      }
    }
    return { time: clusterTime * ts, next: h.size === Infinity ? start + end : start + h.size, blocks, bytes: b.length };
  }

  /** Finds the first cluster at or after an absolute offset by scanning for the Cluster ID. */
  async findCluster(offset) {
    const sig = [0x1f, 0x43, 0xb6, 0x75];
    for (let p = offset; p < this.segEnd; p += (4 << 20) - 4) {
      const b = await readBytes(this.blob, p, p + (4 << 20));
      for (let i = 0; i + 4 <= b.length; i++) {
        if (b[i] === sig[0] && b[i + 1] === sig[1] && b[i + 2] === sig[2] && b[i + 3] === sig[3]) {
          const c = await this.readCluster(p + i, new Set());
          if (c) return p + i;
        }
      }
      if (b.length < 4 << 20) break;
    }
    return null;
  }

  /** Decodes the stored form of a block for a track (zlib / header stripping). */
  async decodeBlock(track, data) {
    for (const enc of track.encodings) {
      if (enc.type !== 0) continue;
      if (enc.algo === 3 && enc.settings) {
        const out = new Uint8Array(enc.settings.length + data.length);
        out.set(enc.settings);
        out.set(data, enc.settings.length);
        data = out;
      } else if (enc.algo === 0) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      }
    }
    return data;
  }
}

/**
 * Collects subtitle blocks for the given tracks, scanning outward from the playhead.
 * onBlocks(trackNumber, [{time, duration, data}]) is called as clusters are read.
 */
export class MkvSubtitleScanner {
  constructor(mkv, tracks, onBlocks) {
    this.mkv = mkv;
    this.tracks = new Map(tracks.map((t) => [t.number, t]));
    this.onBlocks = onBlocks;
    this.done = new Set();
    this.focusTime = 0;
    this.running = false;
    this.stopped = false;
    this.complete = false;
    this.bytesPerSecond = 60e6;
  }

  focus(time) {
    this.focusTime = time;
    this._restart = true;
    if (!this.running) this._run();
  }

  stop() {
    this.stopped = true;
  }

  _startOffset() {
    const cues = this.mkv.cues;
    if (cues.length) {
      let best = cues[0];
      for (const c of cues) if (c.time <= this.focusTime - 5 && c.time >= best.time) best = c;
      return best.offset;
    }
    return null;
  }

  async _run() {
    this.running = true;
    const want = new Set(this.tracks.keys());
    try {
      while (!this.stopped) {
        this._restart = false;
        let offset = this._startOffset();
        if (offset === null) {
          // no index: estimate from the duration
          const first = this.mkv.firstClusterOffset || this.mkv.segStart;
          const frac = this.mkv.duration ? Math.max(0, (this.focusTime - 5) / this.mkv.duration) : 0;
          offset = frac > 0 ? await this.mkv.findCluster(first + Math.floor(frac * (this.mkv.segEnd - first))) : first;
          if (offset === null) offset = first;
        }
        let wrapped = false;
        const start = offset;
        while (!this.stopped && !this._restart) {
          if (this.done.has(offset)) {
            // already read: hop to the next cluster
            const next = this._next.get(offset);
            if (next != null) { offset = next; } else {
              const c = await this.mkv.readCluster(offset, new Set());
              if (!c) offset = null; else { this._next.set(offset, c.next); offset = c.next; }
            }
          } else {
            const c = await this.mkv.readCluster(offset, want);
            if (!c) offset = null;
            else {
              this.done.add(offset);
              this._next.set(offset, c.next);
              const byTrack = new Map();
              for (const blk of c.blocks) {
                const tr = this.tracks.get(blk.track);
                const data = await this.mkv.decodeBlock(tr, blk.data);
                if (!byTrack.has(blk.track)) byTrack.set(blk.track, []);
                byTrack.get(blk.track).push({ time: blk.time, duration: blk.duration, data });
              }
              for (const [tn, list] of byTrack) this.onBlocks(tn, list);
              offset = c.next;
              // stay gentle on the disk: the movie itself is being read at the same time
              await new Promise((r) => setTimeout(r, Math.min(500, (c.bytes / this.bytesPerSecond) * 1000)));
            }
          }
          if (offset === null || offset >= this.mkv.segEnd) {
            if (wrapped) break;
            wrapped = true;
            offset = this.mkv.firstClusterOffset;
            if (offset === null) break;
          }
          if (wrapped && offset >= start) break;
        }
        if (!this._restart) { this.complete = true; break; }
      }
    } finally {
      this.running = false;
    }
  }

  get _next() {
    if (!this.__next) this.__next = new Map();
    return this.__next;
  }
}

/** Reads Nero-style chapters ('chpl') from an MP4/MOV file's moov/udta box. */
export async function readMp4Chapters(blob) {
  let p = 0;
  for (let guard = 0; guard < 64 && p < blob.size; guard++) {
    const h = new DataView(await blob.slice(p, p + 16).arrayBuffer());
    if (h.byteLength < 8) break;
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    let hl = 8;
    if (size === 1) { size = Number(h.getBigUint64(8)); hl = 16; }
    if (size === 0) size = blob.size - p;
    if (size < 8) break;
    if (type === 'moov') {
      if (size > 512 << 20) return [];
      const b = new Uint8Array(await blob.slice(p + hl, p + size).arrayBuffer());
      return findChpl(b, 0, b.length);
    }
    p += size;
  }
  return [];
}

function findChpl(b, start, end) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = start;
  while (p + 8 <= end) {
    const size = v.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (size < 8 || p + size > end) break;
    if (type === 'udta') return findChpl(b, p + 8, p + size);
    if (type === 'chpl') {
      let q = p + 8;
      const version = b[q];
      q += 4;
      if (version) q += 4;
      const count = b[q++];
      const out = [];
      for (let i = 0; i < count && q + 9 <= p + size; i++) {
        const t = Number(v.getBigUint64(q)) / 1e7;
        const len = b[q + 8];
        const title = new TextDecoder().decode(b.subarray(q + 9, q + 9 + len));
        out.push({ time: t, title });
        q += 9 + len;
      }
      return out;
    }
    p += size;
  }
  return [];
}
