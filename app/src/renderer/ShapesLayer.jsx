import { observer } from 'mobx-react-lite';
import { Line, Rect, Circle, Path } from 'react-konva';
import { ShapeType } from '@core';
import { findOpeningsOnWall } from '../openings/openingGeometry.js';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';

const DASH = {
  solid:     undefined,
  dashed:    [8, 4],
  center:    [12, 4, 2, 4],
  dimension: [4, 4],
};

// 壁下地（間柱）のピッチ表現(mm)。LOD詳細描画でのみ使用。
const WALL_BACKING_PITCH = 450;
// 壁下地の角材を通り芯方向に描く際の見かけ幅(mm)。実材の長手方向寸法は壁データに
// 持たないため、間柱の標準的な厚み（□-90×45 の 45 側）を描画上の固定値として使う。
const WALL_STUD_WIDTH = 45;

function strokeProps(shape, scaleX, scaleY) {
  return {
    stroke:      shape.color,
    strokeWidth: resolveStrokeWidth(shape.lineWeight, Math.min(scaleX, scaleY)),
    dash:        DASH[shape.lineType],
    listening:   false,
  };
}

// SVG arc パス文字列 (ワールド座標 mm)
export function arcPathD(cx, cy, radius, startAngleDeg, includedAngleDeg) {
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
  const { scaleX, scaleY, lodLevel } = viewport;

  // 下地（間柱）描画の重複防止: 同一axisCL上で範囲が重なる正負オフセットの壁ペア
  // （部屋境界の内外両側）は通り芯上の同じ構造材を指すため、正(+)側のみ描画する。
  const deferredBackingIds = new Set();
  if (lodLevel === LodLevel.DETAIL) {
    const wallShapes = graph.generalShapes.filter(s => s.type === ShapeType.WALL && s.wallFinish != null);
    for (const w of wallShapes) {
      if (w.axisOffset >= 0) continue;
      const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
      const hasPositiveOverlap = wallShapes.some(o =>
        o !== w && o.axisCL === w.axisCL && o.axisOffset > 0 &&
        Math.min(o.coord1, o.coord2) < wHi && Math.max(o.coord1, o.coord2) > wLo,
      );
      if (hasPositiveOverlap) deferredBackingIds.add(w.id);
    }
  }

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

      case ShapeType.WALL: {
        // ホストされた開口がある区間を除いた複数の区間に分割する
        const openings = findOpeningsOnWall(shape, graph)
          .slice().sort((a, b) => a.coord1 - b.coord1);
        const lo = Math.min(shape.coord1, shape.coord2), hi = Math.max(shape.coord1, shape.coord2);
        const segments = [];
        let cursor = lo;
        for (const o of openings) {
          if (o.coord1 > cursor) segments.push([cursor, o.coord1]);
          cursor = Math.max(cursor, o.coord2);
        }
        if (cursor < hi) segments.push([cursor, hi]);

        if (lodLevel === LodLevel.SCHEMATIC) {
          // 略図: 軸オフセット位置の単線（厚み表現なし）
          return segments.map(([a, b], i) => (
            <Line
              key={`${shape.id}:${i}`}
              points={shape.isVertical
                ? [shape.axisValue, a, shape.axisValue, b]
                : [a, shape.axisValue, b, shape.axisValue]
              }
              {...sp}
            />
          ));
        }

        // 標準・詳細: 軸CL(柱芯) 〜 face(仕上げ面) の帯で実厚を表現
        // 中心線(axisV)は CenterLinesLayer が別途描画するため、ここでは重複させない
        // （仕上げ面の長辺 + 両端の妻線のみを描き、軸CL上の長辺は描かない）
        const axisV = shape.axisCL.effectiveValue;
        const faceV = shape.axisValue;
        const thickLo = Math.min(axisV, faceV), thickHi = Math.max(axisV, faceV);
        const rects = segments.flatMap(([a, b], i) => [
          <Line
            key={`${shape.id}:face:${i}`}
            points={shape.isVertical
              ? [faceV, a, faceV, b]
              : [a, faceV, b, faceV]
            }
            {...sp}
          />,
          <Line
            key={`${shape.id}:capA:${i}`}
            points={shape.isVertical
              ? [axisV, a, faceV, a]
              : [a, axisV, a, faceV]
            }
            {...sp}
          />,
          <Line
            key={`${shape.id}:capB:${i}`}
            points={shape.isVertical
              ? [axisV, b, faceV, b]
              : [b, axisV, b, faceV]
            }
            {...sp}
          />,
        ]);

        // 詳細のみ: 仕上げ面〜下地境界の平行線 + 下地（間柱断面）450mmピッチ配置
        // wallFinish は generateRoomWallsFromOutline/generateExteriorWalls 生成時のみ確定（手動壁は null）
        if (lodLevel !== LodLevel.DETAIL || shape.wallFinish == null) {
          return rects;
        }

        const elems = [...rects];

        if (shape.wallFinish > 0 && shape.wallFinish < thickHi - thickLo) {
          const boundary = faceV >= axisV ? thickHi - shape.wallFinish : thickLo + shape.wallFinish;
          elems.push(...segments.map(([a, b], i) => (
            <Line
              key={`${shape.id}:fin:${i}`}
              points={shape.isVertical
                ? [boundary, a, boundary, b]
                : [a, boundary, b, boundary]
              }
              {...sp}
            />
          )));
        }

        // 下地（間柱）断面: 通り芯(axisCL)上に左右対称に乗る実材厚 = (thickHi-thickLo-wallFinish)*2
        const backingDepth = 2 * (thickHi - thickLo - shape.wallFinish);
        if (backingDepth > 0 && !deferredBackingIds.has(shape.id)) {
          const halfDepth = backingDepth / 2, halfWidth = WALL_STUD_WIDTH / 2;
          for (const [a, b] of segments) {
            let p = lo + Math.ceil((a - lo) / WALL_BACKING_PITCH) * WALL_BACKING_PITCH;
            if (p - halfWidth < a) p += WALL_BACKING_PITCH;
            for (; p + halfWidth <= b; p += WALL_BACKING_PITCH) {
              elems.push(
                <Rect
                  key={`${shape.id}:stud:${p}`}
                  x={shape.isVertical ? axisV - halfDepth : p - halfWidth}
                  y={shape.isVertical ? p - halfWidth : axisV - halfDepth}
                  width={shape.isVertical ? backingDepth : WALL_STUD_WIDTH}
                  height={shape.isVertical ? WALL_STUD_WIDTH : backingDepth}
                  fill="transparent"
                  stroke={sp.stroke}
                  strokeWidth={sp.strokeWidth}
                  listening={false}
                />,
              );
            }
          }
        }

        return elems;
      }

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
