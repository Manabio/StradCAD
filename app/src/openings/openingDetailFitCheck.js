// ================================================================
// 三方枠の部分詳細図が（壁厚・出幅・見付）に合わせられないものの集計（部分詳細図 S3）。
// 建具モード（OpeningModeState.init）と展開モード（ElevationModeState.init）の突入時に呼ぶ。描画時のメモには頼らず、
// 自分で fit を試す（描画は毎レンダー呼ばれる純関数で通知の経路が無いため。平面モードでは通知しない＝R21）。
// 試す寸法は描画と同じ式: 平面の方立＝(壁厚・出幅・開口半幅で頭打ちの見付)、展開の上枠＝(同・開口高さ半分で頭打ち)。
// 図の解決は描画と同じ resolveDetailFigure（建具個別の detailRefs ＞ 記号の detailFigures。head は jamb を流用）。
// 壁厚はホスト壁の両仕上げ面（openingSectionWallRange）。ホスト壁が引けない三方枠は試さない。
// 建具の姿図（S6b。slot=figure）は全機構の建具が対象で、壁は引かない（collectDetailFigureFailures。立面の入力組み立ても使う）。
// ================================================================

import { DetailSlot } from '../core/constants.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, DETAIL_OWNER_OPENING } from '../error.js';
import { effectiveFrameFaceWidth, effectiveFrameProjection, effectiveHeight, fixtureSymbolOf } from './openingNumbering.js';
import { detailFitKey, fitDetailLocalMemo, subTypeDetailFigureRefsFor } from './openingCatalog.js';
import { clampFrameFaceWidth } from './openingPlanSymbolGeometry.js';
import { isFrameOnlySection, openingSectionWallRange } from './openingSection.js';
import { resolveDetailFigure, elevationDetailDims } from './openingDetailFit.js';

const FRAME_SLOTS = Object.freeze([DetailSlot.JAMB, DetailSlot.HEAD]);
const ALL_SLOTS = Object.freeze([...FRAME_SLOTS, DetailSlot.FIGURE]);

// 1つの解決結果 r（resolveDetailFigure の戻り値）の失敗（参照先の図が無い・fit できない）を failures に積む。
// ownerKey＝通知文の主語（三方枠は建具記号キー・姿図は建具種別キー）。dims＝fit の寸法の写像。extra＝行に足す項目。
function pushFailuresOf(r, { failures, seen, ownerKey, slot, dims, extra }) {
  const push = (key, label, reason) => {
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({
      key, symbolKey: ownerKey, slot, label, reason, message: ERR_DETAIL_FIT_FAILED(label, ownerKey, reason, slot), ...extra,
    });
  };
  // 優先の参照先の図が無い（描画は後ろの候補の図を流用するか既定へ戻す）。
  if (r.drawn?.key !== r.intended.key) {
    // 鍵は寸法を含めない（図が無いのは寸法によらない。出幅・見付違いの建具ごとに同じ文の行を増やさない）。
    // fit 失敗の鍵（detailFitKey）とは接頭辞で名前空間を分ける。
    push(`notFound|${r.intended.key}|${r.intended.slot}`, r.intended.key,
      ERR_DETAIL_FIGURE_NOT_FOUND(r.intended.source === 'opening' ? DETAIL_OWNER_OPENING : ownerKey, r.intended.slot));
  }
  if (!r.drawn) return;
  const fitted = fitDetailLocalMemo({ figureKey: r.drawn.key, slot: r.drawn.slot, dims });
  if (fitted.error) {
    push(detailFitKey({ figureKey: r.drawn.key, slot: r.drawn.slot, dims }),
      r.drawn.entry.label || r.drawn.key, fitted.error.message);
  }
}

/**
 * 建具の姿図（slot=figure）の詳細図が（幅・高さ・窓台高さ）に合わせられないものの集計。全機構の建具が対象（三方枠に限らない）。
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
    const r = resolveDetailFigure({ detailRefs: o.detailRefs ?? null, slot: DetailSlot.FIGURE, subTypeRefs: refs });
    if (!r) continue;
    const dims = elevationDetailDims(o);
    pushFailuresOf(r, { failures, seen, ownerKey: o.subType, slot: DetailSlot.FIGURE, dims, extra: { dims } });
  }
  return failures;
}

/**
 * graph の建具について、詳細図の fit に失敗する（図×寸法）の組と、参照先の図がカタログに無い組を集める。
 * 三方枠の方立・上枠（図×壁厚・出幅・見付）と、全建具の姿図（図×幅・高さ・窓台高さ。collectDetailFigureFailures）。
 * @param {object|null} graph
 * @param {Set<string>} [seen] 重複排除の鍵の集合。複数階で共有すると階をまたいで同じ組を1回にできる（破壊的に更新する）
 * @param {{slots?: string[]}} [opts] slots＝試す枠。既定は方立（平面）・上枠（展開）・姿図。展開モードは
 *   断面が実際に使う上枠（head の図があれば head、無ければ jamb の流用）と姿図だけ [DetailSlot.HEAD, DetailSlot.FIGURE] を渡す
 * @returns {{key:string, symbolKey:string, slot:string, label:string, reason:string, message:string,
 *            wallThickness?:number, projection?:number, faceWidth?:number, dims?:Object<string,number>}[]}
 */
export function collectDetailFitFailures(graph, seen = new Set(), { slots = ALL_SLOTS } = {}) {
  const failures = [];
  const frameSlots = slots.filter(s => FRAME_SLOTS.includes(s));
  for (const o of graph?.openings ?? []) {
    if (frameSlots.length === 0 || !isFrameOnlySection(o)) continue;
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
    for (const slot of frameSlots) {
      const r = resolveDetailFigure({ symbolKey, detailRefs: o.detailRefs ?? null, slot });
      if (!r) continue;
      const faceWidth = faceWidthOf[slot];
      pushFailuresOf(r, {
        failures, seen, ownerKey: symbolKey, slot, dims: { wallThickness, projection, faceWidth },
        extra: { wallThickness, projection, faceWidth },
      });
    }
  }
  if (slots.includes(DetailSlot.FIGURE)) failures.push(...collectDetailFigureFailures(graph?.openings, seen));
  return failures;
}
