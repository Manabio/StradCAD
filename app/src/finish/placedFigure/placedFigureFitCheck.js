// ================================================================
// 姿図の配置（graph.placedFigures）の図を配置先に合わせられない通知の集計（部分詳細図 S10 P4）。純モジュール。
// 仕上げモード init が呼ぶ。描画（renderer/placedFigureDrawPlan.js）は毎レンダー呼ばれる純関数で通知の経路が無いので、
// 通知は init が自分で fit を試して集める（finish/roomDetailJunction.js collectRoomJunctionFailures と同型）。
//   対象: 配置の figureKey の図（平面の配置図でなければ分類違い）と、見上げ（views.ceiling。天伏に描かれる主題の図だけ）の図
//   参照切れ（配置の figureKey がカタログに無い）は unresolved-code 側（FinishModeState._missingUsageForKind）で出すのでここでは出さない。
//   views.ceiling の参照切れは walker の対象外なのでここで出す。展開の views.front／back／left／right も同様（主題を問わない。P5）
// 行は buildResolveRows の detailFitFailures と同形: {key, symbolKey, slot, label, reason, message, placedFigureId}。
//   symbolKey＝DETAIL_TARGET_PLACED_FIGURE（通知文の主語）・slot＝DetailSlot.FIGURE（「…の姿図に合わせられません」）
// fit は位置・回転・鏡像に依らないので、鍵は図のキー（同じ図を何か所に置いても 1 行。placedFigureId は最初の配置）。
// 失敗は例外にしない（行にする）。依存は葉だけ（store.js・snap.js・.jsx・react を引かない）。
// ================================================================

import { DetailSlot, DetailPlacementView, DETAIL_VIEWS_FIELD, CEILING_PLACED_FIGURE_SUBJECTS } from '../../core/constants.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, ERR_DETAIL_NOT_PLACED_FIGURE, DETAIL_TARGET_PLACED_FIGURE } from '../../error.js';
import { canHaveDetailViews } from '../../detail/detailModel.js';
import { fitLocal } from '../../detail/detailPlacement.js';
import { detailFigureEntry } from '../../openings/openingCatalog.js';
import { placedFigureTargets, isPlaceableViewFigure } from './placedFigureTargets.js';

const CHECKED_VIEWS = Object.freeze(Object.values(DetailPlacementView));

const classificationOf = fig => `${String(fig?.category)}・${String(fig?.view)}・${String(fig?.subject)}`;

/**
 * 配置の図を配置先に合わせられない・見つからない組を集める。seen（重複排除の鍵）は破壊的に更新する。
 * @param {ReadonlyArray<object>} placedFigures graph.placedFigures
 * @param {Set<string>} [seen]
 * @param {{entryOf?:(key:string)=>object|null}} [opts] entryOf＝図のキー→エントリ（既定はカタログ）
 * @returns {Array<{key:string, symbolKey:string, slot:string, label:string, reason:string, message:string, placedFigureId:string}>}
 */
export function collectPlacedFigureFailures(placedFigures, seen = new Set(), { entryOf = detailFigureEntry } = {}) {
  const failures = [];
  const push = (key, pf, label, reason) => {
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({
      key, symbolKey: DETAIL_TARGET_PLACED_FIGURE, slot: DetailSlot.FIGURE, label, reason,
      message: ERR_DETAIL_FIT_FAILED(label, DETAIL_TARGET_PLACED_FIGURE, reason, DetailSlot.FIGURE), placedFigureId: pf.id,
    });
  };
  // 図 1 枚を配置先に合わせてみる。合わせられない理由（文言）か null
  const failureOf = (fig, placeable) => {
    if (!placeable) return ERR_DETAIL_NOT_PLACED_FIGURE(classificationOf(fig));
    const t = placedFigureTargets(fig);
    if (t.error) return t.error.message;
    const fitted = fitLocal(fig, t.targets);
    return fitted.error ? fitted.error.message : null;
  };
  for (const pf of Array.isArray(placedFigures) ? placedFigures : []) {
    const fig = entryOf(pf.figureKey);
    if (!fig) continue;
    const label = fig.label || pf.figureKey;
    const reason = failureOf(fig, canHaveDetailViews(fig));
    if (reason !== null) push(`placedFigure|${pf.figureKey}`, pf, label, reason);
    // views の図（見上げ・展開の正面〜側面）。描画は失敗すると描かない／平面図へ落ちるが、利用者には知らせる。
    // 見上げ図は天伏に描かれる主題の図だけ。展開の 4 面は主題を問わない
    for (const view of CHECKED_VIEWS) {
      if (view === DetailPlacementView.CEILING && !CEILING_PLACED_FIGURE_SUBJECTS.includes(fig.subject)) continue;
      const viewKey = fig[DETAIL_VIEWS_FIELD]?.[view];
      if (typeof viewKey !== 'string' || viewKey === '') continue;
      const rowKey = `placedFigure|${view}|${viewKey}`;
      const viewFig = entryOf(viewKey);
      if (!viewFig) {
        push(rowKey, pf, viewKey, ERR_DETAIL_FIGURE_NOT_FOUND(DETAIL_TARGET_PLACED_FIGURE, DetailSlot.FIGURE));
        continue;
      }
      const viewReason = failureOf(viewFig, isPlaceableViewFigure(viewFig, view));
      if (viewReason !== null) push(rowKey, pf, viewFig.label || viewKey, viewReason);
    }
  }
  return failures;
}
