// The page owns decoding and playback (Web Audio), the interface, text and images;
// the wasm module owns analysis, the look over time and every GPU pass. Each
// animation frame passes the playback position (and the text layer's state) to
// `render`.
import init, { Viz } from './pkg/audio_viz_web.js';
import { Timeline, computePeaks } from './timeline.js';
import { rasterize, layerStates, captionAt, newText, newLogo, ANCHORS, ANIMS, FONTS, MAX_TEXTS } from './overlay.js';
import { bitmapFrom, pixels, coverFromTags, dataUrl } from './media.js';
import { CODECS, QUALITY, frameSize, supportedCodecs, exportVideo, exportAudio, exportPng, pickFile, fadeGain, saveBlob } from './export.js';
import * as license from './license.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const status = (s) => ($('status').textContent = s);
const clock = (s, tenths = false) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${tenths ? r.toFixed(1).padStart(4, '0') : String(Math.floor(r)).padStart(2, '0')}`;
};
const parseClock = (v) => {
  const p = String(v).trim().replace(',', '.').split(':').map(Number);
  return p.some(Number.isNaN) ? NaN : p.reduce((a, x) => a * 60 + x, 0);
};
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

// Same ranges and defaults as the desktop sliders. [key, label, min, max, default, group]
const LOOK = [
  ['exposure', 'Экспозиция', -2, 2, 0, 'color'],
  ['saturation', 'Насыщенность', 0, 2, 1, 'color'],
  ['hue', 'Оттенок', -180, 180, 0, 'color'],
  ['hue_spin', 'Вращение оттенка, об/мин', -10, 10, 0, 'color'],
  ['speed', 'Скорость', 0, 3, 1, 'color'],
  ['reactivity', 'Реакция на звук', 0, 2, 1, 'color'],
  ['bloom', 'Свечение', 0, 2, 0.8, 'fx'],
  ['vignette', 'Виньетка', 0, 1, 0.4, 'fx'],
  ['grain', 'Зерно', 0, 0.15, 0.025, 'fx'],
  ['aberration', 'Аберрация', 0, 2, 0.3, 'fx'],
  ['shake', 'Тряска на бит', 0, 1, 0, 'fx'],
  ['punch', 'Рывок зума на бит', 0, 1, 0, 'fx'],
  ['flash', 'Вспышка на бит', 0, 1, 0, 'fx'],
  ['glitch', 'Глитч', 0, 1, 0, 'fx'],
  ['vhs', 'VHS', 0, 1, 0, 'fx'],
  ['bg_brightness', 'Яркость фона', 0, 2, 0.8, 'bg'],
  ['viz_opacity', 'Визуализация поверх фона', 0, 1, 1, 'bg'],
  ['bg_pulse', 'Пульс фона на бас', 0, 1, 0.3, 'bg'],
  ['cover_size', 'Размер, % высоты', 5, 40, 18, 'cover'],
  ['cover_pulse', 'Пульс на бас', 0, 2, 0.5, 'cover'],
  ['ring', 'Длина столбиков спектра', 0, 3, 1, 'cover'],
  ['bar', 'Толщина (0 — нет)', 0, 3, 0, 'bar'],
];
const COLORS = [['ring_color', 'Цвет кольца', [1, 0.45, 0.75], 'cover'], ['bar_color', 'Цвет полосы', [1, 1, 1], 'bar']];

let viz;
let pro = null; // valid license payload, or null
let exporting = false;
const audio = { ctx: null, gain: null, buffer: null, source: null, offset: 0, startedAt: 0, playing: false, duration: 0, name: '', bytes: null };
const st = {
  fragment: [0, 0], fadeIn: 0, fadeOut: 0, loop: false, sceneFade: 1.5,
  texts: [], logo: null, logoBlob: null, bgBlob: null, coverBlob: null, coverFromTags: false, circle: false,
  export: { mode: 'video', aspect: 'wide', res: '1080', fps: '60', codec: 'avc', quality: '1', loud: false },
  preview: { quality: 'auto', fps: true },
};
let dirty = true; // the paused preview needs a redraw
let overlay = { rgba: null, rects: new Array(10).fill(null), w: 0, h: 0, stale: true };
const touch = () => (dirty = true);
const overlayChanged = () => { overlay.stale = true; dirty = true; saveSoon(); };

// ---------------------------------------------------------------- playback

function position() {
  if (!audio.buffer) return undefined;
  const t = audio.playing ? audio.offset + audio.ctx.currentTime - audio.startedAt : audio.offset;
  return Math.min(Math.max(0, t), audio.duration);
}

const fragGain = (t) => {
  const [a, b] = st.fragment;
  if (t < a || t > b || (!st.fadeIn && !st.fadeOut)) return 1;
  return fadeGain(t - a, b - a, st.fadeIn, st.fadeOut);
};

/** Fades of the fragment, heard in the preview too. */
function scheduleGain(from) {
  const g = audio.gain.gain, now = audio.ctx.currentTime;
  g.cancelScheduledValues(now);
  const [, b] = st.fragment;
  if ((!st.fadeIn && !st.fadeOut) || from >= b) { g.setValueAtTime(1, now); return; }
  const span = b - from, n = Math.max(2, Math.ceil(span * 50));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = fragGain(from + (span * i) / (n - 1));
  g.setValueCurveAtTime(curve, now, span);
  g.setValueAtTime(1, now + span + 0.01);
}

function play(from) {
  stop();
  audio.offset = from;
  audio.source = audio.ctx.createBufferSource();
  audio.source.buffer = audio.buffer;
  audio.source.connect(audio.gain);
  audio.source.onended = () => {
    if (audio.playing && position() >= audio.duration - 0.05) pause();
  };
  scheduleGain(from);
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
  audio.offset = position() ?? 0;
  stop();
  audio.playing = false;
  $('play').textContent = '▶';
  touch();
}

function toggle() {
  if (!audio.buffer) return;
  if (audio.playing) pause();
  else {
    const [a, b] = st.fragment;
    const p = audio.offset >= audio.duration - 0.05 || (st.loop && (audio.offset < a || audio.offset >= b - 0.05)) ? (st.loop ? a : 0) : audio.offset;
    play(p);
  }
}

function seek(t) {
  if (!audio.buffer) return;
  t = Math.min(Math.max(0, t), audio.duration);
  if (audio.playing) play(t);
  else audio.offset = t;
  touch();
}

async function openFile(file) {
  if (exporting) return status('Дождитесь конца экспорта, потом откройте другой трек.');
  status(`Декодирование ${file.name}…`);
  audio.ctx ??= new AudioContext();
  if (!audio.gain) { audio.gain = audio.ctx.createGain(); audio.gain.connect(audio.ctx.destination); }
  if (audio.playing) pause();
  const t0 = performance.now();
  const bytes = await file.arrayBuffer();
  let buffer;
  try {
    buffer = await audio.ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return status(`Не удалось декодировать ${file.name}: браузер не знает этот формат.`);
  }
  const t1 = performance.now();
  // Downmix to mono for the analysis, like the desktop decoder.
  const mono = new Float32Array(buffer.length);
  const k = 1 / buffer.numberOfChannels;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] * k;
  }
  audio.duration = viz.load(mono, buffer.sampleRate);
  const t2 = performance.now();
  timeline.setTrack(computePeaks(mono), audio.duration);
  audio.buffer = buffer;
  audio.name = file.name;
  audio.bytes = bytes;
  audio.offset = 0;
  // Keep a fragment restored from the last session if it fits this track.
  const [a, b] = st.fragment;
  if (b > a && b <= audio.duration + 0.01 && st.trackName === file.name) setFragment(a, b, false);
  else setFragment(0, audio.duration, false);
  st.trackName = file.name;
  $('play').disabled = false;
  document.querySelectorAll('[data-needs-track]').forEach((e) => (e.disabled = false));
  $('drop').hidden = true;
  enableTrackUi();
  status(`${file.name} · декодирование ${Math.round(t1 - t0)} мс, анализ (wasm) ${Math.round(t2 - t1)} мс · ${viz.describe()}`);
  // Cover art from the tags, unless the user picked a picture.
  const tagCover = coverFromTags(bytes);
  $('cover-tags').disabled = !tagCover;
  if (tagCover && (!st.coverBlob || st.coverFromTags)) await setCover(tagCover, true);
  refreshMarkers();
  play(st.fragment[0]);
}

// ---------------------------------------------------------------- preview frame loop

const perf = { last: 0, acc: 0, n: 0, refresh: 1000 / 60, scale: 1, fast: 0, slow: 0, fps: 0, lastUi: 0 };
// A hidden or throttled tab says nothing about the GPU: start over when it comes back.
document.addEventListener('visibilitychange', () => Object.assign(perf, { scale: 1, refresh: 1000 / 60, acc: 0, n: 0, fast: 0, slow: 0 }));

function previewScale() {
  return st.preview.quality === 'auto' ? perf.scale : +st.preview.quality;
}

function resize() {
  // Render at device pixels, capped at 1080p-ish, times the preview quality.
  const r = canvas.getBoundingClientRect();
  const k = Math.min(devicePixelRatio, 1920 / Math.max(r.width, r.height, 1)) * previewScale();
  const w = Math.max(2, Math.round((r.width * k) / 2) * 2), h = Math.max(2, Math.round((r.height * k) / 2) * 2);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    viz?.resize(w, h);
    overlay.stale = true;
    dirty = true;
  }
}

/** Adaptive preview resolution: lower it when frames come late, raise it back when there's headroom. */
function adapt(now) {
  const dt = now - perf.last;
  perf.last = now;
  if (dt <= 0 || dt > 250) return;
  perf.refresh = Math.min(perf.refresh * 1.002, Math.max(dt, 4)); // ~ the display's frame time
  perf.acc += dt;
  if (++perf.n < 30) return;
  const avg = perf.acc / perf.n;
  perf.acc = perf.n = 0;
  perf.fps = 1000 / avg;
  if (st.preview.quality !== 'auto' || !audio.playing) return;
  if (avg > perf.refresh * 1.3 && perf.scale > 0.35) {
    // Two slow windows in a row, so one hiccup (a GC, a shader compile) doesn't count.
    if (++perf.slow >= 2) { perf.scale = Math.max(0.35, perf.scale * 0.85); perf.slow = 0; }
    perf.fast = 0;
  } else if (avg < perf.refresh * 1.1 && perf.scale < 1 && ++perf.fast >= 4) { perf.scale = Math.min(1, perf.scale * 1.12); perf.fast = perf.slow = 0; }
  else perf.slow = 0;
}

function updateOverlay() {
  if (!overlay.stale) return;
  overlay.stale = false;
  const { rgba, rects } = rasterize({ texts: st.texts, logo: st.logo, watermark: false }, canvas.width, canvas.height);
  overlay = { rgba, rects, w: canvas.width, h: canvas.height, stale: false };
  viz.set_overlay(rgba ?? new Uint8Array(), canvas.width, canvas.height);
}

const layerBuf = new Float32Array(80);
function frame(now) {
  requestAnimationFrame(frame);
  adapt(now);
  if (exporting) return; // leave the GPU to the export
  resize();
  const t = position();
  if (t !== undefined && audio.playing && st.loop && t >= st.fragment[1] - 0.01) play(st.fragment[0]);
  const live = !audio.buffer || audio.playing || dirty;
  if (live) {
    updateOverlay();
    const tt = t ?? now / 1000;
    const layers = layerStates(st.texts, overlay.rects, canvas.height, tt, st.fragment, layerBuf);
    const [a, b] = st.fragment;
    const progress = t !== undefined && b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : NaN;
    viz.render(t, now / 1000, t !== undefined ? fragGain(t) : 1, progress, layers);
    dirty = false;
  }
  timeline.draw();
  if (now - perf.lastUi > 120) {
    perf.lastUi = now;
    uiTick(t);
  }
}

function uiTick(t) {
  if (t !== undefined) $('time').textContent = `${clock(t)} / ${clock(audio.duration)}`;
  const fps = st.preview.fps ? ` · ${audio.playing ? Math.round(perf.fps) + ' к/с' : 'пауза'} · ${canvas.width}×${canvas.height}${st.preview.quality === 'auto' ? ` (авто ${Math.round(perf.scale * 100)}%)` : ''}` : '';
  $('frag').textContent = audio.buffer ? `фрагмент ${clock(st.fragment[0], true)}–${clock(st.fragment[1], true)}${fps}` : fps.slice(3);
  // With keyframes the sliders follow the look at the playhead.
  if (viz.key_times().length && t !== undefined) syncSliders(t);
  const p = viz.preset_at(t);
  if (+$('preset').value !== p && document.activeElement !== $('preset')) $('preset').value = p;
  const inScene = t !== undefined && viz.scene_times().some((s) => s <= t);
  $('preset-note').textContent = inScene ? 'Курсор в сцене: выбранный пресет станет пресетом этой сцены.' : '';
}

// ---------------------------------------------------------------- sliders

const sliders = new Map(); // key -> { input, value, def, set(v) }

function addSlider(container, key, label, min, max, def, apply, fmt = (v) => v.toFixed(2)) {
  const row = document.createElement('label');
  row.className = 'slider';
  row.innerHTML = `<span class="label"></span><span></span><input type="range" min="${min}" max="${max}" step="${(max - min) / 200}" value="${def}">`;
  row.firstChild.textContent = label;
  const input = row.querySelector('input'), value = row.children[1];
  const show = (v) => (value.textContent = fmt(+v));
  input.oninput = () => { show(input.value); apply(+input.value); };
  input.ondblclick = () => { input.value = def; show(def); apply(def); };
  show(def);
  container.append(row);
  const s = { input, row, def, set: (v) => { input.value = v; show(v); } };
  sliders.set(key, s);
  return s;
}

function lookSlider(key, label, min, max, def, group) {
  const s = addSlider(document.querySelector(`[data-group="${group}"]`), key, label, min, max, def, (v) => {
    viz.set_look(key, v, position());
    touch();
    saveSoon();
  });
  s.look = true;
  viz.set_look(key, def, undefined);
}

function colorRow(key, label, def, group) {
  const row = document.createElement('label');
  row.className = 'colorrow';
  row.textContent = label;
  const input = Object.assign(document.createElement('input'), { type: 'color', value: rgbToHex(def.map(linearToSrgb)) });
  row.append(input);
  input.oninput = () => {
    const lin = hexToRgb(input.value).map(srgbToLinear);
    lin.forEach((v, i) => viz.set_look(`${key}.${i}`, v, position()));
    touch();
    saveSoon();
  };
  document.querySelector(`[data-group="${group}"]`).append(row);
  sliders.set(key, { color: true, input, set: (rgb) => (input.value = rgbToHex(rgb.map(linearToSrgb))) });
}

function syncSliders(t) {
  const keys = viz.key_times().length > 0;
  for (const [key, s] of sliders) {
    if (document.activeElement === s.input) continue;
    if (s.look) {
      s.set(viz.look_value(key, t));
      s.row.classList.toggle('keyed', keys);
    } else if (s.color) {
      s.set([0, 1, 2].map((i) => viz.look_value(`${key}.${i}`, t)));
    }
  }
}

// ---------------------------------------------------------------- fragment, keys, scenes

function setFragment(a, b, save = true) {
  const d = audio.duration || b;
  a = Math.max(0, Math.min(a, d));
  b = Math.max(a + 0.05, Math.min(b, d));
  st.fragment = [a, b];
  $('frag-a').value = clock(a, true);
  $('frag-b').value = clock(b, true);
  if (audio.playing) scheduleGain(position());
  touch();
  if (save) saveSoon();
}

function refreshMarkers() {
  const has = audio.buffer && viz.key_times().length > 0;
  for (const id of ['key-del', 'key-prev', 'key-next', 'key-clear']) $(id).disabled = !has;
  $('scene-del').disabled = !(audio.buffer && viz.scene_times().length);
  if (!has) for (const s of sliders.values()) s.row?.classList.remove('keyed');
  touch();
}

function nearestKey(t) {
  const keys = viz.key_times();
  let best = -1, bd = Infinity;
  keys.forEach((k, i) => { const d = Math.abs(k - t); if (d < bd) { bd = d; best = i; } });
  return best;
}

function addKey() {
  const t = position();
  if (t === undefined) return;
  viz.add_key(t);
  refreshMarkers();
  saveSoon();
}

function neighbourKey(dir) {
  const t = position() ?? 0;
  const keys = viz.key_times();
  const k = dir > 0 ? keys.find((x) => x > t + 0.05) : [...keys].reverse().find((x) => x < t - 0.05);
  if (k !== undefined) seek(k);
}

function currentScene(t) {
  const s = viz.scene_times();
  let i = -1;
  s.forEach((x, k) => { if (x <= t) i = k; });
  return i;
}

const timeline = new Timeline($('timeline'), {
  position,
  fragment: () => st.fragment,
  fades: () => [st.fadeIn, st.fadeOut],
  keys: () => (viz ? Array.from(viz.key_times()) : []),
  scenes: () => (viz ? Array.from(viz.scene_times()) : []),
}, {
  seek,
  selection: (a, b) => setFragment(a, b),
  keyMoved: (i, t) => { const j = viz.move_key(i, t); touch(); saveSoon(); return j; },
  keyRemoved: (i) => { viz.remove_key(i); refreshMarkers(); saveSoon(); },
  sceneMoved: (i, t) => { const j = viz.move_scene(i, t); touch(); saveSoon(); return j; },
  sceneRemoved: (i) => { viz.remove_scene(i); refreshMarkers(); saveSoon(); },
});

// ---------------------------------------------------------------- images

async function setBackground(blob) {
  st.bgBlob = blob;
  if (!blob) viz.set_background(new Uint8Array(), 0, 0);
  else {
    const p = pixels(await bitmapFrom(blob), 3840);
    viz.set_background(p.rgba, p.w, p.h);
  }
  $('bg-del').disabled = !blob;
  touch();
  saveSoon();
}

async function setCover(blob, fromTags = false) {
  st.coverBlob = blob;
  st.coverFromTags = !!blob && fromTags;
  if (blob) {
    try {
      const p = pixels(await bitmapFrom(blob), 1024, true);
      viz.set_circle(st.circle, p.rgba, p.w);
    } catch {
      st.coverBlob = null;
      viz.set_circle(st.circle, new Uint8Array(), 0);
    }
  } else viz.set_circle(st.circle, new Uint8Array(), 0);
  $('cover-del').disabled = !st.coverBlob;
  $('cover-note').textContent = st.coverBlob ? (st.coverFromTags ? 'Обложка из тегов трека.' : 'Своя картинка.') : 'Без картинки — тёмный круг.';
  touch();
  saveSoon();
}

async function setLogo(blob, props = {}) {
  st.logoBlob = blob;
  st.logo = blob ? { ...newLogo(await bitmapFrom(blob), blob.name ?? 'логотип'), ...props } : null;
  $('logo-del').disabled = !blob;
  renderLogoOpts();
  overlayChanged();
}

// ---------------------------------------------------------------- text and logo editors

function field(parent, label, el) {
  const f = document.createElement('label');
  f.className = 'field';
  f.textContent = label;
  f.append(el);
  parent.append(f);
  return el;
}

function select(options, value) {
  const s = document.createElement('select');
  for (const [v, l] of options) s.add(new Option(l, v));
  s.value = value;
  return s;
}

function miniSlider(parent, label, min, max, value, step, onChange, fmt = (v) => v.toFixed(1)) {
  const row = document.createElement('label');
  row.className = 'slider';
  row.innerHTML = `<span></span><span></span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
  row.firstChild.textContent = label;
  const input = row.querySelector('input'), out = row.children[1];
  out.textContent = fmt(value);
  input.oninput = () => { out.textContent = fmt(+input.value); onChange(+input.value); };
  parent.append(row);
}

