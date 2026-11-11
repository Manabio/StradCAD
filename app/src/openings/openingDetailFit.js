// ================================================================
// 三方枠の方立（平面）・上枠（展開）へ部分詳細図を反映する口（部分詳細図 S3）。
// 図の解決 → （壁厚・出幅・見付）への fit（メモ付き。openingCatalog.js fitDetailLocalMemo）→ 開口の両端へ写す
// （openingDetailFrame.js placeDetailSides）。結果は frameOnlyJambProfiles の detail 引数へそのまま渡せる。
// 失敗は {error} で返し、呼び出し側が profile（opening.frameProfile ?? 記号の profile）へ戻す
// （通知は建具モード・展開モードの init。R21）。frameProfile は「図が無い／合わせられないときに戻る profile」にだけ効く。
// ================================================================

import {
  DetailSlot, DetailDash, FittingPartRole, FITTING_PART_KEY_SEPARATOR, DETAIL_PRIM_SOURCE, DetailFigureSource, DETAIL_FIT_EPS_MM, DOOR_LEAF_THICKNESS_MM,
  DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY, SWING_LEAF_SUBTYPE, OpeningCategory,
  DETAIL_BUILTIN_WINDOW_JAMB_KEY, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
  DETAIL_BUILTIN_WINDOW_HEAD_KEY, DETAIL_BUILTIN_WINDOW_SILL_KEY,
  SLIDE_OUTSET_SUBTYPE, DETAIL_BUILTIN_FITTING_SLIDING_KEY,
} from '../core/constants.js';
import { detailFrameKindOf } from './openingPlanSymbolGeometry.js';
import { ElevationLineRole, ElevationDash, weightForRole } from '../elevation/elevationStyle.js';
import { line, polyline } from '../elevation/elevationPrimitives.js';
import { OpeningMechanism, IMPLEMENTED_MECHANISMS, hingeSideMatters, detailFigureEntry, detailFigureRefsFor, detailFigureRefsOfEntry, findCatalogEntry, fitDetailLocalMemo, subTypeDetailFigureRefsFor } from './openingCatalog.js';
import { placeDetailSides, placeDetailSide, placeDetailElevation, withoutCollinearPoints } from './openingDetailFrame.js';
import { effectiveHeight, effectiveSillHeight, windowHasSill } from './openingNumbering.js';

// 要求された枠の図を探す slot の順（head は head の図が無ければ jamb を流用する＝R9。sill は下枠だけ＝方立・上枠を流用しない。S8f-3 R5）。
const SLOT_ORDER = Object.freeze({
  [DetailSlot.JAMB]: [DetailSlot.JAMB],
  [DetailSlot.HEAD]: [DetailSlot.HEAD, DetailSlot.JAMB],
  [DetailSlot.SILL]: [DetailSlot.SILL],
  [DetailSlot.FIGURE]: [DetailSlot.FIGURE],
  [DetailSlot.FIGURE_BACK]: [DetailSlot.FIGURE_BACK], // 向こう側から見た姿図。他の slot を流用しない（FIGURE への落ち先は resolveDetailElevation が決める）
});

// 建具一式の部品の役割（slot ごとに探す役割。JAMB の片側解決は side で jambHinge/jambLatch を先に探す＝fittingRolesFor）。
const FITTING_SLOT_ROLES = Object.freeze({
  [DetailSlot.JAMB]: Object.freeze([FittingPartRole.JAMB]),
  [DetailSlot.HEAD]: Object.freeze([FittingPartRole.HEAD]),
  [DetailSlot.SILL]: Object.freeze([FittingPartRole.SILL]),
  [DetailSlot.FIGURE]: Object.freeze([FittingPartRole.FIGURE]),
  [DetailSlot.FIGURE_BACK]: Object.freeze([FittingPartRole.FIGURE_BACK]),
});

/** 方立の片側解決の側（resolveDetailFigure の side）。吊元側・戸先側。null（省略）＝両側共通（従来）。 */
export const DetailFrameSide = Object.freeze({ HINGE: 'hinge', LATCH: 'latch' });

