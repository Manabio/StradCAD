import { Rect } from 'react-konva';

export function AxisRulerLayer({ width, height, gutter, gutterBottom = gutter }) {
  const fill = '#f5f5f0';

  return (
    <>
      <Rect x={0} y={0} width={width} height={gutter} fill={fill} listening={false} />
      <Rect x={0} y={gutter} width={gutter} height={height - gutter - gutterBottom} fill={fill} listening={false} />
      <Rect x={width - gutter} y={gutter} width={gutter} height={height - gutter - gutterBottom} fill={fill} listening={false} />
      <Rect x={0} y={height - gutterBottom} width={width} height={gutterBottom} fill={fill} listening={false} />
    </>
  );
}
