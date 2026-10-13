/**
 * 展開図が天伏の「平面（flat）の天井区画」の高さに追従するための点問い合わせ（純モジュール）。
 * 設計意図は .claude/elevation-model.md「天井高さの解決」節。
 *
 * 式は「区画の chMm ?? 部屋の天井高さ」の1つだけ。chMm は部屋 FL 基準で床段差を含まない
 * （floorZFor(room)+ch / floorDeltaMm+chMm にそのまま入れられる）。床段差込みの zMm は使わない。
 * 円弧・ドームは自室の天井断面（zoneCeilingChAlong の includeCurved）と最高点（zoneCeilingChTopAt）だけが対象
 * （遠側・家族の破線・開放スパンは null＝呼び元が部屋の CH へ落とす）。
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
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM, SHORT_WALL_IGNORE_MM } from '../elevationStyle.js';

const FIELD_KEY = { name: 'zoneCeilingField' }; // scopedValue のキー（モジュール内で固定）
const FAR_EDGE_MAX_STEPS = 64; // zoneCeilingFarEdge が奥の端を探して進む矩形数の上限（異常な格子の安全弁）
const COVER_EPS_MM = 0.01;     // 走り範囲を矩形が覆うかの許容差
const WALL_SPAN_MIN_MM = 20;   // 奥の端の壁を探す走り幅の下限（innerWallFaceAt の有意な重なり 5mm を点の問い合わせでも満たす）

const APEX_MARGIN_MM = 1;      // 頭頂が片の端からこれ以上内側にあるときだけ頭頂を返す
const APEX_RISE_EPS_MM = 0.5;  // 頭頂が両端を結ぶ弦より高い量がこれ未満なら直線とみなす（頭頂を返さない）

const isUsableSurface = s => s.zoneId != null && s.shape === 'flat' && Number.isFinite(s.chMm);
// 傾斜の面（区画つき・部屋形状の残りとも）。
const isSlopeSurface = s => s.shape === 'slope' && Number.isFinite(s.chMm);
// 円弧（ヴォールト）・ドームの面（区画つき・部屋形状の残りとも）。
const isCurvedSurface = s => (s.shape === 'arc' || s.shape === 'dome') && Number.isFinite(s.chMm);

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
    return field.surfaces.some(s => isUsableSurface(s) || isSlopeSurface(s) || isCurvedSurface(s)) ? field : null;
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
 * 展開図は壁の仕上げ面 face.faceValue を渡す）。他の部屋・面なし・区画なしの平面は null。
 * **円弧・ドームは includeCurved:true のときだけ**（既定は null＝従来どおり呼び元が部屋の CH へ落とす。遠側の探索・家族の破線・
 * 開放スパンは円弧に追従しない＝既知の限界）。円弧・ドームは (lo, hi) の両端の高さに加え、その壁面上の最高点
 * apex:{along（走り方向の世界座標。面の矩形群の走り方向の中央）, ch}（片の内側にあり、両端を結ぶ弦より高いときだけ）を返す。
 * 走り方向に高さが一定の面（円弧の軸に平行な壁）は chLo==chHi で apex なし（水平線）。
 * 面の判定は probeDepth（既定 depthCoord。セルの内側の点を渡す）×片の中央で行う。両端が別の面に落ちる片は null（防御）。
 * isVertical の面は走り方向が y・奥行きが x（そうでなければ逆）。
 * @param {object|null} field
 * @param {object|null} room
 * @param {{isVertical:boolean, depthCoord:number, probeDepth?:number, lo:number, hi:number, includeCurved?:boolean}} q
 * @returns {{chLo:number, chHi:number, apex?:{along:number, ch:number}}|null}
 */
