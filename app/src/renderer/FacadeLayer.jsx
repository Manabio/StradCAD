import { observer } from 'mobx-react-lite';
import { Group, Text } from 'react-konva';
import { viewport } from '../appViewport.js';
import { scaleLabel } from '../structural/sectionFigure/sectionGeometry.js';
import { makeElevationTransform } from '../elevation/elevationLayout.js';
import { renderFigurePrimitives } from './figurePrimitivesKonva.jsx';
import { SCALE_LABEL_RIGHT_PX, SCALE_LABEL_BOTTOM_PX, SCALE_LABEL_FONT_PX, SCALE_LABEL_COLOR } from '../elevation/elevationStyle.js';

// ================================================================
// 立面モード（外壁立面図4面）の描画本体。mode.scale/mode.layout（=FacadeModeState、固定倍率・縦の積み）
// だけを見て描く。viewport.scaleX/offsetX は一切参照しない（ズームなし。ElevationLayer.jsx と同じ不変条件）。
// lineWeightsPx（校正値ベースの固定px）だけは viewport から借りる。
// ================================================================
export const FacadeLayer = observer(({ mode, size }) => {
  if (!mode || mode.loading || !size) return null;

  const scale = mode.scale;
  if (!(scale > 0)) return null;
  const viewHeightMm = size.height / scale;
  const scrollY = mode.clampedScrollY;
  const facesByDirection = new Map(mode.faces.map(f => [f.direction, f]));
  const screenPxPerMm = (viewport.pxPerMmX + viewport.pxPerMmY) / 2;
  const renderOpts = { lineWeightsPx: viewport.lineWeightsPx, screenPxPerMm };

  return (
    <>
      {mode.layout.placements.map(pl => {
        const face = facesByDirection.get(pl.direction);
        if (!face) return null;
        const top = pl.topMm - scrollY;
        if (!(top + pl.heightMm > 0 && top < viewHeightMm)) return null; // 画面外の面は描かない
        const t = makeElevationTransform(scale, pl.originXMm * scale, (pl.originYMm - scrollY) * scale);
        return (
          <Group key={pl.direction}>
            {renderFigurePrimitives(face.primitives, t, renderOpts)}
          </Group>
        );
      })}
      <Text
        x={size.width - SCALE_LABEL_RIGHT_PX} y={size.height - SCALE_LABEL_BOTTOM_PX}
        text={scaleLabel(scale)} fontSize={SCALE_LABEL_FONT_PX} fill={SCALE_LABEL_COLOR} listening={false}
      />
    </>
  );
});
