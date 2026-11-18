// NovelAI 메타데이터 추출
// 1) PNG 텍스트 청크(tEXt / zTXt / iTXt)
// 2) 스텔스 메타데이터(알파 채널 LSB, stealth_pngcomp / stealth_pnginfo)

const utf8 = new TextDecoder('utf-8');
const latin = new TextDecoder('latin1');

export async function readNaiMetadata(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let info = null;
  let source = null;
  if (isPng(buf)) {
    const t = await readPngText(buf);
    if (t.Comment || t.Description || t.parameters) { info = t; source = 'png'; }
  }
  if (!info) {
    try {
      const st = await readStealth(file);
      if (st) { info = st; source = 'stealth'; }
    } catch (e) { console.warn('stealth read failed', e); }
  }
  return info ? normalize(info, source) : null;
}

function isPng(b) {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function decodeText(u8) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { return latin.decode(u8); }
}

async function inflate(u8, format) {
  const ds = new DecompressionStream(format);
  const res = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return new Uint8Array(await res.arrayBuffer());
}

async function readPngText(b) {
  const out = {};
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const d = b.subarray(p + 8, p + 8 + len);
    try {
      if (type === 'tEXt') {
        const z = d.indexOf(0);
        if (z > 0) out[latin.decode(d.subarray(0, z))] = decodeText(d.subarray(z + 1));
      } else if (type === 'zTXt') {
        const z = d.indexOf(0);
        if (z > 0) out[latin.decode(d.subarray(0, z))] = utf8.decode(await inflate(d.subarray(z + 2), 'deflate'));
      } else if (type === 'iTXt') {
        const z = d.indexOf(0);
        if (z > 0) {
          const key = latin.decode(d.subarray(0, z));
          const compressed = d[z + 1] === 1;
          const langEnd = d.indexOf(0, z + 3);
          const transEnd = d.indexOf(0, langEnd + 1);
          const body = d.subarray(transEnd + 1);
          out[key] = compressed ? utf8.decode(await inflate(body, 'deflate')) : utf8.decode(body);
        }
      } else if (type === 'IEND') break;
    } catch (e) { console.warn('chunk', type, e); }
    p += 12 + len;
  }
  return out;
}

async function readStealth(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); }
  catch { bmp = await createImageBitmap(file); }
  const w = bmp.width, h = bmp.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const px = ctx.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;

  // 열 우선(column-major) 순서로 알파 채널 최하위 비트를 읽는다
  const total = w * h;
  let bit = 0;
  const readBit = () => {
    if (bit >= total) throw new Error('eof');
    const x = (bit / h) | 0, y = bit % h;
    bit++;
    return px[(y * w + x) * 4 + 3] & 1;
  };
  const readBytes = n => {
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | readBit();
      o[i] = v;
    }
    return o;
  };

  const magic = latin.decode(readBytes(15));
  let compressed;
  if (magic === 'stealth_pngcomp') compressed = true;
  else if (magic === 'stealth_pnginfo') compressed = false;
  else return null;

  const lb = readBytes(4);
  const bits = ((lb[0] << 24) | (lb[1] << 16) | (lb[2] << 8) | lb[3]) >>> 0;
  if (bits <= 0 || bits / 8 > total) return null;
  const data = readBytes(Math.floor(bits / 8));
  const text = compressed ? utf8.decode(await inflate(data, 'gzip')) : utf8.decode(data);
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : { Description: String(text) };
  } catch {
    return { parameters: text };
  }
}

// ---------- 표시용 텍스트로 정리 ----------

function normalize(info, source) {
  let c = info.Comment;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
  const sections = [];
  const push = (key, title, body, kind) => {
    if (body == null) return;
    const b = String(body).trim();
    if (b) sections.push({ key, title, body: b, kind });
  };

  if (c && typeof c === 'object') {
    const v4p = c.v4_prompt?.caption;
    const v4n = c.v4_negative_prompt?.caption;
    push('prompt', '프롬프트', v4p?.base_caption ?? c.prompt ?? info.Description, 'prompt');
    (v4p?.char_captions || []).forEach((cc, i) => push(`char${i + 1}`, `캐릭터 ${i + 1} 프롬프트`, cc.char_caption, 'prompt'));
    push('uc', 'UC 프롬프트', v4n?.base_caption ?? c.uc, 'uc');
    (v4n?.char_captions || []).forEach((cc, i) => push(`char${i + 1}uc`, `캐릭터 ${i + 1} UC`, cc.char_caption, 'uc'));
    push('settings', '생성 설정', settingsText(c, info), 'settings');
  } else if (info.parameters) {
    // 참고: 다른 생성기(A1111 등) 형식
    const p = String(info.parameters);
    const ni = p.indexOf('\nNegative prompt:');
    const si = p.lastIndexOf('\nSteps:');
    const promptEnd = ni >= 0 ? ni : si >= 0 ? si : p.length;
    push('prompt', '프롬프트', p.slice(0, promptEnd), 'prompt');
    if (ni >= 0) push('uc', 'UC 프롬프트', p.slice(ni + 17, si > ni ? si : p.length), 'uc');
    if (si >= 0) push('settings', '생성 설정', p.slice(si + 1).replace(/, /g, '\n'), 'settings');
  } else if (info.Description) {
    push('prompt', '프롬프트', info.Description, 'prompt');
  }

  const rawObj = { ...info };
  if (c && typeof c === 'object') rawObj.Comment = c;
  return {
    sections,
    raw: JSON.stringify(rawObj, null, 2),
    source,
    width: c?.width,
    height: c?.height,
  };
}

function settingsText(c, info) {
  const L = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') L.push(`${k}: ${v}`); };
  add('모델', info.Source);
  add('소프트웨어', info.Software);
  if (c.width && c.height) add('크기', `${c.width} × ${c.height}`);
  add('Steps', c.steps);
  add('Prompt Guidance', c.scale);
  add('Guidance Rescale', c.cfg_rescale);
  add('Sampler', c.sampler);
  add('Noise Schedule', c.noise_schedule);
  add('Seed', c.seed);
  if ('sm' in c) add('SMEA', c.sm ? (c.sm_dyn ? 'SMEA + DYN' : 'SMEA') : 'off');
  if (c.skip_cfg_above_sigma != null) add('Variety+', 'on');
  if (c.uncond_scale != null && c.uncond_scale !== 1) add('UC Strength', c.uncond_scale);
  add('요청 유형', c.request_type);
  add('생성 시간', info['Generation time']);
  return L.join('\n');
}
