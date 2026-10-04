// finish/stair/stairFloorSync.js runStairRemoval（階段の削除・上の階への連動）の単体テスト。
//
// 前提は実際の経路で作る（applyNaming で階段を指定→syncUpperFloors で上の階へ展開）。peek・保存は本番同型
// （makeStorePeek・makeStoreSave。IDB 相当の Map のバイト列）で、検証は必ずストアのバイト列を復号した
// グラフに対して行う（生きたグラフを返すスタブは使わない）。失敗・干渉の注入は発火回数を assert する。
// peekFn・saveFloorFn は注入する（floorSwapManager.peek・storage/db.js saveFloor は差し替えない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { StairType, RoomFeature, RoomKind, CenterLineType, Discipline } from '@core';
import { serializeGraph, restoreGraph } from '../../graphSnapshot.js';
import { undoManager } from '../../undoManager.js';
import { noteFloorWrite } from '../../storage/floorWriteGeneration.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../equipment/equipmentTestFixtures.js';
import { runStairRemoval, syncUpperFloors } from './stairFloorSync.js';
import { FinishModeState } from '../../modes/FinishModeState.js';
import { removeStairOnFloor } from './stairRemoval.js';
import { findUnderStairSplitCLs, ensureUnderStairSplit } from './stairUnderSplit.js';
import { cellBoundsFromKey } from '../gridCells.js';
import { setupProject, addPerFloorV, placeStair, LEFT_HALF } from './stairRemovalTestFixtures.js';
import {
  ERR_STAIR_DELETE_CONTINUATION, ERR_STAIR_DELETE_FAILED, ERR_STAIR_FLOORS_CHANGED,
} from '../../error.js';

const alwaysValid = () => true;
const flush = () => new Promise(resolve => setTimeout(resolve, 0)); // 投げっぱなしの保存（fire-and-forget）を待つ

// n 階建て・全階 x=500 の per-floor 中心線・1階（アクティブ）に階段を指定→上の階へ展開（保存済み）。
async function setup(n, opts) {
  const { project, graphs } = setupProject(n);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const placed = placeStair(project, g1, opts);
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  const syncLog = [];
  await syncUpperFloors(project, g1, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, syncLog) });
  store.set('p1', serializeGraph(g1)); // 設置階（本番は階切替の保存。直下階 peek の対象になる）
  return { project, graphs, g1, store, ...placed };
}
const decode = (project, store, id) => decodeFloor(project, project.planeMap.get(id), store.get(id));

/** commitActive の実体（FinishModeState.deleteStair の代役）: 階段を実際に消して本物の undo エントリを返す。 */
function makeCommit(graph, stairId, counter, { throws = false, returnsNull = false } = {}) {
  return () => {
    counter.calls++;
    if (throws) throw new Error('commitActive: 意図した失敗');
    if (returnsNull) return null;
    const before = serializeGraph(graph);
    removeStairOnFloor(graph, graph.stairMap.get(stairId));
    const after = serializeGraph(graph);
    return undoManager.push(() => restoreGraph(graph, before), () => restoreGraph(graph, after));
  };
}

function run(ctx, overrides = {}) {
  const counter = overrides.counter ?? { calls: 0 };
  const saveLog = overrides.saveLog ?? [];
  const params = {
    project: ctx.project, activeGraph: ctx.g1, stairId: ctx.stair.id,
    commitActive: makeCommit(ctx.g1, ctx.stair.id, counter),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(ctx.project, ctx.store),
    saveFloorFn: makeStoreSave(ctx.store, saveLog),
    ...overrides,
  };
  delete params.counter; delete params.saveLog;
  return { promise: runStairRemoval(params), counter, saveLog };
}

const centerLineCount = (g) => g.centerLines.length;
const voidRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
const undefinedRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.UNDEFINED);

// ================================================================
// 正常系
// ================================================================

