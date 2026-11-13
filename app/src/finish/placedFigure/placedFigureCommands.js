// ================================================================
// 姿図の配置（graph.placedFigures）を変える命令。graph を受け取り、変更と undo（withFinishUndo の 1 エントリ）を担う。
// モード状態（仕上げ・図面モードの汎用 State）は選択・配置待ちだけを持ち、graph の変更はここへ委譲する（操作を二重に持たない）。
// 戻り値の規約: 無い id は false を返し何も変えない（undo も積まない）。不正な項目は PlacedFigure.with の RangeError（積む前に投げる）。
// 依存は core・placedFigureOps・finishUndo だけ（React・store・snap は引かない）。
// ================================================================
import { PlacedFigure } from '../../core/placedFigure.js';
import { PLACED_FIGURE_POSITION_STEP_MM, PLACED_FIGURE_ROTATION_STEP_DEG, FULL_TURN_DEG } from '../../core/constants.js';
import { withFinishUndo } from '../finishUndo.js';
import {
  addPlacedFigure as addPlacedFigureTo, updatePlacedFigure as updatePlacedFigureIn, removePlacedFigure as removePlacedFigureFrom,
} from './placedFigureOps.js';

/** 配置点を PLACED_FIGURE_POSITION_STEP_MM で丸める。 */
export function roundPlacedFigurePoint(x, y) {
  return {
    x: Math.round(x / PLACED_FIGURE_POSITION_STEP_MM) * PLACED_FIGURE_POSITION_STEP_MM,
    y: Math.round(y / PLACED_FIGURE_POSITION_STEP_MM) * PLACED_FIGURE_POSITION_STEP_MM,
  };
}

/** 姿図を (x, y) を丸めた点に置く。1回で undo 1エントリ。id は呼び出し側が採る（グラフ内で一意）。置いた id を返す。 */
export function placeFigure(graph, { id, figureKey, x, y }) {
  const p = roundPlacedFigurePoint(x, y);
  withFinishUndo(graph, () => graph.setPlacedFigures(
    addPlacedFigureTo(graph.placedFigures, new PlacedFigure({ id, figureKey, x: p.x, y: p.y })),
  ));
  return id;
}

/** 配置の項目を直す。無い id は false（undo も積まない）。1回で undo 1エントリ。 */
export function updatePlacedFigureWithUndo(graph, id, patch) {
  if (updatePlacedFigureIn(graph.placedFigures, id, patch) === null) return false;
  withFinishUndo(graph, () => graph.setPlacedFigures(updatePlacedFigureIn(graph.placedFigures, id, patch)));
  return true;
}

/** 配置を PLACED_FIGURE_ROTATION_STEP_DEG だけ回す。無い id は false。 */
export function rotatePlacedFigureWithUndo(graph, id) {
  const pf = graph.placedFigures.find(p => p.id === id);
  if (!pf) return false;
  return updatePlacedFigureWithUndo(graph, id, { rotationDeg: (pf.rotationDeg + PLACED_FIGURE_ROTATION_STEP_DEG) % FULL_TURN_DEG });
}

/** 配置の左右反転を切り替える。無い id は false。 */
export function togglePlacedFigureMirrorWithUndo(graph, id) {
  const pf = graph.placedFigures.find(p => p.id === id);
  if (!pf) return false;
  return updatePlacedFigureWithUndo(graph, id, { mirror: !pf.mirror });
}

/** 配置を消す。無い id は false（undo も積まない）。1回で undo 1エントリ。 */
export function removePlacedFigureWithUndo(graph, id) {
  if (removePlacedFigureFrom(graph.placedFigures, id) === null) return false;
  withFinishUndo(graph, () => graph.setPlacedFigures(removePlacedFigureFrom(graph.placedFigures, id)));
  return true;
}
