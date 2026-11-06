// Export: video (MP4: H.264, HEVC, AV1 or VP9 + AAC/Opus), audio only (WAV or M4A)
// and single frames (PNG). The wasm module renders each video frame offscreen at
// the export size and converts it to NV12 on the GPU; WebCodecs encodes and
// mp4-muxer writes the file. Frames are rendered one by one with a few in flight,
// so the export runs as fast as the GPU and encoder allow, with no dropped frames.
import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from './vendor/mp4-muxer.mjs';

/** Frames in flight between GPU render and encoder. */
const RING = 4;
/** Matches shaders/nv12.wgsl: BT.709, limited range. */
const COLOR = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
const AUDIO_CHUNK = 4096;

export const CODECS = [
  ['avc', 'H.264 — работает везде'],
  ['hevc', 'HEVC (H.265) — меньше файл'],
  ['av1', 'AV1 — самый компактный'],
  ['vp9', 'VP9'],
];
export const QUALITY = [['1', 'стандарт (как советует YouTube)'], ['1.6', 'высокое'], ['2.5', 'максимум']];

/** Frame size for a quality given by the short side, as on desktop. */
export function frameSize(aspect, short) {
  const even4 = (v) => Math.round(v / 4) * 4;
  const long = even4((short * 16) / 9);
  return aspect === 'tall' ? [short, long] : aspect === 'square' ? [short, short] : [long, short];
}

/** YouTube's recommended SDR bitrates, the same table as the desktop export. */
function bitrate(w, h, fps) {
  const px = w * h;
  const base = px <= 1280 * 720 ? 5e6 : px <= 1920 * 1080 ? 8e6 : px <= 2560 * 1440 ? 16e6 : 45e6;
  return fps > 30 ? base * 1.5 : base;
}

/** Lowest H.264 level that fits the frame size and macroblock rate. */
function avcLevel(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const levels = [
    [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240],
    [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600],
  ];
  for (const [level, frame, rate] of levels) if (mbs <= frame && mbs * fps <= rate) return level;
  return 0x34;
}

/** Codec strings to try for a codec at a size, best first. */
function codecStrings(codec, w, h, fps) {
  const big = w * h > 1920 * 1088;
  switch (codec) {
    case 'hevc': return [big ? 'hvc1.1.6.L153.B0' : 'hvc1.1.6.L123.B0', 'hev1.1.6.L153.B0'];
    case 'av1': return [big ? 'av01.0.13M.08' : 'av01.0.09M.08', 'av01.0.13M.08'];
    case 'vp9': return [big ? 'vp09.00.51.08' : 'vp09.00.41.08'];
    default: {
      const level = avcLevel(w, h, fps).toString(16);
      return ['6400', '4d00', '4200'].map((p) => `avc1.${p}${level}`);
    }
  }
}

async function videoConfig(codec, w, h, fps, quality) {
  for (const c of codecStrings(codec, w, h, fps)) {
    const config = { codec: c, width: w, height: h, framerate: fps, bitrate: Math.round(bitrate(w, h, fps) * quality), latencyMode: 'quality' };
    if (codec === 'avc') config.avc = { format: 'avc' };
    if (codec === 'hevc') config.hevc = { format: 'hevc' };
    const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({}));
    if (supported) return config;
  }
  return null;
}

/** Codecs this browser can encode (checked at 1080p60). */
export async function supportedCodecs() {
  if (!('VideoEncoder' in window)) return [];
  const out = [];
  for (const [codec] of CODECS) if (await videoConfig(codec, 1920, 1080, 60, 1)) out.push(codec);
  return out;
}

async function audioConfig(rate, channels) {
  const candidates = [
    ['aac', 'mp4a.40.2', rate, 192000], ['aac', 'mp4a.40.2', 48000, 192000], ['aac', 'mp4a.40.2', 44100, 192000],
    ['opus', 'opus', 48000, 160000],
  ];
  if ('AudioEncoder' in window) {
    for (const [mux, codec, sampleRate, bitrate] of candidates) {
      const config = { codec, sampleRate, numberOfChannels: channels, bitrate };
      const { supported } = await AudioEncoder.isConfigSupported(config).catch(() => ({}));
      if (supported) return { config, mux };
    }
  }
  throw new Error('браузер не может закодировать звук ни в AAC, ни в Opus');
}

// ---- audio preparation: fragment, resampling, fades, loudness ----

/** Gain envelope of the fragment's fades at `local` seconds into a fragment of `dur`. */
export function fadeGain(local, dur, fadeIn, fadeOut) {
  let g = 1;
  if (fadeIn > 0) g = Math.min(g, local / fadeIn);
  if (fadeOut > 0) g = Math.min(g, (dur - local) / fadeOut);
  return Math.max(0, Math.min(1, g));
}

