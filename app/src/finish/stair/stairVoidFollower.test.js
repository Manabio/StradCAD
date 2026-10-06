// 階操作の follower（stairsBelowRemoval → stairVoidReconcile）と仕上げ突入の整合（reconcileOnFinishEntry）。
// 階段の上階展開は「設置階の直上1階にだけ階段吹抜け（STAIR_VOID）を置く」方式（ユーザー裁定2026-10-06）。
// 前提は実際の経路で作る（applyNaming で階段を指定→syncUpperFloors で直上階へ吹抜けを展開）。peek・保存は
// 本番同型（makeStorePeek・makeStoreSave。IDB 相当の Map のバイト列）で、検証はストアのバイト列を復号した
// グラフに対して行う。applyFloorOrderChange へは floorIo（peekFn・saveFloorFn）で注入する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { runInAction } from 'mobx';
import { StairType, RoomFeature } from '@core';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { diffFloorOpSnapshot, collectPlaneMetas, applyPlaneMetas } from '../../floorOps.js';
import { undoManager } from '../../undoManager.js';
import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { runFinishEntryBoundary } from '../finishBoundary.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from '../../floorOrderChange.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../equipment/equipmentTestFixtures.js';
import { syncUpperFloors, reconcileAllStairVoids, reconcileOnFinishEntry } from './stairFloorSync.js';
import { clearStairVoidsWithoutBelow } from './stairVoidReconcile.js';
import { setupProject, addPerFloorV, placeStair, keyAt, LEFT_HALF } from './stairRemovalTestFixtures.js';

const followers = floorOrderFollowers.filter(f => f.name === 'stairsBelowRemoval' || f.name === 'stairVoidReconcile');
const ui = { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} };

// 3階建て・全階 x=500 の per-floor 中心線・1階（アクティブ）に階段→2階に吹抜け（3階は空）。
async function setup3() {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const [g1] = graphs;
  const placed = placeStair(project, g1);
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  await syncUpperFloors(project, g1, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  store.set('p1', serializeGraph(g1));
  return { project, graphs, g1, store, ...placed };
}

// 1階に階段・2階にユーザー指定の階段（吹抜けがペア部屋へ転用済み）・3階にその階段の吹抜け。アクティブ階は1階。
async function setupChain3() {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const [g1, g2] = graphs;
  const placed = placeStair(project, g1);
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const sync = (g) => syncUpperFloors(project, g, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  await sync(g1);
  restoreGraph(g2, store.get('p2'));
  g2.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(g2, LEFT_HALF[0])]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 });
  store.set('p2', serializeGraph(g2));
  await sync(g1); // 吹抜けがペア部屋へ転用される
  restoreGraph(g2, store.get('p2'));
  runInAction(() => { project.activePlaneId = 'p2'; });
  await sync(g2); // 3階に吹抜け
  runInAction(() => { project.activePlaneId = 'p1'; });
  store.set('p1', serializeGraph(g1));
  store.set('p2', serializeGraph(g2));
  return { project, graphs, g1, g2, store, ...placed };
}

function makeIo(project, store) {
  const peekLog = [];
  const saveLog = [];
  const inner = makeStorePeek(project, store);
  return {
    peekLog, saveLog,
    floorIo: { peekFn: async (p) => { peekLog.push(p.id); return inner(p); }, saveFloorFn: makeStoreSave(store, saveLog) },
  };
}
const decode = (project, store, id) => decodeFloor(project, project.planeMap.get(id), store.get(id));
const voids = (g) => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
const undefs = (g) => g.rooms.filter(r => r.feature === RoomFeature.UNDEFINED);
const meta = (id, name, startFloor, elevation) => ({ id, name, startFloor, elevation });

test('follower の登録順: stairsBelowRemoval → stairVoidReconcile → structuralReflect', () => {
  const names = floorOrderFollowers.map(f => f.name);
  assert.ok(names.indexOf('stairsBelowRemoval') < names.indexOf('stairVoidReconcile'));
  assert.ok(names.indexOf('stairVoidReconcile') < names.indexOf('structuralReflect'));
});

