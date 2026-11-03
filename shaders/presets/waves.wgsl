// Layered glowing waves; each line's amplitude follows its own band.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.5;
    var col = vec3<f32>(0.004, 0.004, 0.012);
    for (var i = 0; i < 12; i++) {
        let fi = f32(i) / 12.0;
        let b = spec(0.04 + fi * 0.8);
        let freq = 2.0 + fi * 5.0;
        let env = 0.5 + 0.5 * sin(uv.x * 1.3 - t * 0.4 + fi * 9.0);
        let y = (fi - 0.5) * 0.14 + (0.03 + 0.14 * b) * sin(uv.x * freq + t * (1.0 + fi) + fi * 6.0) * env;
        let d = abs(uv.y - y);
        let w = 0.0018 + 0.004 * b;
        let c = palette(fi * 0.8 + t * 0.02, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.0, 0.1, 0.2));
        col += c * c * (w * w) / (d * d + w * w) * (0.3 + 1.6 * b);
    }
    col *= (1.0 + 0.6 * U.beat) * smoothstep(1.0, 0.35, abs(uv.x));
    return col;
}
