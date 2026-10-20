// 階設定表の確定（HEIGHTS）で階高が変わった階の階段の蹴上を追従させる（stairRiserFollow。階設定表 S8）の不変条件。
// 4階建て（p1〜p4）で、対象の階段が最下階（アクティブ階＝ライブのグラフ）・中間・最上階の直下にある場合を確かめる。
//   - 明示 riser は総段数を保ったまま新しい階高÷総段数へ書き換える／明示の無い階段は書かない（自動で追従）
//   - 他階は 1 階 1 回の peek → 全変更 → 1 回の保存（階高が変わらない階・最上階は peek しない）
//   - undo は全階のバイト列（保存前後のバイト列の復号）で戻る
//   - 変化を project の印とトーストに出す
// 他階の peek／保存は本番同型（new PlanGraph(plane)→_structGraph→restoreGraph、保存は Map ストア。検証は保存バイト列の復号）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph } from './core.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from './floorOrderChange.js';
import { computeFloorHeightEdit } from './floorHeights.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from './graphSnapshot.js';
import { stairRiserKey, stairRiserChangesForEdit, announceRiserChanges } from './finish/stair/stairRiserFollow.js';
import { collectFloorSettingsFacts } from './floorSettingsFacts.js';
import { rollbackFloorOp, collectPlaneMetas, collectProjectLevels } from './floorOps.js';

/**
 * p1(0)・p2(3000)・p3(6000)・p4(9000) の4階。p1 がアクティブ。各階に階段1本:
 *   p1＝明示 riser 200（総段数15・階高3000/15=200 と一致）、p2＝自動（riser なし・総段数15）、
 *   p3＝明示 riser 190（総段数16。階高3000/16=187.5 と食い違う指定値）、p4（最上階）＝明示 riser 180。
 */
function makeFourFloors() {
  const project = new Project('proj', 'test');
  const graphs = [];
  for (const [i, el] of [0, 3000, 6000, 9000].entries()) {
    graphs.push(project.addPlane(el, `${i + 1}階`, `p${i + 1}`, i + 1, 1).graph);
  }
  project.activePlaneId = 'p1';
  const stairs = [
    graphs[0].addStair({ totalSteps: 15, riser: 200 }, 's1'),
    graphs[1].addStair({ totalSteps: 15 }, 's2'),
    graphs[2].addStair({ totalSteps: 16, riser: 190 }, 's3'),
    graphs[3].addStair({ totalSteps: 15, riser: 180 }, 's4'),
  ];
  const store = new Map(graphs.slice(1).map((g, i) => [`p${i + 2}`, serializeGraph(g)]));
  return { project, graphs, stairs, store };
}

function makeIo(project, store, counts) {
  return {
    peekFn: async (plane) => {
      counts.peek[plane.id] = (counts.peek[plane.id] ?? 0) + 1;
      const g = new PlanGraph(plane);
      g._structGraph = project.structGraph;
      const bytes = store.get(plane.id);
      if (bytes) restoreGraph(g, bytes);
      return g;
    },
    saveFloorFn: async (planeId, bytes) => {
      counts.save[planeId] = (counts.save[planeId] ?? 0) + 1;
      store.set(planeId, bytes);
    },
  };
}

function decodeStair(project, store, planeId, stairId) {
  const g = new PlanGraph(project.planeMap.get(planeId));
  g._structGraph = project.structGraph;
  restoreGraph(g, store.get(planeId));
  return g.stairMap.get(stairId);
}

const onlyRiser = floorOrderFollowers.filter(f => f.name === 'stairRiserFollow');

/** 階高編集 → 確定（stairRiserFollow だけを回す。followers を渡せば全追従）。 */
async function confirm(project, store, heights, { followers = onlyRiser, stairItems, glBelow1FlMm, skipActiveWalls } = {}) {
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map(Object.entries(heights)), glBelow1FlMm }, 2900, project.glBelow1FlMm);
  assert.ok(edit.ok);
  const counts = { peek: {}, save: {} };
  const io = makeIo(project, store, counts);
  const toasts = [];
  const ui = { notify: m => toasts.push(m), switchFloor: async () => true, onFloorSyncChanged() {} };
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => io.peekFn(plane);
  try {
    const applied = await applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui, floorIo: io, stairItems, skipActiveWalls }, followers);
    // App.jsx runFloorHeights と同じ: 通知と印は全追従の成功後（withFloorOpUndo の await の後）にだけ行う
    announceRiserChanges(project, applied.riserChanges, ui.notify);
  } finally { floorSwapManager.peek = orig; }
  return { edit, counts, toasts };
}

