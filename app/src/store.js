import { createContext, useContext } from 'react';
import { runInAction, reaction } from 'mobx';
import {
  Project, CenterLineType, Discipline,
  HDimensionLine, VDimensionLine, DimensionKind, DimensionSide,
} from '@core';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { deleteFloor as dbDeleteFloor, clearAllStores } from './storage/db.js';
import { clearDirty } from './dirtyState.js';
import { SpatialIndex } from './transform/SpatialIndex.js';

// ----------------------------------------------------------------
// ID の永続化
//
// planeId / projectId はセッションをまたいで同じ IDB キーを使うため
// localStorage に保存して再利用する。
// ----------------------------------------------------------------
const PROJECT_ID_KEY = 'strad-project-id';
const PLANE_ID_KEY   = 'strad-plane-0-id';

let savedProjectId = localStorage.getItem(PROJECT_ID_KEY);
if (!savedProjectId) {
  savedProjectId = crypto.randomUUID();
  localStorage.setItem(PROJECT_ID_KEY, savedProjectId);
}

let activePlaneId = localStorage.getItem(PLANE_ID_KEY);
if (!activePlaneId) {
  activePlaneId = crypto.randomUUID();
  localStorage.setItem(PLANE_ID_KEY, activePlaneId);
}

// ----------------------------------------------------------------
// プロジェクト・プレーン・グラフの初期化
// ----------------------------------------------------------------
export const project = new Project(savedProjectId, '新規プロジェクト');
const { plane, graph } = project.addPlane(0, '1階', activePlaneId, 1, 1);

// ----------------------------------------------------------------
// デフォルト初期状態
//
// 通り芯 → project.structGraph（全階共通）
// 寸法線 → フロアグラフ（階固有）
// setupStructGraph / activate が IndexedDB に保存済みデータがあれば上書きする
// ----------------------------------------------------------------
const clProps = { discipline: Discipline.STRUCT };
project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0, clProps);
project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, clProps);

graph.addBackingMaterial('木下地', 60, 90);

graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP    });
graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT   });
graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT  });
graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP    });
graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT   });
graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT  });

// ----------------------------------------------------------------
// 空間インデックス（R-Tree）— 頂点の高速検索
//
// CL.value 変化時（bake 後）に自動再構築される。
// ドラッグ中は pendingDelta が変化するが cl.value は不変なため、再構築は起きない。
// ----------------------------------------------------------------
export const spatialIndex = new SpatialIndex();

reaction(
  () => graph.centerLines.map(cl => cl.value),
  () => spatialIndex.rebuild(graph.intersections, graph.points),
  { fireImmediately: true },
);

// ----------------------------------------------------------------
// IndexedDB 起動時初期化 + auto-save 開始
//
// 起動時は常に全ストア（全階のフロアデータ・通り芯・構造情報など）を削除し、
// 完全な初期状態（白紙）から作業を開始する。F5 リロードでも保持しない。
// ----------------------------------------------------------------
(async () => {
  await clearAllStores();
  floorSwapManager.setupStructGraph(project.structGraph, project.structuralInfo, savedProjectId, project.structuralTagRegistry).catch(console.error);
  floorSwapManager.activate(plane, graph).catch(console.error);
})();

// ----------------------------------------------------------------
// フロア管理
// ----------------------------------------------------------------

/**
 * 新しいフロアを追加する。
 * @param {number} elevation   高さ（例: 3000mm = 3m）
 * @param {string} name        フロア名（例: '2FL'）
 * @param {number} startFloor  開始階番号（デフォルト 1）
 * @param {number} stories     層数（デフォルト 1）
 * @param {string} [planeId]   plane.id（省略時は新規発番。階追加 undo の redo が同一 ID で再作成するために指定する）
 * @returns {{ plane, graph }}
 */
export function addFloor(elevation, name, startFloor = 1, stories = 1, planeId = crypto.randomUUID()) {
  const result = project.addPlane(elevation, name, planeId, startFloor, stories);

  // 新フロアにも寸法線を追加
  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP    });
  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT   });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT  });
  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP    });
  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT   });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT  });

  return result;
}

/**
 * 検討フロアを追加する。
 * @param {string} referenceId  親採用の plane.id
 * @param {string} name         検討の名称
 */
export function addAlternativeFloor(referenceId, name) {
  const refPlane = project.planeMap.get(referenceId);
  if (!refPlane) return null;

  const altCount = [...project.planeMap.values()]
    .filter(p => p.isAlternative && p.referenceId === referenceId).length;

  const newPlaneId = crypto.randomUUID();
  const result = project.addPlane(
    refPlane.elevation, name, newPlaneId,
    refPlane.startFloor, refPlane.stories,
    true, referenceId, altCount,
  );

  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP    });
  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT   });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT  });
  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP    });
  result.graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT   });
  result.graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT  });
  return result;
}

/**
 * フロアを IDB から削除し、project からも除去する。
 * 採用の場合はその検討も連鎖削除する。
 * アクティブフロアを削除する前に switchFloor で切り替えること。
 */
export async function removeFloor(planeId) {
  const plane = project.planeMap.get(planeId);
  if (!plane) return;

  const idsToDelete = [planeId];
  if (!plane.isAlternative) {
    for (const [id, p] of project.planeMap) {
      if (p.isAlternative && p.referenceId === planeId) idsToDelete.push(id);
    }
  }
  for (const id of idsToDelete) await dbDeleteFloor(id);

  runInAction(() => { project.removePlane(planeId); });
}

/**
 * アクティブなフロアを切り替える。
 * 現在のフロアを IDB に保存してクリアし、次のフロアを IDB から復元する。
 *
 * @param {string} nextPlaneId  切り替え先の plane.id
 */
export async function switchFloor(nextPlaneId) {
  const currentPlane = project.activePlane;
  const currentGraph = project.activeGraph;
  if (!currentPlane || !currentGraph) return;
  if (currentPlane.id === nextPlaneId) return;

  const nextGraph = project.graphMap.get(nextPlaneId);
  const nextPlane = project.planeMap.get(nextPlaneId);
  if (!nextGraph || !nextPlane) return;

  // 現フロアをスワップアウト
  await floorSwapManager.deactivate(currentPlane, currentGraph);

  // アクティブ切替
  runInAction(() => { project.activePlaneId = nextPlaneId; });

  // 次フロアをスワップイン
  await floorSwapManager.activate(nextPlane, nextGraph);
}

/**
 * 現在のフロアと通り芯を IndexedDB に明示的に保存し、dirty をリセットする。
 */
export async function saveToIDB() {
  await floorSwapManager.saveNow(plane, graph, project.structGraph, project.structuralInfo, savedProjectId, project.structuralTagRegistry);
  clearDirty();
}

export const StoreContext = createContext(project);
export function useStore() { return useContext(StoreContext); }
