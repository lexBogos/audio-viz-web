// Text layer: captions, logo and the free-tier watermark, rasterized with Canvas 2D
// (so any installed or web font works) into one RGBA image the size of the target.
// The GPU shows each area with its own opacity, offset and reveal per frame, so the
// image is only redrawn when something about the text changes, not every frame.

export const MAX_TEXTS = 8;
const LOGO_SLOT = 8, WATERMARK_SLOT = 9, SLOTS = 10;
const FLOATS = 8; // per slot: rect x0 y0 x1 y1, alpha, shift x, y, wipe

export const ANCHORS = [
  ['top-left', '↖ сверху слева'], ['top', '↑ сверху'], ['top-right', '↗ сверху справа'],
  ['left', '← слева'], ['center', '• по центру'], ['right', '→ справа'],
  ['bottom-left', '↙ снизу слева'], ['bottom', '↓ снизу'], ['bottom-right', '↘ снизу справа'],
];
export const ANIMS = [['none', 'без анимации'], ['fade', 'проявление'], ['rise', 'выезд снизу'], ['reveal', 'слева направо']];
export const FONTS = [
  'system-ui', 'Inter, sans-serif', 'Helvetica Neue, Arial, sans-serif', 'Georgia, serif', 'Times New Roman, serif',
  'Courier New, monospace', 'Impact, sans-serif', 'Arial Black, sans-serif', 'Futura, sans-serif', 'Avenir Next, sans-serif',
];

/** (horizontal, vertical) alignment of an anchor, each 0, 0.5 or 1. */
function align(anchor) {
  const i = Math.max(0, ANCHORS.findIndex(([a]) => a === anchor));
  return [(i % 3) * 0.5, Math.floor(i / 3) * 0.5];
}

export function newText(text = '') {
  return {
    text, size: 6, anchor: 'bottom-left', margin: 6, color: '#ffffff', opacity: 1, shadow: true, bold: true,
    font: 'system-ui', offset: [0, 0], timed: false, from: 0, to: 10, anim: 'fade', animLen: 0.8,
  };
}

export function newLogo(bitmap, name) {
  return { bitmap, name, anchor: 'top-right', size: 8, opacity: 0.85, margin: 4 };
}

const fontOf = (item, px) => `${item.bold ? 700 : 400} ${px}px ${item.font || 'system-ui'}`;

/** Lines, their widths and the block's place for a caption at frame size w×h. */
function layout(g, item, w, h) {
  const px = Math.max(1, (item.size / 100) * h);
  g.font = fontOf(item, px);
  const lines = item.text.split('\n');
  const m = g.measureText('Hg');
  const ascent = m.fontBoundingBoxAscent ?? px * 0.8, descent = m.fontBoundingBoxDescent ?? px * 0.2;
  const lineH = (ascent + descent) * 1.08;
  const widths = lines.map((l) => g.measureText(l).width);
  const bw = Math.max(0, ...widths), bh = lineH * lines.length - (lineH - ascent - descent);
  const [ax, ay] = align(item.anchor);
  const mg = (item.margin / 100) * h;
  const x0 = mg + (w - 2 * mg - bw) * ax + (item.offset[0] / 100) * h;
  const y0 = mg + (h - 2 * mg - bh) * ay + (item.offset[1] / 100) * h;
  return { px, lines, widths, bw, bh, ascent, lineH, x0, y0, ax };
}

function logoRect(logo, w, h) {
  const lh = (logo.size / 100) * h;
  const lw = (lh * logo.bitmap.width) / Math.max(1, logo.bitmap.height);
  const [ax, ay] = align(logo.anchor);
  const m = (logo.margin / 100) * h;
  const x0 = m + (w - 2 * m - lw) * ax, y0 = m + (h - 2 * m - lh) * ay;
  return [x0, y0, x0 + lw, y0 + lh];
}

