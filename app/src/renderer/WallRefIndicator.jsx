import { Text } from 'react-konva';
import { centerLineKind } from '@core';
import { circleRefSymbol } from '../ui/circleRef.js';

// 梁芯（centerLineKind==='beam'）は梁芯線と同じ青（CenterLinesLayer.jsx参照）、それ以外は従来の赤のまま。
const BEAM_COLOR   = '#3b82f6';
const DEFAULT_COLOR = '#ef4444';

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
        text={circleRefSymbol(i)}
        fontSize={22}
        fill={centerLineKind(cl) === 'beam' ? BEAM_COLOR : DEFAULT_COLOR}
        listening={false}
      />
    );
  });
}