function renderTexts() {
  const box = $('texts');
  box.textContent = '';
  st.texts.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = `<span class="grow"></span>`;
    head.firstChild.textContent = `Надпись ${i + 1}`;
    const del = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '✕', title: 'Удалить' });
    del.onclick = () => { st.texts.splice(i, 1); renderTexts(); overlayChanged(); };
    head.append(del);
    card.append(head);
    const set = (k) => (v) => { item[k] = v; overlayChanged(); };
    const text = document.createElement('textarea');
    text.value = item.text;
    text.rows = 2;
    text.placeholder = 'Исполнитель — Название';
    text.oninput = () => set('text')(text.value);
    card.append(text);
    const pos = field(card, 'Место', select(ANCHORS, item.anchor));
    pos.onchange = () => { item.offset = [0, 0]; set('anchor')(pos.value); };
    const fontList = FONTS.map((f) => [f, f.split(',')[0]]);
    if (!FONTS.includes(item.font)) fontList.push([item.font, item.font]);
    const font = field(card, 'Шрифт', select([...fontList, ['__custom', 'другой…']], item.font));
    font.onchange = () => {
      if (font.value === '__custom') {
        const name = prompt('Название шрифта, установленного на компьютере (например, «Montserrat»):', '');
        if (name) set('font')(`"${name.replace(/"/g, '')}", sans-serif`);
        renderTexts();
      } else set('font')(font.value);
    };
    miniSlider(card, 'Размер, % высоты', 1, 25, item.size, 0.1, set('size'));
    miniSlider(card, 'Отступ от края, %', 0, 25, item.margin, 0.1, set('margin'));
    miniSlider(card, 'Прозрачность', 0, 1, item.opacity, 0.01, set('opacity'), (v) => v.toFixed(2));
    const row = document.createElement('div');
    row.className = 'colorrow';
    const color = Object.assign(document.createElement('input'), { type: 'color', value: item.color });
    color.oninput = () => set('color')(color.value);
    const chk = (label, k) => {
      const l = document.createElement('label');
      l.className = 'check';
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: item[k] });
      c.onchange = () => set(k)(c.checked);
      l.append(c, label);
      return l;
    };
    row.append(color, chk('жирный', 'bold'), chk('тень', 'shadow'));
    card.append(row);
    const anim = field(card, 'Появление', select(ANIMS, item.anim));
    anim.onchange = () => set('anim')(anim.value);
    miniSlider(card, 'Длина анимации, с', 0.1, 4, item.animLen, 0.05, set('animLen'), (v) => v.toFixed(2));
    const timed = chk('показывать только в отрезке', 'timed');
    card.append(timed);
    const times = document.createElement('div');
    times.className = 'row2';
    const timeInput = (k, label) => {
      const inp = Object.assign(document.createElement('input'), { type: 'text', value: clock(item[k], true) });
      inp.onchange = () => { const v = parseClock(inp.value); if (!Number.isNaN(v)) set(k)(v); inp.value = clock(item[k], true); };
      field(times, label, inp);
    };
    timeInput('from', 'с');
    timeInput('to', 'до');
    const here = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'отрезок = фрагмент' });
    here.onclick = () => { item.from = st.fragment[0]; item.to = st.fragment[1]; item.timed = true; renderTexts(); overlayChanged(); };
    card.append(times, here);
    box.append(card);
  });
  $('text-add').disabled = st.texts.length >= MAX_TEXTS;
}

