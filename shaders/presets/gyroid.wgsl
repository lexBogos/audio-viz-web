// Flight through glowing gyroid sheets. Depth maps to the spectrum: near
// sheets follow the bass, far ones the highs; onsets light up the whole space.
fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.5;
    let ro = vec3<f32>(0.4 * sin(t * 0.3), 0.3 * cos(t * 0.23), t);
    let dir = normalize(vec3<f32>(uv, 0.9));
    let dxy = rot(t * 0.12 + 0.3 * sin(t * 0.07)) * dir.xy;
    let rd = vec3<f32>(dxy, dir.z);
    let thick = 0.025 + 0.06 * U.bass;

    var col = vec3<f32>(0.0);
    var d = 0.05;
    for (var i = 0; i < 70; i++) {
        let p = ro + rd * d;
        let q = p * 1.6;
        let g = abs(dot(sin(q), cos(q.zxy))) / 1.6 - thick;
        let s = max(g, 0.0015);
        let band = spec(clamp(d / 9.0, 0.0, 1.0));
        let c = palette(p.z * 0.06 + d * 0.04, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.0, 0.15, 0.3));
        col += c * c * (0.0015 / (s * s * 30.0 + 0.004)) * (0.15 + 1.6 * band + 1.2 * U.beat) * exp(-d * 0.3);
        d += max(s * 0.7, 0.03);
        if (d > 10.0) {
            break;
        }
    }
    return col * (0.5 + 0.6 * U.level) * 0.03;
}
