// 平面・構造モードの長クリックで「どの柱の上か」を判定する純関数（柱の削除メニューの対象選び）。
// react/konva/store/snap.js に依存しない（node:test から単体 import 可能。兄弟 beamTap.js と同じ置き場・流儀）。
//
// 柱の断面矩形は finish/columnWrap.js の bareColumnRect（平面の仕上げ包み・展開図の柱型と共有する
// 「柱の素の平面外形」）を使う——判定が独自の寸法表を持つと、描画と当たりが食い違う。
//
// 受容した限界: (1) カタログ未登録の断面は bareColumnRect の辺長 105 で判定し、柱記号（ColumnSymbol）の描画は
// 120 の正方形（COLUMN_FALLBACK_SIZE_MM）で、両者がずれる。(2) 丸柱は外接正方形で判定する。回転が 90/270 以外の
// 柱は回転前の寸法のままの軸平行矩形で判定し、斜めの外接矩形にはしない（bareColumnRect の規約）。
import { bareColumnRect } from '../finish/columnWrap.js';

function assertFiniteScale(name, v) {
  if (!Number.isFinite(v)) throw new Error(`columnAtPoint: ${name} は有限の数値が必要です（実際: ${v}）`);
}

/**
 * 点（wx, wy）が断面矩形の内側にある柱を返す（境界を含む）。画面上で小さい柱は、中心 ± minHalfPx（画面 px）の
 * 正方形まで当たりを広げる（矩形の半幅が minHalfPx/scale より小さい辺だけ。大きい柱は広がらない）。
 * 複数当たれば中心までの画面距離が最小の柱（同距離は先頭）。
 * @param {Array} columns graph.columns
 * @param {number} wx
 * @param {number} wy
 * @param {{scaleX:number, scaleY:number, minHalfPx:number}} opts 画面 px/mm（viewport.scaleX/Y）と最小半幅（px）
 * @returns {object|null}
 */
export function columnAtPoint(columns, wx, wy, { scaleX, scaleY, minHalfPx } = {}) {
  assertFiniteScale('scaleX', scaleX);
  assertFiniteScale('scaleY', scaleY);
  assertFiniteScale('minHalfPx', minHalfPx);
  let best = null, minDist = Infinity;
  for (const column of columns) {
    const r = bareColumnRect(column);
    const cx = (r.xLo + r.xHi) / 2, cy = (r.yLo + r.yHi) / 2;
    const halfX = Math.max((r.xHi - r.xLo) / 2, minHalfPx / scaleX);
    const halfY = Math.max((r.yHi - r.yLo) / 2, minHalfPx / scaleY);
    if (Math.abs(wx - cx) > halfX || Math.abs(wy - cy) > halfY) continue;
    const dist = Math.hypot((wx - cx) * scaleX, (wy - cy) * scaleY);
    if (dist < minDist) { minDist = dist; best = column; }
  }
  return best;
}
