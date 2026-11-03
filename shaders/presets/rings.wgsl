// Concentric glowing arcs; each ring is driven by its own slice of the spectrum.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.2;
    let r = length(uv);
    let a = atan2(uv.y, uv.x);

    var col = vec3<f32>(0.004, 0.003, 0.012);
    col += vec3<f32>(0.02, 0.012, 0.05) * fbm(uv * 2.5 + vec2<f32>(t * 0.3, -t * 0.2)) * (0.5 + U.level);

    for (var i = 0; i < 28; i++) {
        let fi = f32(i) / 28.0;
        let s = spec(fi * 0.9 + 0.02);
        let radius = 0.06 + fi * 0.4 + 0.025 * U.bass;
        let wob = 0.012 * s * sin(a * (3.0 + f32(i % 5)) + t * (1.0 + fi) * 2.0 + f32(i) * 1.3);
        let d = abs(r - radius - wob);
        let w = 0.0012 + 0.0035 * s;
        // Partial arcs that rotate in alternating directions.
        let dir = select(-1.0, 1.0, i % 2 == 0);
        let arc = smoothstep(-0.2, 0.6, sin(a * (1.0 + f32(i % 3)) + dir * t * (0.6 + fi) + f32(i)));
        let c = palette(fi * 0.7 + t * 0.03, vec3<f32>(0.55), vec3<f32>(0.45), vec3<f32>(1.0), vec3<f32>(0.0, 0.33, 0.67));
        col += c * c * (0.25 + 3.0 * s) * arc * (w * w) / (d * d + w * w);
    }

    col += vec3<f32>(1.0, 0.75, 0.9) * U.beat * 0.6 * exp(-r * 7.0);
    return col;
}
