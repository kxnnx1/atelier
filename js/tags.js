// 프롬프트를 태그 단위로 나누고 가중치를 계산한다.
// 지원: 숫자 가중치 `1.2::tag::`, 중괄호 `{tag}` (×1.05), 대괄호 `[tag]` (÷1.05)

const NUM_RE = /(-?\d+(?:\.\d+)?)::/y;

export function tokenize(text) {
  const out = [];
  const nums = [];
  let brace = 0;
  let cur = '';
  let lvl = 0;
  let num = 1;
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, brace: lvl, num });
    cur = '';
  };
  const s = String(text || '');
  const n = s.length;
  let i = 0;
  while (i < n) {
    const started = cur.trim() !== '';
    if (!started) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(s);
      if (m) { cur = ''; nums.push(parseFloat(m[1])); i = NUM_RE.lastIndex; continue; }
    }
    if (s[i] === ':' && s[i + 1] === ':') { flush(); nums.pop(); i += 2; continue; }
    const c = s[i];
    if (c === ',' || c === '\n' || c === '|') { flush(); i++; continue; }
    if (c === '{') { brace++; i++; continue; }
    if (c === '}') { brace--; i++; continue; }
    if (c === '[') { brace--; i++; continue; }
    if (c === ']') { brace++; i++; continue; }
    if (!started) {
      if (/\s/.test(c)) { i++; continue; }
      lvl = brace;
      num = nums.reduce((a, b) => a * b, 1);
    }
    cur += c;
    i++;
  }
  flush();
  return out;
}

export const isArtistPrefixed = t => /^artist\s*:/i.test(String(t).trim());

export function displayName(text) {
  return String(text || '').replace(/^artist\s*:\s*/i, '').trim();
}

export function normalizeTag(text) {
  return displayName(text).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// 갤러리에 저장된 태그 원문에서 비교용 키를 만든다 (가중치 문법이 섞여 있어도 처리)
export function keyOfTag(raw) {
  const t = tokenize(raw)[0];
  return normalizeTag(t ? t.text : raw);
}

export function weightOf(t) {
  return Math.round(t.num * Math.pow(1.05, t.brace) * 100) / 100;
}

export function formatTag(t) {
  let inner = t.text;
  if (t.brace > 0) inner = '{'.repeat(t.brace) + inner + '}'.repeat(t.brace);
  else if (t.brace < 0) inner = '['.repeat(-t.brace) + inner + ']'.repeat(-t.brace);
  if (t.num !== 1) inner = `${+t.num.toFixed(3)}::${inner}::`;
  return inner;
}

// texts: 긍정 프롬프트 문자열 배열, gallery: Map<key, artist>
export function extractArtists(texts, gallery) {
  const seen = new Map();
  for (const text of texts) {
    for (const t of tokenize(text)) {
      const prefixed = isArtistPrefixed(t.text);
      const key = normalizeTag(t.text);
      if (!key || seen.has(key)) continue;
      const artist = gallery?.get(key) || null;
      if (!prefixed && !artist) continue;
      seen.set(key, { ...t, key, prefixed, artist, weight: weightOf(t) });
    }
  }
  return [...seen.values()];
}
