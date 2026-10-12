/**
 * 展開図が天伏の「平面（flat）の天井区画」の高さに追従するための点問い合わせ（純モジュール）。
 * 設計意図は .claude/elevation-model.md「天井高さの解決」節。
 *
 * 式は「区画の chMm ?? 部屋の天井高さ」の1つだけ。chMm は部屋 FL 基準で床段差を含まない
 * （floorZFor(room)+ch / floorDeltaMm+chMm にそのまま入れられる）。床段差込みの zMm は使わない。
 * 円弧・ドームは対象外（null＝呼び元が部屋の CH へ落とす）。
 * 傾斜（slope。区画・部屋形状の残りとも）は zoneCeilingChAlong（片の両端の高さ）と zoneCeilingChTopAt（最高点）、
 * 視線の先の遠側は zoneCeilingFarEdge（同じ面が続く範囲の奥の端の高さ）が返す。
 * 傾斜の高さは「区画の chMm を baseZ にした ceilingShapeSolidZ」で求める（E0 の zAt〔床段差込みの zMm 基準〕は使わない。
 * 床段差は体裁の floorDeltaMm／エンジンの floorZFor が足す）。
 * import は純モジュールだけ（react・store.js・snap.js・.jsx を引かない）。
 */
import { buildCeilingHeightField } from '../../ceiling/ceilingHeightField.js';
import { ceilingShapeSolidZ } from '../../ceiling/ceilingShape.js';
import { roomHasCeiling } from '../../ceiling/ceilingOwners.js';
import { CenterLineType } from '@core';
import { scopedValue, graphList } from '../../graphReadScope.js';
import { isCeilingOnlyKind } from '../../core/centerLineKindPolicy.js';
import { innerWallFaceAt } from '../../finish/wallFaces.js';
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from '../elevationStyle.js';

const FIELD_KEY = { name: 'zoneCeilingField' }; // scopedValue のキー（モジュール内で固定）
const FAR_EDGE_MAX_STEPS = 64; // zoneCeilingFarEdge が奥の端を探して進む矩形数の上限（異常な格子の安全弁）
const WALL_SPAN_MIN_MM = 20;   // 奥の端の壁を探す走り幅の下限（innerWallFaceAt の有意な重なり 5mm を点の問い合わせでも満たす）

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
 * 視線の先（奥）の天井高さ。startCoord（視線が room の面へ入る奥行き座標。展開図は面の軸 CL の値、エンジンはセルへ入る世界座標）から
 * dir（+1/−1。奥行き軸上の向き）へ PROBE_EPS_MM 進んだ点の面が room 自身の flat 区画・slope（区画・部屋形状）なら、
 * **同じ面が続く範囲の奥の端**での高さを返す（部屋 FL 基準。床段差を含まない。baseZ＝chMm の規律は zoneCeilingChAlong と同じ）。
 * 奥の端に面と平行な CL（天井芯は除く）があればその位置の壁の仕上げ面（finish/wallFaces.js innerWallFaceAt）、無ければ座標のまま。
 * - 平面の区画: {chLo: chMm, chHi: chMm, alongRun: false}（従来と同じ値）。
 * - 奥行き方向の傾斜: chLo＝chHi＝奥の端の高さ（alongRun false）。**走り方向に水平な線 1 本**で表せる。
 * - 走り方向の傾斜: chLo/chHi＝奥の端での runLo/runHi の高さ（alongRun true）。体裁は斜線 1 本・エンジンは片を積まない（呼び元が決める）。
 * 面なし・他の部屋・区画なしの平面・円弧・ドーム・端が見つからない（歩く上限 FAR_EDGE_MAX_STEPS）・runLo/runHi の両端が別の面に落ちる片は null
 * （呼び元は部屋の CH へ落とす）。isVertical の面は走り方向が y・奥行きが x（そうでなければ逆）。
 * @param {object|null} field
 * @param {object|null} graph
 * @param {object|null} room
 * @param {{isVertical:boolean, runLo:number, runHi:number, startCoord:number, dir:number}} q
 * @returns {{chLo:number, chHi:number, alongRun:boolean}|null}
 */
