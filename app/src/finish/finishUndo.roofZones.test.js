// 屋根区画（PlanGraph.roofZones）の仕上げ undo（snapshot の `roofZones` キー）のテスト。finishUndo.test.js の主屋根と同型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, RoofSpec, RoofZone, ROOF_ZONE_KEYS, ShaftSoundproof } from '../core.js';
import { NON_DEFAULT_ROOF_SPEC } from './roofTestFixtures.js';
import { undoManager } from '../undoManager.js';
import { withFinishUndo, snapshotFinishState, restoreFinishState } from './finishUndo.js';
import { createRoofZone, removeRoofZone } from './roof/roofZones.js';

function freshGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

test('不変条件: 仕上げ undo の snapshot の roofZones は RoofZone.toData のキー集合と一致する（区画なしは []）', () => {
  const graph = freshGraph();
  assert.deepEqual(snapshotFinishState(graph).roofZones, []);
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a'], spec: RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC) })]);
  const snap = snapshotFinishState(graph);
  assert.deepEqual(Object.keys(snap.roofZones[0]).sort(), [...ROOF_ZONE_KEYS].sort());
  assert.deepEqual(snap.roofZones[0].spec, NON_DEFAULT_ROOF_SPEC);
});

test('区画の追加・削除を withFinishUndo で包むと undo/redo で戻る（1エントリずつ）', () => {
  const graph = freshGraph();
  const before = undoManager._undoStack.length;
  withFinishUndo(graph, () => {
    graph.setRoofZones(createRoofZone(graph.roofZones, ['a', 'b'], RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC), () => 'z1').zones);
  });
  assert.equal(undoManager._undoStack.length, before + 1);
  assert.equal(graph.roofZones.length, 1);
  undoManager.undo();
  assert.deepEqual(graph.roofZones, []);
  undoManager.redo();
  assert.equal(graph.roofZones.length, 1);
  assert.deepEqual(graph.roofZones[0].toData().spec, NON_DEFAULT_ROOF_SPEC);

  withFinishUndo(graph, () => graph.setRoofZones(removeRoofZone(graph.roofZones, 'z1')));
  assert.deepEqual(graph.roofZones, []);
  undoManager.undo();
  assert.deepEqual(graph.roofZones.map(z => [z.id, [...z.cells]]), [['z1', ['a', 'b']]], '削除の undo で同 id・同セルが戻る');
  undoManager.undo();
  undoManager.undo(); // 後始末（積んだ分を戻す）
});

test('区画を作った後に別の仕上げ操作を挟んで undo/redo しても、区画は初期化されない（列挙漏れ対策）', () => {
  const graph = freshGraph();
  withFinishUndo(graph, () => graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a'] })]));
  withFinishUndo(graph, () => graph.setShaftSoundproof(ShaftSoundproof.INSULATION));
  undoManager.undo();
  assert.equal(graph.roofZones.length, 1, '別操作の undo で区画が失われない');
  undoManager.redo();
  assert.equal(graph.roofZones.length, 1, '別操作の redo でも保たれる');
  undoManager.undo();
  undoManager.undo();
  assert.deepEqual(graph.roofZones, []);
});

test('区画の spec の値は snapshot に写され、後の setField が過去のスナップショットへ漏れない', () => {
  const graph = freshGraph();
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a'] })]);
  const snap = snapshotFinishState(graph);
  graph.roofZones[0].spec.setField('slope', 7);
  assert.equal(snap.roofZones[0].spec.slope, 3);
  restoreFinishState(graph, snap);
  assert.equal(graph.roofZones[0].spec.slope, 3, '復元は snapshot の値');
});

test('【失敗系】restoreFinishState: roofZones キー欠落（旧スナップショット）は区画なし、壊れた区画は復元で正規化される', () => {
  const graph = freshGraph();
  const snap = snapshotFinishState(freshGraph());
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a'] })]);
  const legacy = { ...snap };
  delete legacy.roofZones;
  restoreFinishState(graph, legacy);
  assert.deepEqual(graph.roofZones, []);

  restoreFinishState(graph, {
    ...snap,
    roofZones: [
      { id: 'bad', cells: [], spec: {} },
      { id: 'ok', cells: ['a'], spec: { ...NON_DEFAULT_ROOF_SPEC, slope: -1 } },
    ],
  });
  assert.deepEqual(graph.roofZones.map(z => z.id), ['ok'], '空 cells の区画は捨てる');
  assert.equal(graph.roofZones[0].spec.slope, 3, '壊れた slope は既定へ');
});