test('HEIGHTS に stairRiserFollow が登録され、wallRefresh より前にある（書き換えた後の蹴上で壁を作り直す）', () => {
  const names = floorOrderFollowers.map(f => f.name);
  assert.ok(names.indexOf('stairRiserFollow') >= 0);
  assert.ok(names.indexOf('stairRiserFollow') < names.indexOf('wallRefresh'));
  assert.ok(names.indexOf('roofPlaneHeight') < names.indexOf('stairRiserFollow'));
});

test('最下階(p1・アクティブ)の階高 3000→3300: ライブの明示 riser を 220 へ（総段数15を保つ）。peek も保存もしない', async () => {
  const { project, stairs, store } = makeFourFloors();
  const { counts, toasts } = await confirm(project, store, { p1: 3300 });
  assert.equal(stairs[0].riser, 3300 / 15);
  assert.equal(stairs[0].totalSteps, 15, '総段数は保つ');
  assert.deepEqual(counts.peek, {}, 'p1 の階高だけが変わり、他階の階高は不変＝peek しない');
  assert.deepEqual(counts.save, {});
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /^階段の蹴上を 200→220 に変更しました$/, 'stairItems が無ければ表示名は「階段」');
  assert.equal(project.riserAutoUpdated.get(stairRiserKey('p1', 's1')), 220);
});

test('中間階(p2)の階高 3000→3300: 自動の階段は書き換えない（riser は null のまま）が、通知・印には入る。p2 は 1 回だけ peek・保存しない', async () => {
  const { project, store } = makeFourFloors();
  const before = store.get('p2');
  const { counts, toasts } = await confirm(project, store, { p2: 3300 });
  assert.deepEqual(counts.peek, { p2: 1 });
  assert.deepEqual(counts.save, {}, '明示 riser が無いので書き換えも保存も無い');
  assert.equal(store.get('p2'), before);
  assert.equal(decodeStair(project, store, 'p2', 's2').riser, null);
  assert.match(toasts[0], /蹴上を 200→220 に変更しました/);
  assert.equal(project.riserAutoUpdated.get(stairRiserKey('p2', 's2')), 220);
});

test('最上階の直下(p3)の階高 3000→3200: 明示 riser 190（総段数16）を 3200/16=200 へ。peek 1・保存 1。最上階 p4 の階段は無関係', async () => {
  const { project, store } = makeFourFloors();
  const { counts, toasts } = await confirm(project, store, { p3: 3200 });
  assert.deepEqual(counts.peek, { p3: 1 });
  assert.deepEqual(counts.save, { p3: 1 });
  const s3 = decodeStair(project, store, 'p3', 's3');
  assert.equal(s3.riser, 200);
  assert.equal(s3.totalSteps, 16);
  assert.equal(decodeStair(project, store, 'p4', 's4').riser, 180, '最上階の階段は書き換えない');
  assert.match(toasts[0], /蹴上を 190→200 に変更しました/);
});

test('最上階(p4)だけの階高変更: 階段は影響を受けない（peek も通知も無い）', async () => {
  const { project, stairs, store } = makeFourFloors();
  const { counts, toasts } = await confirm(project, store, { p4: 2600 });
  assert.deepEqual(counts.peek, {});
  assert.deepEqual(toasts, []);
  assert.equal(stairs[3].riser, 180);
  assert.equal(project.riserAutoUpdated.size, 0);
});

test('GL だけの変更（updates 空）: 何も peek・保存・通知しない', async () => {
  const { project, stairs, store } = makeFourFloors();
  const { counts, toasts } = await confirm(project, store, {}, { glBelow1FlMm: 500 });
  assert.deepEqual(counts, { peek: {}, save: {} });
  assert.deepEqual(toasts, []);
  assert.equal(stairs[0].riser, 200);
});

