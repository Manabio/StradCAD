import { Circle, Line } from 'react-konva';

const RADIUS     = 8;   // px
const CROSS_ARM  = 5;   // px (円の外に延びるアーム)
const COLOR      = '#2563eb';
const STROKE_W   = 1.5;

/**
 * スナップ位置に十字付き円を描画する (スクリーン空間)
 *
 * @param {Intersection|null} snap      スナップ先の交点
 * @param {Viewport}          viewport
 */
export function SnapIndicator({ snap, viewport }) {
  if (!snap) return null;

  const { x, y } = viewport.worldToScreen(snap.x, snap.y);
  const arm = RADIUS + CROSS_ARM;

  return (
    <>
      {/* 外円 */}
      <Circle
        x={x} y={y}
        radius={RADIUS}
        stroke={COLOR}
        strokeWidth={STROKE_W}
        fill="transparent"
        listening={false}
      />
      {/* 水平アーム */}
      <Line
        points={[x - arm, y, x - RADIUS, y]}
        stroke={COLOR} strokeWidth={STROKE_W} listening={false}
      />
      <Line
        points={[x + RADIUS, y, x + arm, y]}
        stroke={COLOR} strokeWidth={STROKE_W} listening={false}
      />
      {/* 垂直アーム */}
      <Line
        points={[x, y - arm, x, y - RADIUS]}
        stroke={COLOR} strokeWidth={STROKE_W} listening={false}
      />
      <Line
        points={[x, y + RADIUS, x, y + arm]}
        stroke={COLOR} strokeWidth={STROKE_W} listening={false}
      />
    </>
  );
}
