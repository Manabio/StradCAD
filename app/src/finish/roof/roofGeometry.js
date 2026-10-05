/**
 * 屋根の範囲の幾何（純関数。store.js / snap.js / .jsx を静的 import しない）。ステップ B2。
 */
import { RoofShape, RoofHighSide, RoofRidgeDirection } from '../../core/constants.js';
import { roofRidgeIsVertical } from '../../structural/roofFramingGeometry.js';

const EPS = 1e-6;

function uniqueSorted(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > EPS) out.push(v);
  }
  return out;
}

/**
 * 屋根範囲の「短手」(mm)。範囲に内接する全ての軸平行な矩形の短辺の最大。セルの分割の取り方には
 * 依存しない（L字は2本の腕のうち太い方の幅）。離れた成分はそれぞれ独立に測り、その最大を返す。
 * 空・面積0だけなら 0。
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} boundsList セルの矩形（cellBoundsList の結果）
 * @returns {number}
 */
export function roofShortSpanMm(boundsList) {
  const rects = (boundsList ?? []).filter(b => b && b.x2 - b.x1 > EPS && b.y2 - b.y1 > EPS);
  if (rects.length === 0) return 0;

  const xs = uniqueSorted(rects.flatMap(b => [b.x1, b.x2]));
  const ys = uniqueSorted(rects.flatMap(b => [b.y1, b.y2]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const xIndex = v => xs.findIndex(x => Math.abs(x - v) <= EPS);
  const yIndex = v => ys.findIndex(y => Math.abs(y - v) <= EPS);

  // 座標圧縮した格子に塗る（filled[j][i]）
  const filled = Array.from({ length: ny }, () => new Array(nx).fill(0));
  for (const b of rects) {
    for (let j = yIndex(b.y1); j < yIndex(b.y2); j++) {
      for (let i = xIndex(b.x1); i < xIndex(b.x2); i++) filled[j][i] = 1;
    }
  }
  // 累積和（prefix[j][i] = 左上 (0,0) から (i-1,j-1) までの塗り数）
  const prefix = Array.from({ length: ny + 1 }, () => new Array(nx + 1).fill(0));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      prefix[j + 1][i + 1] = prefix[j][i + 1] + prefix[j + 1][i] - prefix[j][i] + filled[j][i];
    }
  }
  const filledCount = (i0, j0, i1, j1) => // 格子 [i0,i1) × [j0,j1) の塗り数
    prefix[j1][i1] - prefix[j0][i1] - prefix[j1][i0] + prefix[j0][i0];

  let best = 0;
  for (let j0 = 0; j0 < ny; j0++) {
    for (let j1 = j0 + 1; j1 <= ny; j1++) {
      const h = ys[j1] - ys[j0];
      if (h <= best) continue; // 短辺は h を超えられない
      for (let i0 = 0; i0 < nx; i0++) {
        for (let i1 = i0 + 1; i1 <= nx; i1++) {
          const w = xs[i1] - xs[i0];
          const short = Math.min(w, h);
          if (short <= best) continue;
          if (filledCount(i0, j0, i1, j1) === (i1 - i0) * (j1 - j0)) best = short;
        }
      }
    }
  }
  return best;
}

/**
 * セル矩形の和集合が外接矩形と面積で一致するときだけ、その外接矩形を返す（重なりのあるセルも和集合で数える）。
 * L字・離れた成分・空（面積0・null だけ）は null。小屋組は矩形の屋根だけを対象にする（structural/roofFramingGeometry.js）。
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} boundsList セルの矩形
 * @returns {{x1:number,y1:number,x2:number,y2:number}|null}
 */
