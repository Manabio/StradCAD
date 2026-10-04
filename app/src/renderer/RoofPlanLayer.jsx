import { observer } from 'mobx-react-lite';
import { Group, Line } from 'react-konva';
import { roofPlanFigure, visibleRoofPlanPrimitives } from '../finish/roof/roofPlanFigure.js';
import { graphComputed } from './graphDerived.js';

const ROOF_PLAN_COLOR = '#1e293b'; // 階段・吹抜けと同じ線色

/**
 * 下屋の平面表示（軒先の線・棟木・隅木・谷木の細い実線）。図形の判断は finish/roof/roofPlanFigure.js（純モジュール）で、
 * ここは Konva 要素へ写すだけ（表示するモードの判断は SceneLayers の showPlanFigure）。
 * 図形は graph 単位に memo する（graphComputed。実装方針9）。LOD は memo の外で絞る（キーに符号化しないため）。
 * 線幅は VoidLayer と同方式（strokeScaleEnabled=false・px 値をそのまま渡す）。
 */
export const RoofPlanLayer = observer(({ graph, viewport }) => {
  if (!graph) return null;
  const prims = visibleRoofPlanPrimitives(graphComputed(graph, 'roofPlanFigure', () => roofPlanFigure(graph)), viewport.lodLevel);
  if (prims.length === 0) return null;
  return (
    <Group name="roof-plan" listening={false}>
      {prims.map(p => (
        <Line
          key={p.key}
          points={p.points}
          closed={p.closed}
          stroke={ROOF_PLAN_COLOR}
          strokeWidth={viewport.lineWeightsPx.thin}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
    </Group>
  );
});
