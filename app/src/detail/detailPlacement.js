// ================================================================
// 部分詳細図を各図へ反映する唯一の口（外部が引ける detail/ のファイルはここだけ）。
//   fitLocal      局所座標の位置合わせ（detailFit.js の再輸出。targets は origin の基準 = 0 の局所座標）
//   placeStrokes  位置合わせ済みの頂点列を frame で図座標へ写す
//   fitAndPlace   両方。fit が error ならそのまま返す
//   computeEnvelope  取り合い断面の室内側の包絡線（段差・折れ・輪郭。detailEnvelope.js の再輸出。S8a）
//   materialCodesOf  図の material 束縛が指す材コード（S8a）
//   paramMmOf     図の param 束縛（LenSpec.mode='param'）が持つ mm（プレビュー値）。建具へ写す値の読み口（S6a・R16）
// frame = { ox, oy, sx, sy, tx, ty }: 図座標 = (ox + s·sx + t·tx, oy + s·sy + t·ty)。
// s 軸・t 軸の図座標ベクトルで表すので、鏡像（行列式が負）・回転もここで表せる。
// 点列は [[x,y], ...]（svgFigurePrimitives・elevationPrimitives と同形）。
// ================================================================

import { DETAIL_PRIM_SOURCE, DetailLenMode } from '../core/constants.js';
import { fitDetailFigure, DetailFitError } from './detailFit.js';
import { moveParts } from './detailModel.js';

export { fitDetailFigure as fitLocal, DetailFitError };
export { computeEnvelope, computeUnderside, EnvelopeWeight } from './detailEnvelope.js';
// 本体標準の図（組込み層）。同期で組込みを要る読み出し口（openings/openingCatalog.js detailFigureCatalog）がここから引く。
// catalogKinds.js の loadBuiltin は従来どおり detailBuiltins.js を動的 import する（catalog/ は静的に引かない）。
export { default as detailBuiltinFigures } from './detailBuiltins.js';

/**
 * 図の material 束縛（LenSpec.mode='material'）が指す材コード（空でない文字列のみ）の集合。部屋の取り合いの基準供給
 * （finish/roomDetailTargets.js）が、図が引く材の寸法だけを targets.materials に載せるために使う。壊れた図でも例外にしない。
 * @param {object|null|undefined} figure
 * @returns {Set<string>}
 */
export function materialCodesOf(figure) {
  const codes = new Set();
  const strokes = Array.isArray(figure?.strokes) ? figure.strokes : [];
  for (const stroke of strokes) {
    const moves = Array.isArray(stroke?.moves) ? stroke.moves : [];
    for (const move of moves) {
      for (const part of moveParts(move) ?? []) {
        const len = part.len;
        if (len?.mode === DetailLenMode.MATERIAL && typeof len.code === 'string' && len.code !== '') codes.add(len.code);
      }
    }
  }
  return codes;
}

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
