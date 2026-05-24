import { observer } from 'mobx-react-lite';
import { Line, Circle, Text } from 'react-konva';
import { CenterLineType, Discipline } from '@core';

// ビューポートのワールド座標範囲 (フォールバック用)
function viewportBounds(viewport, width, height) {
  const m = 50000;
  return {
    xMin: (0      - viewport.offsetX) / viewport.scale - m,
    xMax: (width  - viewport.offsetX) / viewport.scale + m,
    yMin: (0      - viewport.offsetY) / viewport.scale - m,
    yMax: (height - viewport.offsetY) / viewport.scale + m,
  };
}

// 中心線の描画延伸範囲を返す [lo, hi]
// 直交する中心線群の最小・最大値 ± オーバーハング
// 直交CLがない場合は null (呼び元がビューポート範囲にフォールバック)
function clExtent(cl, graph, viewport) {
  const isV = cl.centerLineType === CenterLineType.VERTICAL;
  const perpType = isV ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const perpVals = graph.centerLines
    .filter(p => p.centerLineType === perpType)
    .map(p => p.value);
  if (perpVals.length === 0) return null;
  const lo = Math.min(...perpVals);
  const hi = Math.max(...perpVals);
  // trim=false: 直交CL最外端 + スケール分母×20mm のオーバーハング
  // trim=true:  直交CL最外端でカット (オーバーハングなし)
  const overhang = cl.trim ? 0 : Math.round(100 / viewport.scale) * 20;
  return [lo - overhang, hi + overhang];
}

// ---- 中心線 (ワールド空間、一点鎖線) ----
export const CenterLinesLayer = observer(({ graph, viewport, width, height }) => {
  if (!graph) return null;
  const b = viewportBounds(viewport, width, height);

  return graph.centerLines.map(cl => {
    const isV = cl.centerLineType === CenterLineType.VERTICAL;
    const isH = cl.centerLineType === CenterLineType.HORIZONTAL;
    if (!isV && !isH) return null;

    const ext = clExtent(cl, graph, viewport);
    const [p1, p2] = ext ?? (isV ? [b.yMin, b.yMax] : [b.xMin, b.xMax]);
    const points = isV
      ? [cl.value, p1, cl.value, p2]
      : [p1, cl.value, p2, cl.value];

    return (
      <Line
        key={cl.id}
        points={points}
        stroke={cl.labeled ? '#3b82f6' : '#64748b'}
        strokeWidth={cl.labeled ? 1 : 0.6}
        dash={[12, 4, 2, 4]}
        strokeScaleEnabled={false}
        listening={false}
        opacity={cl.labeled ? 1 : 0.5}
      />
    );
  });
});

// ---- 交点マーカー (ワールド空間) ----
export const IntersectionMarkers = observer(({ graph, viewport }) => {
  if (!graph) return null;
  const r = 4 / viewport.scale; // 常に 4px 相当の半径

  return graph.intersections.map(n => (
    <Circle
      key={n.id}
      x={n.x}
      y={n.y}
      radius={r}
      fill="#3b82f6"
      opacity={0.7}
      listening={false}
    />
  ));
});

// ---- ラベル (スクリーン空間 — overlay レイヤーで使う) ----
export const CenterLineLabels = observer(({ graph, viewport, width, height }) => {
  if (!graph) return null;
  const MARGIN = 24; // px — ラベルを画面端から内側に配置

  return graph.centerLines
    .filter(cl => cl.labeled && cl.discipline === Discipline.STRUCT)
    .map(cl => {
      if (cl.centerLineType === CenterLineType.VERTICAL) {
        const sx = cl.value * viewport.scale + viewport.offsetX;
        if (sx < 0 || sx > width) return null;
        return (
          <Text
            key={cl.id}
            x={sx - 8}
            y={MARGIN}
            text={cl.label}
            fontSize={13}
            fontStyle="bold"
            fill="#3b82f6"
            listening={false}
          />
        );
      }
      if (cl.centerLineType === CenterLineType.HORIZONTAL) {
        const sy = cl.value * viewport.scale + viewport.offsetY;
        if (sy < 0 || sy > height) return null;
        return (
          <Text
            key={cl.id}
            x={MARGIN}
            y={sy - 7}
            text={cl.label}
            fontSize={13}
            fontStyle="bold"
            fill="#3b82f6"
            listening={false}
          />
        );
      }
      return null;
    });
});