test('INSERT（1階と2階の間に M）: M に吹抜け・旧2階の吹抜けは未定義化・1階の階段は不変。peek は平面ごとに1回・保存は変えた平面だけ', async () => {
  const ctx = await setup3();
  const { project, g1, store } = ctx;
  const stairBefore = serializeGraph(g1);
  assert.equal(voids(decode(project, store, 'p2')).length, 1, '前提: 2階に吹抜けがある');
  const totalSteps = g1.stairs[0].totalSteps;
  const { peekLog, saveLog, floorIo } = makeIo(project, store);

  const bytesBefore = new Map(['p1', 'p2', 'p3'].map(id => [id, id === 'p1' ? serializeGraph(g1) : store.get(id)]));
  const metasBefore = collectPlaneMetas(project);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT,
    updates: [meta('p2', '3階', 3, 6000), meta('p3', '4階', 4, 9000)],
    addPlane: () => project.addPlane(3000, '2階', 'm', 2, 1),
    floorIo, ui,
  }, followers);

  assert.deepEqual([...peekLog].sort(), ['m', 'p2', 'p3'], '平面ごとに1回（アクティブ階の p1 は peek しない）');
  assert.deepEqual([...saveLog].sort(), ['m', 'p2'], '保存は変えた平面だけ（p3・アクティブ階は保存しない）');
  assert.equal(voids(decode(project, store, 'm')).length, 1, 'M に吹抜け');
  assert.equal(voids(decode(project, store, 'p2')).length, 0, '旧2階の吹抜けは孤児');
  assert.equal(undefs(decode(project, store, 'p2')).length, 1, '孤児は未定義化（外形を保つ）');
  assert.equal(g1.stairs.length, 1);
  assert.equal(g1.stairs[0].totalSteps, totalSteps, '階段の段数はそのまま');
  assert.deepEqual(serializeGraph(g1), stairBefore, '設置階（アクティブ）は不変');

  // undo の記録（App.jsx withFloorOpUndo と同じ手順）で、follower が書き換えた階が差分に現れる
  const bytesAfter = new Map(['p1', 'p2', 'p3', 'm'].map(id => [id, id === 'p1' ? serializeGraph(g1) : (store.get(id) ?? null)]));
  const diff = diffFloorOpSnapshot({ before: bytesBefore, after: bytesAfter, metasBefore, metasAfter: collectPlaneMetas(project) });
  assert.deepEqual(diff.addedPlanes.map(m => m.id), ['m']);
  assert.deepEqual(diff.changedSiblings.map(r => r.planeId), ['p2'], '既存階で変わったのは p2 だけ（undo で戻せる）');
  assert.deepEqual(diff.changedSiblings[0].before, bytesBefore.get('p2'));
});

test('INSERT（最上階の上に4階）: 何も変わらない（3階に吹抜けなし・保存なし）', async () => {
  const { project, store } = await setup3();
  const p2Before = Buffer.from(store.get('p2'));
  const p3Before = Buffer.from(store.get('p3'));
  const { saveLog, floorIo } = makeIo(project, store);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates: [],
    addPlane: () => project.addPlane(9000, '4階', 'p4', 4, 1),
    floorIo, ui,
  }, followers);
  assert.deepEqual(saveLog, []);
  assert.ok(Buffer.from(store.get('p2')).equals(p2Before));
  assert.ok(Buffer.from(store.get('p3')).equals(p3Before));
  assert.equal(voids(decode(project, store, 'p3')).length, 0, '3階に吹抜けは置かれない');
});

test('ADD_LOWER（B1 追加）: 何も変わらない', async () => {
  const { project, g1, store } = await setup3();
  const g1Before = serializeGraph(g1);
  const p2Before = Buffer.from(store.get('p2'));
  const { saveLog, floorIo } = makeIo(project, store);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.ADD_LOWER, updates: [],
    addPlane: () => ({ plane: project.addPlane(-3000, 'B1', 'b1', -1, 1).plane }),
    floorIo, ui,
  }, followers);
  assert.deepEqual(saveLog, []);
  assert.deepEqual(serializeGraph(g1), g1Before);
  assert.ok(Buffer.from(store.get('p2')).equals(p2Before));
  assert.equal(g1.stairs.length, 1);
});

test('DELETE（2階を消す。2階にユーザー階段・3階に吹抜け）: 1階の階段が正規経路で消え（ペア部屋は未定義化）、3階の吹抜けは未定義化', async () => {
  const { project, g1, store, room } = await setupChain3();
  const { saveLog, floorIo } = makeIo(project, store);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE,
    updates: [meta('p3', '2階', 2, 3000)],
    removePlane: async () => { project.removePlane('p2'); store.delete('p2'); },
    removedPlane: project.planeMap.get('p2'),
    below: project.planeMap.get('p1'),
    floorIo, ui,
  }, followers);

  assert.equal(g1.stairs.length, 0, '1階の階段が消えた');
  assert.equal(g1.roomMap.get(room.id).feature, RoomFeature.UNDEFINED, 'ペア部屋は未定義化（removeStairOnFloor）');
  const p3 = decode(project, store, 'p3');
  assert.equal(voids(p3).length, 0, '3階の吹抜けは孤児');
  assert.equal(undefs(p3).length, 1);
  assert.deepEqual(saveLog, ['p3']);
});

