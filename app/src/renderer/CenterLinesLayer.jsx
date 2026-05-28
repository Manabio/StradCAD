import { observer } from 'mobx-react-lite';
import { Line, Circle, Text } from 'react-konva';
import { CenterLineType, Discipline } from '@core';
import { overhangMm } from '../snap.js';

// ビューポートのワールド座標範囲 (フォールバック用)
function viewportBounds(viewport, width, height) {
  const m = 50000;
  return {
    xMin: (0      - viewport.offsetX) / viewport.scaleX - m,
    xMax: (width  - viewport.offsetX) / viewport.scaleX + m,
    yMin: (0      - viewport.offsetY) / viewport.scaleY - m,
    yMax: (height - viewport.offsetY) / viewport.scaleY + m,
  };
}

// 中心線の描画延伸範囲を返す [lo, hi]
function clExtent(cl, graph, viewport) {
  const isV      = cl.centerLineType === CenterLineType.VERTICAL;
  const perpType  = isV ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;

  if (cl.labeled) {
    // 通り芯: labeled な直交CLのみ参照（中心線追加で長さが変わらないよう）
    const perpScale = isV ? viewport.scaleY : viewport.scaleX;
    const perpVals  = graph.centerLines
      .filter(p => p.centerLineType === perpType && p.labeled)
      .map(p => p.value);
    if (perpVals.length === 0) return null;
    const lo       = Math.min(...perpVals);
    const hi       = Math.max(...perpVals);
    const overhang = cl.trim ? 0 : Math.round(100 / perpScale) * 20;
    return [lo - overhang, hi + overhang];
  } else {
    // 中心線・補助線: 追加時に確定した extentLo/Hi を使用（既存CLは一切変更しない）
    if (cl.extentLo == null || cl.extentHi == null) {
      // extentLo/Hi 未設定（古いデータ等）→ labeled 直交CLのmin/maxにフォールバック
      const vals = graph.centerLines
        .filter(p => p.centerLineType === perpType && p.labeled)
        .map(p => p.value);
      if (vals.length === 0) return null;
      const overhang = overhangMm(viewport, cl.trim);
      return [Math.min(...vals) - overhang, Math.max(...vals) + overhang];
    }
    const overhang = overhangMm(viewport, cl.trim);
    return [cl.extentLo - overhang, cl.extentHi + overhang];
  }
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
  const r = 4 / viewport.scaleX;

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

// ---- ガター内 通り芯マーカー丸 (ラベルの背景) ----
export const GutterCLMarkers = observer(({ graph, viewport, width, height, gutter }) => {
  if (!graph) return null;
  const r   = Math.round(gutter * 0.32);
  const mid = gutter / 2;

  return graph.centerLines
    .filter(cl => cl.labeled && cl.discipline === Discipline.STRUCT)
    .map(cl => {
      if (cl.centerLineType === CenterLineType.VERTICAL) {
        const sx = cl.value * viewport.scaleX + viewport.offsetX;
        if (sx < gutter || sx > width - gutter) return null;
        return (
          <Circle key={cl.id} x={sx} y={mid} radius={r}
            fill="#dbeafe" stroke="#93c5fd" strokeWidth={1.5} listening={false} />
        );
      }
      if (cl.centerLineType === CenterLineType.HORIZONTAL) {
        const sy = cl.value * viewport.scaleY + viewport.offsetY;
        if (sy < gutter || sy > height - gutter) return null;
        return (
          <Circle key={cl.id} x={mid} y={sy} radius={r}
            fill="#dbeafe" stroke="#93c5fd" strokeWidth={1.5} listening={false} />
        );
      }
      return null;
    });
});

// ---- ラベル (スクリーン空間 — overlay レイヤーで使う) ----
// gutter: 通り芯表示エリアの幅 (px)。上帯に縦CL、左帯に横CLラベルを中央配置。
export const CenterLineLabels = observer(({ graph, viewport, width, height, gutter = 24 }) => {
  if (!graph) return null;

  return graph.centerLines
    .filter(cl => cl.labeled && cl.discipline === Discipline.STRUCT)
    .map(cl => {
      if (cl.centerLineType === CenterLineType.VERTICAL) {
        const sx = cl.value * viewport.scaleX + viewport.offsetX;
        if (sx < gutter || sx > width - gutter) return null;
        return (
          <Text
            key={cl.id}
            x={sx - gutter / 2}
            y={0}
            width={gutter}
            height={gutter}
            align="center"
            verticalAlign="middle"
            text={cl.label}
            fontSize={13}
            fontStyle="bold"
            fill="#3b82f6"
            listening={false}
          />
        );
      }
      if (cl.centerLineType === CenterLineType.HORIZONTAL) {
        const sy = cl.value * viewport.scaleY + viewport.offsetY;
        if (sy < gutter || sy > height - gutter) return null;
        return (
          <Text
            key={cl.id}
            x={0}
            y={sy - gutter / 2}
            width={gutter}
            height={gutter}
            align="center"
            verticalAlign="middle"
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
