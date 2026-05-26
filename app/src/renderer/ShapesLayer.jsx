import { observer } from 'mobx-react-lite';
import { Line, Circle, Path } from 'react-konva';
import { ShapeType } from '@core';

const DASH = {
  solid:     undefined,
  dashed:    [8, 4],
  center:    [12, 4, 2, 4],
  dimension: [4, 4],
};

// lineWeight(mm) をワールド空間の strokeWidth に変換
// 最低でもスクリーン上 1px 相当を確保する
function resolveStrokeWidth(lineWeight, scale) {
  const minWorld = 1 / scale; // 1px 相当のワールド mm
  return Math.max(minWorld, lineWeight);
}

function strokeProps(shape, scaleX, scaleY) {
  return {
    stroke:      shape.color,
    strokeWidth: resolveStrokeWidth(shape.lineWeight, Math.min(scaleX, scaleY)),
    dash:        DASH[shape.lineType],
    listening:   false,
  };
}

// SVG arc パス文字列 (ワールド座標 mm)
function arcPathD(cx, cy, radius, startAngleDeg, includedAngleDeg) {
  const toRad = (d) => (d * Math.PI) / 180;
  const sa    = toRad(startAngleDeg);
  const ea    = toRad(startAngleDeg + includedAngleDeg);
  const x1    = cx + radius * Math.cos(sa);
  const y1    = cy + radius * Math.sin(sa);
  const x2    = cx + radius * Math.cos(ea);
  const y2    = cy + radius * Math.sin(ea);
  const large = Math.abs(includedAngleDeg) > 180 ? 1 : 0;
  const sweep = includedAngleDeg > 0 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} ${sweep} ${x2} ${y2}`;
}

export const ShapesLayer = observer(({ graph, viewport }) => {
  if (!graph) return null;
  const { scaleX, scaleY } = viewport;

  return graph.generalShapes.map((shape) => {
    const sp = strokeProps(shape, scaleX, scaleY);

    switch (shape.type) {

      case ShapeType.VERTICAL:
        return (
          <Line
            key={shape.id}
            points={[shape.x, shape.y1, shape.x, shape.y2]}
            {...sp}
          />
        );

      case ShapeType.HORIZONTAL:
        return (
          <Line
            key={shape.id}
            points={[shape.x1, shape.y, shape.x2, shape.y]}
            {...sp}
          />
        );

      case ShapeType.DIAGONAL:
        return (
          <Line
            key={shape.id}
            points={[shape.nodeA.x, shape.nodeA.y, shape.nodeB.x, shape.nodeB.y]}
            {...sp}
          />
        );

      case ShapeType.WALL:
        return (
          <Line
            key={shape.id}
            points={shape.isVertical
              ? [shape.axisValue, shape.coord1, shape.axisValue, shape.coord2]
              : [shape.coord1, shape.axisValue, shape.coord2, shape.axisValue]
            }
            {...sp}
          />
        );

      case ShapeType.ARC:
        return (
          <Path
            key={shape.id}
            data={arcPathD(
              shape.center.x, shape.center.y,
              shape.radius,
              shape.startAngle,
              shape.includedAngle,
            )}
            fill="transparent"
            {...sp}
          />
        );

      case ShapeType.CIRCLE:
        return (
          <Circle
            key={shape.id}
            x={shape.center.x}
            y={shape.center.y}
            radius={shape.radius}
            fill="transparent"
            {...sp}
          />
        );

      default:
        return null;
    }
  });
});
