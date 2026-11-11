// ================================================================
// 三方枠の部分詳細図が（壁厚・出幅・見付）に合わせられないものの集計（部分詳細図 S3）。
// 建具モード（OpeningModeState.init）と展開モード（ElevationModeState.init）の突入時に呼ぶ。描画時のメモには頼らず、
// 自分で fit を試す（描画は毎レンダー呼ばれる純関数で通知の経路が無いため。平面モードでは通知しない＝R21）。
// 試す寸法は描画と同じ式: 平面の方立＝(壁厚・出幅・開口半幅で頭打ちの見付)、展開の上枠＝(同・開口高さ半分で頭打ち)。
// 図の解決は描画と同じ resolveDetailFigure（建具個別の detailRefs ＞ 記号の detailFigures。head は jamb を流用）。
// 壁厚はホスト壁の両仕上げ面（openingSectionWallRange）。ホスト壁が引けない三方枠は試さない。
// 建具の姿図（S6b。slot=figure と figureBack）は全機構の建具が対象で、壁は引かない（collectDetailFigureFailures。立面の入力組み立ても使う）。
// ================================================================

import { DetailSlot, FRAME_OVERHANG_MM } from '../core/constants.js';
import { clampFrameFaceWidth, jambWidthFor } from './openingPlanSymbolGeometry.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, DETAIL_OWNER_OPENING, DETAIL_OWNER_FITTING, ERR_SLIDE_ON_EXTERIOR_WALL } from '../error.js';
import { parseFittingPartKey } from '../detail/detailPlacement.js';
import { FITTING_PART_ROLE_TEXT } from '../catalog/catalogMaintenance.js';
import { OpeningCategory } from '../core.js';
import { isOutsetSlide } from './slideOutset.js';
import { effectiveFrameFaceWidth, effectiveFrameProjection, effectiveHeight, fixtureSymbolOf } from './openingNumbering.js';
import { detailFitKey, fitDetailLocalMemo, subTypeDetailFigureRefsFor, findCatalogEntry, detailFigureEntry } from './openingCatalog.js';
import { isFrameOnlySection, isSwingLeafSection, isWindowSection, sectionFrameFaceWidthFor, openingSectionWallRange, wallMaterialRangeForOpening, wallMaterialRangesOf } from './openingSection.js';
import { findHostWall, wallFaceRange } from './openingGeometry.js';
import { resolveDetailFigure, elevationDetailDims, frameDefaultKey, fittingKeyOf, jambSidesFor } from './openingDetailFit.js';

const FRAME_SLOTS = Object.freeze([DetailSlot.JAMB, DetailSlot.HEAD, DetailSlot.SILL]);
const FIGURE_SLOTS = Object.freeze([DetailSlot.FIGURE, DetailSlot.FIGURE_BACK]);
const ALL_SLOTS = Object.freeze([...FRAME_SLOTS, DetailSlot.FIGURE]);

// 1つの解決結果 r（resolveDetailFigure の戻り値）の失敗（参照先の図が無い・fit できない）を failures に積む。
// ownerKey＝通知文の主語（三方枠は建具記号キー・姿図は建具種別キー）。dims＝fit の寸法の写像。extra＝行に足す項目。
function pushFailuresOf(r, { failures, seen, ownerKey, slot, dims, extra }) {
  const push = (key, label, reason, owner = ownerKey) => {
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({
      key, symbolKey: owner, slot, label, reason, message: ERR_DETAIL_FIT_FAILED(label, owner, reason, slot), ...extra,
    });
  };
  // 優先の参照先の図が無い（描画は後ろの候補の図を流用するか既定へ戻す）。
  if (r.drawn?.key !== r.intended.key) {
    // 鍵は寸法を含めない（図が無いのは寸法によらない。出幅・見付違いの建具ごとに同じ文の行を増やさない）。
    // fit 失敗の鍵（detailFitKey）とは接頭辞で名前空間を分ける。
    push(`notFound|${r.intended.key}|${r.intended.slot}`, r.intended.key,
      ERR_DETAIL_FIGURE_NOT_FOUND(ownerOfSource(r.intended.source, ownerKey), r.intended.slot));
  }
  if (!r.drawn) return;
  const fitted = fitDetailLocalMemo({ figureKey: r.drawn.key, slot: r.drawn.slot, dims });
  if (fitted.error) {
    const fromFitting = r.drawn.source === 'fitting';
    push(detailFitKey({ figureKey: r.drawn.key, slot: r.drawn.slot, dims }),
      fromFitting ? fittingPartLabel(r.drawn.key) : r.drawn.entry.label || r.drawn.key, fitted.error.message,
      fromFitting ? DETAIL_OWNER_FITTING : ownerKey);
  }
}

