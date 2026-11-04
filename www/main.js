// The page owns decoding and playback (Web Audio); the wasm module owns analysis
// and rendering. Each animation frame passes the playback position to `render`.
import init, { Viz } from './pkg/audio_viz_web.js';
import { setupExport } from './export.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const status = (s) => ($('status').textContent = s);

// Same ranges and defaults as the desktop sliders.
const LOOK = [
  ['exposure', 'Экспозиция', -2, 2, 0],
  ['saturation', 'Насыщенность', 0, 2, 1],
  ['hue', 'Оттенок', -180, 180, 0],
  ['hue_spin', 'Вращение оттенка', -10, 10, 0],
  ['speed', 'Скорость', 0, 3, 1],
  ['reactivity', 'Реакция на звук', 0, 2, 1],
  ['bloom', 'Свечение', 0, 2, 0.8],
  ['vignette', 'Виньетка', 0, 1, 0.4],
  ['grain', 'Зерно', 0, 0.15, 0.025],
  ['aberration', 'Аберрация', 0, 2, 0.3],
  ['shake', 'Тряска на бит', 0, 1, 0],
  ['punch', 'Рывок зума', 0, 1, 0],
  ['flash', 'Вспышка', 0, 1, 0],
  ['glitch', 'Глитч', 0, 1, 0],
  ['vhs', 'VHS', 0, 1, 0],
];

let viz;
let exportReady = () => {};
const audio = { ctx: null, name: '', buffer: null, source: null, offset: 0, startedAt: 0, playing: false, duration: 0 };

function position() {
  if (!audio.buffer) return undefined;
  const t = audio.playing ? audio.offset + audio.ctx.currentTime - audio.startedAt : audio.offset;
  return Math.min(t, audio.duration);
}

function play(from) {
  stop();
  audio.offset = from;
  audio.source = audio.ctx.createBufferSource();
  audio.source.buffer = audio.buffer;
  audio.source.connect(audio.ctx.destination);
  audio.source.onended = () => {
    if (audio.playing && position() >= audio.duration - 0.05) pause();
  };
  audio.source.start(0, from);
  audio.startedAt = audio.ctx.currentTime;
  audio.playing = true;
  $('play').textContent = '❚❚';
}

function stop() {
  if (audio.source) {
    audio.source.onended = null;
    audio.source.stop();
    audio.source = null;
  }
}

function pause() {
  audio.offset = position();
  stop();
  audio.playing = false;
  $('play').textContent = '▶';
}

function toggle() {
  if (!audio.buffer) return;
  if (audio.playing) pause();
  else play(audio.offset >= audio.duration - 0.05 ? 0 : audio.offset);
}

function seek(t) {
  if (!audio.buffer) return;
  if (audio.playing) play(t);
  else audio.offset = t;
}

async function openFile(file) {
  status(`Декодирование ${file.name}…`);
  audio.ctx ??= new AudioContext();
  pause();
  const t0 = performance.now();
  const buffer = await audio.ctx.decodeAudioData(await file.arrayBuffer());
  const t1 = performance.now();
  // Downmix to mono for the analysis, like the desktop decoder.
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buffer.numberOfChannels;
  }
  audio.duration = viz.load(mono, buffer.sampleRate);
  const t2 = performance.now();
  audio.buffer = buffer;
  audio.name = file.name;
  exportReady();
  $('play').disabled = $('seek').disabled = false;
  $('seek').max = audio.duration;
  $('drop').hidden = true;
  status(`${file.name} · декодирование ${Math.round(t1 - t0)} мс, анализ (wasm) ${Math.round(t2 - t1)} мс · ${viz.describe()}`);
  play(0);
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function resize() {
  // Render at device pixels, capped at 1080p like a typical preview.
  const r = canvas.getBoundingClientRect();
  const k = Math.min(devicePixelRatio, 1920 / Math.max(r.width, 1));
  const w = Math.round(r.width * k), h = Math.round(r.height * k);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    viz?.resize(w, h);
  }
}

function frame(now) {
  resize();
  const t = position();
  viz.render(t, now / 1000);
  if (t !== undefined) {
    $('time').textContent = `${clock(t)} / ${clock(audio.duration)}`;
    if (document.activeElement !== $('seek')) $('seek').value = t;
  }
  requestAnimationFrame(frame);
}

function setupUi() {
  const presets = Viz.presets();
  const select = $('preset');
  presets.forEach((name, i) => select.add(new Option(name, i)));
  const choose = (i) => {
    i = (i + presets.length) % presets.length;
    select.value = i;
    viz.set_preset(i);
  };
  select.onchange = () => choose(+select.value);

  for (const [key, label, min, max, def] of LOOK) {
    const row = document.createElement('label');
    row.className = 'slider';
    row.innerHTML = `${label}<span></span><input type="range" min="${min}" max="${max}" step="${(max - min) / 200}" value="${def}">`;
    const input = row.querySelector('input'), value = row.querySelector('span');
    const apply = () => {
      viz.set_look(key, +input.value);
      value.textContent = (+input.value).toFixed(2);
    };
    input.oninput = apply;
    input.ondblclick = () => { input.value = def; apply(); };
    apply();
    $('sliders').append(row);
  }

  $('play').onclick = toggle;
  $('seek').oninput = () => seek(+$('seek').value);
  canvas.onclick = toggle;
  $('file').onchange = (e) => e.target.files[0] && openFile(e.target.files[0]);

  const stage = $('stage');
  addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('over'); });
  addEventListener('dragleave', () => stage.classList.remove('over'));
  addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    switch (e.code) {
      case 'Space': e.preventDefault(); toggle(); break;
      case 'ArrowLeft': seek(Math.max(0, (position() ?? 0) - 5)); break;
      case 'ArrowRight': seek(Math.min(audio.duration, (position() ?? 0) + 5)); break;
      case 'KeyN': choose(+select.value + 1); break;
      case 'KeyP': choose(+select.value - 1); break;
    }
  });
}

async function main() {
  if (!navigator.gpu) {
    status('Этот браузер не поддерживает WebGPU. Нужен Chrome/Edge 113+, Safari 26+ или Firefox 141+ (Windows).');
    return;
  }
  await init();
  resize();
  try {
    viz = await Viz.create(canvas);
  } catch (e) {
    status(`Не удалось запустить WebGPU: ${e}`);
    return;
  }
  setupUi();
  exportReady = setupExport({ viz, track: () => audio.buffer && { buffer: audio.buffer, name: audio.name }, onStart: () => audio.playing && pause() });
  status(`GPU: ${viz.describe()} · откройте трек`);
  requestAnimationFrame(frame);
}

main();
