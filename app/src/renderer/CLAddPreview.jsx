import { Line } from 'react-konva';

const WORLD_BOUND = 50000;

export function CLAddPreview({ value, type }) {
  if (value == null) return null;

  const points = type === 'vertical'
    ? [value, -WORLD_BOUND, value, WORLD_BOUND]
    : [-WORLD_BOUND, value, WORLD_BOUND, value];

  return (
    <Line
      points={points}
      stroke="#2563eb"
      strokeWidth={1}
      dash={[12, 4, 2, 4]}
      strokeScaleEnabled={false}
      listening={false}
      opacity={0.6}
    />
  );
}
