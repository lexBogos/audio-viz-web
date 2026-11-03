// Iridescent ink: marbled liquid with thin-film colors. Bass stirs the flow,
// highs and onsets flash the bright veins.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.12;
    var p = uv * 1.5;
    for (var i = 0; i < 5; i++) {
        let fi = f32(i);
        let k = (0.22 + 0.25 * U.bass) / (1.0 + fi * 0.5);
        p += vec2<f32>(sin(p.y * 1.7 + t * 1.1 + fi * 1.3), cos(p.x * 1.5 - t * 0.9 + fi * 2.1)) * k;
    }
    let f = fbm(p * 1.3 + vec2<f32>(t * 0.4, -t * 0.25));
    let h = 0.5 + 0.5 * sin(p.x * 2.2 + p.y * 1.6 + f * 6.0);
    let film = palette(h * 0.5 + f * 0.35 + t * 0.1 + 0.2 * U.mid, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0, 0.7, 0.4), vec3<f32>(0.0, 0.15, 0.2));
    let vein = pow(1.0 - abs(2.0 * h - 1.0), 10.0);

    var col = film * film * (0.08 + 0.5 * U.level) * smoothstep(0.35, 0.8, f);
    col += mix(film, vec3<f32>(1.0), 0.6) * vein * (0.08 + 0.6 * U.high + 1.2 * U.beat);
    return col;
}
