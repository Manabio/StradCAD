import { observer } from 'mobx-react-lite';
import { Line, Circle, Group } from 'react-konva';
import { siteTransformGroupProps } from '../site/sitePlacementView.js';
import {
  SITE_LINE_COLOR, SITE_BOUNDARY_DASH, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT, siteLineWeightKey,
} from '../site/siteLineStyle.js';
import { layoutSitePlacementGrid } from '../site/sitePlacementGrid.js';
import {
  SITE_PLACEMENT_ROOF_LINE_WEIGHT, SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY, SITE_PLACEMENT_GRID_LINE_WEIGHT,
  GRID_DIM_COLOR, GRID_DIM_DOT_RADIUS_PX,
} from '../core/constants.js';
import { PLAN_SOLIDS_COLOR } from './PlanSolidsLayer.jsx';
import { originColor } from './canvasStyle.js';
import { DIMENSION_LINE_WEIGHT, NUM_FONT_PX, TEXT_GAP_PX, gridLineDash } from './dimensionStyle.js';
import { labelCircle, dimensionRow } from './gutterPrimitives.jsx';

// 敷地モードの配置図（site/sitePlacementView.js の composeSitePlacementView の結果を写すだけ。判断は純モジュール側）。
// 屋根伏せ図の線・通り芯（線・寸法・丸ラベル。site/sitePlacementGrid.js が画面 px の離れを世界座標へ直す）は世界座標、
// 敷地の外周は図芯合わせの変換（siteTransformGroupProps）を掛けた Group の中。表示専用（listening しない）。
export const SitePlacementLayer = observer(({ view, viewport }) => {
  const markR = SITE_CORNER_MARK_RADIUS_PX / viewport.scaleX; // 外周の角の丸の半径（SiteLinesLayer と同じ式）
  const siteWidth = viewport.lineWeightsPx[siteLineWeightKey(true, false)];
  const g = layoutSitePlacementGrid(view.grid, viewport.scaleX);
  const gridLineWidth = viewport.lineWeightsPx[SITE_PLACEMENT_GRID_LINE_WEIGHT];
  const dimDotR = GRID_DIM_DOT_RADIUS_PX / viewport.scaleX;
  return (
    <>
      {g.lines.map(l => (
        <Line
          key={l.key}
          points={l.points}
          stroke={originColor(SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY)}
          strokeWidth={gridLineWidth}
          dash={gridLineDash(gridLineWidth)}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
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
      {g.rows.flatMap(row => {
        const { line, labels } = dimensionRow({
          keyBase: row.key, axis: row.axis, side: row.side, lineCoord: row.lineCoord, normalNumCoord: row.normalNumCoord,
          segments: row.segments, color: GRID_DIM_COLOR, strokeWidth: viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT],
          fontSize: NUM_FONT_PX / viewport.scaleX, gap: TEXT_GAP_PX / viewport.scaleX,
        });
        return [
          line,
          ...row.dots.map(d => (
            <Circle key={d.key} x={d.x} y={d.y} radius={dimDotR} fill={GRID_DIM_COLOR} listening={false} />
          )),
          ...labels,
        ];
      })}
      {g.labels.flatMap(l => labelCircle(l.key, l.x, l.y, l.label, viewport))}
    </>
  );
});