export function zoneCeilingFarEdge(field, graph, room, { isVertical, runLo, runHi, startCoord, dir }) {
  if (!field || !room || !roomHasCeiling(room)) return null;
  if (!Number.isFinite(startCoord) || !Number.isFinite(runLo) || !Number.isFinite(runHi) || !(dir === 1 || dir === -1)) return null;
  const pt = (depth, run) => (isVertical ? [depth, run] : [run, depth]);
  const runMid = (runLo + runHi) / 2;
  const s = field.surfaceAt(...pt(startCoord + dir * PROBE_EPS_MM, runMid));
  if (!s || s.roomId !== room.id || !Number.isFinite(s.chMm)) return null;
  if (s.shape === 'flat') return s.zoneId != null ? { chLo: s.chMm, chHi: s.chMm, alongRun: false } : null;
  if (s.shape !== 'slope') return null;
  const e = Math.min(0.01, Math.abs(runHi - runLo) / 4); // 端は面の境界（閉区間で隣の面と共有）なので少し内側で所属を確かめる
  const lo = Math.min(runLo, runHi), hi = Math.max(runLo, runHi);
  if (field.surfaceAt(...pt(startCoord + dir * PROBE_EPS_MM, lo + e)) !== s || field.surfaceAt(...pt(startCoord + dir * PROBE_EPS_MM, hi - e)) !== s) return null;

  // 奥の端: 点を含む矩形の奥側の辺へ進み、その先が同じ面の別の矩形に続く間だけ進む
  let depth = startCoord + dir * PROBE_EPS_MM, farCoord = null;
  for (let i = 0; i < FAR_EDGE_MAX_STEPS; i++) {
    const [px, py] = pt(depth, runMid);
    const r = s.rects.find(q => px >= q.x1 && px <= q.x2 && py >= q.y1 && py <= q.y2);
    if (!r) return null;
    const edge = isVertical ? (dir > 0 ? r.x2 : r.x1) : (dir > 0 ? r.y2 : r.y1);
    const next = edge + dir * PROBE_EPS_MM;
    if (field.surfaceAt(...pt(next, runMid)) !== s) { farCoord = edge; break; }
    depth = next;
  }
  if (farCoord == null) return null;

  // 評価点: 奥の端に面と平行な CL があれば壁の仕上げ面（無ければその座標）。壁の探査幅は点の問い合わせ（lo==hi）でも有意な幅にする
  const cl = parallelCLAt(graph, isVertical, farCoord);
  let wallLo = lo, wallHi = hi;
  if (wallHi - wallLo < WALL_SPAN_MIN_MM) { wallLo = runMid - WALL_SPAN_MIN_MM / 2; wallHi = runMid + WALL_SPAN_MIN_MM / 2; }
  const faceCoord = (cl ? innerWallFaceAt(graph, cl, { isVertical, inward: -dir, spanLo: wallLo, spanHi: wallHi }) : null) ?? farCoord;

  const { zAt } = solidOf(s);
  if (!zAt) return { chLo: s.chMm, chHi: s.chMm, alongRun: false };
  const alongX = s.dims?.[1] === 0 || s.dims?.[1] === 180; // 勾配の軸が x（ceilingShape.js と同じ判定）
  const alongRun = alongX === !isVertical;
  const chLo = zAt(...pt(faceCoord, runLo)), chHi = zAt(...pt(faceCoord, runHi));
  if (!Number.isFinite(chLo) || !Number.isFinite(chHi)) return null;
  return alongRun ? { chLo, chHi, alongRun: true } : { chLo, chHi: chLo, alongRun: false };
}

// 面（isVertical）と平行な CL（天井専用の天井芯は除く。elevationFloorProfile.js findRunCLAt と同じ除外）のうち value に一致するもの。
function parallelCLAt(graph, isVertical, value) {
  const type = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  return (graphList(graph, 'centerLines') ?? []).find(cl =>
    cl.centerLineType === type && cl.value === value && !isCeilingOnlyKind(cl)) ?? null;
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