// 通知文の主語: 建具個別の指定・建具一式はそれぞれ固定の言い方、それ以外（記号・建具種別）は持ち主のキー。
function ownerOfSource(source, ownerKey) {
  if (source === 'opening') return DETAIL_OWNER_OPENING;
  if (source === 'fitting') return DETAIL_OWNER_FITTING;
  return ownerKey;
}

// 行のキー表示（表示だけ）: 合成キー '<一式キー>#<役割>' は「一式キー（役割）」。
function fittingPartLabel(key) {
  const parsed = parseFittingPartKey(key);
  return parsed ? `${parsed.setKey}（${FITTING_PART_ROLE_TEXT[parsed.role] ?? parsed.role}）` : key;
}

/**
 * 建具の姿図（slot=figure と figureBack）の詳細図が（幅・高さ・窓台高さ）に合わせられないものの集計。全機構の建具が対象（三方枠に限らない）。
 * 立面モード（graph を持たない入力）からも呼べるよう、graph でなく建具の列を受ける。
 * 図の解決は描画と同じ resolveDetailFigure（建具個別の detailRefs.figure ＞ 建具種別エントリの detailFigures.figure）。
 * @param {Iterable<object>|null|undefined} openings Opening の列（graph.openings など）
 * @param {Set<string>} [seen] 重複排除の鍵の集合（collectDetailFitFailures と同じ。破壊的に更新する）
 * @returns {{key:string, symbolKey:string, slot:string, label:string, reason:string, message:string,
 *            dims:Object<string,number>}[]} symbolKey＝建具種別キー（通知文の主語）
 */
export function collectDetailFigureFailures(openings, seen = new Set()) {
  const failures = [];
  for (const o of openings ?? []) {
    const refs = subTypeDetailFigureRefsFor(o.category, o.subType);
    // 手前から見た姿図に加えて、向こう側から見た姿図（T2-2。任意）も参照があるときだけ試す
    for (const slot of FIGURE_SLOTS) {
      const r = resolveDetailFigure({ detailRefs: o.detailRefs ?? null, slot, subTypeRefs: refs, fittingKey: fittingKeyOf(o) });
      if (!r) continue;
      const dims = elevationDetailDims(o);
      pushFailuresOf(r, { failures, seen, ownerKey: o.subType, slot, dims, extra: { dims } });
    }
  }
  return failures;
}

/**
 * 建具一式（fittingKeyOf＝建具個別の指定＞建具種別の割当て。暗黙の既定の組込みは対象外）の参照先がカタログに無いものの集計（C7）。
 * 部品が無いことはエラーにしない（一式の図はあるが該当 role の部品が無いだけ）。参照切れは一式のキーごとに 1 行（階をまたいで seen で畳む）。
 * 行の形は pushFailuresOf と同じ（場面 detail-fit-failed。建具モードは詳細図の unresolved-code を持たないので枠・姿図の参照切れと同じ経路）。
 */
export function collectFittingNotFound(openings, seen = new Set()) {
  const failures = [];
  for (const o of openings ?? []) {
    const key = fittingKeyOf(o);
    if (key === null || detailFigureEntry(key) !== null) continue;
    // 主語は参照の持ち主（枠の参照切れと同じ規約）: detailRefs が fitting を持てば建具個別の指定、無ければ建具種別。
    const source = Object.hasOwn(o.detailRefs ?? {}, DetailSlot.FITTING) ? 'opening' : 'subType';
    pushFailuresOf({ drawn: null, intended: { key, source, slot: DetailSlot.FITTING } },
      { failures, seen, ownerKey: o.subType, slot: DetailSlot.FITTING, dims: {}, extra: {} });
  }
  return failures;
}