function biquad(x, [b0, b1, b2, a0, a1, a2]) {
  const y = new Float32Array(x.length);
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Integrated loudness (LUFS, ITU-R BS.1770-4 with gating) of channel planes. */
export function loudness(planes, rate) {
  const shelf = (() => {
    const A = 10 ** (4 / 40), w = (2 * Math.PI * 1500) / rate, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), s = 2 * Math.sqrt(A) * al;
    return [A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s), A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s];
  })();
  const hp = (() => {
    const w = (2 * Math.PI * 38) / rate, c = Math.cos(w), al = Math.sin(w) / (2 * 0.5);
    return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al];
  })();
  const k = planes.map((p) => biquad(biquad(p, shelf), hp));
  const block = Math.round(0.4 * rate), step = Math.round(0.1 * rate);
  const z = [];
  for (let o = 0; o + block <= k[0].length; o += step) {
    let sum = 0;
    for (const ch of k) { let s = 0; for (let i = o; i < o + block; i++) s += ch[i] * ch[i]; sum += s / block; }
    z.push(sum);
  }
  const lufs = (v) => -0.691 + 10 * Math.log10(Math.max(v, 1e-12));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const abs = z.filter((v) => lufs(v) > -70);
  if (!abs.length) return -Infinity;
  const rel = lufs(mean(abs)) - 10;
  return lufs(mean(abs.filter((v) => lufs(v) > rel)));
}

/**
 * The fragment [a, b] of `buffer` as channel planes at `rate`, with fades and
 * (optionally) a static gain to −14 LUFS, capped so peaks stay under −1 dBFS.
 */
export async function prepareAudio(buffer, a, b, rate, channels, fadeIn, fadeOut, normalize) {
  const dur = b - a;
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil(dur * rate)), rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0, a, dur);
  const out = await ctx.startRendering();
  const planes = Array.from({ length: channels }, (_, c) => out.getChannelData(c));
  let gain = 1, measured = null;
  if (normalize) {
    measured = loudness(planes, rate);
    if (Number.isFinite(measured)) {
      let peak = 0;
      for (const p of planes) for (let i = 0; i < p.length; i++) { const v = Math.abs(p[i]); if (v > peak) peak = v; }
      gain = Math.min(10 ** ((-14 - measured) / 20), peak > 0 ? 10 ** (-1 / 20) / peak : 1);
    }
  }
  if (gain !== 1 || fadeIn > 0 || fadeOut > 0) {
    for (const p of planes) {
      for (let i = 0; i < p.length; i++) p[i] *= gain * fadeGain(i / rate, dur, fadeIn, fadeOut);
    }
  }
  return { planes, rate, frames: out.length, gain, measured };
}

// ---- saving ----

/** Asks where to save (Chrome/Edge) — must be called straight from a click. */
export async function pickFile(name, description, mime, ext) {
  if (!window.showSaveFilePicker) return undefined;
  try {
    return await showSaveFilePicker({ suggestedName: name, types: [{ description, accept: { [mime]: [ext] } }] });
  } catch (e) {
    if (e.name === 'AbortError') return null; // the user closed the dialog
    return undefined; // not allowed here: fall back to a download
  }
}

