// Northern lights: curtains over a starry sky, each curtain follows a frequency band.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.15;
    var col = mix(vec3<f32>(0.002, 0.006, 0.02), vec3<f32>(0.012, 0.0, 0.03), uv.y + 0.5);

    let cell = floor(frag / 3.0);
    let s = hash21(cell);
    col += vec3<f32>(step(0.996, s)) * (0.4 + 0.4 * sin(U.time * 2.0 + s * 300.0));

    for (var i = 0; i < 4; i++) {
        let fi = f32(i);
        let x = uv.x * (1.0 + fi * 0.3) + fi * 3.7;
        let y0 = -0.12 + fi * 0.07 + 0.25 * (fbm(vec2<f32>(x * 0.7 + t * (0.5 + fi * 0.2), fi)) - 0.5);
        let b = spec(0.06 + fi * 0.2);
        let d = uv.y - y0;
        let curtain = smoothstep(-0.015, 0.0, d) * exp(-max(d, 0.0) * (7.0 - 4.0 * b));
        let rays = 0.35 + 0.65 * fbm(vec2<f32>(x * 14.0, t * 1.5 + fi));
        let c = mix(vec3<f32>(0.05, 1.0, 0.45), vec3<f32>(0.55, 0.15, 1.0), clamp(d * 2.5 + fi * 0.15, 0.0, 1.0));
        col += c * curtain * rays * (0.2 + 1.4 * b + 0.5 * U.beat) * 0.4;
    }
    return col;
}
