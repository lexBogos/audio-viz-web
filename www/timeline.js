// Timeline under the preview: waveform, fragment selection with fades, playhead,
// keyframes (yellow diamonds) and scene starts (blue flags). Drawing is cheap: the
// waveform is cached in a bitmap and only redrawn when the view or size changes;
// each frame only the playhead and markers are drawn over it.

const MARK_H = 18; // marker strip on top
const EDGE = 6; // px to grab a fragment edge or marker

/** Min/max peaks of `mono` in buckets of `step` samples. */
export function computePeaks(mono, step = 256) {
  const n = Math.ceil(mono.length / step);
  const min = new Float32Array(n), max = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(mono.length, (b + 1) * step);
    for (let i = b * step; i < end; i++) {
      const v = mono[i];
      if (v < lo) lo = v;
      else if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, step };
}

export class Timeline {
  /**
   * `cb`: { seek(t), selection(a, b), keyMoved(i, t), keyRemoved(i), sceneMoved(i, t), sceneRemoved(i) }
   * `get`: { position(), fragment() -> [a, b], fades() -> [in, out], keys() -> times, scenes() -> times }
   */
  constructor(canvas, get, cb) {
    Object.assign(this, { canvas, get, cb });
    this.ctx = canvas.getContext('2d');
    this.peaks = null;
    this.duration = 0;
    this.view = [0, 0];
    this.cache = null;
    this.cacheKey = '';
    this.drag = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('dblclick', () => this.cb.selection(0, this.duration));
    canvas.addEventListener('contextmenu', (e) => this.context(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  setTrack(peaks, duration) {
    this.peaks = peaks;
    this.duration = duration;
    this.view = [0, duration];
    this.cacheKey = '';
  }

  // ---- geometry ----
  get w() { return this.canvas.width; }
  get h() { return this.canvas.height; }
  get dpr() { return this.canvas.width / Math.max(this.canvas.clientWidth, 1); }
  x(t) { const [a, b] = this.view; return ((t - a) / Math.max(b - a, 1e-6)) * this.w; }
  t(x) { const [a, b] = this.view; return Math.min(this.duration, Math.max(0, a + (x / this.w) * (b - a))); }
  px(e) { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; }

  hit(x, y) {
    const tol = EDGE * this.dpr;
    if (y < MARK_H * this.dpr) {
      const near = (times) => {
        let best = -1, bd = tol;
        times.forEach((t, i) => { const d = Math.abs(this.x(t) - x); if (d <= bd) { bd = d; best = i; } });
        return best;
      };
      const k = near(this.get.keys());
      if (k >= 0) return { kind: 'key', i: k };
      const s = near(this.get.scenes());
      if (s >= 0) return { kind: 'scene', i: s };
    }
    const [a, b] = this.get.fragment();
    if (Math.abs(this.x(a) - x) <= tol) return { kind: 'start' };
    if (Math.abs(this.x(b) - x) <= tol) return { kind: 'end' };
    return { kind: 'wave' };
  }

  // ---- interaction ----
  down(e) {
    if (!this.duration || e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.px(e);
    this.drag = { ...this.hit(x, y), x0: x, moved: false };
  }

  move(e) {
    const [x, y] = this.px(e);
    if (!this.drag) {
      const h = this.duration ? this.hit(x, y).kind : 'wave';
      this.canvas.style.cursor = h === 'start' || h === 'end' ? 'ew-resize' : h === 'key' || h === 'scene' ? 'grab' : 'text';
      return;
    }
    const d = this.drag;
    if (Math.abs(x - d.x0) > 3 * this.dpr) d.moved = true;
    if (!d.moved) return;
    const t = this.t(x);
    const [a, b] = this.get.fragment();
    switch (d.kind) {
      case 'start': this.cb.selection(Math.min(t, b - 0.05), b); break;
      case 'end': this.cb.selection(a, Math.max(t, a + 0.05)); break;
      case 'key': d.i = this.cb.keyMoved(d.i, t); break;
      case 'scene': d.i = this.cb.sceneMoved(d.i, t); break;
      default: {
        const t0 = this.t(d.x0);
        this.cb.selection(Math.min(t0, t), Math.max(t0, t));
      }
    }
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved) return;
    const [x] = this.px(e);
    if (d.kind === 'key') this.cb.seek(this.get.keys()[d.i]);
    else if (d.kind === 'scene') this.cb.seek(this.get.scenes()[d.i]);
    else this.cb.seek(this.t(x));
  }

  context(e) {
    e.preventDefault();
    const [x, y] = this.px(e);
    const h = this.hit(x, y);
    if (h.kind === 'key') this.cb.keyRemoved(h.i);
    else if (h.kind === 'scene') this.cb.sceneRemoved(h.i);
  }

  wheel(e) {
    if (!this.duration) return;
    e.preventDefault();
    const [x] = this.px(e);
    let [a, b] = this.view;
    const span = b - a;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const shift = ((e.deltaX || e.deltaY) / this.w) * span * this.dpr;
      a += shift; b += shift;
    } else {
      const k = Math.exp(e.deltaY * 0.002);
      const pivot = this.t(x);
      const next = Math.min(this.duration, Math.max(0.5, span * k));
      a = pivot - ((pivot - a) / span) * next;
      b = a + next;
    }
    if (a < 0) { b -= a; a = 0; }
    if (b > this.duration) { a -= b - this.duration; b = this.duration; }
    this.view = [Math.max(0, a), b];
  }

  // ---- drawing ----
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.round(r.width * devicePixelRatio), h = Math.round(r.height * devicePixelRatio);
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  waveform() {
    const key = `${this.w}x${this.h}:${this.view.join(',')}`;
    if (this.cache && key === this.cacheKey) return this.cache;
    this.cacheKey = key;
    const c = (this.cache ??= new OffscreenCanvas(1, 1));
    c.width = this.w;
    c.height = this.h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (!this.peaks) return c;
    const { min, max, step } = this.peaks;
    const top = MARK_H * this.dpr, mid = top + (this.h - top) / 2, amp = (this.h - top) / 2 - 2;
    const sr = (min.length * step) / this.duration; // samples per second
    g.fillStyle = '#5b5b70';
    for (let x = 0; x < this.w; x++) {
      const b0 = Math.floor((this.t(x) * sr) / step), b1 = Math.max(b0 + 1, Math.floor((this.t(x + 1) * sr) / step));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1 && b < min.length; b++) {
        if (min[b] < lo) lo = min[b];
        if (max[b] > hi) hi = max[b];
      }
      g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    return c;
  }

  draw() {
    this.resize();
    const { ctx: g, w, h, dpr } = this;
    g.clearRect(0, 0, w, h);
    if (!this.duration) return;
    g.drawImage(this.waveform(), 0, 0);
    const top = MARK_H * dpr;
    const [a, b] = this.get.fragment();
    const [fi, fo] = this.get.fades();
    const xa = this.x(a), xb = this.x(b);
    // Outside the fragment dims; fades as ramps inside it.
    g.fillStyle = 'rgba(14,14,18,0.6)';
    g.fillRect(0, top, Math.max(0, xa), h - top);
    g.fillRect(xb, top, w - xb, h - top);
    g.fillStyle = 'rgba(255,115,191,0.10)';
    g.fillRect(xa, top, xb - xa, h - top);
    g.strokeStyle = 'rgba(255,115,191,0.7)';
    g.lineWidth = dpr;
    g.beginPath();
    g.moveTo(xa, h); g.lineTo(this.x(a + fi), top); g.lineTo(this.x(b - fo), top); g.lineTo(xb, h);
    g.stroke();
    g.fillStyle = '#ff73bf';
    g.fillRect(xa - dpr, top, 2 * dpr, h - top);
    g.fillRect(xb - dpr, top, 2 * dpr, h - top);
    // Markers.
    g.fillStyle = '#5ec8ff';
    for (const t of this.get.scenes()) {
      const x = this.x(t);
      g.fillRect(x, 2 * dpr, dpr, h - 2 * dpr);
      g.beginPath(); g.moveTo(x, 2 * dpr); g.lineTo(x + 9 * dpr, 6 * dpr); g.lineTo(x, 10 * dpr); g.fill();
    }
    g.fillStyle = '#ffd24a';
    for (const t of this.get.keys()) {
      const x = this.x(t), y = 9 * dpr, r = 5 * dpr;
      g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.fill();
    }
    const p = this.get.position();
    if (p !== undefined) {
      g.fillStyle = '#fff';
      g.fillRect(this.x(p) - dpr / 2, 0, dpr, h);
    }
  }
}
