/**
 * レイヤ表示スタイル（LayerStyle）→ Konva 属性の写像。
 *
 * SOLID は素通し（属性を足さない＝現状の描画と完全一致）。Phase 3 時点で実際に使われるのは SOLID のみで、
 * DASHED/GHOST/DIM は将来の図面型（天井伏図の上階床梁＝破線参照、PS検討＝ゴースト重ね等）が
 * 「FigureDef を1個足すだけ」で利用できるよう、写像を先に用意したもの（レンダラ側の追加改修を不要にする）。
 */

import { LayerStyle } from './figureTypes.js';

// カテゴリ描画を包む Konva.Group に渡す属性（不透明度）。Group の opacity は子の不透明度に乗算されるため、
// 各図形が持つ固有 opacity（フーチング0.2 等）を保ったまま、レイヤ全体だけを淡くできる。
export function groupPropsForStyle(style) {
  switch (style) {
    case LayerStyle.GHOST: return { opacity: 0.4 };
    case LayerStyle.DIM:   return { opacity: 0.6 };
    default:               return {}; // SOLID / DASHED は不透明度を変えない
  }
}

// 線・帯・輪郭の破線パターン（world mm）。DASHED のみ破線、それ以外は実線（undefined）。
// 図形固有の破線（柱脚の点線など）がある場合はそちらを優先し、これは「固有破線が無い線」に適用する。
export function dashForStyle(style) {
  return style === LayerStyle.DASHED ? [120, 80] : undefined;
}
