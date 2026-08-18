import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSavedFloorDiff } from './floorDocumentDiff.js';

test('computeSavedFloorDiff: planeIdsに無いsavedKeysは削除対象になる', () => {
  const { toDelete } = computeSavedFloorDiff(['a', 'b', 'ghost'], ['a', 'b']);
  assert.deepEqual(toDelete, ['ghost']);
});

test('computeSavedFloorDiff: 新規plane（savedKeysに無いplaneId）は削除対象に含まれず、toCopyに含まれる', () => {
  const { toCopy, toDelete } = computeSavedFloorDiff(['a'], ['a', 'new-plane']);
  assert.deepEqual(toCopy.sort(), ['a', 'new-plane']);
  assert.deepEqual(toDelete, []);
});

// 通常到達しない（project.planeMapは常に採用フロア1階以上を持つ）が、保存ドキュメントは常に
// project.planeMap（planeIds）の鏡であるという不変条件を明文化するためのケース。
test('computeSavedFloorDiff: planeIdsが空なら全savedKeysが削除対象になる（文書＝planeMapの鏡という不変条件。通常到達不能）', () => {
  const { toCopy, toDelete } = computeSavedFloorDiff(['a', 'b'], []);
  assert.deepEqual(toCopy, []);
  assert.deepEqual(toDelete, ['a', 'b']);
});

test('computeSavedFloorDiff: savedKeys/planeIdsともに空なら何もしない', () => {
  assert.deepEqual(computeSavedFloorDiff([], []), { toCopy: [], toDelete: [] });
});
