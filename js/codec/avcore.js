// Loader and thin wrapper for lib/avcore/avcore.wasm (FFmpeg decoders built for wasm32-wasi).
// Works in a browser worker and in Node (for tests). The module has no threads and no file access;
// the WASI imports below are just enough for libc's start-up and FFmpeg's log output.

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function wasiImports(getMemory, log) {
  const view = () => new DataView(getMemory().buffer);
  const ENOSYS = 52, EBADF = 8;
  return {
    environ_get: () => 0,
    environ_sizes_get: (countPtr, sizePtr) => {
      view().setUint32(countPtr, 0, true);
      view().setUint32(sizePtr, 0, true);
      return 0;
    },
    clock_time_get: (_id, _precision, outPtr) => {
      const ns = BigInt(Math.round(performance.now() * 1e6));
      view().setBigUint64(outPtr, ns, true);
      return 0;
    },
    fd_close: () => 0,
    fd_fdstat_get: (fd, ptr) => {
      if (fd > 2) return EBADF;
      const v = view();
      v.setUint8(ptr, 2); // character device
      v.setUint16(ptr + 2, 0, true);
      v.setBigUint64(ptr + 8, 0n, true);
      v.setBigUint64(ptr + 16, 0n, true);
      return 0;
    },
    fd_fdstat_set_flags: () => 0,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_read: () => ENOSYS,
    fd_seek: () => ENOSYS,
    fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
      const v = view();
      const mem = new Uint8Array(getMemory().buffer);
      let total = 0;
      let text = '';
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        text += textDecoder.decode(mem.subarray(ptr, ptr + len));
        total += len;
      }
      if (text.trim() && log) log(fd, text.trimEnd());
      v.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    path_open: () => ENOSYS,
    proc_exit: (code) => { throw new Error('avcore exited with code ' + code); },
    random_get: (ptr, len) => {
      crypto.getRandomValues(new Uint8Array(getMemory().buffer, ptr, len));
      return 0;
    },
  };
}

export class AvCore {
  static async load(source, { log = null } = {}) {
    let memory = null;
    const imports = { wasi_snapshot_preview1: wasiImports(() => memory, log) };
    let instance;
    if (source instanceof WebAssembly.Module) {
      instance = await WebAssembly.instantiate(source, imports);
    } else if (source instanceof Response || (source && typeof source.then === 'function')) {
      ({ instance } = await WebAssembly.instantiateStreaming(source, imports));
    } else {
      ({ instance } = await WebAssembly.instantiate(source, imports));
    }
    memory = instance.exports.memory;
    instance.exports._initialize();
    instance.exports.ac_log_quiet(log ? 0 : 1);
    return new AvCore(instance.exports);
  }

  constructor(exports) {
    this.x = exports;
  }

  get memory() {
    return this.x.memory.buffer;
  }

  _cstring(str) {
    const bytes = textEncoder.encode(str + '\0');
    const ptr = this.x.ac_malloc(bytes.length);
    new Uint8Array(this.memory, ptr, bytes.length).set(bytes);
    return ptr;
  }

  _readCString(ptr) {
    const mem = new Uint8Array(this.memory);
    let end = ptr;
    while (mem[end]) end++;
    return textDecoder.decode(mem.subarray(ptr, end));
  }

  /**
   * Opens a decoder by FFmpeg name (e.g. 'mpeg2video', 'ac3', 'dca', 'truehd', 'pcm_dvd').
   * useParser: true when packets are arbitrary chunks of an elementary stream (MPEG-PS/TS),
   * false when every packet is one whole frame (MKV, MP4).
   */
  openDecoder(name, { extradata = null, sampleRate = 0, channels = 0, useParser = false, deinterlace = false } = {}) {
    const namePtr = this._cstring(name);
    let exPtr = 0, exLen = 0;
    if (extradata && extradata.length) {
      exLen = extradata.length;
      exPtr = this.x.ac_malloc(exLen);
      new Uint8Array(this.memory, exPtr, exLen).set(extradata);
    }
    const handle = this.x.ac_open(namePtr, exPtr, exLen, sampleRate, channels, useParser ? 1 : 0, deinterlace ? 1 : 0);
    this.x.ac_free(namePtr);
    if (exPtr) this.x.ac_free(exPtr);
    if (!handle) throw new Error('Decoder "' + name + '" could not be opened');
    return new Decoder(this, handle);
  }
}

