/**
 * 下階の階段の吹抜け（続きの階段の足元）: 設置階の直下階に階段があり、その破れ線先セル（踊り場・上側の
 * レーン＝`cellsBeyondBreak`）の上は自階の床が無い（下階の階段が上がってくる穴）。自階の階段帯は、
 * その列では**自分の階段の断面線（切断面にある段板の天端）より下を描かない**（ユーザー指示 2026-10-19
 * roof-test1 2階 階段 A「設置階下階に階段がある場合、下階分は断面を書かない」）——下は下階の階段帯が描く空間で、
 * 2FL の床線・隔て板や壁の断面の縁・段板の下辺・上り口の開口は自階の帯の内容ではない。
 *
 * 判定は材質・階段タイプによらない（セルと切断線の幾何だけ）。床の有無はセル単位（平面はセル＝CL 区切り）だが、
 * 区間の境界が自階の切断壁（隔て板）の材の中に落ちるときは**壁の吹抜け側の面へ寄せる**（ユーザー裁定 2026-10-19:
 * 床は隔て板の下まで続き、穴の縁は隔て板の面）。
 * 純モジュール（store.js・snap.js・*.jsx を静的 import しない）。
 * @module
 */
import { cellsBeyondBreak } from '../../finish/stair/stairGeometry.js';
import { cellBoundsFromKey } from '../../finish/gridCells.js';
import { isIndoorStair } from '../../finish/stair/stairVoidReconcile.js';
import { riserOf } from '../../finish/stair/stairDimensions.js';
import { isCutWall } from './sectionHits.js';
import { localXOf } from './sectionTypes.js';
import { graphList, scopedValue } from '../../graphReadScope.js';
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from '../elevationStyle.js';

/**
 * 直下階の屋内階段の破れ線先セルの矩形（世界座標）。切断ごとに呼ばれるので graph の読み取りスコープで memo 化する
 * （スコープの外＝単体テストでは毎回計算）。riser は直進系の破れ位置に効く（平面・天伏と同じ「階高÷段数」の既定）ので、
 * 呼び出し側が直下階の階高を渡す。
 */
function lowerStairVoidRects(lowerGraph, lowerFloorHeightMm) {
  return scopedValue(lowerGraph, `lowerStairVoid:rects:${lowerFloorHeightMm ?? 'null'}`, () => {
    const rects = [];
    for (const stair of lowerGraph.stairs ?? []) {
      if (!isIndoorStair(lowerGraph, stair)) continue;
      for (const key of cellsBeyondBreak(stair, lowerGraph, riserOf(stair, lowerFloorHeightMm))) {
        const b = cellBoundsFromKey(key, lowerGraph);
        if (b) rects.push(b);
      }
    }
    return rects;
  });
}

/**
 * 切断線（視線の向きへ PROBE_EPS だけ入った位置）が下階の階段の吹抜けのセルを通る範囲（面ローカル x・昇順・互いに離れた区間）。
 * 直下階が無い・吹抜けのセルを通らない・判定不能（破れ線先セルが導出できない）ときは []（＝従来どおり）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {object|null} lowerGraph 直下階の graph（無ければ null）
 * @param {object|null} [graph] 自階の graph（切断壁の材の範囲へ境界を寄せるのに使う。省略時は寄せない）
 * @param {number|null} [lowerFloorHeightMm] 直下階の階高（riser 未指定の直進系の破れ位置に使う。省略時は既定比率）
 * @returns {Array<{lo:number, hi:number, floorLo:number, floorHi:number}>} lo/hi … 断面線より下を落とす区間（境界は切断壁の
 *   吹抜け側の面）。floorLo/floorHi … 自階の床が無い区間（境界は同じ壁の手前の面＝床線はここで止まる。壁が無ければ lo/hi と同じ）。
 *   吹抜けの縁に立つ壁の下には床線を通さない（ユーザー指摘 2026-10-19「2FL に隔て板の下線が残った。不要」）。
 */
