import { Line } from 'react-konva';

export function DrawPreview({ drawState, snapPoint, cursorWorld }) {
  if (!drawState) return null;

  const { mode, startSnap, startWorld } = drawState;
  const sx = startSnap?.x ?? startWorld?.x;
  const sy = startSnap?.y ?? startWorld?.y;
  if (sx == null || sy == null) return null;

  const ex = snapPoint?.x ?? cursorWorld?.x ?? sx;
  const ey = snapPoint?.y ?? cursorWorld?.y ?? sy;

  if (mode !== 'diag') return null;
  const points = [sx, sy, ex, ey];

  return (
    <Line
      points={points}
      stroke="#2563eb"
      strokeWidth={1}
      dash={[8, 4]}
      strokeScaleEnabled={false}
      listening={false}
    />
  );
}