function renderLogoOpts() {
  const box = $('logo-opts');
  box.textContent = '';
  const logo = st.logo;
  if (!logo) return;
  const set = (k) => (v) => { logo[k] = v; overlayChanged(); };
  const pos = field(box, 'Место', select(ANCHORS, logo.anchor));
  pos.onchange = () => set('anchor')(pos.value);
  miniSlider(box, 'Размер, % высоты', 2, 40, logo.size, 0.1, set('size'));
  miniSlider(box, 'Отступ от края, %', 0, 20, logo.margin, 0.1, set('margin'));
  miniSlider(box, 'Прозрачность', 0, 1, logo.opacity, 0.01, set('opacity'), (v) => v.toFixed(2));
}

/** Drag captions in the preview; a click without dragging toggles playback. */
function setupCaptionDrag() {
  let drag = null;
  const px = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = px(e);
    const i = captionAt(overlay.rects, x, y);
    drag = { i, x, y, moved: false, start: i >= 0 ? [...st.texts[i].offset] : null };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = px(e);
    if (!drag) {
      canvas.style.cursor = captionAt(overlay.rects, x, y) >= 0 ? 'move' : 'pointer';
      return;
    }
    if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
    if (drag.moved && drag.i >= 0) {
      const h = canvas.height;
      st.texts[drag.i].offset = [drag.start[0] + ((x - drag.x) / h) * 100, drag.start[1] + ((y - drag.y) / h) * 100];
      overlayChanged();
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (drag && !drag.moved) toggle();
    drag = null;
  });
}

