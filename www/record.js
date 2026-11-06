// Recording sound into a file, like the desktop `record`: a microphone or any input
// (getUserMedia), or the sound of a tab / the screen (getDisplayMedia, the browser
// asks what to share). MediaRecorder encodes while recording (Opus or AAC), so a long
// recording costs no memory beyond the compressed file.

const TYPES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
export const canRecordDisplay = () => !!navigator.mediaDevices?.getDisplayMedia;

/** Audio inputs ([deviceId, label]); labels appear once the page has had microphone access. */
export async function inputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => [d.deviceId, d.label || `Вход ${i + 1}`]);
  } catch {
    return [];
  }
}

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export class Recorder {
  /** source: 'display' or an audio input id ('' = the default input). */
  async start(source, onEnd) {
    let stream;
    if (source === 'display') {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by browsers; it is dropped right away
        audio: { ...RAW, suppressLocalAudioPlayback: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('браузер не передал звук: в окне выбора включите «Поделиться звуком» (Chrome/Edge: вкладка или весь экран)');
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: source ? { ...RAW, deviceId: { exact: source } } : RAW });
    }
    this.stream = stream;
    const audio = new MediaStream(stream.getAudioTracks());
    for (const t of stream.getTracks()) t.onended = () => this.recorder?.state !== 'inactive' && onEnd?.();
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.ctx.createMediaStreamSource(audio).connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.recorder = new MediaRecorder(audio, { mimeType: this.mime || undefined, audioBitsPerSecond: 256000 });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(1000);
    this.elapsed = 0;
    this.since = performance.now();
    this.peakHold = 0;
  }

  get paused() { return this.recorder?.state === 'paused'; }

  /** Seconds recorded (pauses excluded). */
  time() {
    return (this.elapsed + (this.paused ? 0 : performance.now() - this.since)) / 1000;
  }

  /** Peak level 0..1 of the last ~40 ms, with a short hold. */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (const v of this.buf) p = Math.max(p, Math.abs(v));
    this.peakHold = Math.max(p, this.peakHold * 0.92);
    return Math.min(1, this.peakHold);
  }

  pause() {
    if (this.recorder?.state !== 'recording') return;
    this.recorder.pause();
    this.elapsed += performance.now() - this.since;
  }

  resume() {
    if (!this.paused) return;
    this.recorder.resume();
    this.since = performance.now();
  }

  /** Stops and resolves to { blob, ext, seconds }. */
  stop() {
    const seconds = this.time();
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || this.mime || 'audio/webm';
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        resolve({ blob: new Blob(this.chunks, { type: type.split(';')[0] }), ext, seconds });
        this.close();
      };
      if (this.recorder.state === 'inactive') this.recorder.onstop();
      else this.recorder.stop();
    });
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.analyser = null;
  }
}