export function zoneCeilingChAlong(field, room, { isVertical, depthCoord, probeDepth = depthCoord, lo, hi, includeCurved = false }) {
  if (!field || !room || !roomHasCeiling(room)) return null;
  const pt = (depth, run) => (isVertical ? [depth, run] : [run, depth]);
  const surfaceAtRun = run => field.surfaceAt(...pt(probeDepth, run));
  const s = surfaceAtRun((lo + hi) / 2);
  if (!s || s.roomId !== room.id || !Number.isFinite(s.chMm)) return null;
  if (s.shape === 'flat') return s.zoneId != null ? { chLo: s.chMm, chHi: s.chMm } : null;
  const curved = s.shape === 'arc' || s.shape === 'dome';
  if (s.shape !== 'slope' && !(curved && includeCurved)) return null;
  const e = Math.min(0.01, (hi - lo) / 4); // 端は面の境界（閉区間で隣の面と共有）なので少し内側で所属を確かめる
  if (surfaceAtRun(lo + e) !== s || surfaceAtRun(hi - e) !== s) return null;
  const { zAt } = solidOf(s);
  if (!zAt) return { chLo: s.chMm, chHi: s.chMm };
  const chLo = zAt(...pt(depthCoord, lo)), chHi = zAt(...pt(depthCoord, hi));
  if (!Number.isFinite(chLo) || !Number.isFinite(chHi)) return null;
  if (!curved) return { chLo, chHi };
  // 円弧は軸に直交する壁（走り方向が高さの変わる方向）、ドームはどの壁でも、走り方向に高さが変わる
  const varies = s.shape === 'dome' || ((s.dims?.[1] === 0) === isVertical);
  if (!varies) return { chLo, chHi };
  const runs = s.rects.flatMap(r => (isVertical ? [r.y1, r.y2] : [r.x1, r.x2]));
  const along = (Math.min(...runs) + Math.max(...runs)) / 2;
  if (!(along > lo + APEX_MARGIN_MM && along < hi - APEX_MARGIN_MM)) return { chLo, chHi };
  const ch = zAt(...pt(depthCoord, along));
  const chord = chLo + (chHi - chLo) * ((along - lo) / (hi - lo));
  return Number.isFinite(ch) && ch - chord > APEX_RISE_EPS_MM ? { chLo, chHi, apex: { along, ch } } : { chLo, chHi };
}

/**
 * 点 (x,y) の天井の最高点（部屋 FL 基準）。層スタック（壁の帯の打ち切り・垂れ壁）用。
 * 傾斜・円弧・ドームは chMm＋ライズ（面の最高点）・区画つき平面は chMm。他の部屋・面なし・区画なしの平面は null。
 * @returns {number|null}
 */
