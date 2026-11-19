// 백업 파일(.zip) = data.json + images/
import { makeZip, readZip } from './zip.js';

const extOf = b => {
  const t = b?.type || '';
  return t.includes('webp') ? 'webp' : t.includes('png') ? 'png' : 'jpg';
};
const typeOf = p => p.endsWith('.webp') ? 'image/webp' : p.endsWith('.png') ? 'image/png' : 'image/jpeg';

export async function buildBackup({ artists, images, styles, tombstones, folderOrder, tagSections = [], tagItems = [] }) {
  const entries = [];
  const fileOf = (id, suffix, blob) => {
    if (!blob) return null;
    const name = `images/${id}${suffix}.${extOf(blob)}`;
    entries.push({ name, data: blob });
    return name;
  };
  const strip = r => {
    const { thumb, image, ...rest } = r;
    return { ...rest, thumb: fileOf(r.id, '_t', thumb), image: fileOf(r.id, '', image) };
  };
  const data = {
    app: 'atelier',
    format: 1,
    exportedAt: Date.now(),
    artists,
    artistImages: images.map(strip),
    styles: styles.map(strip),
    tombstones,
    folderOrder,
    tagSections,
    tagItems: tagItems.map(strip),
  };
  entries.unshift({ name: 'data.json', data: JSON.stringify(data) });
  return makeZip(entries);
}

export async function parseBackup(file) {
  const z = await readZip(file);
  const dj = z.names
    .filter(n => n.endsWith('data.json') && !n.includes('__MACOSX'))
    .sort((a, b) => a.length - b.length)[0];
  if (!dj) throw new Error('백업 파일 안에 data.json이 없어요');
  const prefix = dj.slice(0, -'data.json'.length);
  const data = JSON.parse(new TextDecoder().decode(await z.get(dj)));
  if (data.app !== 'atelier') throw new Error('Atelier 백업 파일이 아니에요');
  const load = async p => {
    if (!p) return null;
    const u = await z.get(prefix + p);
    return u ? new Blob([u], { type: typeOf(p) }) : null;
  };
  for (const list of [data.artistImages || [], data.styles || [], data.tagItems || []]) {
    for (const r of list) {
      r.thumb = await load(r.thumb);
      r.image = await load(r.image);
    }
  }
  data.artists ||= [];
  data.artistImages ||= [];
  data.styles ||= [];
  data.tombstones ||= [];
  data.tagSections ||= [];
  data.tagItems ||= [];
  return data;
}