test('表示名: stairItems の label がトーストに入る（無ければ「階段」）', async () => {
  const { project, store } = makeFourFloors();
  const { toasts } = await confirm(project, store, { p3: 3200 }, { stairItems: [{ planeId: 'p3', stairId: 's3', label: '階段7（3->4階）' }] });
  assert.match(toasts[0], /^階段7（3->4階）の蹴上を 190→200 に変更しました$/);
});

test('undo: 保存前後のバイト列（全階）が違い、前のバイト列の復号で元の明示 riser に戻る。後のバイト列は新しい値', async () => {
  const { project, graphs, store } = makeFourFloors();
  const bytesBefore = new Map([['p1', serializeGraph(graphs[0])], ...store]);
  await confirm(project, store, { p1: 3300, p3: 3200 });
  const bytesAfter = new Map([['p1', serializeGraph(graphs[0])], ...store]);

  const riserOf = (bytes, id, sid) => {
    const g = new PlanGraph(project.planeMap.get(id));
    g._structGraph = project.structGraph;
    restoreGraph(g, bytes.get(id));
    return g.stairMap.get(sid).riser;
  };
  // p1: 200→3300/15=220、p3: 190→3200/16=200
  assert.notDeepEqual(bytesBefore.get('p1'), bytesAfter.get('p1'));
  assert.notDeepEqual(bytesBefore.get('p3'), bytesAfter.get('p3'));
  assert.equal(riserOf(bytesAfter, 'p1', 's1'), 220);
  assert.equal(riserOf(bytesAfter, 'p3', 's3'), 200);
  assert.equal(riserOf(bytesBefore, 'p1', 's1'), 200);
  assert.equal(riserOf(bytesBefore, 'p3', 's3'), 190);
  assert.deepEqual(bytesBefore.get('p2'), bytesAfter.get('p2'), '階高が変わらない p2 のバイト列は不変（undo の対象外）');
});

test('全追従（wallRefresh・structuralReflect とも）を通しても、書き換えた riser は保存バイト列に残る', async () => {
  const { project, store } = makeFourFloors();
  await confirm(project, store, { p3: 3200 }, { followers: floorOrderFollowers });
  assert.equal(decodeStair(project, store, 'p3', 's3').riser, 200);
});

test('【失敗系】他階の peek が throw: applyFloorOrderChange が reject し、何も保存・印付けしない', async () => {
  const { project, store } = makeFourFloors();
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map([['p3', 3200]]) }, 2900, 0);
  const saved = [];
  const io = { peekFn: async () => { throw new Error('peek 失敗'); }, saveFloorFn: async (id) => { saved.push(id); } };
  await assert.rejects(
    applyFloorOrderChange(project, {
      kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, floorIo: io,
      ui: { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} },
    }, onlyRiser),
    /peek 失敗/,
  );
  assert.deepEqual(saved, []);
  assert.equal(project.riserAutoUpdated.size, 0);
  assert.ok(store.has('p3'));
});

test('【失敗系】蹴上の書き換え後に wallRefresh が失敗: 通知も印も無く、巻き戻し(rollbackFloorOp)で IDB の riser が元に戻る', async () => {
  const { project, graphs, store } = makeFourFloors();
  const before = new Map([['p1', serializeGraph(graphs[0])], ...store]);
  const metasBefore = collectPlaneMetas(project);
  const levelsBefore = collectProjectLevels(project);
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map([['p3', 3200]]) }, 2900, 0);
  const counts = { peek: {}, save: {} };
  const base = makeIo(project, store, counts);
  // 蹴上の書き換え(p3 の保存)は通り、wallRefresh が最初に行う自階(p1)の保存で失敗する
  const io = { peekFn: base.peekFn, saveFloorFn: async (id, b) => { if (id === 'p1') throw new Error('保存失敗'); return base.saveFloorFn(id, b); } };
  const toasts = [];
  const ui = { notify: m => toasts.push(m), switchFloor: async () => true, onFloorSyncChanged() {} };
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => io.peekFn(plane);
  try {
    await assert.rejects(async () => {
      const applied = await applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui, floorIo: io }, floorOrderFollowers);
      announceRiserChanges(project, applied.riserChanges, ui.notify); // 到達しない
    }, /保存失敗/);
  } finally { floorSwapManager.peek = orig; }
  assert.equal(decodeStair(project, store, 'p3', 's3').riser, 200, '失敗時点では p3 の IDB は書き換え済み');
  assert.deepEqual(toasts, [], '通知は出ない');
  assert.equal(project.riserAutoUpdated.size, 0, '印は 0 件');

  const saved = [];
  await rollbackFloorOp(project, {
    before, metasBefore, levelsBefore, followRoof: () => {},
    collectBytes: async () => new Map([['p1', serializeGraph(graphs[0])], ...store]),
    applyBytes: () => {}, saveFloorFn: async (id, b) => { saved.push(id); store.set(id, b); },
  });
  assert.deepEqual(saved, ['p3']);
  assert.equal(decodeStair(project, store, 'p3', 's3').riser, 190, 'IDB の riser が元に戻る');
  assert.deepEqual(toasts, []);
  assert.equal(project.riserAutoUpdated.size, 0);
});