// 片開き戸（S8e-2）の方立（平面）・上枠（展開の断面）と窓（S8f-2）の方立（平面）。明示の割当て（建具個別の detailRefs ＞ 記号の detailFigures）だけが対象で、
// 暗黙の既定は resolveDetailFigure が null を返すので構造上ここに来ない（既定の fit 失敗は黙って従来の描きへ戻る）。
// 試す寸法は描画と同じ式で、壁厚だけ平面と断面で値が違う: 方立＝ホスト壁の両仕上げ面の間（OpeningsLayer の faceLo/faceHi＝wallFaceRange）、
// 上枠＝展開の断面の帯。帯の経路が 2 つあり壁厚が違う: 隅の断面は同じ通りの実壁の材の範囲の合併（wallMaterialRangeForOpening）、
// 切断壁の帯は当該部屋側の壁 1 枚の材の範囲（片開き戸は openingWallRange を持たない）。両方の壁厚を試し（重複は除く）、
// どれかが合わなければ上枠の行は 1 slot につき 1 件（最初に合わなかった壁厚）。見付は方立＝開口幅の半分で頭打ち、上枠・下枠＝sectionFrameFaceWidthFor（片開き戸 30・窓 min(25, 高さ/2)）。
// 壁が引けない slot は試さない。同じ図が片方の寸法にだけ合わないときは、合わない slot の行だけ出る。
// 窓は方立（平面。S8f-2。見付は jambWidthFor＝窓 25・建具 30、開口幅の半分で頭打ち）に加え、上枠・下枠（断面。S8f-3c）。
// 上枠・下枠の見付は sectionFrameFaceWidthFor（窓 min(25, 高さ/2)）。窓でどの slot を試すかは呼び出し側が frameDefaultKey で絞る。
function collectFrameFailures(o, graph, frameSlots, { failures, seen }) {
  const symbolKey = fixtureSymbolOf(o);
  const dimsListOf = slot => {
    if (!o.axisCL) return [];
    if (slot === DetailSlot.JAMB) {
      const host = findHostWall(o, graph);
      if (!host) return [];
      const [lo, hi] = wallFaceRange(host, graph);
      return [{ wallThickness: hi - lo, projection: FRAME_OVERHANG_MM, faceWidth: jambWidthFor(o) }];
    }
    // 上枠・下枠（断面）。見付は片開き戸 30・窓 min(25, 高さ/2)（描画と同じ sectionFrameFaceWidthFor）
    const merged = wallMaterialRangeForOpening(o, graph);
    if (!merged) return [];
    const thicknesses = [merged, ...wallMaterialRangesOf(o, graph)].map(r => r.hi - r.lo);
    return [...new Set(thicknesses)].map(wallThickness => ({ wallThickness, projection: FRAME_OVERHANG_MM, faceWidth: sectionFrameFaceWidthFor(o) }));
  };
  const fittingKey = fittingKeyOf(o);
  // 片開き戸の方立は吊元側・戸先側を別々に解決する（描画 resolveSwingDoorFrame と同じ条件）。それ以外は両側共通の 1 回。
  const swingEntry = isSwingLeafSection(o) ? findCatalogEntry(o.category, o.subType) : null;
  for (const slot of frameSlots) {
    const sides = swingEntry === null ? [null]
      : jambSidesFor({ slot, fittingKey, hingeSide: o.hingeSide, mechanism: swingEntry.mechanism, entry: swingEntry });
    for (const side of sides) {
      const r = resolveDetailFigure({ symbolKey, detailRefs: o.detailRefs ?? null, slot, fittingKey, side });
      if (!r) continue;
      for (const dims of dimsListOf(slot)) {
        const before = failures.length;
        pushFailuresOf(r, { failures, seen, ownerKey: symbolKey, slot, dims, extra: { ...dims } });
        if (failures.length > before) break;
      }
    }
  }
}

/**
 * graph の建具について、詳細図の fit に失敗する（図×寸法）の組と、参照先の図がカタログに無い組を集める。
 * 三方枠の方立・上枠、片開き戸の方立・上枠、窓の方立・上枠・下枠（図×壁厚・出幅・見付）と、全建具の姿図（図×幅・高さ・窓台高さ。collectDetailFigureFailures）。
 * @param {object|null} graph
 * @param {Set<string>} [seen] 重複排除の鍵の集合。複数階で共有すると階をまたいで同じ組を1回にできる（破壊的に更新する）
 * @param {{slots?: string[]}} [opts] slots＝試す枠。既定は方立（平面）・上枠（展開）・下枠（展開。窓だけ）・姿図。展開モードは
 *   断面が実際に使う上枠（head の図があれば head、無ければ jamb の流用）・下枠と姿図だけ [DetailSlot.HEAD, DetailSlot.SILL, DetailSlot.FIGURE] を渡す
 * @returns {{key:string, symbolKey:string, slot:string, label:string, reason:string, message:string,
 *            wallThickness?:number, projection?:number, faceWidth?:number, dims?:Object<string,number>}[]}
 */
