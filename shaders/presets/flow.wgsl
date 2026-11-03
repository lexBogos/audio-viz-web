// Soft liquid gradient: colored blobs drift and swell with their frequency band.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.14;
    let warp = vec2<f32>(fbm(uv * 1.3 + t), fbm(uv * 1.3 - t + 3.1)) - 0.5;
    let p = uv + warp * (0.25 + 0.35 * U.bass);

    var col = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var i = 0; i < 6; i++) {
        let fi = f32(i);
        let c = 0.5 * vec2<f32>(
            sin(t * (0.7 + 0.13 * fi) + fi * 1.7) * 1.5,
            cos(t * (0.5 + 0.11 * fi) + fi * 2.3),
        );
        let b = spec(0.05 + 0.17 * fi);
        let d = p - c;
        let w0 = 1.0 / (dot(d, d) * (5.0 - 3.0 * b) + 0.02);
        let w = w0 * w0;
        let hue = palette(fi / 6.0 + t * 0.02, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.8, 0.9, 0.3));
        col += hue * hue * hue * w * (0.5 + b);
        wsum += w;
    }
    col /= wsum;
    return col * (0.3 + 0.8 * U.level + 0.5 * U.beat);
}