export function zoneCeilingChTopAt(field, room, x, y) {
  if (!field || !room || !roomHasCeiling(room)) return null;
  const s = field.surfaceAt(x, y);
  if (!s || s.roomId !== room.id || !Number.isFinite(s.chMm)) return null;
  if (s.shape === 'flat') return s.zoneId != null ? s.chMm : null;
  if (s.shape !== 'slope' && s.shape !== 'arc' && s.shape !== 'dome') return null;
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
 * 奥の端の探索は**走り範囲 [runLo,runHi] 全体**を同じ面の矩形が覆う間だけ進む（中央の 1 行だけで進まない）。壁を探す幅も同じ走り範囲
 * （lo==hi の点の問い合わせは最低 WALL_SPAN_MIN_MM）。
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

  // 奥の端: **走り範囲 [lo,hi] 全体**を同じ面の矩形が覆っている間だけ進む（L 字など、中央の 1 行は続いても範囲の端が面から外れる所で止める）。
  // 各深さで、走り範囲に掛かる矩形の奥側の辺のうち最も手前のものまで進み、その先も範囲全体が同じ面で覆われるなら続ける。
  const rectDepthRange = q => (isVertical ? [q.x1, q.x2] : [q.y1, q.y2]);
  const rectRunRange = q => (isVertical ? [q.y1, q.y2] : [q.x1, q.x2]);
  const rectsAt = depth => s.rects.filter(q => {
    const [d1, d2] = rectDepthRange(q), [r1, r2] = rectRunRange(q);
    if (!(depth >= d1 && depth <= d2)) return false;
    // 走り範囲に掛かる矩形（点の問い合わせ lo==hi は点を含むもの。辺が接するだけの隣の矩形は含めない）
    return hi - lo > COVER_EPS_MM ? Math.min(r2, hi) - Math.max(r1, lo) > COVER_EPS_MM : (r1 <= lo + COVER_EPS_MM && r2 >= hi - COVER_EPS_MM);
  });
  const coversRun = rects => {
    let cursor = lo, touched = false;
    for (const [r1, r2] of rects.map(rectRunRange).sort((a, b) => a[0] - b[0])) {
      if (r1 > cursor + COVER_EPS_MM) break;
      if (r2 < cursor - COVER_EPS_MM) continue;
      touched = true;
      cursor = Math.max(cursor, r2);
    }
    return touched && cursor >= hi - COVER_EPS_MM;
  };
  let depth = startCoord + dir * PROBE_EPS_MM, farCoord = null;
  for (let i = 0; i < FAR_EDGE_MAX_STEPS; i++) {
    const rects = rectsAt(depth);
    if (!coversRun(rects)) return null; // 入口から走り範囲を覆えない（防御。2 歩目以降は直前に確かめ済み）
    const edge = rects.reduce((m, q) => {
      const e = rectDepthRange(q)[dir > 0 ? 1 : 0];
      return dir > 0 ? Math.min(m, e) : Math.max(m, e);
    }, dir > 0 ? Infinity : -Infinity);
    const next = edge + dir * PROBE_EPS_MM;
    if (!coversRun(rectsAt(next))) { farCoord = edge; break; }
    depth = next;
  }
  if (farCoord == null) return null;

  // 評価点: 奥の端に面と平行な CL があれば壁の仕上げ面（無ければその座標）。壁の探査幅は点の問い合わせ（lo==hi）でも有意な幅にする
  const cl = parallelCLAt(graph, isVertical, farCoord);
  let wallLo = lo, wallHi = hi;
  if (wallHi - wallLo < WALL_SPAN_MIN_MM) { wallLo = runMid - WALL_SPAN_MIN_MM / 2; wallHi = runMid + WALL_SPAN_MIN_MM / 2; }
  // 走り範囲そのものが閾値より狭い問い合わせ（エンジンの細い列・点）は、範囲いっぱいを必要な重なりとする（壁が範囲を覆えば壁あり）
  const wallFilter = shortWallFilter(wallLo, wallHi, Math.min(SHORT_WALL_IGNORE_MM, wallHi - wallLo));
  const faceCoord = (cl ? innerWallFaceAt(graph, cl, { isVertical, inward: -dir, spanLo: wallLo, spanHi: wallHi, wallFilter }) : null) ?? farCoord;

  const { zAt } = solidOf(s);
  if (!zAt) return { chLo: s.chMm, chHi: s.chMm, alongRun: false };
  const alongX = s.dims?.[1] === 0 || s.dims?.[1] === 180; // 勾配の軸が x（ceilingShape.js と同じ判定）
  const alongRun = alongX === !isVertical;
  const chLo = zAt(...pt(faceCoord, runLo)), chHi = zAt(...pt(faceCoord, runHi));
  if (!Number.isFinite(chLo) || !Number.isFinite(chHi)) return null;
  return alongRun ? { chLo, chHi, alongRun: true } : { chLo, chHi: chLo, alongRun: false };
}

/**
 * 壁と走り範囲 [lo,hi] の重なりが SHORT_WALL_IGNORE_MM 未満なら壁と見なさない wallFilter（裁定2026-10-13）。
 * need は必要な重なり（既定は閾値。点の問い合わせの最低幅へ広げた範囲では呼び元が範囲幅へ下げる）。
 */
