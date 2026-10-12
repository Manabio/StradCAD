/**
 * 展開図が天伏の「平面（flat）の天井区画」の高さに追従するための点問い合わせ（純モジュール）。
 * 設計意図は .claude/elevation-model.md「天井高さの解決」節。
 *
 * 式は「区画の chMm ?? 部屋の天井高さ」の1つだけ。chMm は部屋 FL 基準で床段差を含まない
 * （floorZFor(room)+ch / floorDeltaMm+chMm にそのまま入れられる）。床段差込みの zMm は使わない。
 * 円弧・ドームは対象外（null＝呼び元が部屋の CH へ落とす）。
 * 傾斜（slope。区画・部屋形状の残りとも）は zoneCeilingChAlong（片の両端の高さ）と zoneCeilingChTopAt（最高点）が返す。
 * 傾斜の高さは「区画の chMm を baseZ にした ceilingShapeSolidZ」で求める（E0 の zAt〔床段差込みの zMm 基準〕は使わない。
 * 床段差は体裁の floorDeltaMm／エンジンの floorZFor が足す）。
 * import は純モジュールだけ（react・store.js・snap.js・.jsx を引かない）。
 */
import { buildCeilingHeightField } from '../../ceiling/ceilingHeightField.js';
import { ceilingShapeSolidZ } from '../../ceiling/ceilingShape.js';
import { roomHasCeiling } from '../../ceiling/ceilingOwners.js';
import { scopedValue } from '../../graphReadScope.js';
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

const FIELD_KEY = { name: 'zoneCeilingField' }; // scopedValue のキー（モジュール内で固定）

const isUsableSurface = s => s.zoneId != null && s.shape === 'flat' && Number.isFinite(s.chMm);
// 傾斜の面（区画つき・部屋形状の残りとも）。円弧・ドームは E4 まで対象外。
const isSlopeSurface = s => s.shape === 'slope' && Number.isFinite(s.chMm);

// 面ごとの高さ関数（baseZ＝chMm。部屋 FL 基準）。zAt が null の面は平面扱い。
const solidByField = new WeakMap(); // surface -> {zAt, zHi}
function solidOf(s) {
  let sol = solidByField.get(s);
  if (!sol) {
    sol = ceilingShapeSolidZ({ shape: s.shape, dims: s.dims, baseZ: s.chMm, rects: s.rects });
    solidByField.set(s, sol);
  }
  return sol;
}

function buildField(graph) {
  try {
    const field = buildCeilingHeightField(graph);
    return field.surfaces.some(s => isUsableSurface(s) || isSlopeSurface(s)) ? field : null;
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
 * 走り方向の片 (lo,hi) の両端の天井高さ（部屋 FL 基準）。room 自身の面だけ。
 * 平面の区画は {chLo, chHi} が同値、傾斜は面の高さ関数の (lo, hi) での値（奥行き座標 depthCoord で評価。
 * 展開図は壁の仕上げ面 face.faceValue を渡す）。円弧・ドーム・他の部屋・面なし・区画なしの平面は null。
 * 面の判定は probeDepth（既定 depthCoord。セルの内側の点を渡す）×片の中央で行う。両端が別の面に落ちる片は null（防御）。
 * isVertical の面は走り方向が y・奥行きが x（そうでなければ逆）。
 * @param {object|null} field
 * @param {object|null} room
 * @param {{isVertical:boolean, depthCoord:number, probeDepth?:number, lo:number, hi:number}} q
 * @returns {{chLo:number, chHi:number}|null}
 */
export function zoneCeilingChAlong(field, room, { isVertical, depthCoord, probeDepth = depthCoord, lo, hi }) {
  if (!field || !room || !roomHasCeiling(room)) return null;
  const pt = (depth, run) => (isVertical ? [depth, run] : [run, depth]);
  const surfaceAtRun = run => field.surfaceAt(...pt(probeDepth, run));
  const s = surfaceAtRun((lo + hi) / 2);
  if (!s || s.roomId !== room.id || !Number.isFinite(s.chMm)) return null;
  if (s.shape === 'flat') return s.zoneId != null ? { chLo: s.chMm, chHi: s.chMm } : null;
  if (s.shape !== 'slope') return null;
  const e = Math.min(0.01, (hi - lo) / 4); // 端は面の境界（閉区間で隣の面と共有）なので少し内側で所属を確かめる
  if (surfaceAtRun(lo + e) !== s || surfaceAtRun(hi - e) !== s) return null;
  const { zAt } = solidOf(s);
  if (!zAt) return { chLo: s.chMm, chHi: s.chMm };
  const chLo = zAt(...pt(depthCoord, lo)), chHi = zAt(...pt(depthCoord, hi));
  return Number.isFinite(chLo) && Number.isFinite(chHi) ? { chLo, chHi } : null;
}

/**
 * 点 (x,y) の天井の最高点（部屋 FL 基準）。層スタック（壁の帯の打ち切り・垂れ壁）用。
 * 傾斜は chMm＋ライズ・区画つき平面は chMm。円弧・ドーム・他の部屋・面なし・区画なしの平面は null。
 * @returns {number|null}
 */
export function zoneCeilingChTopAt(field, room, x, y) {
  if (!field || !room || !roomHasCeiling(room)) return null;
  const s = field.surfaceAt(x, y);
  if (!s || s.roomId !== room.id || !Number.isFinite(s.chMm)) return null;
  if (s.shape === 'flat') return s.zoneId != null ? s.chMm : null;
  if (s.shape !== 'slope') return null;
  return solidOf(s).zHi;
}

/**
 * 奥行き座標 depthCoord を含む区画矩形の辺のうち、(lo,hi) の厳密に内側にあるものの走り方向座標（昇順）。
 * isVertical の面は走り方向が y・奥行きが x（そうでなければ逆）。
 * includeShaped:true のときは傾斜の面（区画つき・部屋形状の残り）の辺も含める（既定は平面の区画だけ）。
 * @param {object|null} field
 * @param {{isVertical:boolean, depthCoord:number, lo:number, hi:number, includeShaped?:boolean}} q
 * @returns {number[]}
 */
export function zoneCeilingEdgesAlong(field, { isVertical, depthCoord, lo, hi, includeShaped = false }) {
  if (!field) return [];
  const vals = [];
  for (const s of field.surfaces) {
    if (!isUsableSurface(s) && !(includeShaped && isSlopeSurface(s))) continue;
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
