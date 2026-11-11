// 柱の手動追加・手動削除の確定（structural/manualMemberCommit.js）の単体テスト。
// フィクスチャは manualMemberAdd.test.js の makeGridGraph と同形だが、原点 (0,0) から離した座標にする
// （符号・オフセットの変異を検出するため）。.jsx/store.js/snap.js は import しない。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { serializeGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import { autorun } from 'mobx';
import { commitManualColumnAdd, commitManualMemberRemoval } from './manualMemberCommit.js';
import { renumberMembers } from './memberNumbering.js';
import { REMOVE_FN_BY_MAP } from './memberCatalog.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';

// 採番（renumberMembers）が project.memberGroupLedger / memberNumberIndex を読むため実 Project を使う。
// makeGridGraph が作り直して代入する（各テストの冒頭で呼ぶ）。
let GRID_PROJECT = null;

function makeGridGraph(structure, xs = [1300, 5300], ys = [2700, 6700]) {
  GRID_PROJECT = new Project('proj1', 'test');
  const { graph } = GRID_PROJECT.addPlane(0, '1階');
  graph.structureOverride = structure;
  // 通り芯は全階共有の project.structGraph に置く（スナップショットは階固有の線しか持たず、
  // 柱の復元は structGraph 経由で CL を解決する。graph 側に置くと undo で柱が落ちる）。
  const sg = GRID_PROJECT.structGraph;
  const xCLs = xs.map(v => sg.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  const yCLs = ys.map(v => sg.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  return { graph, xCLs, yCLs };
}

// undoManager はモジュール状態（シングルトン）。前テストの残骸を読まないよう毎回空にする。
beforeEach(() => {
  while (undoManager.canUndo) undoManager.undo();
  while (undoManager.canRedo) undoManager.redo();
  undoManager._undoStack.splice(0);
  undoManager._redoStack.splice(0);
});

const slots = graph => [...graph.excludedColumnSlots].sort();

test('【確定・柱追加】1本増え memberNo が付き locked。undo で 0 本・除外集合も元どおり、redo で戻る', () => {
  const { graph, xCLs: [, x2], yCLs: [, y2] } = makeGridGraph('S造');
  const slotsBefore = slots(graph);
  const column = commitManualColumnAdd(graph, GRID_PROJECT, { vCL: x2, hCL: y2 });
  assert.equal(graph.columns.length, 1);
  assert.ok(column.memberNo, 'memberNo が付いていない（採番漏れ）');
  assert.equal(column.dimensionStatus, 'locked');
  assert.equal(undoManager._undoStack.length, 1);
  undoManager.undo();
  assert.equal(graph.columns.length, 0);
  assert.deepEqual(slots(graph), slotsBefore);
  undoManager.redo();
  assert.equal(graph.columns.length, 1);
  assert.ok([...graph.columnMap.values()][0].memberNo);
});

test('【確定・柱追加】除外済みスロットへの追加は除外を解除し、undo で除外が戻る', () => {
  const { graph, xCLs: [, x2], yCLs: [, y2] } = makeGridGraph('S造');
  const first = graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', x2, y2, {});
  graph.removeColumn(first.id);
  const excluded = slots(graph);
  assert.equal(excluded.length, 1, '前提: 除外集合に 1 件');
  commitManualColumnAdd(graph, GRID_PROJECT, { vCL: x2, hCL: y2 });
  assert.equal(graph.excludedColumnSlots.size, 0, '追加で除外が解除されるはず');
  undoManager.undo();
  assert.deepEqual(slots(graph), excluded);
  assert.equal(graph.columns.length, 0);
});

test('【確定・柱追加】在来木造でも 1 本追加し undo できる', () => {
  const { graph, xCLs: [, x2], yCLs: [y1] } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE);
  const c = commitManualColumnAdd(graph, GRID_PROJECT, { vCL: x2, hCL: y1 });
  assert.equal(c.dimensionStatus, 'locked');
  undoManager.undo();
  assert.equal(graph.columns.length, 0);
});

test('【確定・柱追加・失敗経路】vCL/hCL 欠落は throw し、graph も undo スタックも不変', () => {
  const { graph, xCLs: [, x2], yCLs: [, y2] } = makeGridGraph('S造');
  const snap = JSON.stringify(serializeGraph(graph));
  assert.throws(() => commitManualColumnAdd(graph, GRID_PROJECT, { vCL: null, hCL: y2 }), /commitManualColumnAdd/);
  assert.throws(() => commitManualColumnAdd(graph, GRID_PROJECT, { vCL: x2, hCL: undefined }), /commitManualColumnAdd/);
  assert.ok(JSON.stringify(serializeGraph(graph)) === snap, 'graph が変わった');
  assert.ok(undoManager.peekUndo() === null, 'undo を積んではいけない');
});

function makeWithColumns() {
  const { graph, xCLs, yCLs } = makeGridGraph('S造');
  const c1 = graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xCLs[0], yCLs[0], {});
  const c2 = graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xCLs[1], yCLs[1], {});
  const c3 = graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xCLs[1], yCLs[0], {});
  return { graph, xCLs, yCLs, cols: [c1, c2, c3] };
}

test('【確定・削除】柱を消し除外集合へ記録、undo で戻り redo で消える', () => {
  const { graph, cols: [c1] } = makeWithColumns();
  const n = commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [c1.id]);
  assert.equal(n, 1);
  assert.equal(graph.columnMap.has(c1.id), false);
  assert.equal(graph.excludedColumnSlots.size, 1);
  undoManager.undo();
  assert.equal(graph.columnMap.has(c1.id), true);
  assert.equal(graph.excludedColumnSlots.size, 0);
  undoManager.redo();
  assert.equal(graph.columnMap.has(c1.id), false);
  assert.equal(graph.excludedColumnSlots.size, 1);
});

