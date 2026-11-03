// Kaleidoscope over a folding fractal; bass zooms, bands color the layers.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.12;
    let p0 = rot(t * 0.3) * uv;
    let r = length(p0);
    let seg = TAU / 8.0;
    var a = atan2(p0.y, p0.x);
    a = abs(a - seg * floor(a / seg) - seg * 0.5);
    var q = vec2<f32>(cos(a), sin(a)) * r * (1.8 - 0.6 * U.bass);

    var col = vec3<f32>(0.0);
    let k = vec2<f32>(0.85 + 0.1 * sin(t), 0.55 + 0.1 * cos(t * 0.7));
    for (var i = 0; i < 6; i++) {
        q = abs(q) / max(dot(q, q), 1e-3) - k;
        let fi = f32(i);
        let c = palette(fi * 0.12 + t * 0.1 + r * 0.5, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.2, 0.4, 0.6));
        col += c * c * exp(-length(q) * (5.0 - 2.5 * spec(fi * 0.16))) * 0.3;
    }
    col *= 0.3 + 0.8 * U.level + 0.6 * U.beat;
    return col * smoothstep(1.2, 0.1, r);
}
