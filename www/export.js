// MP4 export: the wasm module renders each frame offscreen at the export size and
// converts it to NV12 on the GPU; WebCodecs encodes H.264 + AAC (or Opus) and
// mp4-muxer writes the file. Runs as fast as the GPU and encoder allow, frame by
// frame, so there are no dropped frames whatever the speed.
import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from './vendor/mp4-muxer.mjs';

const $ = (id) => document.getElementById(id);

/** Frames in flight between GPU render and encoder. */
const RING = 3;
/** Matches shaders/nv12.wgsl: BT.709, limited range. */
const COLOR = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
/** Audio is fed to the encoder in chunks of this many sample frames. */
const AUDIO_CHUNK = 4096;

/** Frame size for a quality given by the short side, as on desktop. */
export function frameSize(aspect, short) {
  const long = Math.round((short * 16) / 9);
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

async function videoConfig(w, h, fps) {
  const level = avcLevel(w, h, fps).toString(16);
  for (const profile of ['6400', '4d00', '4200']) {
    const config = { codec: `avc1.${profile}${level}`, width: w, height: h, framerate: fps, bitrate: bitrate(w, h, fps), avc: { format: 'avc' } };
    const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({}));
    if (supported) return config;
  }
  throw new Error(`браузер не может закодировать H.264 ${w}×${h} ${fps} к/с`);
}

async function audioConfig(rate, channels) {
  const candidates = [
    ['aac', 'mp4a.40.2', rate, 192000], ['aac', 'mp4a.40.2', 48000, 192000], ['aac', 'mp4a.40.2', 44100, 192000],
    ['opus', 'opus', 48000, 160000],
  ];
  for (const [mux, codec, sampleRate, bitrate] of candidates) {
    const config = { codec, sampleRate, numberOfChannels: channels, bitrate };
    const { supported } = await AudioEncoder.isConfigSupported(config).catch(() => ({}));
    if (supported) return { config, mux };
  }
  throw new Error('браузер не может закодировать звук ни в AAC, ни в Opus');
}

/** The track at another sample rate, for encoders that don't take the original one. */
async function resample(buffer, rate, channels) {
  if (buffer.sampleRate === rate && buffer.numberOfChannels === channels) return buffer;
  const ctx = new OfflineAudioContext(channels, Math.ceil(buffer.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const tick = () => new Promise((r) => setTimeout(r, 2));

/**
 * Wires up the export panel. `track()` returns `{ buffer, name }` of the loaded
 * track (or null); `onStart` runs before the export (the page pauses playback).
 * Returns a function that enables the panel once a track is loaded.
 */
export function setupExport({ viz, track, onStart }) {
  const start = $('ex-start'), cancel = $('ex-cancel'), bar = $('ex-progress'), note = $('ex-status');
  const inputs = [$('ex-aspect'), $('ex-res'), $('ex-fps')];
  if (!('VideoEncoder' in window) || !('AudioEncoder' in window)) {
    note.textContent = 'Этот браузер не поддерживает WebCodecs, экспорт недоступен. Нужен Chrome/Edge 94+, Safari 26+ или Firefox 130+.';
    return () => {};
  }
  let job = null;

  const busy = (on) => {
    start.disabled = on || !track();
    inputs.forEach((i) => (i.disabled = on));
    cancel.hidden = !on;
    bar.hidden = !on;
  };

  start.onclick = async () => {
    const t = track();
    if (!t || job) return;
    const [w, h] = frameSize($('ex-aspect').value, +$('ex-res').value);
    const fps = +$('ex-fps').value;
    const name = `${t.name.replace(/\.[^.]+$/, '') || 'audio-viz'}.mp4`;

    // The save dialog must open straight from the click, before any other await.
    let handle = null;
    if (window.showSaveFilePicker) {
      try {
        handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'Видео MP4', accept: { 'video/mp4': ['.mp4'] } }] });
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }

    job = { cancelled: false };
    onStart();
    busy(true);
    note.textContent = 'Подготовка…';
    const began = performance.now();
    let writable = null;
    try {
      await run(job, { viz, buffer: t.buffer, w, h, fps, handle, name, setWritable: (s) => (writable = s), report });
      if (job.cancelled) note.textContent = handle ? 'Экспорт отменён. Файл остался недописанным, его можно удалить.' : 'Экспорт отменён.';
      else note.textContent = `Готово: ${name}, ${w}×${h} ${fps} к/с, за ${clock((performance.now() - began) / 1000)}.`;
    } catch (e) {
      console.error(e);
      await writable?.abort().catch(() => {});
      note.textContent = `Ошибка экспорта: ${e.message ?? e}`;
    } finally {
      job = null;
      busy(false);
    }

    function report(done, total) {
      bar.max = total;
      bar.value = done;
      const secs = (performance.now() - began) / 1000;
      const rate = done / Math.max(secs, 1e-3);
      const eta = (total - done) / Math.max(rate, 1e-3);
      note.textContent = `${w}×${h} ${fps} к/с · кадр ${done} из ${total} · ${rate.toFixed(0)} к/с · осталось ${clock(eta)}`;
    }
  };

  cancel.onclick = () => job && (job.cancelled = true);

  return () => busy(!!job);
}

