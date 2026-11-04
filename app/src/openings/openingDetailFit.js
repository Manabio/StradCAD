// ================================================================
// 三方枠の方立（平面）・上枠（展開）へ部分詳細図を反映する口（部分詳細図 S3）。
// 図の解決 → （壁厚・出幅・見付）への fit（メモ付き。openingCatalog.js fitDetailLocalMemo）→ 開口の両端へ写す
// （openingDetailFrame.js placeDetailSides）。結果は frameOnlyJambProfiles の detail 引数へそのまま渡せる。
// 失敗は {error} で返し、呼び出し側が profile（opening.frameProfile ?? 記号の profile）へ戻す
// （通知は建具モード・展開モードの init。R21）。frameProfile は「図が無い／合わせられないときに戻る profile」にだけ効く。
// ================================================================

import {
  DetailSlot, DetailDash, DETAIL_PRIM_SOURCE, DetailFigureSource, DETAIL_FIT_EPS_MM, DOOR_LEAF_THICKNESS_MM,
  DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY,
} from '../core/constants.js';
import { ElevationLineRole, ElevationDash, weightForRole } from '../elevation/elevationStyle.js';
import { line, polyline } from '../elevation/elevationPrimitives.js';
import { detailFigureEntry, detailFigureRefsFor, fitDetailLocalMemo, subTypeDetailFigureRefsFor } from './openingCatalog.js';
import { placeDetailSides, placeDetailElevation, withoutCollinearPoints } from './openingDetailFrame.js';
import { effectiveHeight, effectiveSillHeight } from './openingNumbering.js';