test('【確定・削除】複数 id を 1 エントリで消す', () => {
  const { graph, cols: [c1, c2, c3] } = makeWithColumns();
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [c1.id, c2.id]), 2);
  assert.equal(graph.columns.length, 1);
  assert.equal(graph.columnMap.has(c3.id), true);
  assert.equal(undoManager._undoStack.length, 1);
  undoManager.undo();
  assert.equal(graph.columns.length, 3);
});

test('【確定・削除】採番を呼ばない（残った柱の memberNo は削除前のまま）', () => {
  // 断面が違えば別グループ＝別番号。先頭の番号の柱を消して採番し直すと残りが繰り上がる構成にする。
  const { graph, xCLs, yCLs } = makeGridGraph('S造');
  const mk = (sec, xi, yi) => graph.addColumn(StructuralMaterialType.RC, sec, xCLs[xi], yCLs[yi], {});
  const [c1, c2, c3] = [mk('RC-300x300', 0, 0), mk('RC-400x400', 1, 1), mk('RC-500x500', 1, 0)];
  renumberMembers(graph, GRID_PROJECT, 'columnMap');
  const noOf = c => graph.columnMap.get(c.id).memberNo;
  const before2 = noOf(c2), before3 = noOf(c3);
  assert.ok(noOf(c1) && before2 && before3, '前提: 3 本とも採番済み');
  assert.notEqual(before2, before3, '前提: 柱ごとに別番号（採番すれば詰まって変わる構成）');
  const first = [c1, c2, c3].map(noOf).sort()[0];
  const victim = [c1, c2, c3].find(c => noOf(c) === first);
  const rest = [c1, c2, c3].filter(c => c !== victim);
  const recorded = rest.map(noOf);
  commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [victim.id]);
  assert.deepEqual(rest.map(noOf), recorded);
});

test('【確定・柱追加】追加・採番は 1 つの action で行う（途中の memberNo 無しの状態が観測されない）', () => {
  const { graph, xCLs: [, x2], yCLs: [, y2] } = makeGridGraph('S造');
  const seen = [];
  const dispose = autorun(() => {
    seen.push(graph.columns.map(c => c.memberNo ?? null));
  });
  try {
    assert.equal(seen.length, 1, '前提: autorun の初回実行');
    commitManualColumnAdd(graph, GRID_PROJECT, { vCL: x2, hCL: y2 });
    assert.equal(seen.length, 2, '追加と採番で再実行はちょうど 1 回');
    assert.ok(seen[1][0], '再実行時点で memberNo が付いている');
  } finally {
    dispose();
  }
});

test('【確定・削除】REMOVE_FN_BY_MAP の全キーが graph の map として存在する', () => {
  const { graph } = makeGridGraph('S造');
  for (const k of Object.keys(REMOVE_FN_BY_MAP)) {
    assert.equal(typeof graph[k].has, 'function', `${k} が graph に map として無い`);
  }
});

test('【確定・削除】スラブ・耐力壁も 1 件消せて undo で戻る', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const slab = graph.addSlab(StructuralMaterialType.RC, null, new Set(['k1']));
  const wall = graph.addBearingWall(StructuralMaterialType.RC, 'RC-300x300', y1, false, x1, x2, {});
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'slabMap', [slab.id]), 1);
  assert.equal(graph.slabMap.has(slab.id), false);
  undoManager.undo();
  assert.equal(graph.slabMap.has(slab.id), true);
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'wallMap', [wall.id]), 1);
  assert.equal(graph.wallMap.has(wall.id), false);
  undoManager.undo();
  assert.equal(graph.wallMap.has(wall.id), true);
});

test('【確定・削除】柱以外（beamMap・footingMap）も 1 件消せる', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const beam = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y1, false, x1, x2, {});
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'beamMap', [beam.id]), 1);
  assert.equal(graph.beamMap.has(beam.id), false);
  undoManager.undo();
  assert.equal(graph.beamMap.has(beam.id), true);
  const f = graph.addFooting('independent', 'RC-300x300', x2, y1, { materialType: StructuralMaterialType.RC });
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'footingMap', [f.id]), 1);
  assert.equal(graph.footingMap.has(f.id), false);
});

test('【確定・削除・失敗経路】未知の mapName は throw し不変', () => {
  const { graph, cols: [c1] } = makeWithColumns();
  const snap = JSON.stringify(serializeGraph(graph));
  assert.throws(() => commitManualMemberRemoval(graph, GRID_PROJECT, 'noSuchMap', [c1.id]), /未知の mapName/);
  assert.ok(JSON.stringify(serializeGraph(graph)) === snap, 'graph が変わった');
  assert.ok(undoManager.peekUndo() === null, 'undo を積んではいけない');
});

test('【確定・削除・失敗経路】実在しない id だけなら 0 を返し undo を積まない', () => {
  const { graph } = makeWithColumns();
  const snap = JSON.stringify(serializeGraph(graph));
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', ['nope-1', 'nope-2']), 0);
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', []), 0);
  assert.ok(JSON.stringify(serializeGraph(graph)) === snap, 'graph が変わった');
  assert.ok(undoManager.peekUndo() === null, 'undo を積んではいけない');
});

test('【確定・削除】実在と非実在の混在は実在分だけ消える', () => {
  const { graph, cols: [c1, c2] } = makeWithColumns();
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', ['nope', c1.id]), 1);
  assert.equal(graph.columnMap.has(c1.id), false);
  assert.equal(graph.columnMap.has(c2.id), true);
  assert.equal(graph.excludedColumnSlots.size, 1);
});
