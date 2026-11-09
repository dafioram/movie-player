// Main-thread side of the codec workers. The wasm module is compiled once here and shared.

const WASM_URL = new URL('../../lib/avcore/avcore.wasm', import.meta.url);
const WORKER_URL = new URL('./worker.js', import.meta.url);

let modulePromise = null;
function wasmModule() {
  if (!modulePromise) {
    modulePromise = WebAssembly.compileStreaming(fetch(WASM_URL)).catch((e) => {
      modulePromise = null;
      throw new Error('Could not load the decoder module (' + e.message + ')');
    });
  }
  return modulePromise;
}

class CodecWorker {
  constructor(name) {
    this.name = name;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
  }

  async _start() {
    if (!this.ready) {
      this.ready = (async () => {
        const module = await wasmModule();
        this.worker = new Worker(WORKER_URL, { type: 'module', name: 'codec-' + this.name });
        this.worker.onmessage = (e) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (e.data.ok) p.resolve(e.data.result);
          else p.reject(new Error(e.data.error));
        };
        this.worker.onerror = (e) => {
          for (const p of this.pending.values()) p.reject(new Error('Codec worker failed: ' + (e.message || 'unknown error')));
          this.pending.clear();
        };
        await this._send({ type: 'init', module });
      })();
    }
    return this.ready;
  }

  _send(msg, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async call(msg, transfer = []) {
    await this._start();
    return this._send(msg, transfer);
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('stopped'));
    this.pending.clear();
    this.worker = null;
    this.ready = null;
  }
}

let sidCounter = 1;

/** A conversion session living in one worker. */
export class ConvertSession {
  constructor(worker, spec) {
    this.worker = worker;
    this.spec = spec;
    this.sid = sidCounter++;
    this.opened = null;
  }

  open() {
    if (!this.opened) this.opened = this.worker.call({ type: 'open', sid: this.sid, spec: this.spec });
    return this.opened;
  }

  /** packets: [{data: Uint8Array, ptsUs, key}] (data buffers are transferred) */
  async feed(packets, end = false) {
    await this.open();
    const list = packets.map((p) => {
      const data = p.data.byteOffset === 0 && p.data.byteLength === p.data.buffer.byteLength ? p.data.buffer : p.data.slice().buffer;
      return { data, ptsUs: p.ptsUs, key: !!p.key };
    });
    return this.worker.call({ type: 'feed', sid: this.sid, packets: list, end }, list.map((p) => p.data));
  }

  async reset() {
    await this.open();
    return this.worker.call({ type: 'reset', sid: this.sid });
  }

  close() {
    if (this.opened) this.worker.call({ type: 'close', sid: this.sid }).catch(() => {});
  }
}

export class CodecClient {
  constructor() {
    this.audio = new CodecWorker('audio');
    this.video = new CodecWorker('video');
    this.misc = new CodecWorker('misc');
  }

  /** Warm up the wasm compile in the background. */
  preload() {
    wasmModule().catch(() => {});
  }

  audioSession(spec) { return new ConvertSession(this.audio, { kind: 'audio', ...spec }); }
  videoSession(spec) { return new ConvertSession(this.video, { kind: 'video', ...spec }); }

  probe(kind, codec, sample, { extradata = null, useParser = true } = {}) {
    const s = sample.slice().buffer;
    return this.misc.call({ type: 'probe', kind, codec, sample: s, extradata, useParser }, [s]);
  }

  thumb(codec, packets, { extradata = null, useParser = false, width = 160 } = {}) {
    const list = packets.map((p) => ({ data: p.data.slice().buffer, ptsUs: p.ptsUs }));
    return this.misc.call({ type: 'thumb', codec, extradata, useParser, packets: list, width }, list.map((p) => p.data));
  }

  terminate() {
    this.audio.terminate();
    this.video.terminate();
    this.misc.terminate();
  }
}