test('(a) 3階建て: 設置階で削除→2階は階段なし・ペア部屋は未定義、3階は吹抜けが未定義、上の階の中心線の本数は不変。保存は2階→3階', async () => {
  const ctx = await setup(3);
  const before2 = decode(ctx.project, ctx.store, 'p2');
  const before3 = decode(ctx.project, ctx.store, 'p3');
  const pairId2 = before2.stairs[0].roomId;
  assert.ok(pairId2 && voidRooms(before3).length === 1, '前提: 2階に階段とペア部屋・3階に階段吹抜け');

  const { promise, counter, saveLog } = run(ctx);
  const result = await promise;

  assert.deepEqual(result, { status: 'removed', upperCount: 2 });
  assert.deepEqual(saveLog, ['p2', 'p3']);
  assert.equal(counter.calls, 1);
  assert.equal(ctx.g1.stairs.length, 0, '設置階の階段が消える');
  const after2 = decode(ctx.project, ctx.store, 'p2');
  const after3 = decode(ctx.project, ctx.store, 'p3');
  assert.equal(after2.stairs.length, 0);
  assert.equal(after2.roomMap.get(pairId2)?.feature, RoomFeature.UNDEFINED, '2階のペア部屋は未定義化（外形を保つ）');
  assert.equal(voidRooms(after3).length, 0);
  assert.equal(undefinedRooms(after3).length, 1, '3階の吹抜けは未定義化');
  assert.equal(centerLineCount(after2), centerLineCount(before2), '2階の中心線は消さない');
  assert.equal(centerLineCount(after3), centerLineCount(before3), '3階の中心線は消さない');
});

test('(b) 2階建て: 設置階で削除→2階の階段吹抜けが未定義化', async () => {
  const ctx = await setup(2);
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1, '前提: 吹抜けがある');
  const { promise, saveLog } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 1 });
  assert.deepEqual(saveLog, ['p2']);
  const after2 = decode(ctx.project, ctx.store, 'p2');
  assert.equal(voidRooms(after2).length, 0);
  assert.equal(undefinedRooms(after2).length, 1);
});

test('(c) 屋外階段の3階建て: 2階の分身のペア部屋（屋内）が未定義化される（3階は何も展開されていないので対象外）', async () => {
  const ctx = await setup(3, { kind: RoomKind.EXTERIOR });
  const before2 = decode(ctx.project, ctx.store, 'p2');
  const pair2 = before2.roomMap.get(before2.stairs[0].roomId);
  assert.equal(pair2.kind, RoomKind.INTERIOR, '前提: 上の階の分身のペア部屋は屋内で作られている');

  const { promise, saveLog } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 1 });
  assert.deepEqual(saveLog, ['p2']);
  const after2 = decode(ctx.project, ctx.store, 'p2');
  assert.equal(after2.stairs.length, 0);
  assert.equal(after2.roomMap.get(pair2.id)?.feature, RoomFeature.UNDEFINED);
});

test('(d) 上の階に同 footprint が無い→removed・upperCount 0・保存の記録が空（設置階だけ確定）', async () => {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const { stair } = placeStair(project, g1); // 上の階へ展開しない
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const ctx = { project, g1, store, stair };
  const { promise, counter, saveLog } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 0 });
  assert.deepEqual(saveLog, []);
  assert.equal(counter.calls, 1);
  assert.equal(g1.stairs.length, 0);
});

test('noop: アクティブ階に無い階段idは何もしない（peek・保存・commitActive なし）', async () => {
  const ctx = await setup(2);
  const peeked = [];
  const base = makeStorePeek(ctx.project, ctx.store);
  const { promise, counter, saveLog } = run(ctx, { stairId: 'no-such-stair', peekFn: async (p) => { peeked.push(p.id); return base(p); } });
  assert.deepEqual(await promise, { status: 'noop' });
  assert.deepEqual([peeked, saveLog, counter.calls], [[], [], 0]);
});

// ================================================================
// 拒否: 中間階（下の階から続く階段）
// ================================================================

