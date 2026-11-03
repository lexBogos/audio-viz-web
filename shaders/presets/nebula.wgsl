// Domain-warped fbm clouds; bass pumps the zoom, onsets flash the bright folds.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.22;
    var p = rot(t * 0.12) * uv * (1.7 - 0.3 * U.bass);

    let q = vec2<f32>(
        fbm(p * 1.4 + vec2<f32>(0.0, t * 0.5)),
        fbm(p * 1.4 + vec2<f32>(5.2, 1.3) - t * 0.35),
    );
    let r = vec2<f32>(
        fbm(p * 1.4 + 3.0 * q + vec2<f32>(1.7, 9.2) + t * 0.25),
        fbm(p * 1.4 + 3.0 * q + vec2<f32>(8.3, 2.8) - t * 0.2),
    );
    let f = fbm(p * 1.4 + 3.5 * r);

    let hue = 0.6 + 0.2 * U.mid + 0.08 * sin(t * 0.3);
    var col = palette(f * 0.9 + hue, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.0, 0.12, 0.25));
    col *= col; // deepen saturation in linear space
    col = mix(col, vec3<f32>(1.0, 0.35, 0.55), clamp(length(q) - 0.6, 0.0, 1.0) * U.high * 0.7);

    let fold = smoothstep(0.45, 0.95, f);
    let intensity = f * f * (0.5 + 1.3 * U.level) + fold * (0.3 * U.mid + 1.4 * U.beat);
    return col * intensity;
}
