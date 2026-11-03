// Circular spectrum: mirrored bars around a glowing ring.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.08;
    let px = 1.5 / U.res.y;
    let r = length(uv);
    let a = atan2(uv.y, uv.x) + t;
    let x = abs(fract(a / TAU + 0.25) * 2.0 - 1.0); // mirrored 0..1 around the circle
    let n = 48.0;
    let seg = floor(x * n);
    let cx = (seg + 0.5) / n;
    let local = fract(x * n);
    let v = spec(cx * 0.85);

    let inner = 0.17 + 0.035 * U.bass;
    let len = 0.015 + 0.26 * v;
    let gap = smoothstep(0.0, 0.18, local) * smoothstep(1.0, 0.82, local);
    let inside = smoothstep(inner - px, inner, r) * smoothstep(inner + len + px, inner + len, r);
    let tip = exp(-abs(r - inner - len) * 90.0);

    let c = palette(cx * 0.6 + t * 0.5, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.0, 0.33, 0.67));
    var col = c * c * gap * (inside * (0.3 + 1.2 * v) + tip * 1.5 * v);
    col += vec3<f32>(1.0, 0.9, 1.0) * exp(-abs(r - inner + 0.012) * 250.0) * (0.4 + U.beat);
    col += vec3<f32>(0.6, 0.3, 0.9) * smoothstep(inner, inner - 0.02, r) * (0.03 + 0.25 * U.beat);
    col += vec3<f32>(0.03, 0.01, 0.06) * fbm(uv * 3.0 + t * 4.0) * (0.5 + U.level);
    return col;
}
