// ================================================================
// 三方枠の部分詳細図が（壁厚・出幅・見付）に合わせられないものの集計（部分詳細図 S3）。
// 建具モード（OpeningModeState.init）と展開モード（ElevationModeState.init）の突入時に呼ぶ。描画時のメモには頼らず、
// 自分で fit を試す（描画は毎レンダー呼ばれる純関数で通知の経路が無いため。平面モードでは通知しない＝R21）。
// 試す寸法は描画と同じ式: 平面の方立＝(壁厚・出幅・開口半幅で頭打ちの見付)、展開の上枠＝(同・開口高さ半分で頭打ち)。
// 図の解決は描画と同じ resolveDetailFigure（建具個別の detailRefs ＞ 記号の detailFigures。head は jamb を流用）。
// 壁厚はホスト壁の両仕上げ面（openingSectionWallRange）。ホスト壁が引けない三方枠は試さない。
// ================================================================

import { DetailSlot } from '../core/constants.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, DETAIL_OWNER_OPENING } from '../error.js';
import { effectiveFrameFaceWidth, effectiveFrameProjection, effectiveHeight, fixtureSymbolOf } from './openingNumbering.js';
import { detailFitKey, fitDetailLocalMemo } from './openingCatalog.js';
import { clampFrameFaceWidth } from './openingPlanSymbolGeometry.js';
import { isFrameOnlySection, openingSectionWallRange } from './openingSection.js';
import { resolveDetailFigure } from './openingDetailFit.js';

const ALL_SLOTS = Object.freeze([DetailSlot.JAMB, DetailSlot.HEAD]);

/**
 * graph の三方枠について、詳細図の fit に失敗する（図×壁厚・出幅・見付）の組と、参照先の図がカタログに無い組を集める。
 * @param {object|null} graph
 * @param {Set<string>} [seen] 重複排除の鍵の集合。複数階で共有すると階をまたいで同じ組を1回にできる（破壊的に更新する）
 * @param {{slots?: string[]}} [opts] slots＝試す枠。既定は方立（平面）と上枠（展開）の両方。展開モードは
 *   断面が実際に使う上枠（head の図があれば head、無ければ jamb の流用）だけ [DetailSlot.HEAD] を渡す
 * @returns {{key:string, symbolKey:string, slot:string, label:string, reason:string, message:string,
 *            wallThickness:number, projection:number, faceWidth:number}[]}
 */
export function collectDetailFitFailures(graph, seen = new Set(), { slots = ALL_SLOTS } = {}) {
  const failures = [];
  for (const o of graph?.openings ?? []) {
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
    for (const slot of slots) {
      const r = resolveDetailFigure({ symbolKey, detailRefs: o.detailRefs ?? null, slot });
      if (!r) continue;
      const faceWidth = faceWidthOf[slot];
      const push = (key, label, reason) => {
        if (seen.has(key)) return;
        seen.add(key);
        failures.push({
          key, symbolKey, slot, label, reason, message: ERR_DETAIL_FIT_FAILED(label, symbolKey, reason, slot),
          wallThickness, projection, faceWidth,
        });
      };
      // 優先の参照先の図が無い（描画は後ろの候補の図を流用するか既定へ戻す）。
      if (r.drawn?.key !== r.intended.key) {
        // 鍵は寸法を含めない（図が無いのは寸法によらない。出幅・見付違いの建具ごとに同じ文の行を増やさない）。
        // fit 失敗の鍵（detailFitKey）とは接頭辞で名前空間を分ける。
        push(`notFound|${r.intended.key}|${r.intended.slot}`, r.intended.key,
          ERR_DETAIL_FIGURE_NOT_FOUND(r.intended.source === 'opening' ? DETAIL_OWNER_OPENING : symbolKey, r.intended.slot));
      }
      if (!r.drawn) continue;
      const fitted = fitDetailLocalMemo({ figureKey: r.drawn.key, slot: r.drawn.slot, wallThickness, projection, faceWidth });
      if (fitted.error) {
        push(detailFitKey({ figureKey: r.drawn.key, slot: r.drawn.slot, wallThickness, projection, faceWidth }),
          r.drawn.entry.label || r.drawn.key, fitted.error.message);
      }
    }
  }
  return failures;
}