test('DELETE（3階を消す。2階に吹抜け）: 2階の吹抜けは残り、1階の階段も残る', async () => {
  const { project, g1, store } = await setup3();
  const p2Before = Buffer.from(store.get('p2'));
  const { saveLog, floorIo } = makeIo(project, store);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE, updates: [],
    removePlane: async () => { project.removePlane('p3'); store.delete('p3'); },
    removedPlane: project.planeMap.get('p3'),
    below: project.planeMap.get('p2'),
    floorIo, ui,
  }, followers);
  assert.equal(g1.stairs.length, 1);
  assert.equal(voids(decode(project, store, 'p2')).length, 1);
  assert.ok(Buffer.from(store.get('p2')).equals(p2Before));
  assert.deepEqual(saveLog, []);
});

test('REORDER（1階と2階を入替え）: 直下階が変わった3階に吹抜けが置かれ、最下階になった旧2階の吹抜けは未定義化される', async () => {
  const { project, g1, store } = await setup3();
  const { peekLog, saveLog, floorIo } = makeIo(project, store);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.REORDER,
    updates: [meta('p1', '2階', 2, 3000), meta('p2', '1階', 1, 0)],
    floorIo, ui,
  }, followers);
  assert.equal(voids(decode(project, store, 'p3')).length, 1, '3階の直下階（旧1階）に階段があるので吹抜けが置かれる');
  assert.equal(g1.stairs.length, 1);
  const p2 = decode(project, store, 'p2');
  assert.equal(voids(p2).length, 0, '最下階（直下階なし）の吹抜けは孤児');
  assert.equal(undefs(p2).length, 1);
  assert.deepEqual([...saveLog].sort(), ['p2', 'p3']);
  assert.deepEqual([...peekLog].sort(), ['p2', 'p3'], '平面ごとに1回');
});

test('CHANGE（階変更で並びは同じ）: 変更なしなら保存しない', async () => {
  const { project, store } = await setup3();
  const { saveLog, floorIo } = makeIo(project, store);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.CHANGE, updates: [meta('p3', '4階', 4, 6000)], floorIo, ui,
  }, followers);
  assert.deepEqual(saveLog, []);
});

test('reconcileAllStairVoids: 直上階に roomId なしの階段があれば吹抜けをペア部屋へ転用する（ensureStairRooms を後に回す）', async () => {
  const { project, graphs, store } = await setup3();
  const g2 = graphs[1];
  restoreGraph(g2, store.get('p2'));
  g2.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(g2, LEFT_HALF[0])]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 });
  store.set('p2', serializeGraph(g2));
  const { saveLog, floorIo } = makeIo(project, store);
  const r = await reconcileAllStairVoids(project, floorIo);
  assert.deepEqual(r.changedPlaneIds, ['p2', 'p3'], '2階はペア部屋化、3階には2階の階段の吹抜けが置かれる');
  assert.deepEqual(saveLog, ['p2', 'p3']);
  assert.equal(voids(decode(project, store, 'p3')).length, 1);
  const p2 = decode(project, store, 'p2');
  assert.ok(p2.stairs[0].roomId, 'ペア部屋が作られた');
  assert.equal(p2.roomMap.get(p2.stairs[0].roomId).feature, RoomFeature.STAIR);
  assert.equal(voids(p2).length, 0, '吹抜けは残らない（転用）');
  // 冪等
  saveLog.length = 0;
  assert.deepEqual((await reconcileAllStairVoids(project, floorIo)).changedPlaneIds, []);
  assert.deepEqual(saveLog, []);
});

test('【失敗系】reconcileAllStairVoids: peek がグラフを返さなければ throw し、アクティブ階は元へ戻る（保存しない）', async () => {
  const { project, graphs, store } = await setup3();
  const g2 = graphs[1];
  restoreGraph(g2, store.get('p2'));
  runInAction(() => { project.activePlaneId = 'p2'; });
  for (const v of voids(g2)) g2.removeRoom(v.id); // アクティブの2階から吹抜けを外す（整合すると足される）
  const before = serializeGraph(g2);
  const saveLog = [];
  const inner = makeStorePeek(project, store);
  const peekFn = async (p) => (p.id === 'p3' ? null : inner(p));
  await assert.rejects(
    reconcileAllStairVoids(project, { peekFn, saveFloorFn: makeStoreSave(store, saveLog) }),
    /グラフがありません/,
  );
  assert.deepEqual(serializeGraph(g2), before, '途中まで足した吹抜けが戻っている');
  assert.deepEqual(saveLog, []);
});