// 要求された枠の図を探す slot の順（head は head の図が無ければ jamb を流用する＝R9）。
const SLOT_ORDER = Object.freeze({
  [DetailSlot.JAMB]: [DetailSlot.JAMB],
  [DetailSlot.HEAD]: [DetailSlot.HEAD, DetailSlot.JAMB],
  [DetailSlot.FIGURE]: [DetailSlot.FIGURE],
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
 * 姿図（slot=figure）の「記号側」の参照元は建具種別の detailFigures（呼び出し側が subTypeRefs で渡す。symbolKey は使わない）。
 * @param {{symbolKey?:string, detailRefs?:object|null, slot:string, subTypeRefs?:object|null}} p
 *   slot は DetailSlot.JAMB | HEAD | FIGURE
 * @returns {null | {intended:{slot:string,key:string,source:'opening'|'symbol'|'subType'}, drawn:{slot:string,key:string,source:'opening'|'symbol'|'subType',entry:object}|null}}
 *   source＝参照の出所（'opening'＝建具個別の detailRefs・'symbol'＝記号の detailFigures・'subType'＝建具種別の detailFigures）。通知文の主語に使う。
 *   null＝参照が1つも無い（従来どおり）。intended＝優先順の先頭の参照（利用者の意図）。drawn＝実在する図のうち先頭
 *   （intended の図が無いとき、後ろの候補の図を流用する）。drawn が null＝参照はあるが図が1つも実在しない。
 */
export function resolveDetailFigure({ symbolKey, detailRefs = null, slot, subTypeRefs = null }) {
  const isFigure = slot === DetailSlot.FIGURE;
  const baseSource = isFigure ? 'subType' : 'symbol';
  const baseRefs = isFigure ? subTypeRefs : detailFigureRefsFor(symbolKey);
  const candidates = [];
  for (const s of SLOT_ORDER[slot] ?? []) {
    // detailRefs がこの slot を null で明示しているときは「なし」＝記号（姿図は建具種別）側の同じ slot を候補にしない
    // （保守パネルのプレビューが、保存済みの割当てを未保存で外した状態を描くための口）。キー無し・undefined は従来どおり記号へ進む。
    // 永続化（S6）は「空なら書かない」規約なので、保存された detailRefs に null は現れない。
    const openingSaysNone = detailRefs !== null && typeof detailRefs === 'object' && Object.hasOwn(detailRefs, s) && detailRefs[s] === null;
    for (const [source, refs] of [['opening', detailRefs], [baseSource, baseRefs]]) {
      if (source === baseSource && openingSaysNone) continue;
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

// 片開き戸の暗黙の既定（S8e）: 割当て無しのとき slot ごとに使う組込み図のキー。
const SWING_DOOR_DEFAULT_KEYS = Object.freeze({
  [DetailSlot.JAMB]: DETAIL_BUILTIN_DOOR_JAMB_KEY,
  [DetailSlot.HEAD]: DETAIL_BUILTIN_DOOR_HEAD_KEY,
});

/** 片開き戸の暗黙の既定の組込み図のキー（slot が方立・上枠でなければ undefined）。建具エディタが「同キーの選択＝既定扱い」へ畳む基準に使う。 */
export function swingDoorDefaultKey(slot) {
  return SWING_DOOR_DEFAULT_KEYS[slot];
}

// 組込み図の fit・配置で出る浮動小数の丸め誤差（数 ULP）を、従来の描きと同じ式の値へ寄せる。寄せるのは DETAIL_FIT_EPS_MM 以内だけ。
const snapNear = (v, refs) => refs.find(r => Math.abs(v - r) <= DETAIL_FIT_EPS_MM) ?? v;

/**
 * 片開き戸の方立（平面。S8e-1）の詳細図を開口の両端へ写す。図の解決は三方枠と同じ（建具個別の detailRefs ＞ 記号の detailFigures）で、
 * 割当てが無いときだけ組込みの図（DETAIL_BUILTIN_DOOR_*_KEY）を暗黙の既定にする（source=DEFAULT。通知の対象外）。
 * 図の t は「扉が閉じる側（開く側の面）が正」。tSign はその側が perp の増える向きなら +1、減る向きなら −1（placeDetailSides）。
 * 戻り値の点列は共線の頂点を除く（withoutCollinearPoints）。既定の図は従来の描きと同じ式の値へ丸め誤差を寄せる。
 * slot=HEAD（展開の断面の上枠。S8e-2）の探索順は resolveDetailFigure のまま（建具個別の head ＞ 記号の head ＞ 建具個別の jamb ＞ 記号の jamb）で、
 * どれも無いときだけ組込みの上枠（R9 の流用）。明示の方立の図は上枠にも流用される（上枠は同じ戸当たりの断面なので物理的に正しい）が、
 * 既定の上枠は従来の矩形（R2。方立の既定を流用すると欠き込みが出て従来と一致しない）。
 * @param {object} p resolveDetailFrame と同じ（slot は既定 JAMB）に、faceMax・tSign を加えたもの。wallThickness＝faceMax−faceMin をそのまま渡す
 * @returns {null | {error:{code:string, message:string}, source:string} | {sides: object[][], profiles: object[], source:string}}
 *   null＝従来の描きへ戻る（参照切れ・既定の組込みが引けない）。error＝fit できない（呼び出し側は従来の描きへ。明示の割当てだけ通知の対象）。
 */
export function resolveSwingDoorFrame({ symbolKey, detailRefs = null, slot = DetailSlot.JAMB, coord1, coord2, faceMin, faceMax, wallThickness, tSign, faceWidth, projection }) {
  const r = resolveDetailFigure({ symbolKey, detailRefs, slot });
  let figure;
  let source;
  if (r === null) {
    const key = SWING_DOOR_DEFAULT_KEYS[slot];
    if (key === undefined || detailFigureEntry(key) === null) return null;
    figure = { key, slot };
    source = DetailFigureSource.DEFAULT;
  } else if (r.drawn) {
    figure = r.drawn;
    source = DetailFigureSource.EXPLICIT;
  } else {
    return null;
  }
  const fitted = fitDetailLocalMemo({ figureKey: figure.key, slot: figure.slot, wallThickness, projection, faceWidth });
  if (fitted.error) return { error: fitted.error, source };
  // 寄せ先は 1 組で足りる: 方立の組は上枠の組（帯の両端と壁の面）を含み、上枠は欠き込みが無いので余分な値は偶然一致しない限り効かない。
  const refs = tSign < 0
    ? [faceMax + projection, faceMin + DOOR_LEAF_THICKNESS_MM, faceMin - projection, faceMin, faceMax]
    : [faceMin - projection, faceMax - DOOR_LEAF_THICKNESS_MM, faceMax + projection, faceMin, faceMax];
  const sides = placeDetailSides(fitted, { coord1, coord2, faceMin, faceMax, tSign }).map(side => side.map(st => {
    const points = withoutCollinearPoints(st.points, st.closed);
    return { ...st, points: source === DetailFigureSource.DEFAULT ? points.map(({ along, perp }) => ({ along, perp: snapNear(perp, refs) })) : points };
  }));
  return { sides, profiles: sides.flat(), source };
}

/** 姿図の fit の寸法 dims（描画 resolveDetailElevation と集計 openingDetailFitCheck.js が共有する唯一の式）。 */
export function elevationDetailDims(opening) {
  return { width: opening.width, height: effectiveHeight(opening), sill: effectiveSillHeight(opening) };
}

// 図の線の太さの役割（LINE_WEIGHT_MM のキー）→ 展開図の線種の役割。極太は展開図の語彙に無いので最も太い切断線へ寄せる。
const ELEVATION_ROLE_BY_WEIGHT_ROLE = Object.freeze({
  ultraThick: ElevationLineRole.CUT,
  thick:      ElevationLineRole.CUT,
  medium:     ElevationLineRole.SILHOUETTE,
  thin:       ElevationLineRole.DETAIL,
});

/**
 * 写像済みのストローク（placeDetailElevation の結果）を姿図のプリミティブにする。実線＝polyline・破線＝線分ごとの line
 * （展開図の Konva は polyline の dash を描かず、閉じた polyline は塗るため、閉じ辺は始点を末尾に足した開いた折れ線で表す）。
 * 全プリミティブに source:'detail' を付ける（立面が kind を上書きするので kind は使わない）。型は line／polyline だけ。
 */
function detailStrokesToElevationPrimitives(strokes) {
  const out = [];
  for (const st of strokes) {
    const pts = st.closed && st.points.length > 1 ? [...st.points, st.points[0]] : st.points;
    if (pts.length < 2) continue;
    const weight = weightForRole(ELEVATION_ROLE_BY_WEIGHT_ROLE[st.line?.weightRole] ?? ElevationLineRole.DETAIL);
    if (st.line?.dashRole === DetailDash.DASHED) {
      for (let i = 1; i < pts.length; i += 1) {
        out.push(line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], { weight, dash: ElevationDash.DASHED, source: DETAIL_PRIM_SOURCE }));
      }
    } else {
      out.push(polyline(pts, { weight, source: DETAIL_PRIM_SOURCE }));
    }
  }
  return out;
}

/**
 * 建具の姿図（正面図）の詳細図を（幅・高さ・窓台高さ）に合わせてプリミティブにする（S6b）。buildOpeningElevation の内部から呼ぶ
 * （展開・立面・建具エディタ・カタログプレビューは buildOpeningElevation を呼ぶだけ）。解決順は
 * 建具個別の opening.detailRefs.figure ＞ 建具種別エントリの detailFigures.figure。
 * @param {{opening:object, entry?:object|null}} p entry＝建具種別エントリ（findCatalogEntry の結果。未保存ドラフトでもよい）
 * @returns {null | {error:{code:string, message:string}} | {primitives: object[]}}
 *   null＝参照が無い、または参照先の図が実在しない（従来どおり）。error＝fit できない（従来の姿図へ戻る。通知は init）。
 *   primitives＝壁の座標昇順＝図の x 昇順の正準向き（FL を y=0・上方は負）。
 */
export function resolveDetailElevation({ opening, entry = null }) {
  const r = resolveDetailFigure({
    detailRefs: opening.detailRefs ?? null, slot: DetailSlot.FIGURE,
    subTypeRefs: subTypeDetailFigureRefsFor(opening.category, opening.subType, entry),
  });
  if (!r?.drawn) return null;
  const dims = elevationDetailDims(opening);
  const fitted = fitDetailLocalMemo({ figureKey: r.drawn.key, slot: r.drawn.slot, dims });
  if (fitted.error) return fitted;
  return { primitives: detailStrokesToElevationPrimitives(placeDetailElevation(fitted, { sillTop: -dims.sill })) };
}