// ---------------------------------------------------------------- export

const exportName = (ext) => `${(audio.name || 'audio-viz').replace(/\.[^.]+$/, '')}${ext}`;
let job = null;

function exportBusy(on) {
  exporting = on;
  $('busy').hidden = !on;
  $('ex-start').disabled = on || !audio.buffer;
  $('ex-png').disabled = on || !audio.buffer || st.export.mode !== 'video';
  $('ex-cancel').hidden = !on || st.export.mode !== 'video';
  $('ex-progress').hidden = !on;
  for (const id of ['ex-mode', 'ex-aspect', 'ex-res', 'ex-fps', 'ex-codec', 'ex-quality', 'ex-loud']) $(id).disabled = on;
  if (!on) touch();
}

function exportSize() {
  let [w, h] = frameSize(st.export.aspect, +st.export.res);
  const max = viz.max_size();
  if (Math.max(w, h) > max) { const k = max / Math.max(w, h); w = Math.floor((w * k) / 4) * 4; h = Math.floor((h * k) / 2) * 2; }
  return [w, h];
}

async function startExport() {
  if (!audio.buffer || job) return;
  const e = st.export;
  const [a, b] = st.fragment;
  const note = $('ex-status');
  const ext = e.mode === 'video' ? '.mp4' : e.mode === 'wav' ? '.wav' : '.m4a';
  const name = exportName(ext);
  const mime = e.mode === 'video' ? 'video/mp4' : e.mode === 'wav' ? 'audio/wav' : 'audio/mp4';
  // The save dialog must open straight from the click, before any other await.
  const handle = await pickFile(name, e.mode === 'video' ? 'Видео MP4' : 'Звук', mime, ext);
  if (handle === null) return;
  job = { cancelled: false };
  if (audio.playing) pause();
  exportBusy(true);
  note.textContent = 'Подготовка…';
  const began = performance.now();
  const loudNote = (r) => (r?.measured != null && Number.isFinite(r.measured) ? ` Громкость была ${r.measured.toFixed(1)} LUFS, поправка ${(20 * Math.log10(r.gain)).toFixed(1)} дБ.` : '');
  try {
    if (e.mode === 'video') {
      const [w, h] = exportSize();
      const ov = rasterize({ texts: st.texts, logo: st.logo, watermark: !pro }, w, h);
      const buf = new Float32Array(80);
      const r = await exportVideo(job, {
        viz, buffer: audio.buffer, a, b, fadeIn: st.fadeIn, fadeOut: st.fadeOut, normalize: e.loud,
        w, h, fps: +e.fps, codec: e.codec, quality: +e.quality, handle, name, overlay: ov,
        layers: (t) => layerStates(st.texts, ov.rects, h, t, [a, b], buf),
        report: (done, total) => {
          const bar = $('ex-progress');
          bar.max = total; bar.value = done;
          const secs = (performance.now() - began) / 1000, rate = done / Math.max(secs, 1e-3);
          const speed = rate / +e.fps;
          note.textContent = `${w}×${h} ${e.fps} к/с · кадр ${done} из ${total} · ${rate.toFixed(0)} к/с (×${speed.toFixed(1)} от реального) · осталось ${clock((total - done) / Math.max(rate, 1e-3))}`;
        },
      });
      note.textContent = r
        ? `Готово: ${name}, ${w}×${h} ${e.fps} к/с, ${r.codec}, за ${clock((performance.now() - began) / 1000)}.${loudNote(r)}`
        : handle ? 'Экспорт отменён. Файл остался недописанным, его можно удалить.' : 'Экспорт отменён.';
    } else {
      note.textContent = 'Кодирование звука…';
      const r = await exportAudio({ buffer: audio.buffer, a, b, fadeIn: st.fadeIn, fadeOut: st.fadeOut, normalize: e.loud, format: e.mode, handle, name });
      note.textContent = `Готово: ${name}, ${clock(b - a, true)}.${loudNote(r)}`;
    }
  } catch (err) {
    console.error(err);
    note.textContent = `Ошибка экспорта: ${err.message ?? err}`;
  } finally {
    job = null;
    exportBusy(false);
  }
}