test('reconcileAllStairVoids: 採用階が1階だけで吹抜けも無ければ変更なし・保存なし', async () => {
  const { project } = setupProject(1);
  const { saveLog, floorIo } = makeIo(project, new Map());
  assert.deepEqual(await reconcileAllStairVoids(project, floorIo), { changedPlaneIds: [] });
  assert.deepEqual(saveLog, []);
});

test('clearStairVoidsWithoutBelow: 孤児2件は未定義化・無ければ changed=false・graph なしは throw', async () => {
  const { graphs } = setupProject(1);
  const g = graphs[0];
  addPerFloorV(graphs);
  g.addRoom(new Set([keyAt(g, [250, 500])])).setFeature(RoomFeature.STAIR_VOID);
  g.addRoom(new Set([keyAt(g, [750, 500])])).setFeature(RoomFeature.STAIR_VOID);
  const r = clearStairVoidsWithoutBelow(g);
  assert.equal(r.changed, true);
  assert.equal(r.removed.length, 2);
  assert.equal(voids(g).length, 0);
  assert.equal(undefs(g).length, 2);
  assert.deepEqual(clearStairVoidsWithoutBelow(g), { changed: false, removed: [] });
  assert.throws(() => clearStairVoidsWithoutBelow(null), /graph がありません/);
});

// ---- 仕上げ突入 ----

test('突入: 中間階（2階）に直下階の階段の吹抜けが補完され、2回目は変更なし', async () => {
  const { project, store } = await setup3();
  const g2 = decode(project, store, 'p2');
  for (const v of voids(g2)) g2.removeRoom(v.id);
  assert.equal(voids(g2).length, 0, '前提: 吹抜けが無い');
  const peeked = [];
  const inner = makeStorePeek(project, store);
  const peekFn = async (p) => { peeked.push(p.id); return inner(p); };
  assert.equal(await reconcileOnFinishEntry(project, g2, { peekFn }), true);
  assert.equal(voids(g2).length, 1);
  assert.deepEqual(peeked, ['p1'], '直下階だけ peek する');
  const after1 = serializeGraph(g2);
  assert.equal(await reconcileOnFinishEntry(project, g2, { peekFn }), false);
  assert.deepEqual(serializeGraph(g2), after1);
});

test('突入: 最下階は peek せず、吹抜けが無ければ何もしない。孤児の吹抜けがあれば未定義化する', async () => {
  const { project, g1 } = await setup3();
  const peeked = [];
  const peekFn = async (p) => { peeked.push(p.id); return null; };
  assert.equal(await reconcileOnFinishEntry(project, g1, { peekFn }), false);
  g1.addRoom(new Set([keyAt(g1, [750, 500])])).setFeature(RoomFeature.STAIR_VOID);
  assert.equal(await reconcileOnFinishEntry(project, g1, { peekFn }), true);
  assert.equal(voids(g1).length, 0);
  assert.equal(undefs(g1).length, 1);
  assert.deepEqual(peeked, []);
});

test('突入: 直上階の階段（roomId なし）への吹抜けの転用は reconcileOnFinishEntry では行わない（突入境界の ensureStairRooms に任せる）', async () => {
  const { project, store } = await setup3();
  const g2 = decode(project, store, 'p2');
  g2.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(g2, LEFT_HALF[0])]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 });
  await reconcileOnFinishEntry(project, g2, { peekFn: makeStorePeek(project, store) });
  assert.equal(g2.stairs[0].roomId, null, 'ペア部屋は作らない');
  assert.equal(voids(g2).length, 1, '吹抜けは残る（後続の ensureStairRooms が転用する）');
});

test('突入: 孤児の吹抜け（直下階に階段が無い）は未定義化される', async () => {
  const { project, store } = await setup3();
  const g3 = decode(project, store, 'p3');
  const cells = new Set([keyAt(g3, LEFT_HALF[0])]);
  g3.addRoom(cells).setFeature(RoomFeature.STAIR_VOID); // 2階には階段が無い（1階の階段の吹抜けは2階）
  const peekFn = makeStorePeek(project, store);
  assert.equal(await reconcileOnFinishEntry(project, g3, { peekFn }), true);
  assert.equal(voids(g3).length, 0);
  assert.equal(undefs(g3).length, 1);
});

test('【失敗系】突入: 直下階の peek がグラフを返さなければ throw し、自階は変えない', async () => {
  const { project, store } = await setup3();
  const g2 = decode(project, store, 'p2');
  const before = serializeGraph(g2);
  await assert.rejects(reconcileOnFinishEntry(project, g2, { peekFn: async () => null }), /直下階のグラフがありません/);
  assert.deepEqual(serializeGraph(g2), before);
});

