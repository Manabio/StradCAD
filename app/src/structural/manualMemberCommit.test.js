// 柱の手動追加・手動削除の確定（structural/manualMemberCommit.js）の単体テスト。
// フィクスチャは manualMemberAdd.test.js の makeGridGraph と同形だが、原点 (0,0) から離した座標にする
// （符号・オフセットの変異を検出するため）。.jsx/store.js/snap.js は import しない。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { serializeGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import { autorun, runInAction } from 'mobx';
import { splitGroup, setGroupManualTag } from './memberGroups.js';
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

// 断面が違えば別グループ＝別番号（C1・C2・C3）。先頭の番号の部材を消して採番し直すと残りが繰り上がる構成。
// 柱・梁・独立基礎を各 3 本（断面 300・400・500）。戻り値の ids は map ごとの id 配列。
function makeNumberedMixed() {
  const { graph, xCLs, yCLs } = makeGridGraph('S造', [1300, 5300, 9300], [2700, 6700, 10700]);
  const secs = ['RC-300x300', 'RC-400x400', 'RC-500x500'];
  const ids = {
    columnMap: secs.map((s, i) => graph.addColumn(StructuralMaterialType.RC, s, xCLs[i], yCLs[i], {}).id),
    beamMap: secs.map((s, i) => graph.addBeam(StructuralMaterialType.RC, s, yCLs[i], false, xCLs[0], xCLs[1], {}).id),
    footingMap: secs.map((s, i) => graph.addFooting('independent', s, xCLs[i], yCLs[(i + 1) % 3], { materialType: StructuralMaterialType.RC }).id),
  };
  renumberMembers(graph, GRID_PROJECT, null);
  return { graph, ids };
}
// map 内の { id: memberNo }。オブジェクトを assert へ渡さないための文字列化。
const nosOf = (graph, mapName) => JSON.stringify(Object.fromEntries([...graph[mapName].values()].map(e => [e.id, e.memberNo ?? null])));
// 番号が C1 の部材の id（最も大きい断面のグループ）。
const idWithNo = (graph, mapName, no) => [...graph[mapName].values()].find(e => e.memberNo === no)?.id;

test('【確定・削除】削除後に同じ mapName の残りを採番し直す（残った柱の memberNo は「同じ状態で renumberMembers した結果」と一致し、詰まる）', () => {
  const { graph, ids } = makeNumberedMixed();
  const victim = idWithNo(graph, 'columnMap', 'C1');
  assert.ok(victim, '前提: C1 の柱がある');
  const rest = ids.columnMap.filter(id => id !== victim);
  const restNos = () => JSON.stringify(rest.map(id => graph.columnMap.get(id).memberNo).sort());
  const noBefore = restNos();
  assert.equal(noBefore, JSON.stringify(['C2', 'C3']), '前提: 残りは C2・C3');
  commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [victim]);
  const actual = restNos();
  assert.ok(actual !== noBefore, `採番されていない（削除前のまま ${actual}）`);
  assert.equal(actual, JSON.stringify(['C1', 'C2']));
  // 同じ状態（柱を消しただけ）から renumberMembers を呼んだ結果と一致する。
  undoManager.undo();
  graph.removeColumn(victim);
  renumberMembers(graph, GRID_PROJECT, 'columnMap');
  assert.equal(restNos(), actual);
});

test('【確定・削除】削除と採番は 1 つの action で行う（途中の「消えたが番号は古い」状態が観測されない）', () => {
  const { graph, ids } = makeNumberedMixed();
  const victim = idWithNo(graph, 'columnMap', 'C1');
  const seen = [];
  const dispose = autorun(() => {
    seen.push(graph.columns.map(c => `${c.id}:${c.memberNo ?? null}`).join(','));
  });
  try {
    assert.equal(seen.length, 1, '前提: autorun の初回実行');
    commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [victim]);
    assert.equal(seen.length, 2, '削除と採番で再実行はちょうど 1 回');
    assert.ok(!seen[1].includes(victim), '再実行時点で削除済み');
    assert.ok(seen[1].includes(':C1') && seen[1].includes(':C2') && !seen[1].includes(':C3'), '再実行時点で採番済み');
  } finally {
    dispose();
  }
  assert.equal(ids.columnMap.length, 3);
});

test('【確定・削除】undo で残りの memberNo が削除前へ、redo で採番後へ戻る（全部材）', () => {
  const { graph } = makeNumberedMixed();
  const victim = idWithNo(graph, 'columnMap', 'C1');
  const pre = nosOf(graph, 'columnMap');
  commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [victim]);
  const post = nosOf(graph, 'columnMap');
  assert.ok(post !== pre, '前提: 採番で変わる');
  undoManager.undo();
  assert.equal(nosOf(graph, 'columnMap'), pre);
  undoManager.redo();
  assert.equal(nosOf(graph, 'columnMap'), post);
  undoManager.undo();
  assert.equal(nosOf(graph, 'columnMap'), pre);
});

