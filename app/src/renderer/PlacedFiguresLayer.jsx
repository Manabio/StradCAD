import { observer } from 'mobx-react-lite';
import { Group, Line, Rect } from 'react-konva';
import { PLACED_FIGURE_MISSING_MARK_PX } from '../core/constants.js';
import { overlayGeneration } from '../catalog/catalogRegistry.js';
import { detailFigureEntry } from '../openings/openingCatalog.js';
import { MEMBER_SELECTION_COLOR } from '../structural/memberSelection.js';
import { placedFigureDrawPlan } from './placedFigureDrawPlan.js';
import { PLAN_SOLIDS_COLOR } from './PlanSolidsLayer.jsx';
import { DASH_DASHED } from './dashPhase.js';
import { graphComputed } from './graphDerived.js';

/**
 * 姿図の配置（graph.placedFigures）を平面（見下げ）・天伏（見上げ）に描くだけのレイヤー。
 * 図形の判断（回転・鏡像・見上げの絞り・views.ceiling の優先・解決失敗の印）は純モジュール renderer/placedFigureDrawPlan.js。
 * 図の解決は詳細図カタログ（detailFigureEntry）。カタログの世代（overlayGeneration）を鍵に入れて、差し替えに追従する。
 * 全 LOD で描く。線は strokeScaleEnabled=false・px 値、解決できない配置は配置点の×（半幅は画面 px 一定）。
 * selectedId に一致する配置があればその外接に選択枠を描く（仕上げモード・図面モードが SceneLayers から渡す）。
 * subjects: 図面モードが扱う分類（null＝絞らない。分類不明の配置は絞っても出る＝placedFigureDrawPlan の規則）。
 * 計画のキャッシュ鍵に subjects を含める（含めないと、絞りの違うモードが前のモードの計画を使い回す）。
 */
export const PlacedFiguresLayer = observer(({ graph, viewport, direction = 'down', selectedId = null, subjects = null }) => {
  if (!graph) return null;
  const plan = graphComputed(graph, `placedFigures:${direction}:${String(subjects)}:${overlayGeneration()}`, () => placedFigureDrawPlan(graph.placedFigures, detailFigureEntry, { direction, subjects }));
  if (plan.lines.length === 0 && plan.marks.length === 0) return null;
  const half = PLACED_FIGURE_MISSING_MARK_PX / viewport.scaleX;
  const selected = selectedId === null ? null : plan.boxes.find(b => b.figureId === selectedId) ?? null;
  return (
    <Group name="placed-figures" listening={false}>
      {plan.lines.map(l => (
        <Line
          key={l.key}
          points={l.points}
          stroke={PLAN_SOLIDS_COLOR}
          strokeWidth={viewport.lineWeightsPx[l.weight]}
          dash={l.dashed ? DASH_DASHED : undefined}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
      {plan.marks.flatMap(m => [
        [`${m.figureId}:x1`, [m.x - half, m.y - half, m.x + half, m.y + half]],
        [`${m.figureId}:x2`, [m.x - half, m.y + half, m.x + half, m.y - half]],
      ].map(([key, points]) => (
        <Line
          key={key}
          points={points}
          stroke={PLAN_SOLIDS_COLOR}
          strokeWidth={viewport.lineWeightsPx.thin}
          strokeScaleEnabled={false}
          listening={false}
        />
      )))}
      {selected && (
        <Rect
          x={selected.minX}
          y={selected.minY}
          width={selected.maxX - selected.minX}
          height={selected.maxY - selected.minY}
          stroke={MEMBER_SELECTION_COLOR}
          strokeWidth={viewport.lineWeightsPx.thin}
          strokeScaleEnabled={false}
          listening={false}
        />
      )}
    </Group>
  );
});
