// RGB (gamma-encoded) -> NV12, BT.709 limited range, written as packed bytes.
// One invocation handles 4 horizontal pixels of luma, and for the top half of
// the grid also the 4x2 chroma block below it. Requires width % 4 == 0, height % 2 == 0.

struct Dims {
    w: u32,
    h: u32,
    _a: u32,
    _b: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out_buf: array<u32>;
@group(0) @binding(2) var<uniform> dims: Dims;

const KR: f32 = 0.2126;
const KG: f32 = 0.7152;
const KB: f32 = 0.0722;

fn to_byte(v: f32) -> u32 {
    return u32(clamp(round(v), 0.0, 255.0));
}

fn load(x: u32, y: u32) -> vec3<f32> {
    return clamp(textureLoad(src, vec2<i32>(i32(x), i32(y)), 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let quads = dims.w / 4u;
    let qx = id.x;
    let y = id.y;
    if (qx >= quads || y >= dims.h) {
        return;
    }
    let x0 = qx * 4u;

    var luma = 0u;
    for (var i = 0u; i < 4u; i++) {
        let c = load(x0 + i, y);
        luma |= to_byte(16.0 + 219.0 * dot(c, vec3<f32>(KR, KG, KB))) << (8u * i);
    }
    out_buf[y * quads + qx] = luma;

    if (y < dims.h / 2u) {
        var chroma = 0u;
        for (var j = 0u; j < 2u; j++) {
            let x = x0 + j * 2u;
            let c = 0.25 * (load(x, 2u * y) + load(x + 1u, 2u * y) + load(x, 2u * y + 1u) + load(x + 1u, 2u * y + 1u));
            let yn = dot(c, vec3<f32>(KR, KG, KB));
            let cb = 128.0 + 224.0 * (c.b - yn) / 1.8556;
            let cr = 128.0 + 224.0 * (c.r - yn) / 1.5748;
            chroma |= (to_byte(cb) | (to_byte(cr) << 8u)) << (16u * j);
        }
        out_buf[(dims.w * dims.h) / 4u + y * quads + qx] = chroma;
    }
}