async function startPng() {
  if (!audio.buffer || job) return;
  const t = position() ?? 0;
  const name = exportName(`-${clock(t).replace(':', '-')}.png`);
  const handle = await pickFile(name, 'Картинка PNG', 'image/png', '.png');
  if (handle === null) return;
  const [w, h] = exportSize();
  const [a, b] = st.fragment;
  const ov = rasterize({ texts: st.texts, logo: st.logo, watermark: !pro }, w, h);
  try {
    await exportPng({ viz, w, h, t, fade: fragGain(t), progress: b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0, layers: layerStates(st.texts, ov.rects, h, t, [a, b]), overlay: ov, handle, name });
    $('ex-status').textContent = `Кадр сохранён: ${name}, ${w}×${h}.`;
  } catch (err) {
    $('ex-status').textContent = `Не удалось сохранить кадр: ${err.message ?? err}`;
  }
}

async function setupExportUi() {
  if (!('VideoEncoder' in window)) {
    $('ex-status').textContent = 'Этот браузер не умеет кодировать видео (WebCodecs) — доступен экспорт звука в WAV. Для видео нужен Chrome/Edge, Safari 26+ или Firefox 130+.';
    st.export.mode = 'wav';
    $('ex-mode').value = 'wav';
    [...$('ex-mode').options].forEach((o) => (o.disabled = o.value !== 'wav'));
  }
  const codecs = await supportedCodecs();
  const sel = $('ex-codec');
  for (const [c, label] of CODECS) if (codecs.includes(c)) sel.add(new Option(label, c));
  if (!codecs.includes(st.export.codec)) st.export.codec = codecs[0] ?? 'avc';
  for (const [q, label] of QUALITY) $('ex-quality').add(new Option(label, q));
  const bind = (id, key, after) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = st.export[key];
    else el.value = st.export[key];
    el.onchange = () => { st.export[key] = el.type === 'checkbox' ? el.checked : el.value; after?.(); saveSoon(); };
  };
  const modeUi = () => {
    $('ex-video').hidden = st.export.mode !== 'video';
    $('ex-png').disabled = !audio.buffer || st.export.mode !== 'video';
    $('ex-start').textContent = st.export.mode === 'video' ? 'Экспорт видео' : 'Экспорт звука';
  };
  const aspectUi = () => {
    $('stage').classList.toggle('tall', st.export.aspect === 'tall');
    $('stage').classList.toggle('square', st.export.aspect === 'square');
    touch();
  };
  bind('ex-mode', 'mode', modeUi);
  bind('ex-aspect', 'aspect', aspectUi);
  bind('ex-res', 'res');
  bind('ex-fps', 'fps');
  bind('ex-codec', 'codec');
  bind('ex-quality', 'quality');
  bind('ex-loud', 'loud');
  modeUi();
  aspectUi();
  $('ex-start').onclick = startExport;
  $('ex-png').onclick = startPng;
  $('ex-cancel').onclick = () => job && (job.cancelled = true);
}

