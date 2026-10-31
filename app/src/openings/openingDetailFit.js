// ================================================================
// 三方枠の方立（平面）・上枠（展開）へ部分詳細図を反映する口（部分詳細図 S3）。
// 図の解決 → （壁厚・出幅・見付）への fit（メモ付き。openingCatalog.js fitDetailLocalMemo）→ 開口の両端へ写す
// （openingDetailFrame.js placeDetailSides）。結果は frameOnlyJambProfiles の detail 引数へそのまま渡せる。
// 失敗は {error} で返し、呼び出し側が profile（opening.frameProfile ?? 記号の profile）へ戻す
// （通知は建具モード・展開モードの init。R21）。frameProfile は「図が無い／合わせられないときに戻る profile」にだけ効く。
// ================================================================

import { DetailSlot } from '../core/constants.js';
import { detailFigureEntry, detailFigureRefsFor, fitDetailLocalMemo } from './openingCatalog.js';
import { placeDetailSides } from './openingDetailFrame.js';

// 要求された枠の図を探す slot の順（head は head の図が無ければ jamb を流用する＝R9）。
const SLOT_ORDER = Object.freeze({
  [DetailSlot.JAMB]: [DetailSlot.JAMB],
  [DetailSlot.HEAD]: [DetailSlot.HEAD, DetailSlot.JAMB],
});

const refOf = (refs, slot) => {
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) return undefined;
  const key = refs[slot];
  return typeof key === 'string' && key !== '' ? key : undefined;
};

/**
 * 枠に使う詳細図の解決（描画と集計が共有する唯一の判定）。優先順は
 * 建具個別の detailRefs ＞ 記号の detailFigures ＞（無ければ既定の profile）。slot の順は SLOT_ORDER
 * （head の要求: detailRefs.head ＞ 記号.head ＞ detailRefs.jamb ＞ 記号.jamb）。
 * @param {{symbolKey:string, detailRefs?:object|null, slot:string}} p slot は DetailSlot.JAMB | DetailSlot.HEAD
 * @returns {null | {intended:{slot:string,key:string,source:'opening'|'symbol'}, drawn:{slot:string,key:string,source:'opening'|'symbol',entry:object}|null}}
 *   source＝参照の出所（'opening'＝建具個別の detailRefs・'symbol'＝記号の detailFigures）。通知文の主語に使う。
 *   null＝参照が1つも無い（従来どおり）。intended＝優先順の先頭の参照（利用者の意図）。drawn＝実在する図のうち先頭
 *   （intended の図が無いとき、後ろの候補の図を流用する）。drawn が null＝参照はあるが図が1つも実在しない。
 */
export function resolveDetailFigure({ symbolKey, detailRefs = null, slot }) {
  const symbolRefs = detailFigureRefsFor(symbolKey);
  const candidates = [];
  for (const s of SLOT_ORDER[slot] ?? []) {
    for (const [source, refs] of [['opening', detailRefs], ['symbol', symbolRefs]]) {
      const key = refOf(refs, s);
      if (key !== undefined) candidates.push({ slot: s, key, source });
    }
  }
  if (candidates.length === 0) return null;
  for (const c of candidates) {
    const entry = detailFigureEntry(c.key);
    if (entry) return { intended: candidates[0], drawn: { ...c, entry } };
  }
  return { intended: candidates[0], drawn: null };
}

/**
 * 三方枠の詳細図を開口の両端へ写す。
 * @param {object} p
 * @param {string} p.symbolKey 建具記号キー
 * @param {object|null} [p.detailRefs] opening.detailRefs（{[slot]: 図のキー}）。記号の割当てより優先
 * @param {string} p.slot DetailSlot.JAMB（平面の方立）| DetailSlot.HEAD（展開の上枠。head 無しなら jamb を流用）
 * @param {number} p.coord1 along の小さい側の開口端（展開の上枠では上端 y）
 * @param {number} p.coord2 along の大きい側の開口端（展開の上枠では開口下端 y）
 * @param {number} p.faceMin 壁の面（perp の小さい側。展開の上枠では帯の壁面位置）
 * @param {number} p.wallThickness 壁厚（面間。呼び出し側の値をそのまま渡す——差分の再計算で丸め誤差を入れない）
 * @param {number} p.faceWidth 見付（開口半幅で頭打ちにした後の値）
 * @param {number} p.projection 出幅
 * @returns {null | {error:{code:string, message:string}} | {sides: object[][], profiles: object[]}}
 *   null＝割当てが無い、または参照先の図が実在しない（従来どおり）。sides＝[coord1側, coord2側]のストローク列、
 *   profiles＝sides を平らにしたもの（frameOnlyJambProfiles の detail にそのまま渡す）。
 */
export function resolveDetailFrame({ symbolKey, detailRefs = null, slot, coord1, coord2, faceMin, wallThickness, faceWidth, projection }) {
  const r = resolveDetailFigure({ symbolKey, detailRefs, slot });
  if (!r?.drawn) return null;
  const fitted = fitDetailLocalMemo({ figureKey: r.drawn.key, slot: r.drawn.slot, wallThickness, projection, faceWidth });
  if (fitted.error) return fitted;
  const sides = placeDetailSides(fitted, { coord1, coord2, faceMin });
  return { sides, profiles: sides.flat() };
}
