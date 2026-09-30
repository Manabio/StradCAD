// centerLineOps.test.js・lineKindTransfer.test.js が共有する「本番同型 peek」テスト部品。
// 他の平面の読み出しを生きたグラフのスタブで代用すると壁の消失等を検出できない
// （team-lessons「他階 peek のテストスタブが『生きたグラフ』を返し…」）ため、本番と同じ手順
// （`new PlanGraph(plane)` → `_structGraph = project.structGraph` → `restoreGraph`）で行う。
// `.test.js` を付けない純粋な補助モジュール（node:test から二重にテストとして拾われないため）。
// 同型の部品が finish/equipment/equipmentTestFixtures.js（decodeFloor・makeStorePeek）や
// fixedMemberRefs.test.js・centerLineFloorSync.test.js にも残っている。1か所への統合は別タスク。
import { PlanGraph } from '../core.js';
import { restoreGraph } from '../graphSnapshot.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

// store に保存されたバイト列を、peek と同じ手順で復号する（decode ヘルパは saveFloorFn 観測テストで前例あり）。
export function decodeFloor(project, plane, bytes) {
  const tmp = new PlanGraph(plane);
  tmp._structGraph = project.structGraph;
  if (bytes) restoreGraph(tmp, bytes);
  return tmp;
}

// 本番同型 peek（IDBの代わりに Map ストアを読む）へ floorSwapManager.peek を差し替えて fn を実行し、
// 終了後に必ず元へ戻す共通ヘルパ。
export function withProductionPeek(project, store, fn) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => decodeFloor(project, plane, store.get(plane.id));
  return (async () => {
    try {
      return await fn();
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  })();
}