// ---------------------------------------------------------------- Pro

async function setupPro() {
  pro = await license.current();
  const line = $('pro-line'), box = $('pro-box');
  const render = () => {
    line.innerHTML = '';
    if (pro) {
      line.innerHTML = '<span class="badge">PRO</span> без водяного знака. <a href="#">Ключ…</a>';
    } else {
      line.innerHTML = 'В бесплатной версии в углу видео маленький знак «◆ audio-viz». <a href="#">Убрать — Pro</a>';
    }
    line.querySelector('a').onclick = (e) => { e.preventDefault(); box.hidden = !box.hidden; };
    $('pro-off').hidden = !pro;
    $('pro-status').textContent = pro ? `Активирован${pro.who ? ` для «${pro.who}»` : ''}${pro.exp ? `, действует до ${pro.exp}` : ', бессрочно'}.` : '';
  };
  if (license.CHECKOUT_URL) {
    $('pro-buy').href = license.CHECKOUT_URL;
    $('pro-buy-row').hidden = false;
  }
  $('pro-activate').onclick = async () => {
    try {
      const p = await license.activate($('pro-key').value);
      pro = { key: $('pro-key').value.trim(), ...p };
      $('pro-key').value = '';
    } catch (e) {
      $('pro-status').textContent = `Не получилось: ${e.message}.`;
      return;
    }
    render();
  };
  $('pro-off').onclick = () => { license.deactivate(); pro = null; render(); };
  render();
}

