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
 * 個別柱・共通柱の両方が壁の中で偏心する量(mm)。柱芯（axisX/axisY。偏心を含まない）が乗る壁を
 * 軸ごとに同定し（X軸＝isVertical:trueの壁、Y軸＝isVertical:falseの壁。pointsOnWallLinesを再利用）、
 * 軸ごとの偏心を **2項の和** で求める（ユーザー裁定2026-09-17・ステップ2）:
 *   ecc = (その壁の帯の寄せ。segments[].bandOffset) + s_face * (floorWidthMm − columnWidthMm) / 2
 * 第1項（bandOffset）は壁自身が真実——柱寸法が基準（120）より細い階の外壁下地帯シフト
 * （structural/structureRules.js woodBaseColumnWidthMm・finish/wallGeneration.js
 * generateExteriorWalls。core/wall.js Wall.bandOffset）で、外壁の外面を通り芯±60に固定するために
 * 帯（＝柱の乗る位置）そのものが寄った量。共通柱（columnWidthMm===floorWidthMm）でも外壁上に乗って
 * いれば非ゼロになる——共通柱は「壁の下地帯の中で自分だけ動く」向きの選択余地が無い（帯が動けば
 * 柱も帯と一緒に動くだけ）ため、UI（MemberListTab.jsx ColumnOffsetAxisSelect）の表示条件
 * 「解決柱寸≠階の値」は変えない。第2項（既存 B-1）は柱寸法が階の値と異なる（個別指定）柱が、
 * 帯の中で外面をそろえるための偏心——side指定・outsideSign自動判定・ALONG_PROBE_STEP_MM再試行・
 * 食い違いは中央、の規律は一切変えない。基準幅120（structureRules.js woodBaseColumnWidthMm）は
 * ここには一切現れない——柱側は「階の値(floorWidthMm)との差」だけを見る一系統に統一し、
 * 「基準(120)との差」という別系統を作らない（二重管理防止）。壁が無い軸・不正入力は例外を
 * 投げず {x:0, y:0}（該当軸は0）を返す。
 * @param {object} args
 * @param {number} args.axisX - 柱芯のX座標（偏心を含まない。StructuralColumn.axisX）
 * @param {number} args.axisY - 柱芯のY座標（偏心を含まない。StructuralColumn.axisY）
 * @param {number} args.floorWidthMm - 階の柱寸（壁厚の真実。structureRules.js woodColumnWidthMm）
 * @param {number} args.columnWidthMm - この柱の実効柱寸（structureRules.js columnWidthMm）
 * @param {{x?:-1|0|1, y?:-1|0|1}} [args.side] - 向きの明示指定（WoodColumn.woodOffsetSide。
 *   キー欠落＝自動判定、0＝中央、±1＝その向きの面をそろえる）
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, halfDepth:number, bandOffset?:number}>} args.segments
 *   - 壁区間（wallBeamAxes.js selfWallSegments）。bandOffset は柱寸法シフト量(mm)。
 *   null/undefined/NaNは0扱い（例外を投げない）。
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
  // 早期return（最適化。フル計算と同値——共通柱(floorWidthMm===columnWidthMm)は第2項が0、かつ
  // 全segmentにbandOffsetが無ければ第1項も0のため、結果は必ず{x:0,y:0}になる。この判定自体は
  // 柱ごとにO(segments)——pointsOnWallLinesの壁当たり判定1回分を追加するだけ——なのでコストは
  // ゼロではないが、それに続くpointsOnWallLines呼び出し・resolveSideの走行方向再試行を2軸分
  // 丸ごと省ける）。
  const noBandShift = (segments ?? []).every(s => !s?.bandOffset);
  if (floorWidthMm === columnWidthMm && noBandShift) return { x: 0, y: 0 };
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
  // 第1項: bestが一致した元segmentのbandOffset（壁自身の帯の寄せ量）。best.segはpointsOnWallLinesが
  // 持ち帰る元segmentそのものの参照（QA指摘・2026-09-17: 以前はcoord/lo/hiの値一致で再同定していたが、
  // 他軸に同じ(coord,lo,hi)を持つ壁区間があると誤って取り違える恐れがあった）。segが無い（旧形式の
  // 呼び出し）・非数（null/undefined/NaN）は0扱い（例外は投げない）。
  const bandOffset = Number.isFinite(best.seg?.bandOffset) ? best.seg.bandOffset : 0;
  return normalizeZero(bandOffset + s * half);
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