test('仕上げモード(skipActiveWalls)でもアクティブ階の明示 riser 200(15段)は階高 3000→3300 で 220 になり、自階の保存バイト列にも 220', async () => {
  const { project, stairs, store } = makeFourFloors();
  const { counts } = await confirm(project, store, { p1: 3300 }, { followers: floorOrderFollowers, skipActiveWalls: true });
  assert.equal(stairs[0].riser, 220, 'ライブ');
  assert.equal(stairs[0].totalSteps, 15);
  assert.equal(counts.save.p1, 1, '自階は他階の前に1回保存される');
  assert.equal(decodeStair(project, store, 'p1', 's1').riser, 220, '保存バイト列を復号しても 220');
});

test('ダイアログの確認一覧(collectFloorSettingsFacts→stairRiserChangesForEdit)と確定後の印(riserAutoUpdated)が一致する（地階・複層の変更を含む）', async () => {
  const project = new Project('proj', 'test');
  const defs = [['b1', -3000, -1, 1], ['p1', 0, 1, 1], ['m', 3000, 2, 2], ['p4', 9000, 4, 1], ['p5', 12000, 5, 1]];
  const graphs = defs.map(([id, el, sf, st]) => project.addPlane(el, id, id, sf, st).graph);
  project.activePlaneId = 'p1';
  graphs[0].addStair({ totalSteps: 16, riser: 185 }, 'sb1');
  graphs[1].addStair({ totalSteps: 15 }, 'sp1');
  graphs[2].addStair({ totalSteps: 30, riser: 205 }, 'sm');
  graphs[3].addStair({ totalSteps: 15, riser: 190 }, 'sp4');
  graphs[4].addStair({ totalSteps: 15 }, 'sp5');
  const store = new Map(graphs.map((g, i) => [defs[i][0], serializeGraph(g)]).filter(([id]) => id !== 'p1'));
  const counts = { peek: {}, save: {} };
  const facts = await collectFloorSettingsFacts(project, { peekFn: makeIo(project, store, counts).peekFn });

  const heights = { b1: 3200, m: 3100, p4: 3300 }; // 地階・複層(1層分)・通常階を同時に変える
  const edit = computeFloorHeightEdit(project.planes, { heights: new Map(Object.entries(heights)) }, 2900, 0);
  const shown = stairRiserChangesForEdit(facts.stairItems, project.planes, edit.updates);
  assert.deepEqual(shown.map(c => c.planeId).sort(), ['b1', 'm', 'p4'], '階高が変わる階の階段だけ（p1・p5 は不変）');

  await confirm(project, store, heights, { stairItems: facts.stairItems });
  assert.deepEqual(
    [...project.riserAutoUpdated].sort(([a], [b]) => a.localeCompare(b)),
    shown.map(c => [c.key, c.to]).sort(([a], [b]) => a.localeCompare(b)),
    '確認一覧の {key, to} と確定後の印が一致',
  );
  assert.equal(decodeStair(project, store, 'b1', 'sb1').riser, 3200 / 16);
  assert.equal(decodeStair(project, store, 'm', 'sm').riser, 6200 / 30);
  assert.equal(decodeStair(project, store, 'p4', 'sp4').riser, 3300 / 15);
});
