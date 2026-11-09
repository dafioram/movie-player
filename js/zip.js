// Zip reader. Stored (uncompressed) entries are exposed as slices of the zip file itself, so a
// movie inside a zip plays straight from disk without extraction. Small compressed entries
// (subtitles, fonts) are inflated in memory. Supports Zip64 for files over 4 GB.

const SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
export const MAX_INFLATE = 64 << 20; // compressed entries larger than this are refused

export class ZipError extends Error {}

async function read(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

export async function openZip(blob) {
  const tailLen = Math.min(blob.size, 65536 + 22);
  const tail = await read(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('This zip file is damaged or not a zip file.');
  const disk = tail.getUint16(eocd + 4, true);
  const cdDisk = tail.getUint16(eocd + 6, true);
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('Multi-part zips are not supported. Join the parts into one zip first.');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = eocd - 20;
    if (locPos < 0 || tail.getUint32(locPos, true) !== SIG_LOC64) throw new ZipError('This zip file is damaged (Zip64 record missing).');
    const eocd64Off = Number(tail.getBigUint64(locPos + 8, true));
    const z = await read(blob, eocd64Off, eocd64Off + 56);
    if (z.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('This zip file is damaged (Zip64 record invalid).');
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdOffset = Number(z.getBigUint64(48, true));
  }
  const cd = await read(blob, cdOffset, cdOffset + cdSize);
  const entries = [];
  const utf8 = new TextDecoder('utf-8');
  const cp437 = new TextDecoder('ibm866'); // close enough for legacy names; ASCII is identical
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== SIG_CEN) throw new ZipError('This zip file is damaged (bad directory entry).');
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    const name = (flags & 0x800 ? utf8 : cp437).decode(nameBytes);
    // Zip64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(cd.getBigUint64(q, true)); q += 8; }
      }
      e += 4 + len;
    }
    p = eEnd + commentLen;
    if (name.endsWith('/')) continue;
    entries.push(new ZipEntry(blob, { name, flags, method, compSize, size, localOffset }));
  }
  return entries;
}

export class ZipEntry {
  constructor(zip, meta) {
    this.zip = zip;
    this.path = meta.name;
    this.name = meta.name.split('/').pop();
    this.size = meta.size;
    this.compressedSize = meta.compSize;
    this.method = meta.method;
    this.encrypted = !!(meta.flags & 1);
    this.localOffset = meta.localOffset;
    this.lastModified = zip.lastModified || 0;
  }

  get stored() {
    return this.method === 0 && !this.encrypted;
  }

  get methodName() {
    return { 0: 'stored', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 99: 'AES' }[this.method] || 'method ' + this.method;
  }

  async _dataStart() {
    if (this._start != null) return this._start;
    const h = await read(this.zip, this.localOffset, this.localOffset + 30);
    if (h.getUint32(0, true) !== SIG_LOC) throw new ZipError('This zip file is damaged (bad local header for ' + this.name + ').');
    this._start = this.localOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    return this._start;
  }

  /** Can this entry be used? For media we need stored entries; small files may be compressed. */
  usable(maxCompressed = MAX_INFLATE) {
    if (this.encrypted) return false;
    if (this.method === 0) return true;
    return this.method === 8 && this.size <= maxCompressed;
  }

  /** Returns a Blob with the entry's contents. Stored entries are a zero-copy slice. */
  async blob(type = '') {
    if (this.encrypted) throw new ZipError(this.name + ' is encrypted.');
    const start = await this._dataStart();
    const raw = this.zip.slice(start, start + this.compressedSize, type);
    if (this.method === 0) return raw;
    if (this.method !== 8) throw new ZipError(this.name + ' uses ' + this.methodName + ' compression, which is not supported.');
    if (this.size > MAX_INFLATE) throw new ZipError(this.name + ' is compressed and too large to unpack in memory.');
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return new Blob([buf], { type });
  }
}
