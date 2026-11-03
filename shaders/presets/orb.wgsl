// Raymarched liquid orb: the spectrum ripples its surface (lows at the equator,
// highs at the poles), bass inflates it, onsets flash the iridescent rim.

fn orb_rot(p: vec3<f32>, t: f32) -> vec3<f32> {
    let xz = rot(t * 0.31) * p.xz;
    let q = vec3<f32>(xz.x, p.y, xz.y);
    let yz = rot(t * 0.17) * q.yz;
    return vec3<f32>(q.x, yz.x, yz.y);
}

fn orb_map(p: vec3<f32>, t: f32) -> f32 {
    let r = length(p);
    let n = p / max(r, 1e-4);
    let wobble = sin(n.x * 5.0 + t * 1.3) * sin(n.y * 4.0 - t * 0.9) * sin(n.z * 6.0 + t * 1.1);
    let spikes = 0.5 + 0.5 * sin(atan2(n.z, n.x) * 6.0 + n.y * 4.0 + t * 2.0);
    // A few bands averaged, so neighbouring bands don't carve rings into the surface.
    let y = abs(n.y) * 0.6;
    let band = (spec(y - 0.06) + spec(y) + spec(y + 0.06)) / 3.0;
    let bump = 0.12 * band * spikes;
    return r - (0.5 + 0.1 * U.bass + 0.07 * wobble * (0.3 + U.mid) + bump);
}

fn orb_normal(p: vec3<f32>, t: f32) -> vec3<f32> {
    let e = vec2<f32>(0.0015, -0.0015);
    return normalize(
        e.xyy * orb_map(p + e.xyy, t) + e.yyx * orb_map(p + e.yyx, t) +
        e.yxy * orb_map(p + e.yxy, t) + e.xxx * orb_map(p + e.xxx, t)
    );
}

fn scene(uv: vec2<f32>, frag: vec2<f32>) -> vec3<f32> {
    let t = U.energy * 0.45;
    // March in the orb's rotating frame: rotate the ray instead of the object.
    let ro = orb_rot(vec3<f32>(0.0, 0.0, 2.3), t);
    let rd = orb_rot(normalize(vec3<f32>(uv, -1.35)), t);
    let light = orb_rot(normalize(vec3<f32>(0.6, 0.8, 0.7)), t);

    var d = 0.0;
    var glow = 0.0;
    var hit = false;
    for (var i = 0; i < 110; i++) {
        let h = orb_map(ro + rd * d, t);
        glow += 1.0 / (1.0 + h * h * 900.0);
        if (h < 0.0008) {
            hit = true;
            break;
        }
        d += h * 0.45;
        if (d > 4.5) {
            break;
        }
    }

    let haze = fbm(uv * 2.5 + vec2<f32>(t * 0.2, -t * 0.13));
    var col = vec3<f32>(0.03, 0.012, 0.06) * haze * (0.4 + U.level);
    col += vec3<f32>(0.35, 0.2, 1.0) * glow * 0.012 * (0.4 + U.level + 1.5 * U.beat);
    col += vec3<f32>(0.5, 0.25, 0.9) * exp(-length(uv) * 3.0) * 0.06 * (0.3 + U.bass);

    if (hit) {
        let p = ro + rd * d;
        let n = orb_normal(p, t);
        let v = -rd;
        let nv = max(dot(n, v), 0.0);
        let fres = pow(1.0 - nv, 3.0);
        let diff = max(dot(n, light), 0.0);
        let shine = pow(max(dot(reflect(-light, n), v), 0.0), 48.0);
        let iri = palette(nv * 0.9 + 0.35 * spec(abs(n.y)) + t * 0.04, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0), vec3<f32>(0.0, 0.33, 0.67));
        col = iri * iri * (0.03 + 0.35 * diff) * (0.4 + U.level);
        col += vec3<f32>(1.0) * shine * (0.6 + U.high);
        col += iri * fres * (0.35 + 2.0 * U.beat);
    }
    return col;
}