export function lowerStairVoidRanges(cut, lowerGraph, graph = null, lowerFloorHeightMm = null) {
  if (!cut?.line || !lowerGraph) return [];
  const line = cut.line;
  const depth = line.axisValue + (cut.viewSign ?? 1) * PROBE_EPS_MM;
  const lineLo = Math.min(line.lo, line.hi), lineHi = Math.max(line.lo, line.hi);
  const world = [];
  for (const b of lowerStairVoidRects(lowerGraph, lowerFloorHeightMm)) {
    // 切断線の軸（深さ）の座標がセルの中にあるか。横切る範囲はセルのもう一方の軸
    const [dLo, dHi, aLo, aHi] = line.isVertical ? [b.x1, b.x2, b.y1, b.y2] : [b.y1, b.y2, b.x1, b.x2];
    if (depth < dLo - GAP_EPS || depth > dHi + GAP_EPS) continue;
    const lo = Math.max(aLo, lineLo), hi = Math.min(aHi, lineHi);
    if (hi - lo > GAP_EPS) world.push({ lo, hi });
  }
  if (world.length === 0) return [];
  const merged = mergeRanges(world);
  const snapped = graph ? merged.map(r => snapToCutWalls(r, cut, graph)).filter(Boolean) : merged;
  const local = (lo, hi) => { const a = localXOf(cut, lo), b = localXOf(cut, hi); return [Math.min(a, b), Math.max(a, b)]; };
  return mergeRanges(snapped.map(r => {
    const [lo, hi] = local(r.lo, r.hi), [floorLo, floorHi] = local(r.floorLo ?? r.lo, r.floorHi ?? r.hi);
    return { lo, hi, floorLo, floorHi };
  }));
}

/** 重なる・接する区間を結合して昇順に返す（floorLo/floorHi があれば min/max で引き継ぐ） */
export function mergeRanges(ranges) {
  const sorted = ranges.filter(r => r.hi - r.lo > GAP_EPS).sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi + GAP_EPS) {
      last.hi = Math.max(last.hi, r.hi);
      if ('floorLo' in last || 'floorLo' in r) {
        last.floorLo = Math.min(last.floorLo ?? last.lo, r.floorLo ?? r.lo);
        last.floorHi = Math.max(last.floorHi ?? last.hi, r.floorHi ?? r.hi);
      }
    } else out.push('floorLo' in r ? { lo: r.lo, hi: r.hi, floorLo: r.floorLo, floorHi: r.floorHi } : { lo: r.lo, hi: r.hi });
  }
  return out;
}

// 区間の端が自階の切断壁（切断線を横切る壁）の材の中に落ちるときは、壁の吹抜け側の面へ寄せる。
// 「材の中」は端の外側の面を含み吹抜け側の面を含まない（lo は [mLo, mHi)・hi は (mLo, mHi]）——端が壁の外側の面に
// ちょうど立つ壁は丸ごと吹抜けの側にあり、床はその壁の下まで続く。端が壁の吹抜け側の面にある壁（面の端の外壁）は
// 吹抜けの外なので寄せない。寄せた結果つぶれた区間は null。
function snapToCutWalls(range, cut, graph) {
  let { lo, hi } = range;
  // 床が無い区間の境界＝寄せた壁の手前の面（壁の連なりの外側）。寄せが無ければ元の境界
  let floorLo = lo, floorHi = hi;
  const walls = (graphList(graph, 'walls') ?? []).filter(w => w?.materialRange && isCutWall(w, cut.line));
  // 隔て板はオーナー壁＋薄壁の合併なので、1 枚で止まらず隣の壁へ続く限り寄せる（壁の数だけ回れば収束する）
  for (let k = 0; k <= walls.length; k++) {
    let moved = false;
    for (const w of walls) {
      const { lo: mLo, hi: mHi } = w.materialRange;
      if (lo >= mLo - GAP_EPS && lo < mHi - GAP_EPS) { lo = mHi; floorLo = Math.min(floorLo, mLo); moved = true; }
      if (hi > mLo + GAP_EPS && hi <= mHi + GAP_EPS) { hi = mLo; floorHi = Math.max(floorHi, mHi); moved = true; }
    }
    if (!moved) break;
  }
  // 寄せた側では、その壁に手前で接する壁（隔て板の仕上げの薄壁など、同じ帯の連なり）の手前の面まで床の無い区間を広げる
  if (floorLo < lo - GAP_EPS) for (let k = 0; k <= walls.length; k++) {
    const w = walls.find(x => floorLo > x.materialRange.lo + GAP_EPS && floorLo <= x.materialRange.hi + GAP_EPS);
    if (!w) break;
    floorLo = w.materialRange.lo;
  }
  if (floorHi > hi + GAP_EPS) for (let k = 0; k <= walls.length; k++) {
    const w = walls.find(x => floorHi >= x.materialRange.lo - GAP_EPS && floorHi < x.materialRange.hi - GAP_EPS);
    if (!w) break;
    floorHi = w.materialRange.hi;
  }
  return hi - lo > GAP_EPS ? { lo, hi, floorLo, floorHi } : null;
}

/**
 * x が区間のどれかに入るか（端を含む）。
 * @param {Array<{lo:number, hi:number}>} ranges
 * @param {number} x
 */
export function inRanges(ranges, x) {
  return (ranges ?? []).some(r => x >= r.lo - GAP_EPS && x <= r.hi + GAP_EPS);
}
