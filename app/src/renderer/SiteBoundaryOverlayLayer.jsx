import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text } from 'react-konva';
import { composeSiteBoundaryOverlay } from '../site/sitePlacementView.js';
import { siteTransformGroupProps } from '../site/siteTransform.js';
import {
  SITE_LINE_COLOR, SITE_BOUNDARY_LABEL_BOX_PX, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT, siteLineWeightKey,
} from '../site/siteLineStyle.js';
import { NUM_FONT_PX } from './dimensionStyle.js';

// 他モード（平面・仕上げ・天伏・構造）の 1 階（相当）へ重ねる敷地の境界線（site/sitePlacementView.js composeSiteBoundaryOverlay の結果を写すだけ）。
// 境界線（実線の小区間）・角の丸は配置の変換 Group の中（敷地座標）、境界線ラベルは Group の外（配置図座標）。
// 通り芯寸法・はなれ寸法・頂点番号は描かない。すべて listening しない（当たりなし＝平面の操作を妨げない）。
// 配置の指定（site.placement）が無ければ何も描かない。出し入れ（モード・階）は SceneLayers が決める。
export const SiteBoundaryOverlayLayer = observer(({ site, viewport }) => {
  const overlay = composeSiteBoundaryOverlay({ site, scale: viewport.scaleX });
  if (!overlay) return null;
  const markR = SITE_CORNER_MARK_RADIUS_PX / viewport.scaleX;
  const numFontSize = NUM_FONT_PX / viewport.scaleX;
  const boundaryBoxW = SITE_BOUNDARY_LABEL_BOX_PX / viewport.scaleX;
  const lineWidth = viewport.lineWeightsPx[siteLineWeightKey(true, false)];
  return (
    <>
      <Group {...siteTransformGroupProps(overlay.transform)} listening={false}>
        {overlay.chains.flatMap(c => c.runs.map((run, i) => (
          <Line
            key={`oc-${c.key}/${i}`}
            points={run.points}
            stroke={SITE_LINE_COLOR}
            strokeWidth={lineWidth}
            strokeScaleEnabled={false}
            listening={false}
          />
        )))}
        {overlay.corners.map(c => (
          <Circle
            key={`oh-${c.key}`}
            x={c.x} y={c.y}
            radius={markR}
            stroke={SITE_LINE_COLOR}
            strokeWidth={viewport.lineWeightsPx[SITE_CORNER_MARK_WEIGHT]}
            strokeScaleEnabled={false}
            listening={false}
          />
        ))}
      </Group>
      {overlay.labels.map(l => (
        <Text
          key={`ot-${l.key}`}
          x={l.x} y={l.y}
          rotation={l.rotation}
          text={l.text}
          fontSize={numFontSize}
          fill={SITE_LINE_COLOR}
          width={boundaryBoxW}
          offsetX={boundaryBoxW / 2}
          offsetY={numFontSize}
          align="center"
          listening={false}
        />
      ))}
    </>
  );
});
