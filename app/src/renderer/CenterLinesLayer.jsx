import { observer } from 'mobx-react-lite';
import { Line, Circle } from 'react-konva';
import { CenterLineType, DimensionSide, Discipline, centerLineKind } from '@core';
import { overhangMm } from '../snap.js';
import { gutterEdgeCoord } from './gutterPrimitives.jsx';

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
export function clExtent(cl, graph, viewport, width, height) {
  const isV      = cl.centerLineType === CenterLineType.VERTICAL;
  const perpType  = isV ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;

  if (cl.labeled) {
    if (cl.trim) {
      // トリム指定: labeled な直交CLの端でカットする（オーバーハングなし）
      const perpVals = graph.centerLines
        .filter(p => p.centerLineType === perpType && p.labeled)
        .map(p => p.effectiveValue);
      if (perpVals.length === 0) return null;
      return [Math.min(...perpVals), Math.max(...perpVals)];
    }
    // 通り芯: ガター丸ラベルの中心まで伸ばす（GutterCircleLabelsと同じ座標を参照）
    return isV
      ? [gutterEdgeCoord(viewport, width, height, DimensionSide.TOP),  gutterEdgeCoord(viewport, width, height, DimensionSide.BOTTOM)]
      : [gutterEdgeCoord(viewport, width, height, DimensionSide.LEFT), gutterEdgeCoord(viewport, width, height, DimensionSide.RIGHT)];
  } else {
    // 中心線・補助線: 追加時に確定した extentLo/Hi を使用（既存CLは一切変更しない）
    if (cl.extentLo == null || cl.extentHi == null) {
      // extentLo/Hi 未設定（古いデータ等）→ labeled 直交CLのmin/maxにフォールバック
      const vals = graph.centerLines
        .filter(p => p.centerLineType === perpType && p.labeled)
        .map(p => p.effectiveValue);
      if (vals.length === 0) return null;
      const overhang = overhangMm(viewport, cl.trim);
      return [Math.min(...vals) - overhang, Math.max(...vals) + overhang];
    }
    const overhang = overhangMm(viewport, cl.trim);
    return [cl.extentLo - overhang, cl.extentHi + overhang];
  }
}

// ---- 中心線 (ワールド空間、一点鎖線) ----
// columnAxisMode時は、通り芯からの柱芯偏心（columnAxisOffsets、ラーメン系のみ非0）を
// 同じ一点鎖線で建物内に描画する。柱・梁の実位置はこのオフセットをCL.effectiveValueに加算した
// 位置を使う（core.js参照）——ここではその基準線を可視化するだけで、新規CL/Shapeは作らない。
// appMode: 梁芯CL（discipline:'fuse'）は構造モード（appMode==='structure'）以外では描画しない
// （データ（CenterLine実体・shapeMap上）は残したまま、描画のみスキップする——他モードから見えず
// 操作できなくなるが、構造モード専用の線という仕様どおり）。線のスタイルは柱芯線（下のaxisLines）と
// 同一にする（青#3b82f6・一点鎖線[12,4,2,4]・opacity1・通常CLと同じstrokeWidth）。
export const CenterLinesLayer = observer(({ graph, viewport, width, height, columnAxisMode = false, axisLineCoords = null, appMode }) => {
  if (!graph) return null;
  const b = viewportBounds(viewport, width, height);

  const clLines = graph.centerLines.map(cl => {
    const isV = cl.centerLineType === CenterLineType.VERTICAL;
    const isH = cl.centerLineType === CenterLineType.HORIZONTAL;
    if (!isV && !isH) return null;

    // 梁芯CLは構造モード限定表示（柱芯線と同格の扱い）。
    const isBeamAxis = centerLineKind(cl) === 'beam';
    if (isBeamAxis && appMode !== 'structure') return null;

    // 意匠系CL（中心線・補助線。labeled:false かつ discipline:'arch'）は逆に構造モードでは表示しない
    // ——構造モードは梁芯（壁由来の自動生成含む）に一本化し、意匠CLを目印に使わせない設計。
    // データ（CenterLine実体）は残したまま描画だけスキップする（削除ではない。既存規律どおり）。
    const isArchCL = !cl.labeled && cl.discipline === Discipline.ARCH;
    if (isArchCL && appMode === 'structure') return null;

    const ext = clExtent(cl, graph, viewport, width, height);
    const [p1, p2] = ext ?? (isV ? [b.yMin, b.yMax] : [b.xMin, b.xMax]);
    const points = isV
      ? [cl.effectiveValue, p1, cl.effectiveValue, p2]
      : [p1, cl.effectiveValue, p2, cl.effectiveValue];

    // 補助線（labeled=false かつ lineType='dashed' で識別）は実線で描画
    const isAux = !cl.labeled && cl.lineType === 'dashed';

    return (
      <Line
        key={cl.id}
        points={points}
        stroke={cl.labeled || isBeamAxis ? '#3b82f6' : '#64748b'}
        strokeWidth={viewport.lineWeightsPx.thin}
        dash={isAux ? undefined : [12, 4, 2, 4]}
        strokeScaleEnabled={false}
        listening={false}
        opacity={cl.labeled || isBeamAxis ? 1 : 0.5}
      />
    );
  });

  if (!columnAxisMode) return clLines;

  const axisLines = [...graph.gridXs, ...graph.gridYs].flatMap(cl => {
    const off = graph.columnAxisOffsets.get(cl.id) ?? 0;
    if (off === 0) return [];
    const isV = cl.centerLineType === CenterLineType.VERTICAL;
    // 寸法線の足を別途引かない代わりに、軸線自体をガター内の○「柱芯」ラベル中心まで伸ばす
    // （通り芯が丸ラベル中心まで伸びるのと同じ。isV: TOP/BOTTOM、!isV: LEFT/RIGHT のラベル座標。
    //  片方でも欠ける場合は clExtent にフォールバック）。
    const fallback = clExtent(cl, graph, viewport, width, height);
    const lo = (isV ? axisLineCoords?.top    : axisLineCoords?.left)  ?? fallback?.[0];
    const hi = (isV ? axisLineCoords?.bottom : axisLineCoords?.right) ?? fallback?.[1];
    if (lo == null || hi == null) return [];
    const v = cl.effectiveValue + off;
    const points = isV ? [v, lo, v, hi] : [lo, v, hi, v];
    return [
      <Line
        key={`saxis-${cl.id}`}
        points={points}
        stroke="#3b82f6"
        strokeWidth={viewport.lineWeightsPx.thin}
        dash={[12, 4, 2, 4]}
        strokeScaleEnabled={false}
        listening={false}
      />,
    ];
  });

  return [...clLines, ...axisLines];
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