// ---- 突入境界（runFinishEntryBoundary）を通した結果 ----

// floorSwapManager.peek を store の peek へ差し替えて fn を走らせる（finishBoundary.test.js と同じ流儀）
async function withStorePeek(project, store, fn) {
  const original = floorSwapManager.peek;
  const peek = makeStorePeek(project, store);
  floorSwapManager.peek = async (plane) => peek(plane);
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

// 2階（アクティブ）のライブグラフを保存データから復元して返す
function liveG2(ctx) {
  const g2 = ctx.graphs[1];
  restoreGraph(g2, ctx.store.get('p2'));
  runInAction(() => { ctx.project.activePlaneId = 'p2'; });
  return g2;
}
const addUserStair = (g) => g.addStair({
  type: StairType.STRAIGHT, cells: new Set([keyAt(g, LEFT_HALF[0])]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
});

test('突入境界: 2階に roomId なしの階段（吹抜けなし）があれば、整合のあと転用でペア部屋が付き、吹抜けは0件', async () => {
  const ctx = await setup3();
  const g2 = liveG2(ctx);
  for (const v of voids(g2)) g2.removeRoom(v.id);
  addUserStair(g2);
  await withStorePeek(ctx.project, ctx.store, () => runFinishEntryBoundary(g2, ctx.project));
  assert.ok(g2.stairs[0].roomId, 'ペア部屋が付いた');
  assert.equal(g2.roomMap.get(g2.stairs[0].roomId).feature, RoomFeature.STAIR);
  assert.equal(voids(g2).length, 0);
});

test('突入境界: 2階に吹抜けがあり roomId なしの階段が重なるなら、吹抜けがペア部屋へ転用される（整合が先・転用が後）', async () => {
  const ctx = await setup3();
  const g2 = liveG2(ctx);
  const voidId = voids(g2)[0].id;
  addUserStair(g2);
  await withStorePeek(ctx.project, ctx.store, () => runFinishEntryBoundary(g2, ctx.project));
  assert.equal(g2.stairs[0].roomId, voidId, '吹抜けがペア部屋として使われた');
  assert.equal(g2.roomMap.get(voidId).feature, RoomFeature.STAIR);
  assert.equal(voids(g2).length, 0);
});

test('突入境界: 2階に吹抜けが欠けていれば補完される。undo しても吹抜けは残る（undo 対象外）', async () => {
  const ctx = await setup3();
  const g2 = liveG2(ctx);
  for (const v of voids(g2)) g2.removeRoom(v.id);
  assert.equal(voids(g2).length, 0, '前提: 吹抜けが無い');
  const undoBefore = undoManager.peekUndo();
  await withStorePeek(ctx.project, ctx.store, () => runFinishEntryBoundary(g2, ctx.project));
  assert.equal(voids(g2).length, 1, '補完された');
  if (undoManager.peekUndo() !== undoBefore) undoManager.undo();
  assert.equal(voids(g2).length, 1, 'undo しても残る');
});

// ---- 保存途中の失敗 ----

test('【失敗系】reconcileAllStairVoids: 2階目の保存で失敗したら、保存済みの階が変更前のバイト列に戻り、元の例外を再スローする', async () => {
  const ctx = await setup3();
  const { project, g1, store } = ctx;
  // 1階と2階を入替え済みの状態（旧2階=最下階の孤児吹抜けと、3階の吹抜け補完の2階分が変わる）
  applyPlaneMetas(project, [meta('p1', '2階', 2, 3000), meta('p2', '1階', 1, 0)]);
  const p2Before = Buffer.from(store.get('p2'));
  const p3Before = Buffer.from(store.get('p3'));
  restoreGraph(g1, serializeGraph(g1)); // fixture の素のグラフは一度 restore すると正規化される。比較は正規化後に揃える
  const g1Before = serializeGraph(g1);
  const saveLog = [];
  const peekFn = makeStorePeek(project, store);
  await assert.rejects(
    reconcileAllStairVoids(project, { peekFn, saveFloorFn: makeStoreSave(store, saveLog, { failOn: 'p3' }) }),
    /意図した失敗/,
  );
  assert.deepEqual(saveLog, ['p2', 'p2'], 'p2 を保存→p3 で失敗→p2 を巻き戻し保存');
  assert.ok(Buffer.from(store.get('p2')).equals(p2Before), 'p2 は変更前のバイト列');
  assert.ok(Buffer.from(store.get('p3')).equals(p3Before));
  assert.deepEqual(serializeGraph(g1), g1Before, 'アクティブ階も変更前');
});
