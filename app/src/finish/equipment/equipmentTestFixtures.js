// node:test 用のテスト専用ヘルパー（structural/memberTestFixtures.js と同じ命名規約——ファイル名に
// ".test." を含めない。node --test の既定 glob 対象から外れ、テスト本体として実行されないように
// するため。製品コードから import しない）。以下の不変条件 I1 を assert する。
//
// I1: 登録済みの昇降路Room（その Room を指す器具行が1件以上ある Room）について、
// refreshCells(room.cells) は、その Room を指す全器具行の refreshCells(row.cellKeys) の
// 和集合に等しい。行どうしのセルは重ならない。すべての行の roomId は実在の Room を指し、
// その Room の属性が昇降機。昇降路の Room で referenceRoomIds.size > 0 のものが無い
// （登録済みに限る——未登録（Q2・旧データ）はこの対象外）。
//
// centerLineKindPolicy.guard.test.js の TEST_ONLY_HELPERS には登録していない——本ファイルは
// graph.centerLines・.labeled・centerLineKind(...)・discipline/lineType のいずれも参照しないため、
// G1〜G4 のいずれの検出パターンにも一致せず allowlist が不要（登録しても実害は無いが、
// 本当に必要なファイルだけが載っていることをその都度確認できるよう、不要な登録はしない）。
import assert from 'node:assert/strict';
import { isShaftFeature, PlanGraph } from '@core';
import { refreshCells } from '../gridCells.js';
import { restoreGraph } from '../../graphSnapshot.js';

export function assertShaftInvariant(graph, message = '') {
  const prefix = message ? `${message}: ` : '';
  const rowsByRoom = new Map();
  for (const row of graph.equipmentRows) {
    if (!row.roomId) continue;
    if (!rowsByRoom.has(row.roomId)) rowsByRoom.set(row.roomId, []);
    rowsByRoom.get(row.roomId).push(row);
  }

  for (const [roomId, rows] of rowsByRoom) {
    const room = graph.roomMap.get(roomId);
    assert.ok(room, `${prefix}行が roomId=${roomId} を指すが Room が存在しない`);
    assert.ok(isShaftFeature(room.feature), `${prefix}Room ${roomId} の属性が昇降機でない`);
    assert.equal(room.referenceRoomIds.size, 0, `${prefix}登録済みの昇降路Room ${roomId} が referenceRoomIds を持っている`);

    const roomCells = refreshCells(room.cells, graph);
    const union = new Set();
    const seen = new Set();
    for (const row of rows) {
      const rowCells = refreshCells(row.cellKeys, graph);
      for (const key of rowCells) {
        assert.ok(!seen.has(key), `${prefix}行どうしのセルが重なっている（key=${key}）`);
        seen.add(key);
        union.add(key);
      }
    }
    assert.deepEqual([...roomCells].sort(), [...union].sort(),
      `${prefix}Room ${roomId} の refreshCells(cells) が全行の和集合と一致しない`);
  }
}

/**
 * 本番同型の peek 関数を作る（`new PlanGraph(plane)` → `_structGraph = project.structGraph` →
 * `restoreGraph(g, store.get(plane.id))`）。transform/centerLineFloorSync.test.js の
 * withPeekOverride・decodeFloor と同じ手順——生きたグラフをそのまま返さない（team-lessons
 * 「他階peekのテストスタブが生きたグラフを返し、復元時に捨てられる壁を検出できない」対応）。
 * @param {object} project
 * @param {Map<string, Uint8Array>} store - planeId → 直列化バイト列
 * @returns {(plane: object) => object} plane を受けて復元済み PlanGraph を返す
 */
export function makeStorePeek(project, store) {
  return (plane) => {
    const g = new PlanGraph(plane);
    g._structGraph = project.structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
}

/**
 * store（Map<planeId, bytes>）へ書き込む保存関数を作る。呼ばれた planeId を log（配列。省略可）へ
 * 記録する——失敗系テストで「保存された回数・順序」を assert するため。failOn を指定すると、
 * その planeId への保存だけ例外を投げる（巻き戻しテスト用）。
 * @param {Map<string, Uint8Array>} store
 * @param {string[]} [log]
 * @param {{failOn?: string|null}} [opts]
 * @returns {(planeId: string, bytes: Uint8Array) => Promise<void>}
 */
export function makeStoreSave(store, log = null, { failOn = null } = {}) {
  return async (planeId, bytes) => {
    if (failOn && planeId === failOn) throw new Error(`makeStoreSave: 意図した失敗（planeId=${planeId}）`);
    store.set(planeId, bytes);
    if (log) log.push(planeId);
  };
}

/**
 * store に保存されたバイト列を、peek と同じ手順で復号する（本番同型。検証専用）。
 * @param {object} project
 * @param {object} plane
 * @param {Uint8Array|undefined} bytes
 * @returns {object} 復元済み PlanGraph
 */
export function decodeFloor(project, plane, bytes) {
  const tmp = new PlanGraph(plane);
  tmp._structGraph = project.structGraph;
  if (bytes) restoreGraph(tmp, bytes);
  return tmp;
}
