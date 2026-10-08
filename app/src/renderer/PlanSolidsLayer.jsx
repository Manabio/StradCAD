import { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { Group, Line } from 'react-konva';
import { planSolidsLayerResolve } from '../plan/planSolidsLayerFilter.js';
import { stairRiserOf } from '../finish/stair/stairDimensions.js';
import { graphComputed } from './graphDerived.js';

const PLAN_SOLIDS_COLOR = '#1e293b'; // 階段・吹抜け・下屋と同じ線色

/**
 * 平面の「立体＋水平切断」で描く線のうち、今の平面に無い種類（梁・汎用立体）。切断高より下の梁は細線の見えがかり、
 * 切断面をまたぐ梁は太線。柱・壁・床・屋根は既存レイヤが描くので、ここでは遮蔽物としてだけ解決に参加する
 * （描く種別の集合は plan/planSolidsLayerFilter.js S4_DRAWN_KINDS）。表示するモードの判断は SceneLayers の showPlanFigure。
 * 層は自階＋直下階（belowPeek。App.jsx が直下階を peek して渡す）。判断は純関数 planSolidsLayerResolve に集約:
 *   belowPeek の3状態（undefined＝未解決→描かない／null＝下階なし／オブジェクト＝あり。upperStairEntries の null／[] と同じ作法）、
 *   通り芯ドラッグ中は前回の結果を描き続ける（毎フレームの全再計算を避ける。ref に前回の線を持つ）、
 *   それ以外は graphComputed で memo（置き場は直下階 peek の graph、鍵は自階×切断高×直下階）。
 * 線幅は RoofPlanLayer と同方式（strokeScaleEnabled=false・px 値をそのまま渡す）。
 */
export const PlanSolidsLayer = observer(({ graph, project, viewport, belowPeek }) => {
  const prevRef = useRef(null); // { planeId, prims }: ドラッグ中に描き続ける前回の線（階が違えば使わない）
  if (!graph) return null;
  const prims = planSolidsLayerResolve({
    graph, belowPeek, memo: graphComputed,
    prevPrims: prevRef.current?.planeId === graph.plane.id ? prevRef.current.prims : null,
    selfRiserOf: s => stairRiserOf(s, project, graph.plane),
  });
  if (prims) prevRef.current = { planeId: graph.plane.id, prims };
  if (!prims || prims.length === 0) return null;
  return (
    <Group name="plan-solids" listening={false}>
      {prims.map(p => (
        <Line
          key={p.key}
          points={p.points}
          stroke={PLAN_SOLIDS_COLOR}
          strokeWidth={viewport.lineWeightsPx[p.weight]}
          dash={p.dash}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
    </Group>
  );
});