class Decoder {
  constructor(core, handle) {
    this.core = core;
    this.h = handle;
    this.x = core.x;
    this.bufPtr = 0;
    this.bufCap = 0;
  }

  /** Feeds bytes. ptsUs: presentation time in microseconds, or -1 when unknown. */
  send(bytes, ptsUs = -1, key = false) {
    if (bytes.length > this.bufCap) {
      if (this.bufPtr) this.x.ac_free(this.bufPtr);
      this.bufCap = Math.max(bytes.length, 65536);
      this.bufPtr = this.x.ac_malloc(this.bufCap);
    }
    new Uint8Array(this.core.memory, this.bufPtr, bytes.length).set(bytes);
    this.x.ac_send(this.h, this.bufPtr, bytes.length, ptsUs == null ? -1 : ptsUs, key ? 1 : 0);
  }

  flushEnd() {
    this.x.ac_flush_end(this.h);
  }

  reset() {
    this.x.ac_reset(this.h);
  }

  get error() {
    return this.core._readCString(this.x.ac_error(this.h));
  }

  /** Returns the next decoded video frame or null. Planes are copies (I420, tightly packed). */
  receiveVideo() {
    if (!this.x.ac_receive(this.h)) return null;
    const x = this.x, h = this.h;
    const width = x.ac_v_width(h), height = x.ac_v_height(h);
    const cw = (width + 1) >> 1, ch = (height + 1) >> 1;
    const out = new Uint8Array(width * height + 2 * cw * ch);
    const mem = new Uint8Array(this.core.memory);
    let o = 0;
    for (let p = 0; p < 3; p++) {
      const ptr = x.ac_v_data(h, p), stride = x.ac_v_stride(h, p);
      const w = p ? cw : width, hh = p ? ch : height;
      for (let y = 0; y < hh; y++) {
        out.set(mem.subarray(ptr + y * stride, ptr + y * stride + w), o);
        o += w;
      }
    }
    return {
      data: out,
      width,
      height,
      ptsUs: x.ac_v_pts(h),
      durationUs: x.ac_v_duration(h),
      sarNum: x.ac_v_sar_num(h),
      sarDen: x.ac_v_sar_den(h),
      repeat: x.ac_v_repeat(h),
      key: !!x.ac_v_key(h),
    };
  }

  /** Returns the next decoded audio frame as planar Float32Arrays, or null. */
  receiveAudio() {
    if (!this.x.ac_receive(this.h)) return null;
    const x = this.x, h = this.h;
    const n = x.ac_a_samples(h), channels = x.ac_a_channels(h);
    const ptr = x.ac_a_data(h);
    const all = new Float32Array(this.core.memory, ptr, n * channels);
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(all.slice(c * n, (c + 1) * n));
    return { planes, samples: n, channels, sampleRate: x.ac_a_rate(h), ptsUs: x.ac_a_pts(h) };
  }

  info() {
    const x = this.x, h = this.h;
    return {
      width: x.ac_c_width(h),
      height: x.ac_c_height(h),
      fpsNum: x.ac_c_fps_num(h),
      fpsDen: x.ac_c_fps_den(h),
      profile: x.ac_c_profile(h),
      interlaced: !!x.ac_c_interlaced(h),
    };
  }

  close() {
    if (this.bufPtr) this.x.ac_free(this.bufPtr);
    this.bufPtr = 0;
    this.x.ac_close(this.h);
    this.h = 0;
  }
}
