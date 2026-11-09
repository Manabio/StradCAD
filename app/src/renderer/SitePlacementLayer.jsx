import { observer } from 'mobx-react-lite';
import { Line, Circle, Group } from 'react-konva';
import { siteTransformGroupProps } from '../site/sitePlacementView.js';
import {
  SITE_LINE_COLOR, SITE_BOUNDARY_DASH, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT, siteLineWeightKey,
} from '../site/siteLineStyle.js';
import { SITE_PLACEMENT_ROOF_LINE_WEIGHT } from '../core/constants.js';
import { PLAN_SOLIDS_COLOR } from './PlanSolidsLayer.jsx';

// 敷地モードの配置図（site/sitePlacementView.js の composeSitePlacementView の結果を写すだけ。判断は純モジュール側）。
// 屋根伏せ図の線は世界座標、敷地の外周は図芯合わせの変換（siteTransformGroupProps）を掛けた Group の中。表示専用（listening しない）。
export const SitePlacementLayer = observer(({ view, viewport }) => {
  const markR = SITE_CORNER_MARK_RADIUS_PX / viewport.scaleX; // 外周の角の丸の半径（SiteLinesLayer と同じ式）
  const siteWidth = viewport.lineWeightsPx[siteLineWeightKey(true, false)];
  return (
    <>
      {view.roofLines.map(l => (
        <Line
          key={`rf-${l.key}`}
          points={l.points}
          closed={l.closed}
          stroke={PLAN_SOLIDS_COLOR}
          strokeWidth={viewport.lineWeightsPx[SITE_PLACEMENT_ROOF_LINE_WEIGHT]}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
      <Group {...siteTransformGroupProps(view.siteTransform)} listening={false}>
        {view.siteSegments.map(s => (
          <Line
            key={`sg-${s.key}`}
            points={s.points}
            stroke={SITE_LINE_COLOR}
            strokeWidth={siteWidth}
            dash={[...SITE_BOUNDARY_DASH]}
            strokeScaleEnabled={false}
            listening={false}
          />
        ))}
        {view.siteCorners.map(c => (
          <Circle
            key={`sc-${c.key}`}
            x={c.x} y={c.y}
            radius={markR}
            stroke={SITE_LINE_COLOR}
            strokeWidth={viewport.lineWeightsPx[SITE_CORNER_MARK_WEIGHT]}
            strokeScaleEnabled={false}
            listening={false}
          />
        ))}
      </Group>
    </>
  );
});
