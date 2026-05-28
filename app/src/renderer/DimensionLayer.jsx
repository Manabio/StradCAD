import { observer } from 'mobx-react-lite';
import { Line, Circle, Text } from 'react-konva';
import { DimensionKind, DimensionSide } from '@core';

// ガター内 寸法線レイヤー — GRID 寸法線のみ描画
//
// 配置 (各辺):
//   TOP    — 数字: gutter - NUM_INSET (上)   線: gutter - LINE_INSET (下)
//   BOTTOM — 数字: gutterBottom - B_NUM_INSET (上)  線: gutterBottom - B_LINE_INSET (下)
//   LEFT   — 線: gutter - LINE_INSET  数字: gutter - NUM_INSET (外側)
//   RIGHT  — 数字: w - gutter + LINE_INSET (内側)  線: w - gutter + NUM_INSET (外側)
//
// BOTTOM レイアウト (gutterBottom=56, gutter=48):
//   [内端] 数字中心:+8px 線:+14px [CL丸top:+18px CL丸center:+30px] [外端]
const LINE_INSET   = 4;   // 上・左右: 線のガター内端からの距離 (px)
const NUM_INSET    = 12;  // 上・左右: 数字中心のガター内端からの距離 (px)
const B_NUM_INSET  = 8;   // 下: 数字中心のガター内端からの距離 (px)
const B_LINE_INSET = 14;  // 下: 線のガター内端からの距離 (px)
const DOT_RADIUS   = 3;
const NUM_FONT     = 11;
const NUM_COLOR    = '#475569';
const LINE_COLOR   = '#475569';

export const DimensionLayer = observer(({ graph, viewport, width, height, gutter, gutterBottom = gutter }) => {
  if (!graph) return null;

  return graph.dimensionLines.flatMap(d => {
    if (d.dimensionKind !== DimensionKind.GRID) return [];
    const segs = d.segments;
    if (segs.length === 0) return [];

    if (d.axis === 'X') {
      // 横並び寸法 — 上下ガター
      const isTop = d.side === DimensionSide.TOP;
      // TOP: 数字(上)→線(下) / BOTTOM: gutterBottom 基準で数字(上)→線(下)
      const lineY = isTop ? gutter - LINE_INSET : height - gutterBottom + B_LINE_INSET;
      const numY  = isTop ? gutter - NUM_INSET  : height - gutterBottom + B_NUM_INSET;

      const anchors = d.effectiveAnchors;
      const xs = anchors.map(a => a.value * viewport.scaleX + viewport.offsetX);
      const xMin = xs[0];
      const xMax = xs[xs.length - 1];

      const els = [];
      // 長い基準線
      els.push(
        <Line key={`${d.id}-line`} points={[xMin, lineY, xMax, lineY]}
          stroke={LINE_COLOR} strokeWidth={1} listening={false} />
      );
      // 塗りつぶし丸 (各 CL 位置)
      xs.forEach((x, i) => els.push(
        <Circle key={`${d.id}-dot-${i}`} x={x} y={lineY} radius={DOT_RADIUS}
          fill={LINE_COLOR} listening={false} />
      ));
      // 数字 (セグメント中点)
      segs.forEach((seg, i) => {
        const sx1 = xs[i];
        const sx2 = xs[i + 1];
        els.push(
          <Text key={`${d.id}-num-${i}`}
            x={sx1} y={numY - NUM_FONT / 2}
            width={sx2 - sx1} align="center"
            text={String(seg.length)} fontSize={NUM_FONT}
            fill={NUM_COLOR} listening={false} />
        );
      });
      return els;
    }

    if (d.axis === 'Y') {
      // 縦並び寸法 — 左右ガター
      const isLeft = d.side === DimensionSide.LEFT;
      // 左: 線=内側(drawing寄り)、数字=外側 / 右: 数字=内側、線=外側(screen端寄り)
      const lineX = isLeft ? gutter - LINE_INSET : width - gutter + NUM_INSET;
      const numX  = isLeft ? gutter - NUM_INSET  : width - gutter + LINE_INSET;

      const anchors = d.effectiveAnchors;
      const ys = anchors.map(a => a.value * viewport.scaleY + viewport.offsetY);
      const yMin = Math.min(...ys);
      const yMax = Math.max(...ys);

      const els = [];
      // 長い基準線
      els.push(
        <Line key={`${d.id}-line`} points={[lineX, yMin, lineX, yMax]}
          stroke={LINE_COLOR} strokeWidth={1} listening={false} />
      );
      // 塗りつぶし丸 (各 CL 位置)
      ys.forEach((y, i) => els.push(
        <Circle key={`${d.id}-dot-${i}`} x={lineX} y={y} radius={DOT_RADIUS}
          fill={LINE_COLOR} listening={false} />
      ));
      // 数字 (セグメント中点、rotation=-90 で下→上読み = 左向き表示)
      segs.forEach((seg, i) => {
        const sy1 = ys[i];
        const sy2 = ys[i + 1];
        const yA = Math.min(sy1, sy2);
        const yB = Math.max(sy1, sy2);
        // rotation=-90: local-x が screen 上方向(-y) に向くため、origin を yB に置き yA まで伸ばす
        els.push(
          <Text key={`${d.id}-num-${i}`}
            x={numX - NUM_FONT / 2} y={yB}
            width={yB - yA} align="center"
            text={String(seg.length)} fontSize={NUM_FONT}
            fill={NUM_COLOR} rotation={-90} listening={false} />
        );
      });
      return els;
    }

    return [];
  });
});
