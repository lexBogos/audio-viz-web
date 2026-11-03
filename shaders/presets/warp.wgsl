// Hyperspace: star streaks race outward; the bass stretches them into warp
// lines, onsets fire a flash from the core.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.7;
    let r = length(uv);
    let a = atan2(uv.y, uv.x);
    let px = 1.0 / U.res.y;
    var col = vec3<f32>(0.0);

    for (var l = 0; l < 4; l++) {
        let fl = f32(l);
        let n = 90.0 + fl * 70.0;
        let ai = (a / TAU + 0.5) * n;
        let cell = floor(ai);
        let h = hash21(vec2<f32>(cell, fl * 17.0));
        let h2 = hash21(vec2<f32>(cell + 31.0, fl));
        if (h < 0.35) {
            continue;
        }
        let z = fract(h2 + t * (0.2 + 0.25 * h) * (1.0 + 0.35 * fl));
        let head = 0.03 + z * z * 1.1;
        let len = 0.004 + (0.03 + 0.5 * U.bass + 0.4 * U.beat) * z * z;
        let along = smoothstep(head - len, head, r) * (1.0 - smoothstep(head, head + 2.0 * px, r));
        let off = abs(fract(ai) - 0.5) * TAU * r / n;
        let width = 1.0 - smoothstep(0.0, px * (0.8 + 2.0 * z), off);
        let tint = palette(h * 0.7 + fl * 0.15, vec3<f32>(0.6), vec3<f32>(0.4), vec3<f32>(1.0), vec3<f32>(0.55, 0.65, 0.8));
        col += tint * along * width * z * (0.8 + 1.5 * U.level) * 2.5;
    }

    let sw = vec2<f32>(cos(a), sin(a));
    let neb = fbm(sw * 1.8 + vec2<f32>(log(r + 0.02) * 1.5 - t * 0.6, fbm(sw * 3.0)));
    col += vec3<f32>(0.08, 0.03, 0.18) * neb * neb * smoothstep(0.0, 0.4, r) * (0.4 + U.mid);
    col += vec3<f32>(0.45, 0.4, 1.0) * exp(-r * 6.0) * (0.15 + 0.5 * U.bass + 1.2 * U.beat);
    col += vec3<f32>(1.0) * exp(-r * 40.0) * (0.3 + U.beat);
    return col;
}
