const PI: f32 = 3.14159265;

// Bloom (downsample + separable blur at 1/4 res) and final composite.

struct Post {
    res: vec2<f32>,
    bloom_texel: vec2<f32>,
    bloom: f32,
    vignette: f32,
    grain: f32,
    aberration: f32,
    frame: f32,
    srgb_target: f32, // 1.0 when the target encodes sRGB in hardware
    threshold: f32,
    exposure: f32,   // linear multiplier
    saturation: f32,
    hue: f32,        // radians
    fade: f32,       // 0..1 overall fade to black
    bass: f32,
    bg_scale: vec2<f32>,  // cover-fit UV scale for the background image
    bg_brightness: f32,
    viz_opacity: f32,
    bg_pulse: f32,
    overlay: f32,         // 1 when a text layer is bound
    has_background: f32,  // 1 when a background image is bound
    beat: f32,
    shake: f32,           // beat effects: camera shake, zoom kick, flash
    punch: f32,
    flash: f32,
    cover: f32,           // 1 when a cover image is drawn in the center circle
    cover_radius: f32,    // fraction of the height
    text_count: f32,
    _p1: f32,
    _p2: f32,
    glitch: f32,          // torn slices and split colors on beats
    vhs: f32,             // tape look
    bar: f32,             // progress bar thickness, 0 = off
    bar_pos: f32,         // 0..1 through the export
    bar_color: vec3<f32>,
    mix: f32,             // scene crossfade, 0..1 from tex_a to tex_b (fs_mix)
    text_rect: array<vec4<f32>, 10>,   // per caption (and the logo): area in the text layer, pixels
    text_state: array<vec4<f32>, 10>,  // alpha, shift x, shift y, left-to-right reveal
};

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> P: Post;
@group(0) @binding(4) var background: texture_2d<f32>;
@group(0) @binding(5) var overlay: texture_2d<f32>;
@group(0) @binding(6) var cover: texture_2d<f32>;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    let x = f32((vi << 1u) & 2u);
    let y = f32(vi & 2u);
    var o: VsOut;
    o.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    o.uv = vec2<f32>(x, y);
    return o;
}

@fragment
fn fs_down(in: VsOut) -> @location(0) vec4<f32> {
    let o = 1.0 / P.res;
    var c = textureSample(tex_a, samp, in.uv + vec2<f32>(-o.x, -o.y)).rgb;
    c += textureSample(tex_a, samp, in.uv + vec2<f32>(o.x, -o.y)).rgb;
    c += textureSample(tex_a, samp, in.uv + vec2<f32>(-o.x, o.y)).rgb;
    c += textureSample(tex_a, samp, in.uv + vec2<f32>(o.x, o.y)).rgb;
    c *= 0.25;
    let br = max(c.r, max(c.g, c.b));
    // Soft knee so the glow fades in instead of switching on.
    let knee = P.threshold * 0.5;
    let soft = clamp(br - P.threshold + knee, 0.0, 2.0 * knee);
    let k = max(soft * soft / (4.0 * knee + 1e-4), br - P.threshold) / max(br, 1e-4);
    return vec4<f32>(c * k, 1.0);
}

fn blur(uv: vec2<f32>, dir: vec2<f32>) -> vec4<f32> {
    let d = dir * P.bloom_texel * 2.0;
    var c = textureSample(tex_a, samp, uv).rgb * 0.2270270;
    c += textureSample(tex_a, samp, uv + d * 1.3846154).rgb * 0.3162162;
    c += textureSample(tex_a, samp, uv - d * 1.3846154).rgb * 0.3162162;
    c += textureSample(tex_a, samp, uv + d * 3.2307692).rgb * 0.0702703;
    c += textureSample(tex_a, samp, uv - d * 3.2307692).rgb * 0.0702703;
    return vec4<f32>(c, 1.0);
}

