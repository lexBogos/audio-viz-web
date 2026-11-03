// Endless tunnel: rings rush past with the music, bass tightens the ring edges.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.6;
    let r = max(length(uv), 1e-3);
    let a = atan2(uv.y, uv.x);
    let z = 0.35 / r + t;
    let sw = vec2<f32>(cos(a), sin(a));

    let rings = pow(abs(sin(z * PI)), 30.0 - 18.0 * U.bass);
    let stripes = pow(abs(sin(a * 6.0 + z * 0.9)), 8.0);
    let n = fbm(sw * 1.5 + vec2<f32>(z * 0.35, -z * 0.2));
    let band = spec(fract(z * 0.07));

    let base = palette(z * 0.04 + n * 0.3, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.6, 0.3, 0.1));
    var col = base * base * (0.05 + 0.4 * n) * (0.3 + U.level);
    col += base * rings * (0.4 + 2.5 * band);
    col += vec3<f32>(0.6, 0.8, 1.0) * stripes * rings * (0.2 + U.high);
    col *= smoothstep(0.0, 0.3, r) * (1.0 + 0.8 * U.beat);
    return col * 0.5;
}