// ---------------------------------------------------------------- project: save, open, autosave

const AUTOSAVE = 'audio-viz.autosave';
let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE, JSON.stringify(snapshot(false))); } catch {}
  }, 800);
}

function snapshot(withImages) {
  const texts = st.texts.map((t) => ({ ...t }));
  const logo = st.logo ? { anchor: st.logo.anchor, size: st.logo.size, margin: st.logo.margin, opacity: st.logo.opacity } : null;
  return {
    app: 'audio-viz-web', version: 1, track: st.trackName ?? null,
    viz: JSON.parse(viz.project_json()),
    fragment: st.fragment, fadeIn: st.fadeIn, fadeOut: st.fadeOut, loop: st.loop, sceneFade: st.sceneFade, circle: st.circle,
    texts, logo, export: st.export, preview: st.preview,
    images: withImages ? st.images : undefined,
  };
}

async function saveProject() {
  const images = {};
  if (st.bgBlob) images.background = await dataUrl(st.bgBlob);
  if (st.coverBlob && !st.coverFromTags) images.cover = await dataUrl(st.coverBlob);
  if (st.logoBlob) images.logo = await dataUrl(st.logoBlob);
  st.images = images;
  const json = JSON.stringify(snapshot(true));
  st.images = undefined;
  const name = exportName('.avz.json');
  const handle = await pickFile(name, 'Проект audio-viz', 'application/json', '.json');
  if (handle === null) return;
  await saveBlob(handle, new Blob([json], { type: 'application/json' }), name);
  status(`Проект сохранён: ${name}`);
}

async function applyProject(p, withImages) {
  if (p.viz) viz.load_project_json(JSON.stringify(p.viz));
  st.fadeIn = p.fadeIn ?? 0;
  st.fadeOut = p.fadeOut ?? 0;
  st.loop = !!p.loop;
  st.sceneFade = p.sceneFade ?? 1.5;
  viz.set_scene_fade(st.sceneFade);
  st.circle = !!p.circle;
  $('circle').checked = st.circle;
  st.texts = (p.texts ?? []).slice(0, MAX_TEXTS).map((t) => ({ ...newText(), ...t }));
  st.export = { ...st.export, ...(p.export ?? {}) };
  st.preview = { ...st.preview, ...(p.preview ?? {}) };
  st.trackName = p.track;
  if (p.fragment?.length === 2) st.fragment = p.fragment;
  $('loop').checked = st.loop;
  if (withImages) {
    const blob = async (u) => (u ? (await fetch(u)).blob() : null);
    await setBackground(await blob(p.images?.background));
    if (p.images?.cover) await setCover(await blob(p.images.cover));
    await setLogo(await blob(p.images?.logo), p.logo ?? {});
  } else if (st.logo && p.logo) Object.assign(st.logo, p.logo);
  viz.set_circle(st.circle, new Uint8Array(), 0);
  if (st.coverBlob) await setCover(st.coverBlob, st.coverFromTags);
  for (const [k, s] of [['fadeIn', 'frag-in'], ['fadeOut', 'frag-out'], ['sceneFade', 'scene-fade']]) sliders.get(s)?.set(st[k]);
  $('pv-quality').value = st.preview.quality;
  $('pv-fps').checked = st.preview.fps;
  if (audio.buffer) setFragment(...st.fragment, false);
  renderTexts();
  renderLogoOpts();
  syncSliders(position());
  refreshMarkers();
  overlayChanged();
}

async function openProject(file) {
  try {
    const p = JSON.parse(await file.text());
    if (p.app !== 'audio-viz-web') throw new Error('это не проект audio-viz web');
    await applyProject(p, true);
    status(`Проект открыт: ${file.name}${p.track && p.track !== audio.name ? ` · откройте трек «${p.track}»` : ''}`);
  } catch (e) {
    status(`Не удалось открыть проект: ${e.message}`);
  }
}

// ---------------------------------------------------------------- setup

function enableTrackUi() {
  for (const id of ['key-add', 'scene-add', 'frag-a', 'frag-b', 'frag-set-a', 'frag-set-b', 'frag-all']) $(id).disabled = false;
  $('ex-start').disabled = exporting;
  $('ex-png').disabled = exporting || st.export.mode !== 'video';
}

