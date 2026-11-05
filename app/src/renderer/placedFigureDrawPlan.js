// ================================================================
// 姿図の配置（PlacedFigure）を平面（見下げ）・天伏（見上げ）に描くための図形の計画（部分詳細図 S10 P3）。純モジュール。
//   入力: graph.placedFigures（PlacedFigure の配列）・figureOf（詳細図キー→エントリ。無ければ null）・direction
//   出力: lines（世界 mm の平坦な頂点列＋線の太さの役割＋破線か）・marks（解決できない配置点の×）・boxes（描けた配置の外接。選択強調用）
// 回転 +90° は画面時計回り（y 下向き正）。鏡像は図の局所 s を反転してから回転する。
// 見下げ: 平面の配置図（FIGURE・PLAN・衛生/家具/空調）をすべて描く。
// 見上げ: CEILING_PLACED_FIGURE_SUBJECTS の図だけ。views.ceiling の図が解ければそれを優先し、無い・参照切れ・分類違い・fit 不能は平面図自身へ落ちる。
// 解決できない配置（参照切れ・配置図でない分類・基準の供給失敗・fit 失敗）は配置点の印（marks）にする。矩形で代用しない。
// 依存は constants・placedFigureTargets・roomDetailTargets（失敗の語彙 RoomDetailError だけ）・detailPlacement（store.js・snap.js・.jsx・react・konva を引かない）。
// ================================================================

import {
  LINE_WEIGHT_MM, DETAIL_DEFAULT_WEIGHT_ROLE, DetailDash, DetailPlacementView, DETAIL_VIEWS_FIELD, CEILING_PLACED_FIGURE_SUBJECTS,
} from '../core/constants.js';
import { placedFigureTargets, isPlaceableViewFigure } from '../finish/placedFigure/placedFigureTargets.js';
import { RoomDetailError } from '../finish/roomDetailTargets.js';
import { fitLocal, placeStrokes, canHaveDetailViews } from '../detail/detailPlacement.js';

const toRad = deg => (deg * Math.PI) / 180;
// 回転は 90° の整数倍なので cos・sin は 0／±1 に丸める（+ 0 で -0 を 0 にそろえる）
const unit = v => Math.round(v) + 0;

/** 配置の frame（図の局所 s・t → 世界）。mirror は s 軸だけ反転。 */
function frameOf(pf) {
  const c = unit(Math.cos(toRad(pf.rotationDeg)));
  const sn = unit(Math.sin(toRad(pf.rotationDeg)));
  const m = pf.mirror ? -1 : 1;
  return { ox: pf.x, oy: pf.y, sx: m * c + 0, sy: m * sn + 0, tx: -sn + 0, ty: c };
}

/** 図キー 1 つぶんの fit（位置に依らないので呼出し内でキャッシュする）。{fitted} | {error:{code}} */
function fitOnce(cache, key, fig) {
  const hit = cache.get(key);
  if (hit) return hit;
  const t = placedFigureTargets(fig);
  let result;
  if (t.error) result = { error: t.error };
  else {
    const fitted = fitLocal(fig, t.targets);
    result = fitted.error ? { error: fitted.error } : { fitted };
  }
  cache.set(key, result);
  return result;
}

const flatten = pts => pts.flatMap(p => [p[0], p[1]]);

/**
 * @param {ReadonlyArray<object>} placedFigures graph.placedFigures
 * @param {(key:string) => (object|null)} figureOf 詳細図キー → エントリ
 * @param {{direction?: 'down'|'up'}} [opts]
 * @returns {{lines: Array<{key:string, figureId:string, points:number[], weight:string, dashed:boolean}>,
 *            marks: Array<{figureId:string, x:number, y:number, code:(string|null)}>,
 *            boxes: Array<{figureId:string, minX:number, minY:number, maxX:number, maxY:number}>}}
 */
export function placedFigureDrawPlan(placedFigures, figureOf, { direction = 'down' } = {}) {
  const lines = [];
  const marks = [];
  const boxes = [];
  if (!Array.isArray(placedFigures)) return { lines, marks, boxes };
  const up = direction === 'up';
  const cache = new Map();
  for (const pf of placedFigures) {
    if (pf === null || typeof pf !== 'object') continue;
    const mark = code => marks.push({ figureId: pf.id, x: pf.x, y: pf.y, code });
    const fig = figureOf(pf.figureKey);
    if (!fig) { mark(null); continue; }
    // 平面の配置図でない分類（建具の詳細図・立面側の姿図など）は配置先違い＝UNSUPPORTED_SLOT（placedFigureTargets と同じ語彙。参照切れの null と区別する）
    if (!canHaveDetailViews(fig)) { mark(RoomDetailError.UNSUPPORTED_SLOT); continue; }
    let drawKey = pf.figureKey;
    let drawFig = fig;
    if (up) {
      if (!CEILING_PLACED_FIGURE_SUBJECTS.includes(fig.subject)) continue;
      const ceilKey = fig[DETAIL_VIEWS_FIELD]?.[DetailPlacementView.CEILING];
      if (typeof ceilKey === 'string' && ceilKey !== '') {
        const figC = figureOf(ceilKey);
        // 見上げ図は任意の上乗せ: 無い・参照切れ・分類違い・fit 不能は平面図自身へ落ちる（建具の figureBack と同じ規則。fit の結果はキャッシュに残る）
        if (isPlaceableViewFigure(figC, DetailPlacementView.CEILING) && !fitOnce(cache, ceilKey, figC).error) { drawKey = ceilKey; drawFig = figC; }
      }
    }
    const r = fitOnce(cache, drawKey, drawFig);
    if (r.error) { mark(r.error.code ?? null); continue; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let drawn = 0;
    for (const st of placeStrokes(r.fitted, frameOf(pf))) {
      const pts = st.closed && st.points.length > 1 ? [...st.points, st.points[0]] : st.points;
      if (pts.length < 2) continue;
      const role = st.line?.weightRole;
      lines.push({
        key: `${pf.id}:${st.id}`,
        figureId: pf.id,
        points: flatten(pts),
        weight: Object.hasOwn(LINE_WEIGHT_MM, role) ? role : DETAIL_DEFAULT_WEIGHT_ROLE,
        dashed: st.line?.dashRole === DetailDash.DASHED,
      });
      drawn += 1;
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (drawn > 0) boxes.push({ figureId: pf.id, minX, minY, maxX, maxY });
  }
  return { lines, marks, boxes };
}
