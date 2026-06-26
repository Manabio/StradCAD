import { observer } from 'mobx-react-lite';
import { Rect } from 'react-konva';

// 材カテゴリごとの塗り分け（簡易ハッチ代わりの色分け）。
const CATEGORY_FILL = {
  backing: '#d9c9a3', // 下地（木/鋼）
  panel:   '#cfd8dc', // 面材
  finish:  '#e6bfbf', // 仕上げ
};
const NULL_FILL = '#f2f2f2'; // 未指定（厚0は描画されない）

/**
 * LOD 詳細描画: 仕上げモードかつ高倍率時、各エッジの層構成を世界座標の帯で描く。
 * 層解決は materialMap を要するため、resolveEdgeSection をプロップで受け取る
 * （このコンポーネントは材データを import しない＝メインバンドルを汚さない）。
 */
export const EdgeSectionLayer = observer(({ graph, viewport, cellToRoom, resolveEdgeSection }) => {
  if (!graph || !resolveEdgeSection) return null;
  const scale  = Math.min(viewport.scaleX, viewport.scaleY);
  const stroke = 0.5 / scale; // スクリーン上 ~0.5px

  const rects = [];
  for (const edge of graph.edges) {
    const bands = resolveEdgeSection(edge, graph, cellToRoom);
    if (!bands) continue;
    bands.forEach((b, i) => {
      rects.push(
        <Rect
          key={`${edge.key}:${i}`}
          x={b.x} y={b.y} width={b.width} height={b.height}
          fill={b.category ? CATEGORY_FILL[b.category] : NULL_FILL}
          stroke="#555"
          strokeWidth={stroke}
          listening={false}
        />,
      );
    });
  }
  return rects;
});
