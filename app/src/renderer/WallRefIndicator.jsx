import { Text } from 'react-konva';

const CIRCLE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

export function WallRefIndicator({ nearbyCLs, worldPos, viewport }) {
  return nearbyCLs.map((cl, i) => {
    const isV = cl.centerLineType === 'X';
    const wx  = isV ? cl.effectiveValue : worldPos.x;
    const wy  = isV ? worldPos.y       : cl.effectiveValue;
    const sx  = wx * viewport.scaleX + viewport.offsetX;
    const sy  = wy * viewport.scaleY + viewport.offsetY;
    return (
      <Text
        key={cl.id}
        x={sx - 11}
        y={sy - 11}
        text={CIRCLE_NUMS[i] ?? `(${i + 1})`}
        fontSize={22}
        fill="#ef4444"
        listening={false}
      />
    );
  });
}
