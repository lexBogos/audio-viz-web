// Images for the background, cover circle and logo, plus cover art from the
// track's tags (ID3v2 for MP3, FLAC pictures, MP4/M4A `covr`). Decoding is done by
// the browser (createImageBitmap); only the final, size-capped pixels go to the GPU.

export async function bitmapFrom(blob) {
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

/** RGBA pixels of a bitmap, scaled to fit `maxSide`; with `square` center-cropped. */
export function pixels(bitmap, maxSide, square = false) {
  let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
  if (square) {
    const s = Math.min(sw, sh);
    sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s;
  }
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  return { rgba: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer), w, h };
}

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function id3Cover(b) {
  if (ascii(b, 0, 3) !== 'ID3') return null;
  const ver = b[3];
  const syncsafe = (o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const end = 10 + syncsafe(6);
  let o = 10;
  if (b[5] & 0x40) o += ver === 4 ? syncsafe(10) : u32(b, 10) + 4; // extended header
  while (o + 10 < end) {
    const id = ascii(b, o, 4);
    const size = ver === 4 ? syncsafe(o + 4) : u32(b, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || size <= 0) break;
    if (id === 'APIC') {
      const f = b.subarray(o + 10, o + 10 + size);
      const enc = f[0];
      let p = 1;
      while (p < f.length && f[p]) p++; // MIME type
      const mime = ascii(f, 1, p - 1) || 'image/jpeg';
      p += 2; // NUL + picture type
      if (enc === 1 || enc === 2) { while (p + 1 < f.length && (f[p] || f[p + 1])) p += 2; p += 2; }
      else { while (p < f.length && f[p]) p++; p++; }
      return new Blob([f.subarray(p)], { type: mime.includes('/') ? mime : `image/${mime.toLowerCase()}` });
    }
    o += 10 + size;
  }
  return null;
}

function flacCover(b) {
  if (ascii(b, 0, 4) !== 'fLaC') return null;
  let o = 4;
  for (;;) {
    const last = b[o] & 0x80, type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (type === 6) {
      let p = o + 8;
      const mlen = u32(b, p); const mime = ascii(b, p + 4, mlen); p += 4 + mlen;
      p += 4 + u32(b, p); // description
      p += 16;
      const dlen = u32(b, p);
      return new Blob([b.subarray(p + 4, p + 4 + dlen)], { type: mime || 'image/jpeg' });
    }
    o += 4 + len;
    if (last || o >= b.length) return null;
  }
}

function mp4Cover(b) {
  // Walk moov > udta > meta > ilst > covr > data.
  const find = (start, end, path) => {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = ascii(b, o + 4, 4);
      if (size === 1) size = Number((BigInt(u32(b, o + 8)) << 32n) | BigInt(u32(b, o + 12)));
      if (size < 8) size = end - o;
      if (type === path[0]) {
        const body = o + 8 + (type === 'meta' ? 4 : 0);
        if (path.length === 1) return [o + 8, o + size];
        return find(body, o + size, path.slice(1));
      }
      o += size;
    }
    return null;
  };
  const d = find(0, b.length, ['moov', 'udta', 'meta', 'ilst', 'covr', 'data']);
  if (!d) return null;
  const kind = u32(b, d[0]);
  return new Blob([b.subarray(d[0] + 8, d[1])], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
}

/** Cover art embedded in an audio file, as an image Blob, or null. */
export function coverFromTags(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer);
  try {
    return id3Cover(b) ?? flacCover(b) ?? mp4Cover(b);
  } catch {
    return null;
  }
}

/** Data URL of a blob (to store images in a project file). */
export function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
