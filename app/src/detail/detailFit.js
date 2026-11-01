// ================================================================
// 位置合わせ（fit。純関数）。ペン命令列の図を、取り付け先から渡される目標（基準の位置・寸法）に合わせた頂点列にする。
//   - stretch 以外の長さ（fixed・param・material）を解決して歩く。
//   - end の Anchor を持つ軸は、origin の頂点と end の頂点の差が (end の目標 − origin の目標) になるよう、
//     その軸の stretch 1 本にだけ全差分を配る（固定寸法は変えない）。
//   - 最後に origin の Anchor の頂点が origin の目標に来るよう軸ごとに平行移動する。
// targets は局所座標（origin の基準 = 0）。各 Datum の offsetMm は目標値に加算する（FL+900 → datums.fl + 900）。
// 解決できないものは黙って代用せず error を返す。
// ================================================================

import { DetailLenMode, DetailAxis, DetailDatumKind, DETAIL_FIT_EPS_MM } from '../core/constants.js';
import { normalizeDetailFigure, validateDetailFigure, moveParts, stretchPartsOf } from './detailModel.js';
import { penWalk } from './detailPen.js';

/** fit の失敗の種類。 */
export const DetailFitError = Object.freeze({
  INVALID:               'invalid',            // validateDetailFigure が通らない（errors に理由）
  NO_TARGET_DATUM:       'noTargetDatum',      // targets.datums に無い・有限でない Datum
  UNRESOLVED_PARAM:      'unresolvedParam',
  UNRESOLVED_MATERIAL:   'unresolvedMaterial',
  BAD_RESOLVED_LENGTH:   'badResolvedLength',  // 解決した長さが有限かつ正でない
  FIXED_EXCEEDS_TARGET:  'fixedExceedsTarget', // 固定寸法の和が目標を超え、stretch が 0 以下になる
});
const F = DetailFitError;

const fail = (code, message, extra) => ({ error: { code, message, ...extra } });
const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {object} plain DetailFigure
 * @param {{datums?: Object<string, number>, params?: Object<string, number>, materials?: Object<string, {thickness:number, x:number, y:number}>}} targets
 * @returns {{strokes: {id:string, points:{s:number,t:number}[], closed:boolean, line:object, edgeMarks?:(string|null)[]}[], warnings: object[]} | {error:{code:string, message:string}}}
 *   edgeMarks は印（Move.edge）が 1 つでもあるストロークだけ。手 i（頂点 i→i+1）の印、無ければ null
 */
export function fitDetailFigure(plain, targets) {
  const fig = normalizeDetailFigure(plain);
  const v = validateDetailFigure(fig);
  if (!v.ok) return fail(F.INVALID, `詳細図が不正: ${v.errors.map(e => e.message).join(' / ')}`, { errors: v.errors });

  const tg = targets ?? {};
  const targetOf = new Map();
  for (const d of fig.datums) {
    const base = tg.datums?.[d.id];
    if (!isFiniteNumber(base)) return fail(F.NO_TARGET_DATUM, `targets.datums に基準 ${d.id} の位置が無い`);
    targetOf.set(d.id, base + d.offsetMm);
  }
  const datumById = new Map(fig.datums.map(d => [d.id, d]));

  const strokes = [];
  for (const stroke of fig.strokes) {
    // (a) stretch 以外を解決する
    const resolved = new Map(); // LenSpec → mm
    for (const move of stroke.moves) {
      for (const p of moveParts(move)) {
        const len = p.len;
        if (len.mode === DetailLenMode.STRETCH) continue;
        let mm;
        if (len.mode === DetailLenMode.FIXED) mm = len.mm;
        else if (len.mode === DetailLenMode.PARAM) {
          mm = tg.params?.[len.param];
          if (mm === undefined || mm === null) return fail(F.UNRESOLVED_PARAM, `param ${len.param} が未解決（ストローク ${stroke.id}）`);
        } else {
          mm = tg.materials?.[len.code]?.[len.field];
          if (mm === undefined || mm === null) return fail(F.UNRESOLVED_MATERIAL, `材 ${len.code} の ${len.field} が未解決（ストローク ${stroke.id}）`);
        }
        if (!isFiniteNumber(mm) || mm <= 0) return fail(F.BAD_RESOLVED_LENGTH, `解決した長さが有限かつ正でない: ${String(mm)}（ストローク ${stroke.id}）`);
        resolved.set(len, mm);
      }
    }
    const walk = () => penWalk(stroke, len => (len.mode === DetailLenMode.STRETCH ? (resolved.get(len) ?? 0) : resolved.get(len)));

    // この軸に載る Anchor（origin / end）の頂点番号と Datum
    const anchorOn = (axis, kind) => {
      for (const a of fig.anchors) {
        if (a.strokeId !== stroke.id) continue;
        const d = datumById.get(a.datumId);
        if (d.axis === axis && d.kind === kind) return { vertexIndex: a.vertexIndex, datum: d };
      }
      return null;
    };

    // (b) end の Anchor がある軸は stretch 1 本の長さを決める
    const provisional = walk();
    if (!Array.isArray(provisional)) return fail(F.INVALID, provisional.error.message);
    for (const axis of [DetailAxis.S, DetailAxis.T]) {
      const end = anchorOn(axis, DetailDatumKind.END);
      if (!end) continue;
      const origin = anchorOn(axis, DetailDatumKind.ORIGIN);
      const [stretch] = stretchPartsOf(stroke, axis); // 検証済み: ちょうど 1 本・origin〜end の間
      const orient = end.vertexIndex > origin.vertexIndex ? 1 : -1;
      const wanted = targetOf.get(end.datum.id) - targetOf.get(origin.datum.id);
      const fixedPart = provisional[end.vertexIndex][axis] - provisional[origin.vertexIndex][axis];
      const x = (wanted - fixedPart) / (orient * stretch.sign);
      if (!(x >= DETAIL_FIT_EPS_MM)) {
        return fail(F.FIXED_EXCEEDS_TARGET, `固定寸法の和が目標を超える（ストローク ${stroke.id}・軸 ${axis}・伸縮 ${x} mm）`, { strokeId: stroke.id, axis });
      }
      resolved.set(stretch.len, x);
    }

    // (c) origin の Anchor の頂点を目標へ平行移動する
    const points = walk();
    if (!Array.isArray(points)) return fail(F.INVALID, points.error.message);
    const shift = {};
    for (const axis of [DetailAxis.S, DetailAxis.T]) {
      const origin = anchorOn(axis, DetailDatumKind.ORIGIN);
      shift[axis] = targetOf.get(origin.datum.id) - points[origin.vertexIndex][axis];
    }
    const fitted = {
      id: stroke.id,
      points: points.map(p => ({ s: p.s + shift[DetailAxis.S], t: p.t + shift[DetailAxis.T] })),
      closed: stroke.closed,
      line: { ...stroke.line },
    };
    // 手の印（Move.edge）。手の番号に対応（印なしは null）。印が 1 つも無いストロークにはキーを付けない（既存の出力は不変）
    if (stroke.moves.some(m => m.edge != null)) fitted.edgeMarks = stroke.moves.map(m => m.edge ?? null);
    strokes.push(fitted);
  }
  return { strokes, warnings: [] };
}