export function shortWallFilter(lo, hi, need = SHORT_WALL_IGNORE_MM) {
  return w => Math.min(Math.max(w.coord1, w.coord2), hi) - Math.max(Math.min(w.coord1, w.coord2), lo) >= need - GAP_EPS;
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
 * includeCurved:true のときは円弧・ドームの面の辺も含める（体裁の片を面ごとに1片にする用。開放スパン・家族の破線は渡さない）。
 * @param {object|null} field
 * @param {{isVertical:boolean, depthCoord:number, lo:number, hi:number, includeShaped?:boolean, includeCurved?:boolean}} q
 * @returns {number[]}
 */
export function zoneCeilingEdgesAlong(field, { isVertical, depthCoord, lo, hi, includeShaped = false, includeCurved = false }) {
  if (!field) return [];
  const vals = [];
  for (const s of field.surfaces) {
    if (!isUsableSurface(s) && !(includeShaped && isSlopeSurface(s)) && !(includeCurved && isCurvedSurface(s))) continue;
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

/**
 * 走り方向の座標 runCoord を含む矩形（**どの形状の面でも**。部屋ごとの残りの面も）の、奥行き方向の辺の座標（昇順・重複除去）のうち (lo,hi) の厳密に内側にあるもの。
 * 断面エンジンの cellsAlong が「同じ部屋でも天井の面が変わる所」で視線方向の区間を割るのに使う（天井芯で割れた天井セルは仕上げのセルの中にもある）。
 * isVertical の面は走り方向が y・奥行きが x（そうでなければ逆）。区画なし（field null）は []。
 * @param {object|null} field
 * @param {{isVertical:boolean, runCoord:number, lo:number, hi:number}} q
 * @returns {number[]}
 */
export function zoneCeilingDepthEdges(field, { isVertical, runCoord, lo, hi }) {
  if (!field) return [];
  const vals = [];
  for (const s of field.surfaces) {
    for (const r of s.rects) {
      const [run1, run2, d1, d2] = isVertical ? [r.y1, r.y2, r.x1, r.x2] : [r.x1, r.x2, r.y1, r.y2];
      if (!(runCoord >= run1 && runCoord <= run2)) continue;
      for (const e of [d1, d2]) if (e > lo && e < hi) vals.push(e);
    }
  }
  vals.sort((a, b) => a - b);
  const out = [];
  for (const v of vals) if (!out.length || v - out[out.length - 1] > GAP_EPS) out.push(v);
  return out;
}

/**
 * 奥行き座標 depthCoord で、走り座標 runCoord を含む「天井セルの走り範囲」を [lo,hi]（仕上げのセルの走り範囲）の中へ絞る。
 * 継ぎ目は矩形の走り方向の辺（形状を問わない全ての面）で、体裁の刻み（collectRunBreaks＋区画の辺）と同じ継ぎ目。区画なし（field null）は [lo,hi] のまま。
 * 断面エンジンの cellsAlong が zoneCeilingFarEdge へ渡す片の走り範囲を決める（片が別の面にまたがらないようにする）。
 * @param {object|null} field
 * @param {{isVertical:boolean, depthCoord:number, runCoord:number, lo:number, hi:number}} q
 * @returns {{lo:number, hi:number}}
 */
export function zoneCeilingRunRangeAt(field, { isVertical, depthCoord, runCoord, lo, hi }) {
  let outLo = lo, outHi = hi;
  if (!field) return { lo: outLo, hi: outHi };
  for (const s of field.surfaces) {
    for (const r of s.rects) {
      const [run1, run2, d1, d2] = isVertical ? [r.y1, r.y2, r.x1, r.x2] : [r.x1, r.x2, r.y1, r.y2];
      if (!(depthCoord > d1 && depthCoord < d2)) continue;
      for (const e of [run1, run2]) {
        if (e <= runCoord && e > outLo) outLo = e;
        if (e > runCoord && e < outHi) outHi = e;
      }
    }
  }
  return { lo: outLo, hi: outHi };
}
