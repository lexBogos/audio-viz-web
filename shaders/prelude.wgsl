// Shared header prepended to every preset.
// A preset only defines: fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32>
//   uv   — centered, aspect-correct coordinates (y up, height spans -0.5..0.5)
//   frag — pixel coordinates (y up)
// It returns linear HDR color; values above 1.0 feed the bloom.

struct Uniforms {
    res: vec2<f32>,
    time: f32,      // seconds
    progress: f32,  // 0..1 over the track
    bass: f32,      // all levels are 0..1, normalized per track
    mid: f32,
    high: f32,
    level: f32,
    beat: f32,      // decaying pulse on onsets
    energy: f32,    // integral of loudness — use instead of time for motion
    bass_acc: f32,  // integral of bass
    seed: f32,
    spectrum: array<vec4<f32>, 16>, // 64 log-spaced bands, read via spec()
    ring: vec4<f32>,       // center circle: radius, bar length, on, —  (drawn by the app)
    ring_color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> U: Uniforms;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;

// Spectrum value at x in 0..1 (low → high frequency), interpolated.
fn spec(x: f32) -> f32 {
    let f = clamp(x, 0.0, 1.0) * 63.0;
    let i = u32(floor(f));
    let j = min(i + 1u, 63u);
    return mix(U.spectrum[i / 4u][i % 4u], U.spectrum[j / 4u][j % 4u], fract(f));
}

fn hash21(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash21(i), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y,
    );
}

fn fbm(p_in: vec2<f32>) -> f32 {
    var p = p_in;
    var a = 0.5;
    var s = 0.0;
    let m = mat2x2<f32>(1.6, 1.2, -1.2, 1.6);
    for (var i = 0; i < 5; i++) {
        s += a * noise(p);
        p = m * p;
        a *= 0.5;
    }
    return s;
}

fn rot(a: f32) -> mat2x2<f32> {
    let c = cos(a);
    let s = sin(a);
    return mat2x2<f32>(c, s, -s, c);
}

// Cosine palette (Inigo Quilez).
fn palette(t: f32, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, d: vec3<f32>) -> vec3<f32> {
    return a + b * cos(TAU * (c * t + d));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let x = f32((vi << 1u) & 2u);
    let y = f32(vi & 2u);
    return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

// Center circle drawn over every preset: a dark disc (the cover image goes
// on top of it in the post pass) with mirrored spectrum bars around it.
fn ring_layer(uv: vec2<f32>, col_in: vec3<f32>) -> vec3<f32> {
    let r = U.ring.x;
    let px = 1.0 / U.res.y;
    let d = length(uv);
    var col = col_in * mix(1.0, 0.06, smoothstep(r + px, r - px, d));

    let n = 48.0; // bars per half circle, lows at the top, mirrored left/right
    let x = abs(atan2(uv.x, uv.y)) / PI;
    let cell = floor(x * n);
    let s = spec((cell + 0.5) / n * 0.85);
    let v = s * s; // more contrast: quiet bands stay short
    let r0 = r + 0.012;
    let len = 0.003 + U.ring.y * 0.15 * v;
    let half_w = 0.32 * PI / n * r0;
    let off = abs(fract(x * n) - 0.5) * PI / n * d;
    let bar = smoothstep(half_w + px, half_w - px, off)
        * smoothstep(r0 - px, r0 + px, d) * smoothstep(r0 + len + px, r0 + len - px, d);
    let tint = mix(U.ring_color.rgb, vec3<f32>(1.0), 0.35 * v);
    col += tint * bar * (0.35 + 0.6 * v + 0.5 * U.beat);
    col += U.ring_color.rgb * exp(-abs(d - r - 0.003) / (1.2 * px)) * (0.3 + 0.4 * U.beat);
    return col;
}

@fragment
fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let frag = vec2<f32>(p.x, U.res.y - p.y);
    let uv = (frag - 0.5 * U.res) / U.res.y;
    var col = max(scene(uv, frag), vec3<f32>(0.0));
    if (U.ring.z > 0.5) {
        col = ring_layer(uv, col);
    }
    return vec4<f32>(col, 1.0);
}
