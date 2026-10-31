// ================================================================
// 部分詳細図を各図へ反映する唯一の口（外部が引ける detail/ のファイルはここだけ）。
//   fitLocal      局所座標の位置合わせ（detailFit.js の再輸出。targets は origin の基準 = 0 の局所座標）
//   placeStrokes  位置合わせ済みの頂点列を frame で図座標へ写す
//   fitAndPlace   両方。fit が error ならそのまま返す
// frame = { ox, oy, sx, sy, tx, ty }: 図座標 = (ox + s·sx + t·tx, oy + s·sy + t·ty)。
// s 軸・t 軸の図座標ベクトルで表すので、鏡像（行列式が負）・回転もここで表せる。
// 点列は [[x,y], ...]（svgFigurePrimitives・elevationPrimitives と同形）。
// ================================================================

import { DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { fitDetailFigure } from './detailFit.js';

export { fitDetailFigure as fitLocal };

export function placeStrokes(fitted, frame) {
  const { ox, oy, sx, sy, tx, ty } = frame;
  return fitted.strokes.map(st => ({
    id: st.id,
    points: st.points.map(p => [ox + p.s * sx + p.t * tx, oy + p.s * sy + p.t * ty]),
    closed: st.closed,
    line: st.line,
    source: DETAIL_PRIM_SOURCE,
  }));
}

export function fitAndPlace(fig, targets, frame) {
  const fitted = fitDetailFigure(fig, targets);
  if (fitted.error) return fitted;
  return placeStrokes(fitted, frame);
}