function setupUi() {
  const presets = Viz.presets();
  const select = $('preset');
  presets.forEach((name, i) => select.add(new Option(name, i)));
  const choose = (i) => {
    i = (i + presets.length) % presets.length;
    select.value = i;
    viz.set_preset(i, position());
    touch();
    saveSoon();
  };
  select.onchange = () => choose(+select.value);

  for (const s of LOOK) lookSlider(...s);
  for (const c of COLORS) colorRow(...c);
  const frag = document.querySelector('[data-group="fragment"]');
  addSlider(frag, 'frag-in', 'Появление, с', 0, 10, 0, (v) => { st.fadeIn = v; setFragment(...st.fragment); });
  addSlider(frag, 'frag-out', 'Затухание, с', 0, 10, 0, (v) => { st.fadeOut = v; setFragment(...st.fragment); });
  addSlider(document.querySelector('[data-group="scene"]'), 'scene-fade', 'Длина перехода, с', 0, 6, 1.5, (v) => { st.sceneFade = v; viz.set_scene_fade(v); touch(); saveSoon(); });

  $('play').onclick = toggle;
  $('loop').onchange = () => { st.loop = $('loop').checked; saveSoon(); };
  for (const id of ['file', 'file2']) $(id).onchange = (e) => e.target.files[0] && openFile(e.target.files[0]);
  $('fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen());

  $('key-add').onclick = addKey;
  $('key-del').onclick = () => { const i = nearestKey(position() ?? 0); if (i >= 0) { viz.remove_key(i); refreshMarkers(); saveSoon(); } };
  $('key-prev').onclick = () => neighbourKey(-1);
  $('key-next').onclick = () => neighbourKey(1);
  $('key-clear').onclick = () => { viz.clear_keys(position() ?? 0); refreshMarkers(); saveSoon(); };
  $('scene-add').onclick = () => {
    const t = position() ?? 0;
    viz.add_scene(t, (viz.preset_at(t) + 1) % presets.length);
    refreshMarkers();
    saveSoon();
  };
  $('scene-del').onclick = () => { const i = currentScene(position() ?? 0); if (i >= 0) { viz.remove_scene(i); refreshMarkers(); saveSoon(); } };

  const fragInput = (id, k) => {
    $(id).onchange = () => {
      const v = parseClock($(id).value);
      if (Number.isNaN(v)) return setFragment(...st.fragment);
      const f = [...st.fragment]; f[k] = v; setFragment(...f);
    };
  };
  fragInput('frag-a', 0);
  fragInput('frag-b', 1);
  $('frag-set-a').onclick = () => setFragment(position() ?? 0, st.fragment[1]);
  $('frag-set-b').onclick = () => setFragment(st.fragment[0], position() ?? audio.duration);
  $('frag-all').onclick = () => setFragment(0, audio.duration);

  $('bg-file').onchange = (e) => e.target.files[0] && setBackground(e.target.files[0]);
  $('bg-del').onclick = () => setBackground(null);
  $('circle').onchange = () => { st.circle = $('circle').checked; setCover(st.coverBlob, st.coverFromTags); };
  $('cover-file').onchange = (e) => { if (e.target.files[0]) { st.circle = $('circle').checked = true; setCover(e.target.files[0]); } };
  $('cover-tags').onclick = () => { const b = audio.bytes && coverFromTags(audio.bytes); if (b) setCover(b, true); };
  $('cover-del').onclick = () => setCover(null);
  $('logo-file').onchange = (e) => e.target.files[0] && setLogo(e.target.files[0]);
  $('logo-del').onclick = () => setLogo(null);
  $('text-add').onclick = () => {
    if (st.texts.length >= MAX_TEXTS) return;
    const item = newText(st.texts.length ? 'Новая надпись' : (audio.name || 'Исполнитель — Название').replace(/\.[^.]+$/, ''));
    if (st.texts.length) item.anchor = ANCHORS[(st.texts.length * 2) % 9][0];
    st.texts.push(item);
    renderTexts();
    overlayChanged();
  };

  $('pv-quality').onchange = () => { st.preview.quality = $('pv-quality').value; perf.scale = 1; touch(); saveSoon(); };
  $('pv-fps').onchange = () => { st.preview.fps = $('pv-fps').checked; saveSoon(); };

  $('pj-save').onclick = saveProject;
  $('pj-open').onchange = (e) => e.target.files[0] && openProject(e.target.files[0]);
  $('pj-reset').onclick = () => {
    if (!confirm('Сбросить все настройки, тексты и картинки?')) return;
    try { localStorage.removeItem(AUTOSAVE); } catch {}
    location.reload();
  };

  const stage = $('stage');
  addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('over'); });
  addEventListener('dragleave', () => stage.classList.remove('over'));
  addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) openProject(f);
    else if (f.type.startsWith('image/')) setBackground(f);
    else openFile(f);
  });
  addEventListener('resize', touch);
  document.addEventListener('fullscreenchange', touch);

  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyS') { e.preventDefault(); saveProject(); return; }
    const tag = e.target.tagName;
    if ((tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return;
    const step = e.shiftKey ? 1 : 5;
    switch (e.code) {
      case 'Space': e.preventDefault(); toggle(); break;
      case 'ArrowLeft': e.preventDefault(); seek((position() ?? 0) - step); break;
      case 'ArrowRight': e.preventDefault(); seek((position() ?? 0) + step); break;
      case 'KeyN': choose(+select.value + 1); break;
      case 'KeyP': choose(+select.value - 1); break;
      case 'BracketLeft': if (audio.buffer) setFragment(position(), st.fragment[1]); break;
      case 'BracketRight': if (audio.buffer) setFragment(st.fragment[0], position()); break;
      case 'KeyL': $('loop').click(); break;
      case 'KeyK': addKey(); break;
      case 'KeyF': $('fullscreen').click(); break;
      case 'Home': seek(st.fragment[0]); break;
      case 'End': seek(st.fragment[1]); break;
    }
  });

  setupCaptionDrag();
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
  // Restore the last session's settings (without images and track).
  try {
    const saved = JSON.parse(localStorage.getItem(AUTOSAVE) ?? 'null');
    if (saved?.app === 'audio-viz-web') await applyProject(saved, false);
  } catch {}
  await Promise.all([setupExportUi(), setupPro()]);
  renderTexts();
  status(`GPU: ${viz.describe()} · откройте трек`);
  requestAnimationFrame(frame);
}

main();
