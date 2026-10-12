/**
 * 展開図が天伏の「平面（flat）の天井区画」の高さに追従するための点問い合わせ（純モジュール）。
 * 設計意図は .claude/elevation-model.md「天井高さの解決」節。
 *
 * 式は「区画の chMm ?? 部屋の天井高さ」の1つだけ。chMm は部屋 FL 基準で床段差を含まない
 * （floorZFor(room)+ch / floorDeltaMm+chMm にそのまま入れられる）。床段差込みの zMm は使わない。
 * 傾斜・円弧・ドームなど平面でない面は対象外（null＝呼び元が部屋の CH へ落とす）。
 * import は純モジュールだけ（react・store.js・snap.js・.jsx を引かない）。
 */
import { buildCeilingHeightField } from '../../ceiling/ceilingHeightField.js';
import { roomHasCeiling } from '../../ceiling/ceilingOwners.js';
import { scopedValue } from '../../graphReadScope.js';
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

const FIELD_KEY = { name: 'zoneCeilingField' }; // scopedValue のキー（モジュール内で固定）

const isUsableSurface = s => s.zoneId != null && s.shape === 'flat' && Number.isFinite(s.chMm);

function buildField(graph) {
  try {
    const field = buildCeilingHeightField(graph);
    return field.surfaces.some(isUsableSurface) ? field : null;
  } catch {
    return null; // 異常な部屋データで展開図全体を巻き添えにしない（区画なし扱い）
  }
}

/**
 * graph の天井高さ場。使える面（区画つきの平面）が1つも無ければ null（＝何も変わらない早道）。
 * @param {object|null} graph
 * @returns {ReturnType<typeof buildCeilingHeightField>|null}
 */
export function zoneCeilingFieldOf(graph) {
  if (!graph) return null;
  return scopedValue(graph, FIELD_KEY, () => buildField(graph));
}

/**
 * 点 (x,y) の区画つき平面の天井高さ（部屋 FL 基準）。room 自身の区画でなければ null。
 * @returns {number|null}
 */
export function zoneCeilingChAt(field, room, x, y) {
  if (!field || !room || !roomHasCeiling(room)) return null;
  const s = field.surfaceAt(x, y);
  if (!s || s.zoneId == null || s.shape !== 'flat') return null;
  if (s.roomId !== room.id || !Number.isFinite(s.chMm)) return null;
  return s.chMm;
}

/**
 * 奥行き座標 depthCoord を含む区画矩形の辺のうち、(lo,hi) の厳密に内側にあるものの走り方向座標（昇順）。
 * isVertical の面は走り方向が y・奥行きが x（そうでなければ逆）。
 * @param {object|null} field
 * @param {{isVertical:boolean, depthCoord:number, lo:number, hi:number}} q
 * @returns {number[]}
 */
export function zoneCeilingEdgesAlong(field, { isVertical, depthCoord, lo, hi }) {
  if (!field) return [];
  const vals = [];
  for (const s of field.surfaces) {
    if (!isUsableSurface(s)) continue;
    for (const r of s.rects) {
      const [d1, d2, e1, e2] = isVertical ? [r.x1, r.x2, r.y1, r.y2] : [r.y1, r.y2, r.x1, r.x2];
      if (!(depthCoord > d1 && depthCoord < d2)) continue;
      for (const e of [e1, e2]) if (e > lo && e < hi) vals.push(e);
    }
  }
  vals.sort((a, b) => a - b);
  const out = [];
  for (const v of vals) if (!out.length || v - out[out.length - 1] > GAP_EPS) out.push(v);
  return out;
}