// 一式の段で slot ごとに探す役割。JAMB だけ side で先頭に吊元側・戸先側の役割を足す（他の slot は side を無視）。
function fittingRolesFor(slot, side) {
  if (slot === DetailSlot.JAMB && side === DetailFrameSide.HINGE) return [FittingPartRole.JAMB_HINGE, FittingPartRole.JAMB];
  if (slot === DetailSlot.JAMB && side === DetailFrameSide.LATCH) return [FittingPartRole.JAMB_LATCH, FittingPartRole.JAMB];
  return FITTING_SLOT_ROLES[slot] ?? [];
}

/**
 * 方立を左右別々に解決するか（描画 resolveSwingDoorFrame と通知が共有する唯一の条件）。JAMB・fittingKey あり・hingeSide が ±1・
 * hingeSideMatters 真（片開き系）のとき ['hinge','latch']、それ以外は両側共通の [null]。
 */
export function jambSidesFor({ slot, fittingKey, hingeSide, mechanism, entry }) {
  const sided = slot === DetailSlot.JAMB && typeof fittingKey === 'string' && fittingKey !== ''
    && (hingeSide === -1 || hingeSide === 1) && hingeSideMatters(mechanism, entry);
  return sided ? [DetailFrameSide.HINGE, DetailFrameSide.LATCH] : [null];
}

/**
 * 建具の一式のキー（建具個別の detailRefs.fitting ＞ 建具種別エントリの detailFigures.fitting。無ければ null）。
 * detailRefs.fitting を null で明示したときは種別の一式を見ない（null）。entry 省略時は建具のカタログエントリを引く。
 */
export function fittingKeyOf(opening, entry = undefined) {
  const refs = opening?.detailRefs ?? null;
  if (refs !== null && typeof refs === 'object' && Object.hasOwn(refs, DetailSlot.FITTING)) {
    const own = refs[DetailSlot.FITTING];
    return typeof own === 'string' && own !== '' ? own : null;
  }
  const e = entry === undefined ? findCatalogEntry(opening?.category, opening?.subType) : entry;
  return detailFigureRefsOfEntry(e, [DetailSlot.FITTING])?.[DetailSlot.FITTING] ?? null;
}