test('(e) 中間階（2階をアクティブ）から実行→rejected・保存ゼロ・commitActive 0回', async () => {
  const ctx = await setup(3);
  const g2 = ctx.graphs[1];
  restoreGraph(g2, ctx.store.get('p2'));
  runInAction(() => { ctx.project.activePlaneId = g2.plane.id; });
  const stair2 = g2.stairs[0];
  assert.ok(stair2, '前提: 2階に階段がある');
  const storeBefore = new Map(ctx.store);

  const counter = { calls: 0 };
  const { promise, saveLog } = run(ctx, {
    counter, activeGraph: g2, stairId: stair2.id, commitActive: makeCommit(g2, stair2.id, counter),
  });
  const result = await promise;
  assert.deepEqual(result, { status: 'rejected', message: ERR_STAIR_DELETE_CONTINUATION });
  assert.equal(counter.calls, 0, 'commitActive は呼ばれない');
  assert.deepEqual(saveLog, []);
  for (const [id, bytes] of storeBefore) assert.equal(ctx.store.get(id), bytes, `${id} のストアは不変`);
  assert.equal(g2.stairs.length, 1, '階段は消えていない');
});

// ================================================================
// undo / redo
// ================================================================

test('(f) undo→redo→undo の往復: 各段でストアのバイト列が before/after と一致し、onApplied の回数が期待どおり', async () => {
  const ctx = await setup(3);
  const peek = makeStorePeek(ctx.project, ctx.store);
  const before = new Map(['p2', 'p3'].map(id => [id, serializeGraph(peek(ctx.project.planeMap.get(id)))]));
  let applied = 0;

  const { promise } = run(ctx, { onApplied: () => { applied++; } });
  assert.equal((await promise).status, 'removed');
  assert.equal(applied, 1, '確定直後に1回');
  const after = new Map(['p2', 'p3'].map(id => [id, ctx.store.get(id)]));
  for (const id of ['p2', 'p3']) assert.notDeepEqual(after.get(id), before.get(id), `前提: ${id} は削除で変わっている`);

  undoManager.undo();
  await flush();
  assert.equal(applied, 2, 'undo後に2回');
  for (const id of ['p2', 'p3']) assert.deepEqual(ctx.store.get(id), before.get(id), `undoで${id}が before のバイト列に戻る`);
  assert.equal(ctx.g1.stairs.length, 1, '設置階も戻る');
  assert.equal(decode(ctx.project, ctx.store, 'p2').stairs.length, 1);

  undoManager.redo();
  await flush();
  assert.equal(applied, 3, 'redo後に3回');
  for (const id of ['p2', 'p3']) assert.deepEqual(ctx.store.get(id), after.get(id), `redoで${id}が after のバイト列になる`);
  assert.equal(ctx.g1.stairs.length, 0);

  undoManager.undo();
  await flush();
  assert.equal(applied, 4, '2度目のundo後に4回');
  for (const id of ['p2', 'p3']) assert.deepEqual(ctx.store.get(id), before.get(id));
  assert.equal(ctx.g1.stairs.length, 1);
});

// ================================================================
// 失敗系
// ================================================================

