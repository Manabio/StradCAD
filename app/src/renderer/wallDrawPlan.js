/**
 * 平面の壁描画に必要な「壁をまたぐ派生値」を1レンダー分まとめて解決する純モジュール。
 * ShapesLayer.jsx の描画前準備（下地の重複防止・T字取り合い・腰壁垂れ壁・柱の仕上げ包み・
 * 壁ごとの開口）をレンダラから切り出したもの。挙動は切り出し前と同じ。
 *
 * 切り出した理由は2つ:
 *   1. **メモ化の継ぎ目**——これらは graph が変わらない限り同じ結果を返すのに、
 *      ポインタ移動・パン・ズームのたびの再レンダーで毎回やり直していた（カクつきの主因）。
 *      呼び出し側は renderer/graphDerived.js の graphComputed でこの関数ごと包む。
 *   2. **計測・検証可能にするため**——react-konva を静的 import する .jsx は node から
 *      実行できず、コストを単体で測れなかった。
 *
 * 純モジュール（node:test / node 直実行から単体 import 可能。store.js・*.jsx を静的に引かない）。
 */
import { ShapeType } from '@core';
import { LodLevel } from '../viewport.js';
import { resolveWallTJunctions } from './wallJunctionResolve.js';
import { resolveKneeDropOverlays } from '../finish/kneeDropWall.js';
import { columnWallCuts } from '../finish/columnWrap.js';
import { indexByAxis, findOpeningsOnWallIndexed } from '../openings/openingGeometry.js';

// 略図LOD で返す下地重複防止の空集合（読み取り専用として共有する）。
const EMPTY_SET = new Set();

/**
 * 下地（間柱）描画の重複防止: 同一axisCL上で範囲が重なる正負オフセットの壁ペア
 * （部屋境界の内外両側）は通り芯上の同じ構造材を指すため、正(+)側のみ描画する。
 * 偏芯壁（backingOffset指定あり）は下地帯が通り芯に対して対称でない＝相手側と共有する構造材
 * ではないため、この重複防止の対象外（自分の下地は常に描画・相手側の判定にも使わない）。
 * 新モデル（finish/wallGeneration.js の resolveBackingOwnership/applyBackingOwnership）で
 * 生成された壁は backingOffset を必ず明示（オーナーは0・非オーナーは薄壁でbackingDepth=0）
 * するため、この判定（backingOffset==null）の対象に自然に入らない——ここは旧データ
 * （backingOffset未設定の対称壁ペア）の表示互換のためのフォールバックとして残す。
 *
 * 走査は axisCL 単位に束ねる（全壁の総当たりと結果は同一——判定条件が
 * `o.axisCL === w.axisCL` を含むため、別の軸CLの壁は元から一致しない）。
 * @param {object[]} generalShapes
 * @returns {Set<string>}
 */
export function resolveDeferredBackingIds(generalShapes) {
  const deferred = new Set();
  const byAxis = new Map(); // axisCL → 対象壁
  for (const s of generalShapes) {
    if (s.type !== ShapeType.WALL || s.wallFinish == null || s.backingOffset != null) continue;
    const bucket = byAxis.get(s.axisCL);
    if (bucket) bucket.push(s);
    else byAxis.set(s.axisCL, [s]);
  }
  for (const bucket of byAxis.values()) {
    const positives = bucket.filter(o => o.axisOffset > 0);
    if (positives.length === 0) continue;
    for (const w of bucket) {
      if (w.axisOffset >= 0) continue;
      const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
      const hasPositiveOverlap = positives.some(o =>
        Math.min(o.coord1, o.coord2) < wHi && Math.max(o.coord1, o.coord2) > wLo);
      if (hasPositiveOverlap) deferred.add(w.id);
    }
  }
  return deferred;
}

/**
 * 1レンダー分の壁描画準備をまとめて解決する。
 * @param {object} graph
 * @param {string} lodLevel - viewport.lodLevel（LodLevel）
 * @returns {{
 *   deferredBackingIds: Set<string>,
 *   wallJunctions: Map<string, object>|null,
 *   kneeDropOverlays: Map<string, object>|null,
 *   columnCuts: Map<string, object>|null,
 *   openingsByWall: Map<string, object[]>,
 * }}
 */
export function buildWallDrawPlan(graph, lodLevel) {
  const detail = lodLevel === LodLevel.DETAIL;
  const walls = graph.walls;

  // 壁ごとの開口（開口位置で壁線にギャップを入れるための区間分割）。従来は壁1本ごとに
  // graph.openings を総当たりしていた（O(壁 × 開口)）。coord1 昇順は ShapesLayer の
  // 区間分割が前提にしているためここで確定させる。
  const openingIndex = indexByAxis(graph.openings);
  const openingsByWall = new Map();
  for (const wall of walls) {
    const found = findOpeningsOnWallIndexed(wall, openingIndex);
    if (found.length > 0) openingsByWall.set(wall.id, found.sort((a, b) => a.coord1 - b.coord1));
  }

  return {
    deferredBackingIds: detail ? resolveDeferredBackingIds(graph.generalShapes) : EMPTY_SET,
    // 壁のT字取り合い（突き当たり）解決: 詳細LODでのみ、ジオメトリを変えずに描画時だけ反映する
    // （wallJunctionResolve.js。resolveStairSideLines と同じ「描画ルールを幾何モジュールに
    // 集約しレンダラは写像するだけ」というパターン）。壁全般が対象——手動壁・部屋壁・外壁・
    // 階段下壁を区別しない。
    wallJunctions: detail ? resolveWallTJunctions(walls) : null,
    // 腰壁・垂れ壁の描画オーバーレイ。略図LOD（単線）では特別描画なし。
    kneeDropOverlays: lodLevel !== LodLevel.SCHEMATIC ? resolveKneeDropOverlays(graph) : null,
    // 柱の仕上げ包み（柱壁）と取り合う区間。柱を描かないモード（仕上げ・敷地）でも
    // 壁の見た目は「柱に取られた区間」を反映してよい——柱は実在するため。
    columnCuts: lodLevel !== LodLevel.SCHEMATIC ? columnWallCuts(graph) : null,
    openingsByWall,
  };
}