// detailRefs がこの slot を null で明示している（＝「なし」。キー無し・undefined は含まない）。
const refsSayNone = (refs, slot) => refs !== null && typeof refs === 'object' && Object.hasOwn(refs, slot) && refs[slot] === null;

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
export function resolveDetailFigure({ symbolKey, detailRefs = null, slot, subTypeRefs = null, fittingKey = null, side = null }) {
  const isFigure = slot === DetailSlot.FIGURE || slot === DetailSlot.FIGURE_BACK;
  const baseSource = isFigure ? 'subType' : 'symbol';
  const baseRefs = isFigure ? subTypeRefs : detailFigureRefsFor(symbolKey);
  // 建具一式（detailRefs.fitting を null で明示したときは種別の一式も見ない）。一式の部品が無い役割は候補にしない。
  const fittingSaysNone = refsSayNone(detailRefs, DetailSlot.FITTING);
  const candidates = [];
  for (const s of SLOT_ORDER[slot] ?? []) {
    // detailRefs がこの slot を null で明示しているときは「なし」＝建具一式・記号（姿図は建具種別）側の同じ slot を候補にしない
    // （保守パネルのプレビューが、保存済みの割当てを未保存で外した状態を描くための口）。キー無し・undefined は従来どおり記号へ進む。
    // 永続化（S6）は「空なら書かない」規約なので、保存された detailRefs に null は現れない。
    const openingSaysNone = refsSayNone(detailRefs, s);
    // この slot の明示 null（「なし」）は記号の段だけでなく一式の段も飛ばす。
    const fittingKeys = typeof fittingKey === 'string' && fittingKey !== '' && !fittingSaysNone && !openingSaysNone
      ? fittingRolesFor(s, side).map(role => `${fittingKey}${FITTING_PART_KEY_SEPARATOR}${role}`).filter(k => detailFigureEntry(k) !== null)
      : [];
    for (const [source, refs] of [['opening', detailRefs], ['fitting', fittingKeys], [baseSource, baseRefs]]) {
      if (source === baseSource && openingSaysNone) continue;
      if (source === 'fitting') {
        for (const key of fittingKeys) candidates.push({ slot: s, key, source });
        continue;
      }
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
export function resolveDetailFrame({ symbolKey, detailRefs = null, fittingKey = null, slot, coord1, coord2, faceMin, wallThickness, faceWidth, projection }) {
  const r = resolveDetailFigure({ symbolKey, detailRefs, slot, fittingKey });
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

// 窓の方立（平面・詳細 LOD）の暗黙の既定（S8f-1）: 方立の種別（planSymbolGeometry.js detailFrameKindOf）→ 組込み図のキー。
const WINDOW_JAMB_DEFAULT_KEYS = Object.freeze({
  notched: DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
  sashOpen: DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY,
  sash: DETAIL_BUILTIN_WINDOW_JAMB_KEY,
});

/**
 * 枠の暗黙の既定の組込み図のキー（無ければ undefined）。片開き戸＝slot ごと（swingDoorDefaultKey）・窓＝方立（JAMB）は方立の種別ごと
 * （引き違い窓 SLIDE_DOUBLE・三方枠 FRAME_ONLY は対象外）、上枠（HEAD）・下枠（SILL。展開の断面。S8f-3b）は引き違い窓も含む窓の共通の図
 * （下枠は窓台のある窓だけ。掃き出し窓は下枠を描かない）。建具エディタが「同キーの選択＝既定扱い」へ畳む基準にも使える。
 * @param {{category?:string, subType?:string, sillHeight?:number}} opening
 * @param {string} slot DetailSlot
 * @param {string} mechanism OpeningMechanism（窓の方立の種別の判定に使う）
 */
export function frameDefaultKey(opening, slot, mechanism) {
  if (opening?.subType === SWING_LEAF_SUBTYPE) return swingDoorDefaultKey(slot);
  if (opening?.category !== OpeningCategory.WINDOW) return undefined;
  if (slot !== DetailSlot.JAMB && slot !== DetailSlot.HEAD && slot !== DetailSlot.SILL) return undefined;
  // 機構の分からない窓（種別の参照切れ）・実装外の機構は描画に方立・上枠・下枠が出ないので対象外
  if (mechanism === undefined || !IMPLEMENTED_MECHANISMS.has(mechanism)) return undefined;
  if (mechanism === OpeningMechanism.FRAME_ONLY) return undefined;
  if (slot === DetailSlot.HEAD) return DETAIL_BUILTIN_WINDOW_HEAD_KEY;
  if (slot === DetailSlot.SILL) return windowHasSill(opening) ? DETAIL_BUILTIN_WINDOW_SILL_KEY : undefined;
  if (mechanism === OpeningMechanism.SLIDE_DOUBLE) return undefined;
  return WINDOW_JAMB_DEFAULT_KEYS[detailFrameKindOf(mechanism)];
}

/**
 * 建具一式の暗黙の既定のキー（外付け引き戸＝subType が SLIDE_OUTSET_SUBTYPE の建具の組込み一式。無ければ null）。
 * 枠の slot の既定（frameDefaultKey）には入れない（一式は部品を引く口で、slot の図ではない）。組込みが引けないときも null。
 */
export function fittingDefaultKey(opening) {
  if (opening?.subType !== SLIDE_OUTSET_SUBTYPE) return null;
  return detailFigureEntry(DETAIL_BUILTIN_FITTING_SLIDING_KEY) === null ? null : DETAIL_BUILTIN_FITTING_SLIDING_KEY;
}

/**
 * 外付け引き戸の平面の部品 3 つ（戸先側 latch・戸尻側の短い縦枠 inner・端材と開けた扉 tail）の図の解決。
 * 一式のキー＝建具個別・種別の指定（fittingKeyOf。source=EXPLICIT）、無ければ暗黙の既定（fittingDefaultKey。source=DEFAULT）。
 * detailRefs.fitting を null で明示したときは既定も使わない（「なし」＝3 つとも null）。
 * 部品のキーは合成キー '<一式>#<役割>'。見上げ（direction 'up'）は *Up の役割を先に探し、その部品が無ければ平面の部品。
 * 一式の参照切れ・部品の無い役割は null（その部品だけ描かない）。
 * @param {object} opening
 * @param {object|null|undefined} entry 建具種別エントリ（省略時は fittingKeyOf が引く）
 * @param {'down'|'up'} [direction]
 * @returns {{latch: {key:string, source:string}|null, inner: {key:string, source:string}|null, tail: {key:string, source:string}|null}}
 */
export function resolveSlideFittingParts(opening, entry, direction = 'down') {
  const none = { latch: null, inner: null, tail: null };
  const refs = opening?.detailRefs ?? null;
  const own = fittingKeyOf(opening, entry);
  const setKey = own ?? (refsSayNone(refs, DetailSlot.FITTING) ? null : fittingDefaultKey(opening));
  if (setKey === null) return none;
  const source = own !== null ? DetailFigureSource.EXPLICIT : DetailFigureSource.DEFAULT;
  const partKey = role => {
    const key = `${setKey}${FITTING_PART_KEY_SEPARATOR}${role}`;
    return detailFigureEntry(key) === null ? null : key;
  };
  const pick = (plainRole, upRole) => {
    const key = (direction === 'up' ? partKey(upRole) : null) ?? partKey(plainRole);
    return key === null ? null : { key, source };
  };
  return {
    latch: pick(FittingPartRole.SLIDE_LATCH, FittingPartRole.SLIDE_LATCH_UP),
    inner: pick(FittingPartRole.SLIDE_INNER, FittingPartRole.SLIDE_INNER_UP),
    tail: pick(FittingPartRole.SLIDE_TAIL, FittingPartRole.SLIDE_TAIL_UP),
  };
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
 * @param {object} p resolveDetailFrame と同じ（slot は既定 JAMB）に、faceMax・tSign を加えたもの。wallThickness＝faceMax−faceMin をそのまま渡す。
 *   defaultKey＝割当て無しのときの組込み図のキー（省略時は片開き戸の slot 別の既定。窓の方立は frameDefaultKey の結果を渡す。S8f-1。null を渡すと引数の既定（片開き戸の表）に落ちず「既定なし」になる。detailFigureEntry(null) が null を返すため）
 *   mechanism・entry・hingeSide＝片開き戸の方立だけが渡す（左右で違う枠）。slot が JAMB で fittingKey があり hingeSideMatters(mechanism, entry) が真のとき
 *   吊元側（hingeSide −1＝coord1 側）・戸先側を別々に解決する（一式の jambHinge/jambLatch ＞ jamb。違う図なら側ごとに fit して placeDetailSide。
 *   fit できない明示の側は既定の組込み図へ戻る）。渡さない・窓・三方枠・引き戸・両開きは両側共通（従来）。
 *   戻り値の sideSources＝[coord1 側, coord2 側] の source（全体の source は従来の意味。呼び出し側の R4 は側ごとに sideSources で見る）。
 * @returns {null | {error:{code:string, message:string}, source:string} | {sides: object[][], profiles: object[], source:string, sideSources:string[]}}
 *   null＝従来の描きへ戻る（参照切れ・既定の組込みが引けない）。error＝fit できない（呼び出し側は従来の描きへ。明示の割当てだけ通知の対象）。
 */
export function resolveSwingDoorFrame({ symbolKey, detailRefs = null, fittingKey = null, slot = DetailSlot.JAMB, coord1, coord2, faceMin, faceMax, wallThickness, tSign, faceWidth, projection, defaultKey = SWING_DOOR_DEFAULT_KEYS[slot], mechanism = null, entry = null, hingeSide = null }) {
  // side の図を選ぶ（side＝null は両側共通）。null＝従来の描きへ戻る（参照切れ・既定の組込みが引けない）。
  const choose = side => {
    const r = resolveDetailFigure({ symbolKey, detailRefs, slot, fittingKey, side });
    if (r === null) {
      if (defaultKey === undefined || detailFigureEntry(defaultKey) === null) return null;
      return { figure: { key: defaultKey, slot }, source: DetailFigureSource.DEFAULT };
    }
    return r.drawn ? { figure: r.drawn, source: DetailFigureSource.EXPLICIT } : null;
  };
  const fitOf = ({ figure }) => fitDetailLocalMemo({ figureKey: figure.key, slot: figure.slot, wallThickness, projection, faceWidth });
  // 寄せ先は 1 組で足りる: 方立の組は上枠の組（帯の両端と壁の面）を含み、上枠は欠き込みが無いので余分な値は偶然一致しない限り効かない。
  const refs = tSign < 0
    ? [faceMax + projection, faceMin + DOOR_LEAF_THICKNESS_MM, faceMin - projection, faceMin, faceMax]
    : [faceMin - projection, faceMax - DOOR_LEAF_THICKNESS_MM, faceMax + projection, faceMin, faceMax];
  const tidy = (strokes, source) => strokes.map(st => {
    const points = withoutCollinearPoints(st.points, st.closed);
    return { ...st, points: source === DetailFigureSource.DEFAULT ? points.map(({ along, perp }) => ({ along, perp: snapNear(perp, refs) })) : points };
  });
  const both = chosen => {
    const fitted = fitOf(chosen);
    if (fitted.error) return { error: fitted.error, source: chosen.source };
    const sides = placeDetailSides(fitted, { coord1, coord2, faceMin, faceMax, tSign }).map(side => tidy(side, chosen.source));
    return { sides, profiles: sides.flat(), source: chosen.source, sideSources: [chosen.source, chosen.source] };
  };

  // 左右で違う枠は片開き系（hingeSideMatters 真）の方立だけ。窓・両開き・三方枠・引き戸は呼び出し側が mechanism を渡さない／偽になる＝従来。
  const sided = jambSidesFor({ slot, fittingKey, hingeSide, mechanism, entry }).length === 2;
  if (!sided) {
    const c = choose(null);
    return c === null ? null : both(c);
  }
  const hingeC = choose(DetailFrameSide.HINGE);
  const latchC = choose(DetailFrameSide.LATCH);
  if (hingeC === null || latchC === null) return null;
  if (hingeC.figure.key === latchC.figure.key && hingeC.figure.slot === latchC.figure.slot && hingeC.source === latchC.source) return both(hingeC);
  // 違う図: 側ごとに fit して置く。吊元端＝hingeSide −1 が coord1 側（sides[0]）。fit できない側は既定の組込み図へ戻す（その側だけ従来）。
  const hingeIdx = hingeSide < 0 ? 0 : 1;
  const placeSide = (chosen, idx) => {
    let c = chosen;
    let fitted = fitOf(c);
    if (fitted.error && c.source === DetailFigureSource.EXPLICIT && defaultKey !== undefined && detailFigureEntry(defaultKey) !== null) {
      c = { figure: { key: defaultKey, slot }, source: DetailFigureSource.DEFAULT };
      fitted = fitOf(c);
    }
    if (fitted.error) return { error: fitted.error, source: c.source };
    const along = idx === 0 ? coord1 : coord2;
    return { strokes: tidy(placeDetailSide(fitted, { along, sx: idx === 0 ? 1 : -1, faceMin, faceMax, tSign }), c.source), source: c.source };
  };
  const placed = [null, null];
  placed[hingeIdx] = placeSide(hingeC, hingeIdx);
  placed[1 - hingeIdx] = placeSide(latchC, 1 - hingeIdx);
  const failed = placed.find(p => p.error);
  if (failed) return { error: failed.error, source: failed.source };
  const sides = placed.map(p => p.strokes);
  // 全体の source は従来の意味（どちらかが明示なら明示。通知の「明示だけ」の判定用）。R4＝既定の図だけに掛ける検査は、呼び出し側が
  // sideSources で側ごとに見る（既定へ戻った側だけ従来の描きに差し替える。C6 QA 指摘）。
  const source = placed.some(p => p.source === DetailFigureSource.EXPLICIT) ? DetailFigureSource.EXPLICIT : DetailFigureSource.DEFAULT;
  return { sides, profiles: sides.flat(), source, sideSources: placed.map(p => p.source) };
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
 * 開き勝手線（dashRole=SWING）は towardViewer が false（向こうへ開く）のときだけ一点鎖線、true（手前）・null（見る側が不明）は実線。
 */
export function detailStrokesToElevationPrimitives(strokes, { towardViewer = null } = {}) {
  const out = [];
  for (const st of strokes) {
    const pts = st.closed && st.points.length > 1 ? [...st.points, st.points[0]] : st.points;
    if (pts.length < 2) continue;
    const weight = weightForRole(ELEVATION_ROLE_BY_WEIGHT_ROLE[st.line?.weightRole] ?? ElevationLineRole.DETAIL);
    const dashRole = st.line?.dashRole;
    const dash = dashRole === DetailDash.DASHED ? ElevationDash.DASHED
      : dashRole === DetailDash.SWING && towardViewer === false ? ElevationDash.CENTER
        : undefined;
    if (dash !== undefined) {
      for (let i = 1; i < pts.length; i += 1) {
        out.push(line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], { weight, dash, source: DETAIL_PRIM_SOURCE }));
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
 * 姿図（slot=figure）は「開く側から見た図」。towardViewer===false（向こうへ開く面から見る）のときだけ向こう側の図
 * （slot=figureBack。detailRefs ＞ 建具種別）を先に探し、無い・参照切れ・fit できないときは figure へ落ちる（figureBack は任意の上乗せ）。
 * true／null は figure だけ（figureBack を見ない）。
 * @param {{opening:object, entry?:object|null, towardViewer?:boolean|null}} p entry＝建具種別エントリ（findCatalogEntry の結果。未保存ドラフトでもよい）
 * @returns {null | {error:{code:string, message:string}} | {primitives: object[], slot: string}}
 *   null＝参照が無い、または参照先の図が実在しない（従来どおり）。error＝fit できない（従来の姿図へ戻る。通知は init）。
 *   primitives＝壁の座標昇順＝図の x 昇順の正準向き（FL を y=0・上方は負）。slot＝実際に使った図の slot（figure | figureBack）。
 */
export function resolveDetailElevation({ opening, entry = null, towardViewer = null }) {
  const subTypeRefs = subTypeDetailFigureRefsFor(opening.category, opening.subType, entry);
  const detailRefs = opening.detailRefs ?? null;
  const fittingKey = fittingKeyOf(opening, entry);
  const dims = elevationDetailDims(opening);
  const placed = (drawn) => {
    const fitted = fitDetailLocalMemo({ figureKey: drawn.key, slot: drawn.slot, dims });
    if (fitted.error) return fitted;
    return {
      primitives: detailStrokesToElevationPrimitives(placeDetailElevation(fitted, { sillTop: -dims.sill }), { towardViewer }),
      slot: drawn.slot,
    };
  };
  if (towardViewer === false) {
    const back = resolveDetailFigure({ detailRefs, slot: DetailSlot.FIGURE_BACK, subTypeRefs, fittingKey });
    if (back?.drawn) {
      const result = placed(back.drawn);
      if (!result.error) return result;
    }
  }
  const r = resolveDetailFigure({ detailRefs, slot: DetailSlot.FIGURE, subTypeRefs, fittingKey });
  return r?.drawn ? placed(r.drawn) : null;
}