test('(g) 3階の peek が失敗→識別コード付きで throw・ストア無変更・commitActive 0回（注入の発火は1回）', async () => {
  const ctx = await setup(3);
  const storeBefore = new Map(ctx.store);
  const base = makeStorePeek(ctx.project, ctx.store);
  let fired = 0;
  const peekFn = async (plane) => {
    if (plane.id === 'p3') { fired++; throw new Error('IDB読込み失敗（意図した失敗）'); }
    return base(plane);
  };
  const { promise, counter, saveLog } = run(ctx, { peekFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(fired, 1);
  assert.equal(counter.calls, 0);
  assert.deepEqual(saveLog, []);
  for (const [id, bytes] of storeBefore) assert.equal(ctx.store.get(id), bytes, `${id} のストアは不変`);
  assert.equal(ctx.g1.stairs.length, 1);
});

test('(h) 3階の保存が失敗→2階が before に戻る・commitActive 0回・識別コード付きで throw（注入の発火は1回）', async () => {
  const ctx = await setup(3);
  const failing = makeStoreSave(ctx.store, [], { failOn: 'p3' });
  let fired = 0;
  const saveFloorFn = async (id, bytes) => { if (id === 'p3') fired++; return failing(id, bytes); };
  const saveLog = [];
  const logging = async (id, bytes) => { saveLog.push(id); return saveFloorFn(id, bytes); };
  const { promise, counter } = run(ctx, { saveFloorFn: logging });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(fired, 1);
  assert.deepEqual(saveLog, ['p2', 'p3', 'p2'], '2階は削除で1回・巻き戻しで1回（3階の保存は失敗）');
  assert.equal(counter.calls, 0);
  assert.equal(decode(ctx.project, ctx.store, 'p2').stairs.length, 1, '2階は before へ戻る');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p3')).length, 1);
  assert.equal(ctx.g1.stairs.length, 1);
});

test('(h2) 3階の変更処理が例外→2階が before に戻る・commitActive 0回・undo 件数不変（注入の発火は1回）', async () => {
  const ctx = await setup(3);
  const base = makeStorePeek(ctx.project, ctx.store);
  let fired = 0;
  const peekFn = async (plane) => {
    const g = base(plane);
    if (plane.id === 'p3') g.rooms.forEach(r => { r.setFeature = () => { fired++; throw new Error('注入した変更処理の失敗'); }; });
    return g;
  };
  const undoCount = undoManager._undoStack.length;
  const { promise, counter } = run(ctx, { peekFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(fired, 1, '注入は3階の吹抜けの未定義化で1回だけ発火する');
  assert.equal(counter.calls, 0);
  assert.equal(undoManager._undoStack.length, undoCount);
  assert.equal(decode(ctx.project, ctx.store, 'p2').stairs.length, 1, '2階は before へ戻る');
});

test('(i) commitActive が throw→上の階が before に戻る・識別コード付きで throw', async () => {
  const ctx = await setup(3);
  const counter = { calls: 0 };
  const { promise } = run(ctx, { counter, commitActive: makeCommit(ctx.g1, ctx.stair.id, counter, { throws: true }) });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(counter.calls, 1, '注入（commitActive の例外）は1回発火');
  assert.equal(decode(ctx.project, ctx.store, 'p2').stairs.length, 1);
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p3')).length, 1);
});

test('(i2) commitActive が undo エントリを返さない(null)→上の階が before に戻る・識別コード付きで throw', async () => {
  const ctx = await setup(2);
  const counter = { calls: 0 };
  const { promise } = run(ctx, { counter, commitActive: makeCommit(ctx.g1, ctx.stair.id, counter, { returnsNull: true }) });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(counter.calls, 1);
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1);
});

test('(j) 世代の不一致（3階の peek 後に別処理が書込み）→巻き戻して aborted と ERR_STAIR_FLOORS_CHANGED（発火は1回）', async () => {
  const ctx = await setup(3);
  const base = makeStorePeek(ctx.project, ctx.store);
  let fired = 0;
  const peekFn = async (plane) => {
    const g = base(plane);
    if (plane.id === 'p3') { noteFloorWrite(plane.id); fired++; }
    return g;
  };
  const { promise, counter } = run(ctx, { peekFn });
  const result = await promise;
  assert.deepEqual(result, { status: 'aborted', message: ERR_STAIR_FLOORS_CHANGED });
  assert.equal(fired, 1);
  assert.equal(counter.calls, 0);
  assert.equal(decode(ctx.project, ctx.store, 'p2').stairs.length, 1, '保存済みだった2階は巻き戻る');
});

test('isStillValid が最初から偽→aborted・書込みゼロ。保存後に偽→巻き戻して aborted', async () => {
  const first = await setup(3);
  const r1 = run(first, { isStillValid: () => false });
  assert.deepEqual(await r1.promise, { status: 'aborted', message: null });
  assert.deepEqual([r1.saveLog, r1.counter.calls], [[], 0]);

  const second = await setup(3);
  let n = 0;
  const r2 = run(second, { isStillValid: () => ++n === 1 });
  assert.deepEqual(await r2.promise, { status: 'aborted', message: null });
  assert.equal(n, 2, '再確認まで進んだ');
  assert.deepEqual(r2.saveLog, ['p2', 'p3', 'p2', 'p3'], '保存→巻き戻し');
  assert.equal(r2.counter.calls, 0);
  assert.equal(decode(second.project, second.store, 'p2').stairs.length, 1);
  assert.equal(voidRooms(decode(second.project, second.store, 'p3')).length, 1);
});

test('連動削除の対象にアクティブ階が含まれる（project のアクティブ階が上の階）→黙って上書きせず throw・書込みゼロ', async () => {
  const ctx = await setup(3);
  runInAction(() => { ctx.project.activePlaneId = 'p2'; }); // 不整合: activeGraph(1階)と project のアクティブ階が食い違う
  const { promise, counter, saveLog } = run(ctx);
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.deepEqual([saveLog, counter.calls], [[], 0]);
});

test('(h3) 3階の保存が失敗し、2階の巻き戻しも失敗→例外の code は ERR_STAIR_DELETE_FAILED・commitActive 0回（注入の発火は各1回）', async () => {
  const ctx = await setup(3);
  const store = ctx.store;
  const base = makeStoreSave(store, []);
  let p3Fired = 0;
  let p2Calls = 0;
  let rollbackFired = 0;
  const saveFloorFn = async (id, bytes) => {
    if (id === 'p3') { p3Fired++; throw new Error('保存失敗（意図した失敗）'); }
    if (id === 'p2' && ++p2Calls === 2) { rollbackFired++; throw new Error('巻き戻し失敗（意図した失敗）'); }
    return base(id, bytes);
  };
  const { promise, counter } = run(ctx, { saveFloorFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(p3Fired, 1, '3階の保存失敗の注入は1回');
  assert.equal(rollbackFired, 1, '2階の巻き戻し失敗の注入は1回');
  assert.equal(counter.calls, 0, 'commitActive は呼ばれない');
});

test('(i) 同じ階に階段が2つ（別位置）、片方だけ削除→もう片方の2階の分身と3階の吹抜けが無傷', async () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const a = placeStair(project, g1, { pts: LEFT_HALF });
  const b = placeStair(project, g1, { pts: [[750, 500]] });
  assert.notEqual(a.stair.id, b.stair.id);
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  await syncUpperFloors(project, g1, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  store.set('p1', serializeGraph(g1));
  assert.equal(decode(project, store, 'p2').stairs.length, 2, '前提: 2階に分身が2つ');
  assert.equal(voidRooms(decode(project, store, 'p3')).length, 2, '前提: 3階に吹抜けが2つ');
  const before2 = decode(project, store, 'p2');
  const stairB2 = before2.stairs.find(s => cellBoundsFromKey([...s.cells][0], before2).x1 >= 500); // 右半分 [500,1000]（B）
  assert.ok(stairB2, '前提: 2階に B の分身がある');
  const keyOfB2 = [...stairB2.cells];

  const ctx = { project, g1, store, stair: a.stair };
  const { promise } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 2 });

  const after2 = decode(project, store, 'p2');
  const after3 = decode(project, store, 'p3');
  assert.equal(after2.stairs.length, 1, '2階はもう片方の分身だけ残る');
  assert.equal(after2.roomMap.get(after2.stairs[0].roomId)?.feature, RoomFeature.STAIR, '残った分身のペア部屋は階段のまま');
  assert.deepEqual([...after2.stairs[0].cells], keyOfB2, '残った分身の footprint は不変');
  assert.equal(voidRooms(after3).length, 1, '3階の吹抜けはもう片方だけ残る');
  assert.equal(undefinedRooms(after3).length, 1, '3階の消えた側は未定義化');
  assert.equal(g1.stairs.length, 1);
  assert.equal(g1.stairs[0].id, b.stair.id);
});

test('(ii) 上の階が直進（STRAIGHT）階段＋階段下の分割CL→連鎖で2階の階段0・ペア部屋は未定義でセルが解決できる・分割CLは階段と一緒に消え、per-floor 中心線は残る', async () => {
  const { project, graphs } = setupProject(3);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const { stair } = placeStair(project, g1, { pts: [[250, 2000]] }); // 500x2000 の縦長
  stair.setField('type', StairType.STRAIGHT);
  stair.setField('sections', null);
  stair.setField('upDirection', 'up');
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  await syncUpperFloors(project, g1, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  store.set('p1', serializeGraph(g1));

  // 2階の分身に階段下の分割CLを足して保存する（本番では2階で階段を編集したときに生じる状態）
  const g2 = decode(project, store, 'p2');
  assert.equal(g2.stairs.length, 1, '前提: 2階に分身');
  assert.equal(g2.stairs[0].type, StairType.STRAIGHT, '前提: 直進');
  ensureUnderStairSplit(g2.stairs[0], g2, null);
  assert.equal(findUnderStairSplitCLs(g2.stairs[0], g2).length, 1, '前提: 2階に階段下の分割CLがある');
  store.set('p2', serializeGraph(g2));
  const clBefore = decode(project, store, 'p2').centerLines.length;
  const pairId2 = g2.stairs[0].roomId;

  const { promise } = run({ project, g1, store, stair });
  assert.equal((await promise).status, 'removed');

  const after2 = decode(project, store, 'p2');
  assert.equal(after2.stairs.length, 0, '2階の階段は消える');
  assert.equal(after2.centerLines.length, clBefore - 1, '階段下の分割CLだけ1本消え、per-floor 中心線は残る');
  const pair = after2.roomMap.get(pairId2);
  assert.equal(pair?.feature, RoomFeature.UNDEFINED, 'ペア部屋は未定義');
  assert.ok(pair.cells.size > 0);
  for (const key of pair.cells) assert.ok(cellBoundsFromKey(key, after2), `未定義部屋のセル ${key} が解決できる`);
});

// ================================================================
// 検討案の平面
// ================================================================

test('検討案の平面がアクティブ→自階だけ確定。上の階の peek・保存なし、undo/redo で onApplied が呼ばれる', async () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const { graph: alt } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  const stair = alt.addStair({ type: StairType.STRAIGHT, cells: new Set(), upDirection: 'up' });
  const store = new Map();
  const peeked = [];
  const base = makeStorePeek(project, store);
  let applied = 0;
  const counter = { calls: 0 };
  const saveLog = [];
  const result = await runStairRemoval({
    project, activeGraph: alt, stairId: stair.id,
    commitActive: makeCommit(alt, stair.id, counter),
    isStillValid: alwaysValid, onApplied: () => { applied++; },
    peekFn: async (p) => { peeked.push(p.id); return base(p); },
    saveFloorFn: makeStoreSave(store, saveLog),
  });
  assert.deepEqual(result, { status: 'removed', upperCount: 0 });
  assert.deepEqual([peeked, saveLog, counter.calls, applied], [[], [], 1, 1]);
  assert.equal(alt.stairs.length, 0);
  undoManager.undo();
  assert.equal(applied, 2);
  assert.equal(alt.stairs.length, 1);
  undoManager.redo();
  assert.equal(applied, 3);
});

// ================================================================
// (k) 削除→再指定
// ================================================================

test('(k) 削除→同じ位置へ再指定（syncUpperFloors を再実行）→2階にペア部屋付きの階段・3階に STAIR_VOID ができる', async () => {
  const ctx = await setup(3);
  const { promise } = run(ctx);
  assert.equal((await promise).status, 'removed');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p3')).length, 0, '前提: 吹抜けは未定義化済み');

  const again = placeStair(ctx.project, ctx.g1);
  assert.equal(again.stair.cells.size > 0, true);
  await syncUpperFloors(ctx.project, ctx.g1, {
    peekFn: makeStorePeek(ctx.project, ctx.store), saveFloorFn: makeStoreSave(ctx.store, []),
  });

  const after2 = decode(ctx.project, ctx.store, 'p2');
  const after3 = decode(ctx.project, ctx.store, 'p3');
  assert.equal(after2.stairs.length, 1, '2階に階段');
  const pair = after2.roomMap.get(after2.stairs[0].roomId);
  assert.equal(pair?.feature, RoomFeature.STAIR, '2階の階段にペア部屋がある');
  assert.equal(voidRooms(after3).length, 1, '3階に階段吹抜け');
  assert.equal(undefinedRooms(after2).length, 0, '2階の未定義部屋は引き抜かれて残らない');
  assert.equal(undefinedRooms(after3).length, 0, '3階の未定義部屋は引き抜かれて残らない');
});

// ================================================================
// 部屋カードの削除（commitActive が deleteRoom。件B 裁定2: 自階の結果は従来の deleteRoom と同じ）
// ================================================================

test('commitActive が FinishModeState.deleteRoom（部屋カードの削除）でも、上の階が連動して消え、undo 1回で全階が戻る', async () => {
  const ctx = await setup(3);
  const state = new FinishModeState(ctx.g1, ctx.project);
  const before = new Map(['p2', 'p3'].map(id => [id, ctx.store.get(id)]));
  const counter = { calls: 0 };
  const commitActive = () => { counter.calls++; state.deleteRoom(ctx.room.id); return state.lastRoomUndoEntry; };

  const { promise, saveLog } = run(ctx, { commitActive });
  assert.deepEqual(await promise, { status: 'removed', upperCount: 2 });
  assert.deepEqual(saveLog, ['p2', 'p3']);
  assert.equal(counter.calls, 1);
  assert.equal(ctx.g1.stairs.length, 0, '設置階の階段が消える');
  assert.equal(ctx.g1.roomMap.get(ctx.room.id)?.feature, RoomFeature.UNDEFINED, '設置階のペア部屋は deleteRoom と同じ未定義化');
  assert.equal(decode(ctx.project, ctx.store, 'p2').stairs.length, 0, '2階の分身が消える');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p3')).length, 0, '3階の吹抜けが消える');

  undoManager.undo(); // 1回で設置階・2階・3階が戻る
  await flush();
  assert.equal(ctx.g1.stairs.length, 1);
  assert.equal(ctx.g1.roomMap.get(ctx.room.id)?.feature, RoomFeature.STAIR);
  for (const id of ['p2', 'p3']) assert.deepEqual(ctx.store.get(id), before.get(id), `undo 1回で${id}が before のバイト列に戻る`);
});

test('【失敗系】部屋カードの削除でも中間階（2階をアクティブ）は rejected・commitActive 0回・保存ゼロ', async () => {
  const ctx = await setup(3);
  const g2 = decode(ctx.project, ctx.store, 'p2');
  const state = new FinishModeState(g2, ctx.project);
  const roomId = g2.stairs[0].roomId;
  ctx.project.activePlaneId = 'p2';
  const counter = { calls: 0 };
  const commitActive = () => { counter.calls++; state.deleteRoom(roomId); return state.lastRoomUndoEntry; };
  const saveLog = [];
  const result = await runStairRemoval({
    project: ctx.project, activeGraph: g2, stairId: g2.stairs[0].id, commitActive,
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(ctx.project, ctx.store), saveFloorFn: makeStoreSave(ctx.store, saveLog),
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.message, ERR_STAIR_DELETE_CONTINUATION);
  assert.deepEqual([counter.calls, saveLog], [0, []]);
});