async function run(job, { viz, buffer, w, h, fps, handle, name, setWritable, report }) {
  const vcfg = await videoConfig(w, h, fps);
  const channels = Math.min(2, buffer.numberOfChannels);
  const { config: acfg, mux } = await audioConfig(buffer.sampleRate, channels);
  const audio = await resample(buffer, acfg.sampleRate, channels);

  let target, writable = null;
  if (handle) {
    writable = await handle.createWritable();
    setWritable(writable);
    target = new FileSystemWritableFileStreamTarget(writable);
  } else {
    target = new ArrayBufferTarget();
  }
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    audio: { codec: mux, numberOfChannels: channels, sampleRate: acfg.sampleRate },
    fastStart: handle ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure = null;
  const fail = (e) => (failure ??= e);
  const ve = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  ve.configure(vcfg);
  const ae = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
  ae.configure(acfg);

  // Audio goes in alongside the video, about a second ahead, so the file interleaves.
  const planes = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  let aPos = 0;
  const feedAudio = (until) => {
    until = Math.min(until, audio.length);
    while (aPos < until) {
      const n = Math.min(AUDIO_CHUNK, audio.length - aPos);
      const data = new Float32Array(n * channels);
      planes.forEach((p, c) => data.set(p.subarray(aPos, aPos + n), c * n));
      const ad = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((aPos * 1e6) / audio.sampleRate), data });
      ae.encode(ad);
      ad.close();
      aPos += n;
    }
  };

  const total = Math.max(1, Math.round(buffer.duration * fps));
  const bytes = viz.export_start(w, h, RING);
  const frame = new Uint8Array(bytes); // VideoFrame copies it, so one buffer is enough
  const pending = new Array(RING);
  const emit = async (i) => {
    const slot = i % RING;
    await pending[slot];
    pending[slot] = undefined;
    viz.export_read(slot, frame);
    const vf = new VideoFrame(frame, {
      format: 'NV12', codedWidth: w, codedHeight: h, colorSpace: COLOR,
      timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps),
    });
    ve.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
  };

  let lastReport = 0;
  try {
    for (let i = 0; i < total && !job.cancelled; i++) {
      if (failure) throw failure;
      if (i >= RING) await emit(i - RING);
      while (ve.encodeQueueSize > 8 || ae.encodeQueueSize > 32) await tick();
      feedAudio(Math.ceil((i / fps + 1) * audio.sampleRate));
      pending[i % RING] = viz.export_frame(i, i / fps, i % RING);
      if (performance.now() - lastReport > 250) {
        lastReport = performance.now();
        report(Math.max(0, i - RING + 1), total);
      }
    }
    if (!job.cancelled) {
      for (let i = Math.max(0, total - RING); i < total; i++) await emit(i);
      report(total, total);
    }
  } finally {
    await Promise.allSettled(pending);
    viz.export_end();
  }

  if (job.cancelled) {
    ve.close();
    ae.close();
    await writable?.abort().catch(() => {});
    return;
  }
  feedAudio(audio.length);
  await Promise.all([ve.flush(), ae.flush()]);
  if (failure) throw failure;
  ve.close();
  ae.close();
  muxer.finalize();
  if (writable) {
    await writable.close();
  } else {
    const url = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
