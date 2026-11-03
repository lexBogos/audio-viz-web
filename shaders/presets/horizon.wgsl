// Retro horizon: a striped sun pulsing with the bass, mountains drawn by the
// spectrum, and a neon grid floor that rushes forward with the music.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy;
    let horizon = -0.08;
    let px = 1.0 / U.res.y;

    // Sky, stars and sun.
    let h = uv.y - horizon;
    var sky = mix(vec3<f32>(0.3, 0.02, 0.22), vec3<f32>(0.008, 0.0, 0.035), smoothstep(0.0, 0.55, h));
    let star_cell = floor(frag / 3.0);
    let s = hash21(star_cell);
    sky += vec3<f32>(step(0.997, s)) * (0.4 + 0.4 * sin(U.time * 2.0 + s * 300.0)) * smoothstep(0.15, 0.45, h);

    let sc = vec2<f32>(0.0, horizon + 0.19);
    let sr = 0.2 + 0.025 * U.bass;
    let sd = length(uv - sc);
    let below = (sc.y - uv.y) / sr;
    let cut = select(0.0, step(fract(uv.y * 30.0 + t * 0.4), below * 0.75), below > 0.0);
    let sun_col = mix(vec3<f32>(1.0, 0.85, 0.25), vec3<f32>(1.0, 0.12, 0.45), clamp(0.5 - 0.5 * (uv.y - sc.y) / sr, 0.0, 1.0));
    sky += sun_col * smoothstep(sr, sr - 2.0 * px, sd) * (1.0 - cut) * (1.6 + 1.5 * U.beat);
    sky += vec3<f32>(1.0, 0.25, 0.5) * exp(-max(sd - sr, 0.0) * 9.0) * (0.15 + 0.35 * U.level);

    // Mountains: mirrored spectrum silhouette, lows in the middle.
    let x = abs(uv.x);
    let ridge = horizon + 0.015 + (0.04 + 0.22 * spec(clamp(x * 1.05, 0.0, 1.0))) * smoothstep(0.05, 0.5, x)
        + 0.012 * noise(vec2<f32>(uv.x * 25.0, 0.0));
    let mountain = smoothstep(ridge + px, ridge - px, uv.y);
    sky = mix(sky, vec3<f32>(0.02, 0.0, 0.045), mountain);
    sky += vec3<f32>(0.9, 0.2, 1.0) * exp(-abs(uv.y - ridge) / px * 0.35) * smoothstep(horizon, horizon + 0.01, uv.y) * (0.4 + 1.2 * U.high);

    // Floor: perspective grid, anti-aliased by its own screen-space footprint.
    let dy = max(horizon - uv.y, 1e-4);
    let depth = 0.12 / dy;
    let gx = uv.x * depth * 2.5;
    let gz = depth + t * 1.3;
    let aa_x = depth * 2.5 * px * 1.5;
    let aa_z = depth * depth / 0.12 * px * 1.5;
    let lx = 1.0 - smoothstep(0.02, 0.02 + aa_x, abs(fract(gx + 0.5) - 0.5));
    let lz = 1.0 - smoothstep(0.02, 0.02 + aa_z, abs(fract(gz + 0.5) - 0.5));
    let fade = clamp(1.0 - aa_z * 1.5, 0.0, 1.0) * exp(-depth * 0.05);
    let row = spec(fract(floor(gz) * 0.137));
    var floor_col = vec3<f32>(0.015, 0.0, 0.03);
    floor_col += vec3<f32>(1.0, 0.15, 0.75) * max(lx, lz) * fade * (0.5 + 1.2 * U.bass + 1.5 * row * lz);
    floor_col += vec3<f32>(1.0, 0.3, 0.5) * exp(-abs(uv.x) * 5.0) * exp(-dy * 12.0) * 0.25 * (0.5 + U.level);

    var col = select(floor_col, sky, uv.y > horizon);
    col += vec3<f32>(1.0, 0.35, 0.7) * exp(-abs(uv.y - horizon) * 80.0) * (0.4 + U.level + U.beat);
    return col;
}
