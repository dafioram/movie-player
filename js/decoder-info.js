// Works out whether video is decoded in hardware or software, and why. Chrome doesn't tell a page
// which decoder it picked, so this asks two questions about the exact stream: would it decode
// power-efficiently (Media Capabilities), and is a hardware decoder available (WebCodecs).

let gpuInfo = null;

/** Detects whether Chrome is rendering with a software GPU (hardware acceleration off). */
export function gpu() {
  if (gpuInfo) return gpuInfo;
  let renderer = null;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
  } catch { /* no WebGL */ }
  const software = !renderer || /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(renderer);
  gpuInfo = { renderer, software };
  return gpuInfo;
}

async function capabilities(contentType, width, height, framerate, bitrate) {
  try {
    const r = await navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: { contentType, width, height, framerate: framerate || 30, bitrate: Math.round(bitrate || 5e6) },
    });
    return r;
  } catch {
    return null;
  }
}

async function hardwareDecoder(codec, width, height, description) {
  try {
    const cfg = { codec, codedWidth: width, codedHeight: height, hardwareAcceleration: 'prefer-hardware' };
    if (description) cfg.description = description;
    const r = await VideoDecoder.isConfigSupported(cfg);
    return !!r.supported;
  } catch {
    return false;
  }
}

/**
 * Returns {hardware: true|false|null, label, reason}.
 * stream: {codec ('avc', 'hevc', ...), codecString, width, height, fps, bitrate, description}
 */
export async function decodeReport(stream) {
  const g = gpu();
  const { codecString, width, height, fps, bitrate, description } = stream;
  if (g.software) {
    return { hardware: false, label: 'Software', reason: 'Hardware acceleration is off in Chrome. Turn on Settings → System → "Use graphics acceleration when available", then restart Chrome.' };
  }
  const caps = await capabilities(`video/mp4; codecs="${codecString}"`, width, height, fps, bitrate);
  const hw = await hardwareDecoder(codecString, width, height, description);
  if (caps && caps.powerEfficient && hw) return { hardware: true, label: 'Hardware (reported by Chrome)', reason: null };
  if (stream.codec === 'hevc' && !hw) {
    return { hardware: false, label: "Can't play", reason: 'Chrome has no software HEVC decoder, and the GPU has no decoder for this HEVC profile.' };
  }
  let reason;
  if (width * height > 4096 * 2304 || (fps && fps > 61)) reason = `The resolution or frame rate (${width}×${height}${fps ? ' @ ' + fps.toFixed(fps % 1 ? 2 : 0) + ' fps' : ''}) is above what the GPU decoder supports.`;
  else reason = `The GPU has no decoder for this codec or profile (${codecString}).`;
  if (hw && caps && !caps.powerEfficient) {
    return { hardware: null, label: 'Probably hardware', reason: 'Chrome reports a hardware decoder but says decoding may not be power efficient.' };
  }
  return { hardware: false, label: 'Software', reason };
}

/** For converted MPEG-1/2: decode is software (wasm); is the H.264 encoder hardware? */
export async function conversionReport(spec, width, height) {
  let hwEncode = false;
  try {
    const r = await VideoEncoder.isConfigSupported({ codec: spec.encoderCodec, width, height, bitrate: spec.bitrate, framerate: spec.framerate, hardwareAcceleration: 'prefer-hardware' });
    hwEncode = !!r.supported;
  } catch { /* unknown */ }
  const play = await decodeReport({ codec: 'avc', codecString: spec.encoderCodec, width, height, fps: spec.framerate, bitrate: spec.bitrate });
  return {
    hardware: false,
    label: 'Converted: software MPEG-2 decode, H.264 re-encode',
    encoder: hwEncode ? 'Hardware H.264 encoder' : 'Software H.264 encoder',
    playback: play.label,
    reason: 'Chrome has no MPEG-2 decoder, so the video is decoded in software and re-encoded as H.264 on the fly.',
  };
}
