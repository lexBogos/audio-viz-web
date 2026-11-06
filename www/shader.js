// The user's own preset: a WGSL body with `fn scene(uv, frag) -> vec3<f32>`, the
// same format as the desktop `--shader my.wgsl`. WebGPU reports shader errors only
// asynchronously and only to the console, so the code is first compiled on a
// separate small device here, which gives line numbers and keeps the main device
// clean. Only code that compiles reaches the renderer.

let checker = null;

function device() {
  checker ??= navigator.gpu.requestAdapter().then((a) => {
    if (!a) throw new Error('нет GPU-адаптера');
    return a.requestDevice();
  });
  return checker;
}

/**
 * Compiles prelude + body. Resolves to a list of errors ({ line, col, text }, with
 * lines counted in the body; line 0 = outside of it), empty when the code is fine.
 */
export async function checkShader(prelude, body) {
  const dev = await device();
  // Same layout as the Rust side: `${prelude}\n${body}`.
  const offset = prelude.split('\n').length;
  dev.pushErrorScope('validation');
  const module = dev.createShaderModule({ code: `${prelude}\n${body}` });
  const info = await module.getCompilationInfo();
  const scope = await dev.popErrorScope();
  const errors = info.messages
    .filter((m) => m.type === 'error')
    .map((m) => ({ line: Math.max(0, m.lineNum - offset), col: m.linePos, text: m.message }));
  if (!errors.length && !/\bfn\s+scene\s*\(/.test(body)) errors.push({ line: 0, col: 0, text: 'нет функции fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32>' });
  if (!errors.length && scope) errors.push({ line: 0, col: 0, text: scope.message });
  return errors;
}

export function formatErrors(errors) {
  return errors.map((e) => (e.line > 0 ? `строка ${e.line}:${e.col} — ${e.text}` : e.text)).join('\n');
}

/** Opens a .wgsl file. With the File System Access API the handle is kept so the file can be watched. */
export async function openShaderFile() {
  if (!window.showOpenFilePicker) return null;
  try {
    const [handle] = await showOpenFilePicker({ types: [{ description: 'WGSL', accept: { 'text/plain': ['.wgsl', '.txt'] } }] });
    const file = await handle.getFile();
    return { handle, name: file.name, text: await file.text(), modified: file.lastModified };
  } catch (e) {
    if (e.name === 'AbortError') return undefined;
    throw e;
  }
}

/**
 * Re-reads a file whenever it changes on disk (like the desktop hot reload), so it
 * can be edited in any editor. Returns a function that stops watching.
 */
export function watchFile(handle, modified, onChange) {
  let last = modified, stopped = false, busy = false;
  const timer = setInterval(async () => {
    if (busy || stopped || document.hidden) return;
    busy = true;
    try {
      const f = await handle.getFile();
      if (f.lastModified !== last) {
        last = f.lastModified;
        onChange(await f.text());
      }
    } catch {
      // Permission revoked or file gone: stop quietly.
      stopped = true;
      clearInterval(timer);
    } finally {
      busy = false;
    }
  }, 700);
  return () => { stopped = true; clearInterval(timer); };
}

export const TEMPLATE = `// Свой пресет: одна функция, которая возвращает линейный HDR-цвет пикселя.
//   uv   — координаты от центра (по высоте −0.5..0.5), frag — пиксели
// Данные звука: U.bass, U.mid, U.high, U.level, U.beat (0..1),
//   U.energy — «музыкальное время» (лучше U.time для движения), spec(x) — спектр 0..1.
// Помощники: noise, fbm, rot, palette, PI, TAU.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.4;
    let d = length(uv);
    let a = atan2(uv.y, uv.x);
    let s = spec(fract(a / TAU + 0.5));
    let ring = exp(-abs(d - 0.22 - 0.12 * s - 0.05 * U.bass) * 60.0);
    let c = palette(d + t * 0.1, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.0, 0.33, 0.67));
    let haze = fbm(uv * 3.0 + vec2<f32>(t, -t * 0.5)) * 0.08;
    return c * (ring * (0.6 + 1.5 * U.beat) + haze);
}
`;