for (const mapName of ['columnMap', 'beamMap', 'footingMap']) {
  test(`【確定・削除】${mapName} でも削除後に採番し直す（他カテゴリの memberNo は変えない）`, () => {
    const { graph } = makeNumberedMixed();
    const others = ['columnMap', 'beamMap', 'footingMap'].filter(m => m !== mapName);
    // 他カテゴリの採番を意図的に古くして、mapName を絞らず全体を採番すると変わる状態にする。
    for (const m of others) for (const e of graph[m].values()) e.setMemberNo('ZZ');
    const stale = others.map(m => nosOf(graph, m));
    const victim = idWithNo(graph, mapName, mapName === 'columnMap' ? 'C1' : mapName === 'beamMap' ? 'G1' : 'F1');
    assert.ok(victim, '前提: 番号 1 の部材がある');
    const pre = nosOf(graph, mapName);
    commitManualMemberRemoval(graph, GRID_PROJECT, mapName, [victim]);
    const nums = [...graph[mapName].values()].map(e => e.memberNo).sort();
    const sym = mapName === 'columnMap' ? 'C' : mapName === 'beamMap' ? 'G' : 'F';
    assert.equal(JSON.stringify(nums), JSON.stringify([`${sym}1`, `${sym}2`]), `採番されていない（前 ${pre}）`);
    assert.equal(JSON.stringify(others.map(m => nosOf(graph, m))), JSON.stringify(stale), '他カテゴリの memberNo が変わった');
  });
}

test('【確定・削除】slabMap・wallMap でも削除後に採番し直す（厚みで別グループ。他カテゴリの memberNo は変えない）', () => {
  const { graph, xCLs, yCLs } = makeGridGraph('S造', [1300, 5300, 9300], [2700, 6700, 10700]);
  const RC = StructuralMaterialType.RC;
  const thick = [120, 150, 180];
  const ids = {
    slabMap: thick.map((t, i) => graph.addSlab(RC, null, new Set([`k${i}`]), { thickness: t }).id),
    wallMap: thick.map((t, i) => graph.addBearingWall(RC, 'RC-300x300', yCLs[i], false, xCLs[0], xCLs[1], { thickness: t }).id),
    columnMap: thick.map((_, i) => graph.addColumn(RC, 'RC-300x300', xCLs[i], yCLs[i], {}).id),
  };
  renumberMembers(graph, GRID_PROJECT, null);
  for (const [mapName, sym] of [['slabMap', 'S'], ['wallMap', 'W']]) {
    const nums = () => JSON.stringify([...graph[mapName].values()].map(e => e.memberNo).sort());
    assert.equal(nums(), JSON.stringify([`${sym}1`, `${sym}2`, `${sym}3`]), `前提: ${mapName} は 3 グループ`);
    // 他カテゴリを古くして、mapName を絞っていることを見る。
    for (const e of graph.columnMap.values()) e.setMemberNo('ZZ');
    const stale = nosOf(graph, 'columnMap');
    commitManualMemberRemoval(graph, GRID_PROJECT, mapName, [idWithNo(graph, mapName, `${sym}1`)]);
    assert.equal(nums(), JSON.stringify([`${sym}1`, `${sym}2`]), `${mapName} の採番が詰まっていない`);
    assert.equal(nosOf(graph, 'columnMap'), stale, '他カテゴリの memberNo が変わった');
    undoManager.undo();
    assert.equal(nums(), JSON.stringify([`${sym}1`, `${sym}2`, `${sym}3`]));
  }
  assert.equal(ids.columnMap.length, 3);
});

test('【確定・削除】複数 id を 1 回で消しても採番し直す（残り 1 本が C1。undo で 3 本とも元の番号）', () => {
  const { graph, ids } = makeNumberedMixed();
  const c1 = idWithNo(graph, 'columnMap', 'C1'), c2 = idWithNo(graph, 'columnMap', 'C2');
  const survivor = ids.columnMap.find(id => id !== c1 && id !== c2);
  const pre = nosOf(graph, 'columnMap');
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [c1, c2]), 2);
  assert.equal(graph.columnMap.get(survivor).memberNo, 'C1');
  assert.equal(undoManager._undoStack.length, 1);
  undoManager.undo();
  assert.equal(nosOf(graph, 'columnMap'), pre);
});

