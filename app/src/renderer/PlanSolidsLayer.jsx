import { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { Group, Line, Text } from 'react-konva';
import { planSolidsLayerResolve, visiblePlanPrimitives } from '../plan/planSolidsLayerFilter.js';
import { planHoleMarksOf, planHoleMarkPrimitives } from '../plan/planHoleMarks.js';
import { floorOpeningGroups } from '../finish/stair/slabOpening.js';
import { stairRiserOf } from '../finish/stair/stairDimensions.js';
import { graphComputed } from './graphDerived.js';

const PLAN_SOLIDS_COLOR = '#1e293b'; // 階段・吹抜け・下屋と同じ線色

/**
 * 平面の「立体＋水平切断」で描く線とラベル。梁・汎用立体（S4）と下屋（S5。外形線・棟木・隅木・谷木と、詳細 LOD の傾斜ラベル＝
 * 水下向きの矢印・「屋根」・「（傾斜N/10）」）。切断高より下は細線の見えがかり、切断面をまたぐ梁は太線。柱・壁・床は既存レイヤが
 * 描くので、ここでは遮蔽物としてだけ解決に参加する（描く種別の集合は plan/planSolidsLayerFilter.js S4_DRAWN_KINDS）。
 * 下階の層（自階の床の穴の窓越し）は S6c から壁・柱・床も含む全種別を細線で描く（BELOW_DRAWN_KINDS。階段吹抜け内の下階の壁のうち StairLayer の隔て壁の輪郭と重なるのは一部〔実測 251 本中 8 本〕で、残りは今回はじめて見える線。段板は立体でないので段の下に隠れるはずの壁も描かれる〔S7b で解消〕。受容）。
 * 表示するモードの判断は SceneLayers の showPlanFigure。
 * 層は自階＋直下階（belowPeek。App.jsx が直下階を peek して渡す）。判断は純関数 planSolidsLayerResolve に集約:
 *   belowPeek の3状態（undefined＝未解決→自階だけで解いて描く／null＝下階なし／オブジェクト＝あり。upperStairEntries の null／[] と同じ作法）、
 *   通り芯ドラッグ中は前回の結果を描き続ける（毎フレームの全再計算を避ける。ref に前回の線を持つ）、
 *   それ以外は graphComputed で memo（置き場は直下階 peek の graph、鍵は自階×切断高×直下階）。
 * LOD は memo の外で viewport.lodLevel により絞る（visiblePlanPrimitives。ラベルは詳細だけ。memo の鍵に符号化しない）。
 * 線幅は strokeScaleEnabled=false・px 値をそのまま渡す。矢印は本体と矢じり（head）の2本の Line、文字は Text。
 * 吹抜け・昇降路の注記（S6）も描く（Group "plan-hole-marks"）: 自階の×（一点鎖線）と、直下階に描く上階吹抜けの×・外形・「上部吹抜け」（破線）。
 * 注記は穴（plan/planHoleMarks.js）から導く切断面上の記号で、遮蔽の解決は通さない。自階の×はドラッグ追従のため memo の外で毎回求め、
 * 上階の穴（abovePeek。App.jsx が上階を peek して渡す。3状態は belowPeek と同じ）は peek した graph に memo する。LOD はラベルだけ落とす。
 */
export const PlanSolidsLayer = observer(({ graph, project, viewport, belowPeek, abovePeek }) => {
  const prevRef = useRef(null); // { planeId, prims }: ドラッグ中に描き続ける前回の線（階が違えば使わない）
  if (!graph) return null;
  const resolved = planSolidsLayerResolve({
    graph, belowPeek, memo: graphComputed,
    prevPrims: prevRef.current?.planeId === graph.plane.id ? prevRef.current.prims : null,
    selfRiserOf: s => stairRiserOf(s, project, graph.plane),
  });
  if (resolved) prevRef.current = { planeId: graph.plane.id, prims: resolved };
  const prims = resolved ? visiblePlanPrimitives(resolved, viewport.lodLevel) : [];
  // 吹抜け・昇降路の注記（S6）。上階の穴は peek した graph（ドラッグで変わらない）に memo、自階の×は memo の外
  // （通り芯ドラッグ中も追従する。planHoleMarksOf）。自階と違う階の peek（階切替直後の1フレーム）は使わない。
  const aboveGroups = abovePeek?.activePlaneId === graph.plane.id
    ? graphComputed(abovePeek.graph, 'planHoleGroups', () => floorOpeningGroups(abovePeek.graph, { stairFilter: () => false }))
    : undefined;
  const holePrims = planHoleMarkPrimitives(planHoleMarksOf(graph, aboveGroups), {
    thickPx: viewport.lineWeightsPx.thick, thinPx: viewport.lineWeightsPx.thin, scale: viewport.scaleX, lod: viewport.lodLevel,
  });
  if (prims.length === 0 && holePrims.length === 0) return null;
  return (
    <>
    <Group name="plan-solids" listening={false}>
      {prims.flatMap(p => {
        if (p.kind === 'text') {
          return [(
            <Text
              key={p.key}
              x={p.x}
              y={p.y}
              text={p.text}
              fontSize={p.fontSizeMm}
              fill={PLAN_SOLIDS_COLOR}
              listening={false}
            />
          )];
        }
        if (p.kind === 'arrow') {
          return [(
            <Line
              key={p.key}
              points={p.points}
              stroke={PLAN_SOLIDS_COLOR}
              strokeWidth={viewport.lineWeightsPx[p.weight]}
              strokeScaleEnabled={false}
              listening={false}
            />
          ), (
            <Line
              key={`${p.key}:head`}
              points={p.head}
              stroke={PLAN_SOLIDS_COLOR}
              strokeWidth={viewport.lineWeightsPx[p.weight]}
              strokeScaleEnabled={false}
              lineCap="round"
              lineJoin="round"
              listening={false}
            />
          )];
        }
        return [(
          <Line
            key={p.key}
            points={p.points}
            stroke={PLAN_SOLIDS_COLOR}
            strokeWidth={viewport.lineWeightsPx[p.weight]}
            dash={p.dash}
            strokeScaleEnabled={false}
            listening={false}
          />
        )];
      })}
    </Group>
    <Group name="plan-hole-marks" listening={false}>
      {holePrims.map(p => (p.kind === 'text' ? (
        <Text
          key={p.key}
          x={p.x}
          y={p.y}
          text={p.text}
          fontSize={p.fontSize}
          fill={PLAN_SOLIDS_COLOR}
          offsetX={p.offsetX}
          listening={false}
        />
      ) : (
        <Line
          key={p.key}
          points={p.points}
          closed={p.closed}
          stroke={PLAN_SOLIDS_COLOR}
          strokeWidth={viewport.lineWeightsPx.thin}
          dash={p.dash}
          strokeScaleEnabled={false}
          listening={false}
        />
      )))}
    </Group>
    </>
  );
});
