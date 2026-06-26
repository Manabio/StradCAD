/**
 * ポインタ位置から最近傍の頂点と接続図形をR-Tree + グラフ接続ロジックで特定する。
 *
 * ユーザーの囲み選択は使わず、「どこを指しているか」と「そこに何が接続されているか」の
 * 2 ステップで変形対象を決定する（Phase 3）。
 * Phase 4 のストレッチ操作開始時にこの関数を呼ぶ。
 *
 * @param {import('../core.js').PlanGraph} graph
 * @param {import('./SpatialIndex.js').SpatialIndex} spatialIndex
 * @param {number} wx          ワールド座標 X
 * @param {number} wy          ワールド座標 Y
 * @param {number} worldRadius 検索半径 (mm)
 * @returns {{ type: 'intersection'|'point', vertex: Intersection|Point, shapes: Shape[] } | null}
 */
export function queryStretchTarget(graph, spatialIndex, wx, wy, worldRadius) {
  const { intersections, points } = spatialIndex.query(wx, wy, worldRadius);

  if (intersections.length > 0) {
    const vertex = spatialIndex.getNode(intersections[0].id);
    if (vertex) {
      // グラフ接続ロジック: この交点をエンドポイントに持つ全図形を取得
      const shapes = graph.getShapesAtNode(vertex);
      return { type: 'intersection', vertex, shapes };
    }
  }

  if (points.length > 0) {
    const vertex = spatialIndex.getNode(points[0].id);
    if (vertex) {
      // 自由点を中心・端点に持つ図形
      const shapes = graph.generalShapes.filter(
        s => s.center === vertex || s.nodeA === vertex || s.nodeB === vertex,
      );
      return { type: 'point', vertex, shapes };
    }
  }

  return null;
}
