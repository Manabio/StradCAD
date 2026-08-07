// ガター帯（描画エリア外周の通り芯表示帯）上のスクリーン座標ヒット判定。
// App.jsx の長押し開始判定（柱芯ラベル・通り芯の長押しメニュー起点特定）から抽出。
import { CenterLineType } from '../core.js';
import { INSET } from '../layout.js';
// GutterLayer.jsx（.jsx・react-konva依存）ではなく、純関数レイヤの gutterLabelHits.js を参照する
// （node:test から import 可能にするため。GutterLayer.jsx 側もここを参照し実装は単一）。
import { columnAxisLabelHits } from '../renderer/gutterLabelHits.js';

// ---- 描画エリア内の○「柱芯」ラベル ヒット判定 ----
// ヒットしたラベルの cl と、窓を固定するためのラベル中心スクリーン座標を返す。
export function findColumnAxisLabel(graph, viewport, width, height, sx, sy) {
  const HIT = 18; // px（丸ラベル半径相当）
  let best = null, bestD = HIT;
  for (const h of columnAxisLabelHits(graph, viewport, width, height)) {
    const d = Math.hypot(sx - h.sx, sy - h.sy);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

// ---- ガター内の通り芯ヒット判定 ----
export function findGutterCL(graph, viewport, width, height, sx, sy) {
  const HIT = 24; // px
  const cls = graph.centerLines.filter(cl => cl.labeled);
  if (sy < INSET.top || sy > height - INSET.bottom) {
    for (const cl of cls) {
      if (cl.centerLineType !== CenterLineType.VERTICAL) continue;
      if (Math.abs(cl.value * viewport.scaleX + viewport.offsetX - sx) < HIT) return cl;
    }
  }
  if (sx < INSET.left || sx > width - INSET.right) {
    for (const cl of cls) {
      if (cl.centerLineType !== CenterLineType.HORIZONTAL) continue;
      if (Math.abs(cl.value * viewport.scaleY + viewport.offsetY - sy) < HIT) return cl;
    }
  }
  return null;
}
