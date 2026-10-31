// ================================================================
// ペン命令列 → 頂点列（純関数）。始点は (0,0)。U=t−・D=t+・L=s−・R=s+・V=(dx,dy)。
// closed でも終点は重ねない（頂点数 = 手の数 + 1。閉じる辺は描画側が先頭へ戻す）。
// 規約: closed のストロークは始点へ戻る手を書かない（戻る図は検証で CLOSED_RETURNS_TO_START）。
// ================================================================

import { DetailAxis } from '../core/constants.js';
import { moveParts } from './detailModel.js';

/** penWalk の失敗の種類。 */
export const DetailPenError = Object.freeze({
  UNKNOWN_DIR:        'unknownDir',
  UNRESOLVED_LENGTH:  'unresolvedLength', // resolveLen が null（param・material が未解決など）
  BAD_LENGTH:         'badLength',        // 有限でない・負
});

/**
 * @param {{moves: object[]}} stroke
 * @param {(len: object) => number|null} resolveLen LenSpec → mm。null は未解決。0 は許す（伸縮の仮置き）が負・非有限は error
 * @returns {{s:number, t:number}[] | {error:{code:string, message:string, moveIndex:number}}}
 */
export function penWalk(stroke, resolveLen) {
  const points = [{ s: 0, t: 0 }];
  let s = 0;
  let t = 0;
  const moves = stroke?.moves ?? [];
  for (let moveIndex = 0; moveIndex < moves.length; moveIndex++) {
    const parts = moveParts(moves[moveIndex]);
    if (parts === null) return { error: { code: DetailPenError.UNKNOWN_DIR, message: `未知の dir: ${String(moves[moveIndex]?.dir)}`, moveIndex } };
    for (const p of parts) {
      const mm = resolveLen(p.len);
      if (mm === null || mm === undefined) return { error: { code: DetailPenError.UNRESOLVED_LENGTH, message: '長さが未解決', moveIndex } };
      if (typeof mm !== 'number' || !Number.isFinite(mm) || mm < 0) return { error: { code: DetailPenError.BAD_LENGTH, message: `長さが有限の非負でない: ${String(mm)}`, moveIndex } };
      if (p.axis === DetailAxis.S) s += p.sign * mm; else t += p.sign * mm;
    }
    points.push({ s, t });
  }
  return points;
}
