import { Rect, Line } from 'react-konva';

export function AxisRulerLayer({ width, height, gutter }) {
  const fill   = '#f5f5f0';

  return (
    <>
      <Rect x={0} y={0} width={width} height={gutter} fill={fill} listening={false} />
      <Rect x={0} y={gutter} width={gutter} height={height - 2 * gutter} fill={fill} listening={false} />
      <Rect x={width - gutter} y={gutter} width={gutter} height={height - 2 * gutter} fill={fill} listening={false} />
      <Rect x={0} y={height - gutter} width={width} height={gutter} fill={fill} listening={false} />
    </>
  );
}
