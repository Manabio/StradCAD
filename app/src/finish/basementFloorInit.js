// 下階追加（最下階の地上階のさらに下へ最初の地階を足す）で、新しい地階へ当該階から引き継ぐもののうち
// 「外壁の中心線」と「地階構造の初期値」（階の追加・削除の見直し S5c-2。問題.md Q15・Q17・Q19）。
// 部屋・壁は写さない（Q13・Q18。地下1階には CL・階段・EV だけを置き、部屋と壁は利用者が作る）。
//
// 純関数（collectExteriorWallCLs・basementStructureToWrite）と、peek→書込み→保存の I/O ラッパー
// （copyExteriorCLsToNewFloors）に分ける。node:test から単体 import できるよう store.js／.jsx は引かない。
import { runInAction } from 'mobx';
import { serializeGraph } from '../graphSnapshot.js';
import { saveFloor } from '../storage/db.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { addMissingCLs } from './floorCLMap.js';
import { ERR_BASEMENT_CL_COPY_FAILED, ERR_BASEMENT_CL_COPY_FAILED_MESSAGE, tagElevatorOpFailure } from '../error.js';
import { effectiveStructure, initialBasementStructureFor, isBasementPlane } from '../structural/structureRules.js';

/**
 * graph の外壁（isExteriorWall）が使う階固有の中心線（壁の軸と両端が乗る CL）を `${type}:${value}` → CL で集める
 * （addMissingCLs の needed の形）。通り芯は全階共通で graph.shapeMap に無いため自然に除かれる。外壁が無ければ空。
 */
export function collectExteriorWallCLs(graph) {
  const needed = new Map();
  for (const w of graph.walls) {
    if (!w.isExteriorWall) continue;
    for (const ref of [w.axisCL, w.clStart, w.clEnd]) {
      const cl = typeof ref === 'string' ? graph.shapeMap.get(ref) : ref; // 壁の CL 参照は実体（テストの手組みは id のこともある）
      if (cl && graph.shapeMap.has(cl.id) && cl.centerLineType != null) needed.set(`${cl.centerLineType}:${cl.value}`, cl);
    }
  }
  return needed;
}

/**
 * 新しい階のうち地階（startFloor<0）が書くべき地階構造。地階が1つも無ければ null（書かない＝地上階の追加）。
 * 値は当該階（sourceGraph）の実効の構造から initialBasementStructureFor で決める（Q17・Q19）。
 */
export function basementStructureToWrite(project, sourceGraph, newPlanes) {
  if (!newPlanes.some(isBasementPlane)) return null;
  return initialBasementStructureFor(effectiveStructure(sourceGraph, project));
}

/**
 * 下階追加の新しい各階（地階だけ）へ、当該階（sourceGraph）の外壁が乗る階固有 CL を写す（addMissingCLs）。
 * 新しい階が地上階（最下階が2階など）なら何もしない。外壁が無い・CL が無ければ peek もしない。
 * 写し先は peek したグラフで、アクティブ階なら throw する（peek→保存が auto-save に上書きされるため）。
 * peek・保存・写しの例外は ERR_BASEMENT_CL_COPY_FAILED 付きで再スローする（巻き戻しなし。写し先は新しい階だけで、
 * 失敗した階は階追加の undo で平面ごと消える）。undo は積まない——withFloorOpUndo が新しい階のバイト列を丸ごと記録する。
 * @returns {Promise<{status:'noop'} | {status:'copied', perPlane: Array<{plane:object, added:number}>}>}
 */
export async function copyExteriorCLsToNewFloors({
  project, sourceGraph, newPlanes,
  peekFn = (p) => floorSwapManager.peek(p, project.structGraph),
  saveFloorFn = saveFloor,
}) {
  if (!sourceGraph) throw new Error('copyExteriorCLsToNewFloors: sourceGraph がありません');
  const targets = newPlanes.filter(isBasementPlane);
  if (targets.length === 0) return { status: 'noop' };
  const needed = collectExteriorWallCLs(sourceGraph);
  if (needed.size === 0) return { status: 'noop' };
  const perPlane = [];
  for (const plane of targets) {
    if (plane.id === project.activePlane?.id) {
      throw new Error(`copyExteriorCLsToNewFloors: 写し先がアクティブ階です（plane=${plane.id}）`);
    }
    try {
      const dst = await peekFn(plane);
      const added = addMissingCLs(needed, sourceGraph, project.structGraph, dst);
      if (added > 0) await saveFloorFn(plane.id, serializeGraph(dst));
      perPlane.push({ plane, added });
    } catch (err) {
      throw tagElevatorOpFailure(err, { code: ERR_BASEMENT_CL_COPY_FAILED, message: ERR_BASEMENT_CL_COPY_FAILED_MESSAGE });
    }
  }
  return { status: 'copied', perPlane };
}

/**
 * 地階構造の初期値を書く（毎回上書き。未設定のときだけ、ではない＝Q-C）。書いた値を返す（書かなければ null）。
 * undo/redo は withFloorOpUndo の levels（collectProjectLevels）が戻す。
 */
export function writeBasementStructure(project, sourceGraph, newPlanes) {
  const value = basementStructureToWrite(project, sourceGraph, newPlanes);
  if (value == null) return null;
  runInAction(() => project.structuralInfo.setBasementStructure(value));
  return value;
}
