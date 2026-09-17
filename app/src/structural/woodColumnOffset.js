// 在来木造の個別柱（柱寸columnWidthMm ≠ 階の柱寸floorWidthMm）が壁の中で偏心する量(mm)を求める
// 純関数（ユーザー裁定2026-09-17・B-1）。設計意図は .claude/structural-model.md
// 「在来木造の個別柱は壁の中で偏心する」参照。
//
// 真実は woodOffsetSide（柱の向き指定。core/structuralEntities.js WoodColumn）——ここでは
// その向きと柱寸・階幅・壁位置から偏心量を導出するだけで、eccentricity{x,y}へは書かない
// （書き手は woodAutoFill.js conformWoodColumnEccentricity のみ）。
//
// 依存は core/constants・woodFraming.js のみ（純モジュール。node:test から単体import可能に保つ——
// .claude structural-model.md「抽出純モジュールはnode:testから単体import可能に保つ」規律）。
import { pointsOnWallLines, WALL_JUNCTION_TOL_MM } from './woodFraming.js';

// 自動判定（side未指定時）で外側方向を確かめる走行方向のサンプリング歩幅(mm)。柱の走行方向座標が
// ちょうど壁の交点（外側判定が0に落ちる位置）に重なるケースを避けるため、±この分ずらして再試行する。
export const ALONG_PROBE_STEP_MM = 100;

/**
 * 個別柱が壁の中で偏心する量(mm)。柱芯（axisX/axisY。偏心を含まない）が乗る壁を軸ごとに同定し
 * （X軸＝isVertical:trueの壁、Y軸＝isVertical:falseの壁。pointsOnWallLinesを再利用）、外面そろえの
 * 向き（side指定、未指定なら自動判定）から `ecc = s_face * (floorWidthMm - columnWidthMm) / 2` を
 * 軸ごとに求める。壁が無い軸・共通柱（columnWidthMm===floorWidthMm）・不正入力は例外を投げず
 * {x:0, y:0} を返す。
 * @param {object} args
 * @param {number} args.axisX - 柱芯のX座標（偏心を含まない。StructuralColumn.axisX）
 * @param {number} args.axisY - 柱芯のY座標（偏心を含まない。StructuralColumn.axisY）
 * @param {number} args.floorWidthMm - 階の柱寸（壁厚の真実。structureRules.js woodColumnWidthMm）
 * @param {number} args.columnWidthMm - この柱の実効柱寸（structureRules.js columnWidthMm）
 * @param {{x?:-1|0|1, y?:-1|0|1}} [args.side] - 向きの明示指定（WoodColumn.woodOffsetSide。
 *   キー欠落＝自動判定、0＝中央、±1＝その向きの面をそろえる）
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, halfDepth:number}>} args.segments
 *   - 壁区間（wallBeamAxes.js selfWallSegments）
 * @param {(axisValue:number, isVertical:boolean, atCross:number)=>(-1|0|1)} args.outsideSign
 *   - 外側方向の符号（+1＝atCross側の外周が座標増加方向）。**wallGate.js buildExteriorSide()の
 *   outsideSignは名前に反して内側方向の符号を返す**（JSDocどおり最小側+1＝内側。実測: 建物内側が
 *   軸座標の増加方向なら+1）ため、呼び出し側（woodAutoFill.js conformWoodColumnEccentricity）が
 *   符号を反転してから渡す。ここでは常に「外側方向の符号」として扱う。
 * @returns {{x:number, y:number}}
 */
export function woodColumnEccentricity({ axisX, axisY, floorWidthMm, columnWidthMm, side, segments, outsideSign }) {
  if (!Number.isFinite(floorWidthMm) || !Number.isFinite(columnWidthMm)) return { x: 0, y: 0 };
  if (floorWidthMm <= 0 || columnWidthMm <= 0) return { x: 0, y: 0 };
  if (floorWidthMm === columnWidthMm) return { x: 0, y: 0 };
  const half = (floorWidthMm - columnWidthMm) / 2;
  return {
    x: axisEccentricity(axisX, axisY, true, half, side?.x, segments, outsideSign),
    y: axisEccentricity(axisX, axisY, false, half, side?.y, segments, outsideSign),
  };
}

// 1軸分の偏心量。isVertical=trueならX軸（縦壁=isVertical:trueの壁で判定・偏心もX方向）、falseならY軸。
function axisEccentricity(axisX, axisY, isVertical, half, sideValue, segments, outsideSign) {
  const lineSegments = (segments ?? []).filter(s => s?.isVertical === isVertical);
  const matches = pointsOnWallLines([{ x: axisX, y: axisY }], lineSegments, WALL_JUNCTION_TOL_MM);
  if (matches.length === 0) return 0; // 一致なしの軸は0（内部壁と同じ扱い＝偏心させない）
  // 同軸複数一致は dist 最小 → coord 昇順で1件に絞る（決定的タイブレーク）。
  const best = matches.reduce((a, b) => {
    if (a.dist !== b.dist) return a.dist < b.dist ? a : b;
    return a.coord <= b.coord ? a : b;
  });
  const s = resolveSide(sideValue, isVertical, best, outsideSign);
  return normalizeZero(s * half);
}

// 外面そろえの向き（-1|0|1）。side指定があればそれを優先し、無ければ outsideSign で判定する。
// まず along（柱そのものの走行方向座標）を試し、非0ならそれを採る。0（判定不能。壁の交点等）なら
// along±ALONG_PROBE_STEP_MMをずらして再試行するが、**ずらした先が一致した壁区間の範囲
// [seg.lo, seg.hi] の外に出る候補は評価しない**（QA指摘・再発防止: 区間外は別の壁・別の位置の
// 外周符号を拾ってしまう——実測 moku1 axis(1820,-10794) のX軸で、区間外の-100候補が拾った符号だけで
// 内部壁なのに非0の偏心が付いた）。区間内の候補が複数あり符号が食い違う（+1と-1）場合も、
// どちらを採るか決定不能なため中央(0)に倒す（食い違いを無視して先着優先すると再現性が無くなる）。
// outsideSign が例外を投げても落とさず0扱いにする（純関数として例外を外へ漏らさない）。
function resolveSide(sideValue, isVertical, seg, outsideSign) {
  if (sideValue === -1 || sideValue === 0 || sideValue === 1) return sideValue;
  const probe = (atCross) => {
    try { return outsideSign?.(seg.coord, isVertical, atCross) ?? 0; } catch { return 0; }
  };
  const along = probe(seg.along);
  if (along !== 0) return along;
  const shifted = [];
  for (const atCross of [seg.along + ALONG_PROBE_STEP_MM, seg.along - ALONG_PROBE_STEP_MM]) {
    if (atCross < seg.lo || atCross > seg.hi) continue; // 区間外の候補は評価しない
    const v = probe(atCross);
    if (v !== 0) shifted.push(v);
  }
  if (shifted.length === 0) return 0;
  return new Set(shifted).size === 1 ? shifted[0] : 0; // 食い違いは中央へ
}

// -0 を 0 へ正規化する（s=0とhalf<0の掛け算、または丸めで -0 になりうる）。
function normalizeZero(v) { return v === 0 ? 0 : v; }
