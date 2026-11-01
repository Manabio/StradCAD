// ================================================================
// 部分詳細図を各図へ反映する唯一の口（外部が引ける detail/ のファイルはここだけ）。
//   fitLocal      局所座標の位置合わせ（detailFit.js の再輸出。targets は origin の基準 = 0 の局所座標）
//   placeStrokes  位置合わせ済みの頂点列を frame で図座標へ写す
//   fitAndPlace   両方。fit が error ならそのまま返す
//   paramMmOf     図の param 束縛（LenSpec.mode='param'）が持つ mm（プレビュー値）。建具へ写す値の読み口（S6a・R16）
// frame = { ox, oy, sx, sy, tx, ty }: 図座標 = (ox + s·sx + t·tx, oy + s·sy + t·ty)。
// s 軸・t 軸の図座標ベクトルで表すので、鏡像（行列式が負）・回転もここで表せる。
// 点列は [[x,y], ...]（svgFigurePrimitives・elevationPrimitives と同形）。
// ================================================================

import { DETAIL_PRIM_SOURCE, DetailLenMode } from '../core/constants.js';
import { fitDetailFigure } from './detailFit.js';
import { moveParts } from './detailModel.js';

export { fitDetailFigure as fitLocal };

/**
 * 図の param 束縛が持つ mm（LenSpec.mm＝プレビュー・試し込み用の値）。param 名 → mm。
 * 同じ param を複数の手が束縛していれば先頭（ストローク順・手順）の正の有限値を採る。
 * mm が正の有限値でない束縛・param 束縛の無い図は含めない（壊れた図でも例外にしない）。
 * @param {object|null|undefined} figure
 * @returns {Record<string, number>}
 */
export function paramMmOf(figure) {
  const out = {};
  const strokes = Array.isArray(figure?.strokes) ? figure.strokes : [];
  for (const stroke of strokes) {
    const moves = Array.isArray(stroke?.moves) ? stroke.moves : [];
    for (const move of moves) {
      for (const part of moveParts(move) ?? []) {
        const len = part.len;
        if (len?.mode !== DetailLenMode.PARAM || typeof len.param !== 'string') continue;
        if (Object.hasOwn(out, len.param)) continue;
        if (Number.isFinite(len.mm) && len.mm > 0) out[len.param] = len.mm;
      }
    }
  }
  return out;
}

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