export function collectDetailFitFailures(graph, seen = new Set(), { slots = ALL_SLOTS } = {}) {
  const failures = [];
  const frameSlots = slots.filter(s => FRAME_SLOTS.includes(s));
  for (const o of graph?.openings ?? []) {
    if (frameSlots.length === 0) continue;
    // 下枠は窓だけ（片開き戸・三方枠は方立・上枠）
    const nonSillSlots = frameSlots.filter(s => s !== DetailSlot.SILL);
    if (isSwingLeafSection(o)) {
      collectFrameFailures(o, graph, nonSillSlots, { failures, seen });
      continue;
    }
    // 窓は方立・上枠・下枠のうち既定の図を持つ slot だけ（引き違い窓は方立なし・掃き出し窓は下枠なし。frameDefaultKey に寄せる）
    if (isWindowSection(o)) {
      const mechanism = findCatalogEntry(o.category, o.subType)?.mechanism;
      collectFrameFailures(o, graph, frameSlots.filter(s => frameDefaultKey(o, s, mechanism) !== undefined), { failures, seen });
      continue;
    }
    if (!isFrameOnlySection(o)) continue;
    const symbolKey = fixtureSymbolOf(o);
    const range = openingSectionWallRange(o, graph);
    if (!range) continue;
    const wallThickness = range.hi - range.lo;
    const projection = effectiveFrameProjection(o);
    const fw = effectiveFrameFaceWidth(o);
    // 見付の頭打ちが違う: 平面の方立＝開口幅の半分、展開の上枠＝開口幅の半分のうえ開口高さの半分。
    const faceWidthOf = {
      [DetailSlot.JAMB]: clampFrameFaceWidth(fw, o.coord1, o.coord2),
      [DetailSlot.HEAD]: clampFrameFaceWidth(Math.min(fw, o.width / 2), 0, effectiveHeight(o)),
    };
    for (const slot of nonSillSlots) {
      const r = resolveDetailFigure({ symbolKey, detailRefs: o.detailRefs ?? null, slot, fittingKey: fittingKeyOf(o) });
      if (!r) continue;
      const faceWidth = faceWidthOf[slot];
      pushFailuresOf(r, {
        failures, seen, ownerKey: symbolKey, slot, dims: { wallThickness, projection, faceWidth },
        extra: { wallThickness, projection, faceWidth },
      });
    }
  }
  if (slots.includes(DetailSlot.FIGURE)) failures.push(...collectDetailFigureFailures(graph?.openings, seen), ...collectFittingNotFound(graph?.openings, seen));
  return failures;
}

/** 外壁をホストにする引き戸の通知の重複排除の鍵（階をまたいで 1 回だけ出す）。 */
export const SLIDE_ON_EXTERIOR_WALL_KEY = 'slideOnExteriorWall';

/**
 * 外壁（isExteriorWall）をホストにする外付け引き戸（category fitting・機構 SLIDE_SINGLE）の通知の集計（R12。
 * 外付けにできず従来の描きのままであることを建具モード突入時に 1 回知らせる）。行の形は collectDetailFitFailures と同じで
 * 同じ経路（場面 detail-fit-failed）に載せる。seen を複数階で共有すれば何本あっても 1 件。ホスト壁が引けない建具は対象外。
 * @param {object|null} graph
 * @param {Set<string>} [seen] 重複排除の鍵の集合（破壊的に更新する）
 * @returns {{key:string, symbolKey:string, label:string, message:string}[]}
 */
export function collectSlideOnExteriorWall(graph, seen = new Set()) {
  if (seen.has(SLIDE_ON_EXTERIOR_WALL_KEY)) return [];
  for (const o of graph?.openings ?? []) {
    if (o.category !== OpeningCategory.FITTING) continue;
    const entry = findCatalogEntry(o.category, o.subType);
    if (!isOutsetSlide(entry?.mechanism)) continue;
    if (findHostWall(o, graph)?.isExteriorWall !== true) continue;
    seen.add(SLIDE_ON_EXTERIOR_WALL_KEY);
    return [{ key: SLIDE_ON_EXTERIOR_WALL_KEY, symbolKey: o.subType, label: entry.label ?? o.subType, message: ERR_SLIDE_ON_EXTERIOR_WALL }];
  }
  return [];
}