// Crossfade between two presets during a scene change.
@fragment
fn fs_mix(in: VsOut) -> @location(0) vec4<f32> {
    let a = textureSample(tex_a, samp, in.uv).rgb;
    let b = textureSample(tex_b, samp, in.uv).rgb;
    return vec4<f32>(mix(a, b, P.mix), 1.0);
}

@fragment
fn fs_blur_h(in: VsOut) -> @location(0) vec4<f32> {
    return blur(in.uv, vec2<f32>(1.0, 0.0));
}

@fragment
fn fs_blur_v(in: VsOut) -> @location(0) vec4<f32> {
    return blur(in.uv, vec2<f32>(0.0, 1.0));
}

fn aces(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

fn hash(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.zyx + 31.32);
    return fract((q.x + q.y) * q.z);
}

@fragment
fn fs_post(in: VsOut) -> @location(0) vec4<f32> {
    // Beat effects move a "camera" over everything except the captions.
    let aspect = P.res.x / P.res.y;
    let kick = P.beat * P.beat;
    let wobble = vec2<f32>(sin(P.frame * 1.7) + 0.5 * sin(P.frame * 3.1 + 1.0), cos(P.frame * 1.3) + 0.5 * sin(P.frame * 2.3 + 2.0));
    var uv = (in.uv - 0.5) * (1.0 - 0.12 * P.punch * P.beat) + 0.5 + wobble * vec2<f32>(1.0, aspect) * 0.025 * P.shake * kick / aspect;

    // Glitch: on beats some horizontal slices jump sideways.
    var split = 0.0;
    if (P.glitch > 0.0) {
        let g = P.glitch * kick;
        let tick = floor(P.frame / 3.0);
        let slice = floor(in.uv.y * (12.0 + 30.0 * hash(vec3<f32>(tick, 1.0, 2.0))));
        let h = hash(vec3<f32>(slice, tick, 3.0));
        uv.x += select(0.0, (h - 0.5) * 0.2 * g, h > 1.0 - 0.45 * g);
        split = 0.012 * g;
    }
    // Tape: wobbling lines and horizontal color bleed.
    if (P.vhs > 0.0) {
        let line = floor(in.pos.y / 2.0);
        uv.x += (sin(in.uv.y * 30.0 + P.frame * 0.21) * 0.0012 + (hash(vec3<f32>(line, P.frame, 4.0)) - 0.5) * 0.0015) * P.vhs;
        split += 0.004 * P.vhs;
    }

    // Chromatic aberration grows toward the edges (center stays sharp) and kicks with the bass.
    let d = uv - 0.5;
    let ca = d * length(d) * 2.0 * P.aberration * (0.6 + 0.8 * P.bass);
    let sp = vec2<f32>(split, 0.0);
    var c = vec3<f32>(
        textureSample(tex_a, samp, uv - ca - sp).r,
        textureSample(tex_a, samp, uv).g,
        textureSample(tex_a, samp, uv + ca + sp).b,
    );
    c += textureSample(tex_b, samp, uv).rgb * P.bloom * 1.5;
    c *= P.exposure;

    // Hue: rotate around the gray axis. Saturation: mix with luma.
    let axis = vec3<f32>(0.57735);
    let ch = cos(P.hue);
    c = c * ch + cross(axis, c) * sin(P.hue) + axis * dot(axis, c) * (1.0 - ch);
    let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    c = max(mix(vec3<f32>(luma), c, P.saturation), vec3<f32>(0.0));
    c = aces(c);

    // Background image under the visualization (screen blend, linear space).
    if (P.has_background > 0.5) {
        let zoom = 1.0 - 0.06 * P.bg_pulse * P.bass;
        let buv = (uv - 0.5) * P.bg_scale * zoom + 0.5;
        let bg = textureSample(background, samp, buv).rgb * P.bg_brightness;
        let v = c * P.viz_opacity;
        c = 1.0 - (1.0 - bg) * (1.0 - v);
    }

    // Cover image in the center circle (sRGB texture, sampled as linear).
    if (P.cover > 0.5) {
        let q = (uv - 0.5) * vec2<f32>(aspect, 1.0);
        let r = P.cover_radius;
        let edge = 1.5 / P.res.y;
        let m = smoothstep(r + edge, r - edge, length(q));
        let img = textureSample(cover, samp, q / (2.0 * r) + 0.5).rgb;
        c = mix(c, img, m);
    }
    c = c + (1.0 - c) * clamp(P.flash * kick * P.beat * 0.45, 0.0, 1.0);

    if (P.vhs > 0.0) {
        let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3<f32>(l), 0.25 * P.vhs) * mix(vec3<f32>(1.0), vec3<f32>(1.05, 1.0, 0.9), P.vhs);
        c *= 1.0 - 0.22 * P.vhs * (0.5 + 0.5 * sin(in.pos.y * PI));
        c += (hash(vec3<f32>(floor(in.pos.y / 3.0), P.frame, 5.0)) - 0.5) * 0.05 * P.vhs;
        c = max(c, vec3<f32>(0.0));
    }

    let v = smoothstep(1.05, 0.15, length((in.uv - 0.5) * vec2<f32>(aspect, 1.0)));
    c *= mix(1.0, v, P.vignette) * P.fade;

    // Progress bar along the bottom: bright up to the current position, dim after.
    if (P.bar > 0.0) {
        let px = in.pos.xy;
        let thick = max(P.bar * 0.008 * P.res.y, 2.0);
        let y0 = P.res.y * (1.0 - 0.045) - thick;
        let x0 = P.res.x * 0.06;
        let x1 = P.res.x * 0.94;
        let inside_y = smoothstep(y0 - 0.5, y0 + 0.5, px.y) * smoothstep(y0 + thick + 0.5, y0 + thick - 0.5, px.y);
        let inside_x = smoothstep(x0 - 0.5, x0 + 0.5, px.x) * smoothstep(x1 + 0.5, x1 - 0.5, px.x);
        let head = mix(x0, x1, clamp(P.bar_pos, 0.0, 1.0));
        let done = smoothstep(head + 0.5, head - 0.5, px.x);
        let bar = inside_y * inside_x;
        c = mix(c, mix(vec3<f32>(0.5), P.bar_color, done) * mix(0.35, 1.0, done), bar * mix(0.35, 1.0, done) * P.fade);
        let dot_r = thick * 1.8;
        let dd = length(px - vec2<f32>(head, y0 + thick * 0.5));
        c = mix(c, P.bar_color, smoothstep(dot_r + 0.7, dot_r - 0.7, dd) * P.fade);
    }

    if (P.srgb_target < 0.5) {
        c = to_srgb(c);
    }
    // Text layer: stored gamma-encoded with straight alpha, same size as the target.
    // Each caption is shown with its own opacity, offset and reveal.
    if (P.overlay > 0.5) {
        let dims = vec2<f32>(textureDimensions(overlay));
        for (var i = 0; i < i32(P.text_count); i++) {
            let st = P.text_state[i];
            if (st.x <= 0.0) {
                continue;
            }
            let rect = P.text_rect[i];
            let src = in.pos.xy - st.yz;
            if (src.x < rect.x || src.y < rect.y || src.x >= rect.z || src.y >= rect.w || src.x >= dims.x || src.y >= dims.y) {
                continue;
            }
            let t = textureLoad(overlay, vec2<i32>(src), 0);
            let soft = max((rect.z - rect.x) * 0.08, 1.0);
            let reveal = clamp((rect.x + (rect.z - rect.x + soft) * st.w - src.x) / soft, 0.0, 1.0);
            var trgb = t.rgb;
            if (P.srgb_target > 0.5) {
                trgb = pow(trgb, vec3<f32>(2.2));
            }
            c = mix(c, trgb, t.a * st.x * reveal * P.fade);
        }
    }
    // Grain doubles as dither: prevents gradient banding after 8-bit encoding.
    let n = hash(vec3<f32>(in.pos.xy, P.frame)) - 0.5;
    c += n * P.grain * P.fade;
    return vec4<f32>(c, 1.0);
}
