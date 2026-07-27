// ================================================================
// 開口（建具・窓） — ホスト壁の解決と配置検証（純関数）
//
// Opening は Wall インスタンスを参照しないため、軸直交方向の実座標
// （axisValue）と壁厚方向の情報は常に「いまその位置にある壁」を
// ライブ検索して得る。
// ================================================================

import { ERR_OPENING_OUT_OF_WALL, ERR_OPENING_OVERLAP } from '../error.js';

/**
 * Opening と同じ axisCL・向き・側（wallSide）にあり、span が opening を完全に
 * 包含する壁を1本返す。シンボル配置（OpeningsLayer）・当たり判定（findOpeningAt）
 * 専用 — 壁線のギャップ判定には使わない（findOpeningsOnWall 参照）。
 *
 * 通常運用では候補は常に1本に定まる（部屋の壁は自動生成のみで、cells が排他的
 * なため同じ (axisCL, 符号, span) を複数の部屋が同時に主張することはない）。
 * 該当する壁が複数あれば axisOffset の絶対値が最小のものを採用するが、これは
 * レガシーインポートデータに対する防御的なフォールバックに過ぎない。
 * 該当なし = null（開口は描画されない）。
 */
export function findHostWall(opening, graph) {
  let best = null, bestAbs = Infinity;
  for (const w of graph.walls) {
    if (w.isVertical !== opening.isVertical) continue;
    if (w.axisCL.id  !== opening.axisCL.id)  continue;
    // CL偏芯の仕上げ面合わせで axisOffset===0（CL上に面が一致）になった壁は両側にマッチさせる
    const wSign = Math.sign(w.axisOffset);
    if (wSign !== 0 && wSign !== opening.wallSide) continue;
    const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
    if (opening.coord1 < lo || opening.coord2 > hi) continue;
    if (Math.abs(w.axisOffset) < bestAbs) { bestAbs = Math.abs(w.axisOffset); best = w; }
  }
  return best;
}

/**
 * 壁1本に物理的に重なる開口の一覧（ShapesLayer のギャップ描画用）。
 *
 * 部屋境界の壁は同じ axisCL・span 上に符号違いで複数本生成される
 * （部屋同士の間仕切り＝両室がそれぞれ自分側の壁を独立生成／部屋と外壁＝
 * 部屋自身の内向き壁と外皮としての外向き壁が同じ境界に独立生成される。
 * いずれも generateRoomWallsFromOutline / generateExteriorWalls 参照）。
 *
 * 1つの開口は物理的にその場所の壁すべてを貫通するため、ここでは
 * axisCL・向き・span の重なりのみで判定し、findHostWall のような
 * wallSide（符号）の厳格一致は要求しない。これにより、間仕切りや
 * 外壁の両面どちらの壁線にも正しくギャップが入る。
 */
export function findOpeningsOnWall(wall, graph) {
  const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
  return graph.openings.filter(o =>
    o.isVertical === wall.isVertical &&
    o.axisCL.id  === wall.axisCL.id &&
    o.coord1 >= lo && o.coord2 <= hi
  );
}

/** 配置検証: 壁範囲内か／既存開口と重なっていないか。OK なら null、NGならエラーメッセージ。 */
export function validateOpeningPlacement(wall, coord1, coord2, graph, excludeId = null) {
  const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
  if (coord1 < lo || coord2 > hi) return ERR_OPENING_OUT_OF_WALL;
  const overlap = findOpeningsOnWall(wall, graph).some(o =>
    o.id !== excludeId && coord1 < o.coord2 && coord2 > o.coord1);
  if (overlap) return ERR_OPENING_OVERLAP;
  return null;
}