export function rectOfBounds(boundsList) {
  const rects = (boundsList ?? []).filter(b => b && [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)
    && b.x2 - b.x1 > EPS && b.y2 - b.y1 > EPS);
  if (rects.length === 0) return null;

  const xs = uniqueSorted(rects.flatMap(b => [b.x1, b.x2]));
  const ys = uniqueSorted(rects.flatMap(b => [b.y1, b.y2]));
  const nearIndex = (arr, v) => arr.findIndex(a => Math.abs(a - v) <= EPS);
  const filled = Array.from({ length: ys.length - 1 }, () => new Array(xs.length - 1).fill(false));
  for (const b of rects) {
    for (let j = nearIndex(ys, b.y1); j < nearIndex(ys, b.y2); j++) {
      for (let i = nearIndex(xs, b.x1); i < nearIndex(xs, b.x2); i++) filled[j][i] = true;
    }
  }
  let unionArea = 0;
  for (let j = 0; j < filled.length; j++) {
    for (let i = 0; i < filled[j].length; i++) {
      if (filled[j][i]) unionArea += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
  }
  const bbox = { x1: xs[0], y1: ys[0], x2: xs[xs.length - 1], y2: ys[ys.length - 1] };
  const bboxArea = (bbox.x2 - bbox.x1) * (bbox.y2 - bbox.y1);
  return Math.abs(unionArea - bboxArea) <= EPS * Math.max(1, bboxArea) ? bbox : null;
}

// 片流れの高い側の候補（同長のときの優先順でもある）。y 軸は下向き正なので top＝y が小さい辺（y1）、
// bottom＝y2、left＝x1、right＝x2。値の定義は RoofHighSide（core/constants.js）、順序はここの責務。
const HIGH_SIDE_ORDER = [RoofHighSide.TOP, RoofHighSide.BOTTOM, RoofHighSide.LEFT, RoofHighSide.RIGHT];

/**
 * 片流れの高い側の実効値。順に:
 *   1. 明示値（highSide が 'top'|'bottom'|'left'|'right' のどれか）。それ以外（null・不正値）は未指定扱い。
 *   2. adjacency（各辺の外側が同じ階の屋内に接する長さ mm。下屋だけ）の最大の辺。同長は top→bottom→left→right。
 *      全て 0 以下・非有限なら接していないとみなす。
 *   3. 接していない場合と主屋根（adjacency=null）: 長手方向に平行な辺のうち座標が小さい側
 *      （横長なら top、縦長なら left。正方形は棟が横方向なので top）。
 * rect が無く 1・2 で決まらなければ null。
 * @param {string|null} highSide
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} rect
 * @param {{top:number,bottom:number,left:number,right:number}|null} adjacency
 * @returns {'top'|'bottom'|'left'|'right'|null}
 */
export function resolveRoofHighSide(highSide, rect, adjacency) {
  if (HIGH_SIDE_ORDER.includes(highSide)) return highSide;
  if (adjacency) {
    let best = null;
    let bestLen = 0;
    for (const side of HIGH_SIDE_ORDER) {
      const len = adjacency[side];
      if (Number.isFinite(len) && len > bestLen + EPS) { best = side; bestLen = len; }
    }
    if (best) return best;
  }
  if (!rect) return null;
  return rect.y2 - rect.y1 > rect.x2 - rect.x1 + EPS ? RoofHighSide.LEFT : RoofHighSide.TOP;
}

/**
 * 切妻の棟木が y 方向（縦）か。明示値（'vertical'|'horizontal'）があればそれ、それ以外（null・不正値）は
 * 未指定扱いで従来の長手（roofRidgeIsVertical。正方形は横）。寄棟・片流れでは使わない（呼び出し側が切妻のときだけ引く。
 * 寄棟の棟木は長手に沿わないと成り立たない）。
 * @param {string|null} ridgeDirection RoofSpec.ridgeDirection
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect
 * @param {number} [tolMm=0] 正方形とみなす許容差
 * @returns {boolean}
 */
export function resolveRoofRidgeIsVertical(ridgeDirection, rect, tolMm = 0) {
  if (ridgeDirection === RoofRidgeDirection.VERTICAL) return true;
  if (ridgeDirection === RoofRidgeDirection.HORIZONTAL) return false;
  return roofRidgeIsVertical(rect, tolMm);
}

/**
 * 外部タブの「棟木の向き」の選択欄の表示判断（描画は RoofGroup.jsx が visible と value に従うだけ）。
 *   visible: 形状の実効値が切妻で、屋根範囲が矩形のときだけ true（片流れ・寄棟・陸屋根・矩形でない屋根は出さない）。
 *   value:   明示値（'vertical'|'horizontal'）。未設定（自動＝長手）・不正値は null（欄は「自動（長手）」を示す）。
 * @param {{ shape: string, ridgeDirection: string|null, rect: object|null }} p
 * @returns {{ visible: boolean, value: string|null }}
 */
export function roofRidgeDirectionView({ shape, ridgeDirection, rect }) {
  if (shape !== RoofShape.GABLE || !rect) return { visible: false, value: null };
  const explicit = ridgeDirection === RoofRidgeDirection.VERTICAL || ridgeDirection === RoofRidgeDirection.HORIZONTAL;
  return { visible: true, value: explicit ? ridgeDirection : null };
}

/**
 * 外部タブの「柱貫通」チェックの表示判断（描画は RoofGroup.jsx が visible と value に従うだけ）。
 *   visible: 下屋で、かつ柱が通り芯の交点に立つ構造（rules.columnPlacement が 'wallIntersections' でなく、柱を持つ確定済みの構造＝S造・RC造（ラーメン）・SRC造。hasColumns）の
 *            ときだけ true。在来木造・主屋根（isLeanTo=false）は出さない（値も使わない）。
 *   value:   保存値（true のとき屋根セルにしか接しない位置にも柱を立てる。既定 false）。
 * @param {{ isLeanTo: boolean, columnPlacement: string|null|undefined, hasColumns: boolean|null|undefined, columnThrough: boolean|null|undefined }} p
 * @returns {{ visible: boolean, value: boolean }}
 */
export function roofColumnThroughView({ isLeanTo, columnPlacement, hasColumns, columnThrough }) {
  const visible = isLeanTo === true && columnPlacement !== 'wallIntersections' && hasColumns === true;
  return { visible, value: columnThrough === true };
}

/**
 * 外部タブの「高い側」の選択欄の表示判断（描画は RoofGroup.jsx が visible と value に従うだけ）。
 *   visible: 形状の実効値が片流れで、屋根範囲が矩形のときだけ true。矩形でない片流れ（下屋のL字など）は
 *            小屋組の決め方が未定なので出さない（value は null）。
 *   value:   resolveRoofHighSide の結果（未設定＝自動なら導いた辺。選ぶと保存する）。
 * @param {{ shape: string, highSide: string|null, rect: object|null, adjacency: object|null }} p
 * @returns {{ visible: boolean, value: string|null }}
 */
export function roofHighSideView({ shape, highSide, rect, adjacency }) {
  if (shape !== RoofShape.MONO || !rect) return { visible: false, value: null };
  const value = resolveRoofHighSide(highSide, rect, adjacency);
  return { visible: value !== null, value };
}