test('【確定・削除】編集先がアクティブ階でない graph でも、その graph を採番する（他階の memberNo は不変）', () => {
  const project = new Project('proj2', 'test');
  const f1 = project.addPlane(0, '1階', 'p1');
  const f2 = project.addPlane(2800, '2階', 'p2', 2, 1);
  f1.graph.structureOverride = 'S造'; f2.graph.structureOverride = 'S造';
  const sg = project.structGraph;
  const xs = [1300, 5300, 9300].map(v => sg.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  const ys = [2700, 6700, 10700].map(v => sg.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  const secs = ['RC-300x300', 'RC-400x400', 'RC-500x500'];
  const mk = g => secs.map((s, i) => g.addColumn(StructuralMaterialType.RC, s, xs[i], ys[i], {}).id);
  const ids1 = mk(f1.graph);
  mk(f2.graph);
  renumberMembers(f1.graph, project, 'columnMap');
  runInAction(() => { project.activePlaneId = f2.plane.id; });
  assert.ok(project.activeGraph === f2.graph, '前提: アクティブは 2 階');
  for (const e of f2.graph.columnMap.values()) e.setMemberNo('ZZ'); // 2 階を採番すると変わる状態
  const stale2 = nosOf(f2.graph, 'columnMap');
  const victim = [...f1.graph.columnMap.values()].find(e => e.memberNo === 'C1').id;
  commitManualMemberRemoval(f1.graph, project, 'columnMap', [victim]);
  const rest = ids1.filter(id => id !== victim).map(id => f1.graph.columnMap.get(id).memberNo).sort();
  assert.equal(JSON.stringify(rest), JSON.stringify(['C1', 'C2']), '編集先（1 階）が採番されていない');
  assert.equal(nosOf(f2.graph, 'columnMap'), stale2, '2 階の memberNo が変わった');
});

test('【確定・削除】台帳ありでも、最終状態は「削除のみ＋全体反映」と同じ（台帳は不変）', () => {
  const { graph, xCLs, yCLs } = makeGridGraph('S造', [1300, 5300, 9300, 13300], [2700, 6700, 10700]);
  const RC = StructuralMaterialType.RC;
  const secs = ['RC-300x300', 'RC-400x400', 'RC-500x500'];
  const cols = secs.map((s, i) => graph.addColumn(RC, s, xCLs[i], yCLs[i], {}));
  const [bA, bB, bC] = secs.map((s, i) => graph.addBeam(RC, s, yCLs[i], false, xCLs[0], xCLs[1], {}));
  const bWait = graph.addBeam(RC, secs[0], yCLs[0], false, xCLs[2], xCLs[3], {}); // bA と同署名・gid なし＝加入待ち
  renumberMembers(graph, GRID_PROJECT, null);
  const ledger = GRID_PROJECT.memberGroupLedger;
  splitGroup(GRID_PROJECT, 'columnMap', [cols[1]]);          // 柱の分割 C#1
  splitGroup(GRID_PROJECT, 'beamMap', [bA]);                 // 梁の分割（bWait が同署名で加入待ち）
  const gidB = splitGroup(GRID_PROJECT, 'beamMap', [bB]);
  setGroupManualTag(ledger, gidB, 'G9');                     // 梁の手動タグ
  assert.ok(bC.id && bWait.numberGroupId == null, '前提: bWait は gid なし');
  const dump = () => JSON.stringify(['columnMap', 'beamMap'].map(m => [...graph[m].values()].map(e => [e.id, e.memberNo ?? null, e.numberGroupId ?? null]).sort()));
  const ledgerStr = () => JSON.stringify([...ledger.entries()].sort());
  const ledgerBefore = ledgerStr();
  const victim = idWithNo(graph, 'columnMap', 'C1');
  commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', [victim]);
  assert.equal(ledgerStr(), ledgerBefore, '台帳が変わった');
  assert.ok(graph.beamMap.get(bWait.id).numberGroupId != null, '加入待ちの梁の gid 付与が前倒しされる（最終状態は同じ）');
  renumberMembers(graph, GRID_PROJECT, null);
  const viaCommit = dump();
  assert.equal(ledgerStr(), ledgerBefore, '全体反映後も台帳は不変');
  undoManager.undo();
  assert.ok(graph.beamMap.get(bWait.id).numberGroupId == null, 'undo で加入待ちに戻る');
  graph.removeColumn(victim);
  renumberMembers(graph, GRID_PROJECT, null);
  assert.equal(dump(), viaCommit, '削除のみ＋全体反映と最終状態が違う');
  assert.equal(ledgerStr(), ledgerBefore);
});

test('【確定・削除・失敗経路】実在しない id だけなら採番も undo も起きない（memberNo 不変）', () => {
  const { graph } = makeNumberedMixed();
  for (const e of graph.columnMap.values()) e.setMemberNo('ZZ'); // 採番が走れば変わる状態
  const pre = nosOf(graph, 'columnMap');
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', ['nope-1']), 0);
  assert.equal(commitManualMemberRemoval(graph, GRID_PROJECT, 'columnMap', []), 0);
  assert.equal(nosOf(graph, 'columnMap'), pre, '採番が走った');
  assert.ok(undoManager.peekUndo() === null, 'undo を積んではいけない');
});

test('【確定・削除・失敗経路】未知の mapName は採番もしない（memberNo 不変）', () => {
  const { graph, ids } = makeNumberedMixed();
  for (const e of graph.columnMap.values()) e.setMemberNo('ZZ');
  const pre = nosOf(graph, 'columnMap');
  assert.throws(() => commitManualMemberRemoval(graph, GRID_PROJECT, 'noSuchMap', [ids.columnMap[0]]), /未知の mapName/);
  assert.equal(nosOf(graph, 'columnMap'), pre);
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