export async function saveBlob(handle, blob, name) {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function wav(planes, rate) {
  const ch = planes.length, n = planes[0].length;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const out = new Int16Array(buf, 44);
  for (let i = 0, o = 0; i < n; i++) {
    for (let c = 0; c < ch; c++, o++) {
      const d = (Math.random() - Math.random()) / 32768; // TPDF dither
      out[o] = Math.max(-32768, Math.min(32767, Math.round((planes[c][i] + d) * 32767)));
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- jobs ----

const tick = () => new Promise((r) => setTimeout(r, 1));

function encodeAudio(ae, prepared, pos, until) {
  const { planes, rate, frames } = prepared;
  const ch = planes.length;
  until = Math.min(until, frames);
  while (pos < until) {
    const n = Math.min(AUDIO_CHUNK, frames - pos);
    const data = new Float32Array(n * ch);
    planes.forEach((p, c) => data.set(p.subarray(pos, pos + n), c * n));
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((pos * 1e6) / rate), data });
    ae.encode(ad);
    ad.close();
    pos += n;
  }
  return pos;
}

/**
 * Video export. `job` = { cancelled }; `o` = { viz, buffer, a, b, fadeIn, fadeOut,
 * normalize, w, h, fps, codec, quality, handle, name, overlay: { rgba, rects },
 * layers(t) -> Float32Array, report(done, total) }.
 */
export async function exportVideo(job, o) {
  const vcfg = await videoConfig(o.codec, o.w, o.h, o.fps, o.quality);
  if (!vcfg) throw new Error(`браузер не может закодировать ${o.codec.toUpperCase()} ${o.w}×${o.h} ${o.fps} к/с`);
  const channels = Math.min(2, o.buffer.numberOfChannels);
  const { config: acfg, mux } = await audioConfig(o.buffer.sampleRate, channels);
  const audio = await prepareAudio(o.buffer, o.a, o.b, acfg.sampleRate, channels, o.fadeIn, o.fadeOut, o.normalize);

  let target, writable = null;
  if (o.handle) {
    writable = await o.handle.createWritable();
    target = new FileSystemWritableFileStreamTarget(writable);
  } else {
    target = new ArrayBufferTarget();
  }
  const muxer = new Muxer({
    target,
    video: { codec: o.codec, width: o.w, height: o.h, frameRate: o.fps },
    audio: { codec: mux, numberOfChannels: channels, sampleRate: acfg.sampleRate },
    fastStart: writable ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure = null;
  const fail = (e) => (failure ??= e);
  const ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: fail });
  ve.configure(vcfg);
  const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: fail });
  ae.configure(acfg);

  const dur = o.b - o.a;
  const total = Math.max(1, Math.round(dur * o.fps));
  const { viz, w, h, fps } = o;
  const bytes = viz.export_start(w, h, RING, o.overlay.rgba ?? new Uint8Array());
  const frame = new Uint8Array(bytes); // VideoFrame copies it, so one buffer is enough
  const pending = new Array(RING);
  const keyEvery = fps * 2;
  const emit = async (i) => {
    const slot = i % RING;
    await pending[slot];
    pending[slot] = undefined;
    viz.export_read(slot, frame);
    const vf = new VideoFrame(frame, {
      format: 'NV12', codedWidth: w, codedHeight: h, colorSpace: COLOR,
      timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps),
    });
    ve.encode(vf, { keyFrame: i % keyEvery === 0 });
    vf.close();
  };

  let aPos = 0, lastReport = 0;
  try {
    for (let i = 0; i < total && !job.cancelled; i++) {
      if (failure) throw failure;
      if (i >= RING) await emit(i - RING);
      while (ve.encodeQueueSize > 8 || ae.encodeQueueSize > 32) await tick();
      // Audio goes in alongside the video, about a second ahead, so the file interleaves.
      aPos = encodeAudio(ae, audio, aPos, Math.ceil((i / fps + 1) * audio.rate));
      const local = i / fps, t = o.a + local;
      const fade = fadeGain(local, dur, o.fadeIn, o.fadeOut);
      pending[i % RING] = viz.export_frame(i, t, i % RING, fade, local / dur, o.layers(t));
      if (performance.now() - lastReport > 200) {
        lastReport = performance.now();
        o.report(Math.max(0, i - RING + 1), total);
      }
    }
    if (!job.cancelled) {
      for (let i = Math.max(0, total - RING); i < total; i++) await emit(i);
      o.report(total, total);
    }
  } finally {
    await Promise.allSettled(pending);
    viz.export_end();
  }

  if (job.cancelled) {
    ve.close();
    ae.close();
    await writable?.abort().catch(() => {});
    return null;
  }
  encodeAudio(ae, audio, aPos, audio.frames);
  await Promise.all([ve.flush(), ae.flush()]);
  if (failure) throw failure;
  ve.close();
  ae.close();
  muxer.finalize();
  if (writable) await writable.close();
  else await saveBlob(null, new Blob([target.buffer], { type: 'video/mp4' }), o.name);
  return { measured: audio.measured, gain: audio.gain, codec: vcfg.codec };
}

/** Audio-only export of the fragment: WAV (lossless, 16-bit) or M4A (AAC). */
export async function exportAudio(o) {
  const channels = Math.min(2, o.buffer.numberOfChannels);
  if (o.format === 'wav') {
    const audio = await prepareAudio(o.buffer, o.a, o.b, o.buffer.sampleRate, channels, o.fadeIn, o.fadeOut, o.normalize);
    await saveBlob(o.handle, wav(audio.planes, audio.rate), o.name);
    return audio;
  }
  const { config, mux } = await audioConfig(o.buffer.sampleRate, channels);
  const audio = await prepareAudio(o.buffer, o.a, o.b, config.sampleRate, channels, o.fadeIn, o.fadeOut, o.normalize);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, audio: { codec: mux, numberOfChannels: channels, sampleRate: config.sampleRate }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let failure = null;
  const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failure ??= e) });
  ae.configure(config);
  encodeAudio(ae, audio, 0, audio.frames);
  await ae.flush();
  if (failure) throw failure;
  ae.close();
  muxer.finalize();
  await saveBlob(o.handle, new Blob([target.buffer], { type: 'audio/mp4' }), o.name);
  return audio;
}

/** One frame as PNG at w×h. */
export async function exportPng(o) {
  const rgba = await o.viz.snapshot(o.w, o.h, o.t, o.fade, o.progress, o.layers, o.overlay.rgba ?? new Uint8Array());
  const c = new OffscreenCanvas(o.w, o.h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), o.w, o.h), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  await saveBlob(o.handle, blob, o.name);
}
