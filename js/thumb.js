// 썸네일 생성: 격자용(긴 변 480px) + 상세용(긴 변 1024px)

let webpOK;

async function decode(file) {
  try { return await createImageBitmap(file); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}

const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

async function encode(src, w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.fillStyle = '#fff';
  x.fillRect(0, 0, cw, ch);
  x.drawImage(src, 0, 0, cw, ch);
  let out = null;
  if (webpOK !== false) {
    const b = await toBlob(c, 'image/webp', 0.86);
    if (b && b.type === 'image/webp') { webpOK = true; out = b; }
    else webpOK = false;
  }
  if (!out) out = await toBlob(c, 'image/jpeg', 0.88);
  c.width = c.height = 0;
  return out;
}

export async function makeImages(file) {
  const src = await decode(file);
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  const thumb = await encode(src, w, h, 480);
  const image = await encode(src, w, h, 1024);
  src.close?.();
  return { thumb, image, w, h };
}