/** Small mark in the bottom-right corner of free-tier exports. */
function drawWatermark(g, w, h) {
  const px = Math.max(11, Math.round(h * 0.022));
  g.font = `600 ${px}px system-ui, sans-serif`;
  const label = '◆ audio-viz';
  const tw = g.measureText(label).width;
  const m = Math.round(h * 0.022);
  const x = w - m - tw, y = h - m;
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = px * 0.25;
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fillText(label, x, y);
  g.shadowBlur = 0;
  g.shadowColor = 'transparent';
  return [x - 4, y - px * 1.1, x + tw + 4, y + px * 0.35];
}

/**
 * Rasterizes the layer at w×h. Returns `{ rgba, rects }`: `rgba` is null when there
 * is nothing to draw; `rects[i]` is the pixel area of slot i (null = unused).
 */
export function rasterize({ texts, logo, watermark }, w, h) {
  const rects = new Array(SLOTS).fill(null);
  const active = texts.slice(0, MAX_TEXTS).map((t) => t.text.trim() && t.opacity > 0);
  if (!active.some(Boolean) && !logo && !watermark) return { rgba: null, rects };
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.textBaseline = 'alphabetic';
  texts.slice(0, MAX_TEXTS).forEach((item, i) => {
    if (!active[i]) return;
    const L = layout(g, item, w, h);
    const passes = [];
    if (item.shadow) {
      const off = Math.max(1, L.px * 0.05);
      passes.push([off, '#000000', item.opacity * 0.55]);
    }
    passes.push([0, item.color, item.opacity]);
    for (const [off, color, alpha] of passes) {
      g.globalAlpha = Math.min(1, Math.max(0, alpha));
      g.fillStyle = color;
      L.lines.forEach((line, k) => {
        const lx = L.x0 + (L.bw - L.widths[k]) * L.ax + off;
        g.fillText(line, lx, L.y0 + L.ascent + L.lineH * k + off);
      });
    }
    g.globalAlpha = 1;
    // Room for the shadow, accents and descenders around the measured box.
    const pad = L.px * 0.3;
    rects[i] = [L.x0 - pad, L.y0 - pad, L.x0 + L.bw + pad, L.y0 + L.bh + pad];
  });
  if (logo) {
    const r = logoRect(logo, w, h);
    g.globalAlpha = Math.min(1, Math.max(0, logo.opacity));
    g.imageSmoothingQuality = 'high';
    g.drawImage(logo.bitmap, r[0], r[1], r[2] - r[0], r[3] - r[1]);
    g.globalAlpha = 1;
    rects[LOGO_SLOT] = r;
  }
  if (watermark) rects[WATERMARK_SLOT] = drawWatermark(g, w, h);
  return { rgba: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer), rects };
}

/**
 * Per-frame state of every slot at track time `t`, as the flat array the wasm
 * module takes. `window` is the fragment, used by captions without their own timing.
 */
export function layerStates(texts, rects, h, t, window, out = new Float32Array(SLOTS * FLOATS)) {
  out.fill(0);
  rects.forEach((rect, i) => {
    if (!rect) return;
    const o = i * FLOATS;
    out.set(rect, o);
    let alpha = 1, shift = 0, wipe = 1;
    const item = i < MAX_TEXTS ? texts[i] : null;
    if (item && (item.timed || item.anim !== 'none')) {
      const [a, z] = item.timed ? [item.from, item.to] : window;
      if (t < a || t > z) alpha = 0;
      else {
        const len = Math.max(0.01, item.animLen);
        let k = Math.min(1, Math.max(0, Math.min((t - a) / len, (z - t) / len)));
        k = k * k * (3 - 2 * k);
        if (item.anim === 'fade') alpha = k;
        else if (item.anim === 'rise') { alpha = k; shift = (1 - k) * 0.04 * h; }
        else if (item.anim === 'reveal') wipe = k;
      }
    }
    out[o + 4] = alpha;
    out[o + 6] = shift;
    out[o + 7] = wipe;
  });
  return out;
}

/** Index of the caption under pixel (x, y), or -1. */
export function captionAt(rects, x, y) {
  for (let i = MAX_TEXTS - 1; i >= 0; i--) {
    const r = rects[i];
    if (r && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return i;
  }
  return -1;
}
