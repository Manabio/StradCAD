// finish/stair/stairFloorSync.js runStairRemoval（階段の削除）の単体テスト。
//
// 新モデル: どの階の階段も自階で削除できる（拒否なし）。削除すると直上1階の同 footprint の階段吹抜け
// （STAIR_VOID）を全部未定義化し、直上階のユーザー指定の階段・N+2 以上は触らない。自階の削除後には直下階の
// 階段の足元の吹抜けを reconcileStairVoids で自階へ復元する（直下階は確定前に peek する）。
// 前提は実際の経路で作る（applyNaming で階段を指定→syncUpperFloors で直上階へ展開）。peek・保存は本番同型
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
import { cellBoundsFromKey, refreshCells } from '../gridCells.js';
import { setupProject, addPerFloorV, placeStair, keyAt, LEFT_HALF } from './stairRemovalTestFixtures.js';
import { ERR_STAIR_DELETE_FAILED, ERR_STAIR_FLOORS_CHANGED } from '../../error.js';

const alwaysValid = () => true;
const flush = () => new Promise(resolve => setTimeout(resolve, 0)); // 投げっぱなしの保存（fire-and-forget）を待つ

// n 階建て・全階 x=500 の per-floor 中心線・1階（アクティブ）に階段を指定→直上階へ展開（2階に吹抜け・保存済み）。
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

// 3階建て: 1階の階段の上に、2階でユーザーが階段を指定済み（同 footprint。元の吹抜けはペア部屋へ転用済み）で、
// 3階にはその階段の吹抜けがある。2階（g2）は生きたグラフ（保存バイト列から復元）。アクティブ階は1階。
async function setupChain() {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const [g1, g2] = graphs;
  const placed = placeStair(project, g1);
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const sync = (g) => syncUpperFloors(project, g, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  await sync(g1); // 2階に吹抜け
  restoreGraph(g2, store.get('p2'));
  const voidId = g2.rooms.find(r => r.feature === RoomFeature.STAIR_VOID).id;
  g2.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(g2, LEFT_HALF[0])]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 });
  store.set('p2', serializeGraph(g2));
  await sync(g1); // 吹抜けがペア部屋へ転用される
  restoreGraph(g2, store.get('p2'));
  assert.equal(g2.roomMap.get(voidId)?.feature, RoomFeature.STAIR, '前提: 2階の吹抜けがペア部屋へ転用されている');
  runInAction(() => { project.activePlaneId = 'p2'; });
  await sync(g2); // 3階に吹抜け
  runInAction(() => { project.activePlaneId = 'p1'; });
  store.set('p1', serializeGraph(g1));
  store.set('p2', serializeGraph(g2));
  return { project, graphs, g1, g2, store, ...placed };
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
  const peekLog = overrides.peekLog ?? [];
  const inner = makeStorePeek(ctx.project, ctx.store);
  const params = {
    project: ctx.project, activeGraph: ctx.g1, stairId: ctx.stair.id,
    commitActive: makeCommit(ctx.g1, ctx.stair.id, counter),
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: async (p) => { peekLog.push(p.id); return inner(p); },
    saveFloorFn: makeStoreSave(ctx.store, saveLog),
    ...overrides,
  };
  delete params.counter; delete params.saveLog; delete params.peekLog;
  return { promise: runStairRemoval(params), counter, saveLog, peekLog };
}

// 2階（g2）をアクティブにして、2階の階段を2階で削除する実行（setupChain 用）
function runOn2F(ctx, overrides = {}) {
  runInAction(() => { ctx.project.activePlaneId = 'p2'; });
  const stairId = ctx.g2.stairs[0].id;
  const counter = overrides.counter ?? { calls: 0 };
  return run({ ...ctx, g1: ctx.g2, stair: { id: stairId } }, { counter, ...overrides });
}

const centerLineCount = (g) => g.centerLines.length;
const voidRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
const undefinedRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.UNDEFINED);

// ================================================================
// 正常系
// ================================================================

test('(a) 3階建て: 1階で削除→1階の階段・ペア部屋が消え（未定義化）、2階の吹抜けは未定義化、3階は不変。保存は2階だけ・peek も2階だけ', async () => {
  const ctx = await setup(3);
  const before2 = decode(ctx.project, ctx.store, 'p2');
  const p3Before = ctx.store.get('p3');
  assert.equal(voidRooms(before2).length, 1, '前提: 2階に階段吹抜け');
  assert.equal(before2.stairs.length, 0, '前提: 2階に階段実体は無い');

  const { promise, counter, saveLog, peekLog } = run(ctx);
  const result = await promise;

  assert.deepEqual(result, { status: 'removed', upperCount: 1 });
  assert.deepEqual(saveLog, ['p2'], '保存は2階だけ（3階は保存0回）');
  assert.deepEqual(peekLog, ['p2'], '1階には直下階が無く、3階は peek もしない');
  assert.equal(counter.calls, 1);
  assert.equal(ctx.g1.stairs.length, 0, '設置階の階段が消える');
  assert.equal(ctx.g1.roomMap.get(ctx.room.id)?.feature, RoomFeature.UNDEFINED, '設置階のペア部屋は未定義化');
  const after2 = decode(ctx.project, ctx.store, 'p2');
  assert.equal(voidRooms(after2).length, 0);
  assert.equal(undefinedRooms(after2).length, 1, '2階の吹抜けは未定義化');
  assert.equal(centerLineCount(after2), centerLineCount(before2), '2階の中心線は消さない');
  assert.equal(ctx.store.get('p3'), p3Before, '3階のバイト列は不変');
});

test('(b) 2階建て: 設置階で削除→2階（最上階）の階段吹抜けが未定義化', async () => {
  const ctx = await setup(2);
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1, '前提: 吹抜けがある');
  const { promise, saveLog } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 1 });
  assert.deepEqual(saveLog, ['p2']);
  const after2 = decode(ctx.project, ctx.store, 'p2');
  assert.equal(voidRooms(after2).length, 0);
  assert.equal(undefinedRooms(after2).length, 1);
});

test('(c) 屋外階段の3階建て: 上の階に何も置かれていないので上の階の保存は0回。設置階の屋外ペア部屋は削除される', async () => {
  const ctx = await setup(3, { kind: RoomKind.EXTERIOR });
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 0, '前提: 屋外階段は吹抜けを置かない');
  const { promise, saveLog } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 0 });
  assert.deepEqual(saveLog, []);
  assert.equal(ctx.g1.stairs.length, 0);
  assert.equal(ctx.g1.roomMap.has(ctx.room.id), false);
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
  const { promise, counter, saveLog, peekLog } = run(ctx, { stairId: 'no-such-stair' });
  assert.deepEqual(await promise, { status: 'noop' });
  assert.deepEqual([peekLog, saveLog, counter.calls], [[], [], 0]);
});

test('(e) 2階にユーザー指定の階段（同 footprint）がある状態で1階の階段を削除→2階の階段・ペア部屋は残り、3階の吹抜けも残る（保存0回）', async () => {
  const ctx = await setupChain();
  const before = new Map(['p2', 'p3'].map(id => [id, ctx.store.get(id)]));
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p3')).length, 1, '前提: 3階に2階の階段の吹抜け');

  const { promise, saveLog, counter } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 0 });

  assert.deepEqual(saveLog, [], '2階にも3階にも書かない');
  assert.equal(counter.calls, 1);
  assert.equal(ctx.g1.stairs.length, 0);
  for (const id of ['p2', 'p3']) assert.equal(ctx.store.get(id), before.get(id), `${id} のバイト列は不変`);
  const d2 = decode(ctx.project, ctx.store, 'p2');
  assert.equal(d2.stairs.length, 1, '2階の階段は残る');
  assert.equal(d2.roomMap.get(d2.stairs[0].roomId)?.feature, RoomFeature.STAIR, '2階のペア部屋は階段のまま');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p3')).length, 1, '3階の吹抜けも残る');
});

test('(e2) 2階の階段（1階の階段の上に指定したもの）を2階で削除→拒否されず、2階の階段が消え、3階の吹抜けは未定義化、1階は不変。2階には1階の階段の吹抜けが復活する', async () => {
  const ctx = await setupChain();
  const p1Before = ctx.store.get('p1');
  const stairId = ctx.g2.stairs[0].id;
  assert.ok(stairId, '前提: 2階に階段がある');

  const { promise, saveLog, peekLog, counter } = runOn2F(ctx);
  const result = await promise;

  assert.deepEqual(result, { status: 'removed', upperCount: 1 }, '削除は拒否されない');
  assert.equal(counter.calls, 1);
  assert.deepEqual(saveLog, ['p3'], '保存は3階だけ（自階はメモリ上のグラフ）');
  assert.deepEqual(peekLog, ['p1', 'p3'], '直下階（吹抜けの復元用）と直上階だけ peek する');
  assert.equal(ctx.g2.stairs.length, 0, '2階の階段が消える');
  const voids2 = voidRooms(ctx.g2);
  assert.equal(voids2.length, 1, '1階の階段の足元に、2階の吹抜けが復活する');
  assert.deepEqual([...refreshCells(voids2[0].cells, ctx.g2)], [...refreshCells(new Set([keyAt(ctx.g2, LEFT_HALF[0])]), ctx.g2)]);
  const after3 = decode(ctx.project, ctx.store, 'p3');
  assert.equal(voidRooms(after3).length, 0, '3階の吹抜けは未定義化');
  assert.equal(undefinedRooms(after3).length, 1);
  assert.equal(ctx.g1.stairs.length, 1, '1階は不変');
  assert.equal(ctx.store.get('p1'), p1Before);
});

test('(e3) 2階の階段の削除の undo→redo: 2階（階段・ペア部屋）と3階が戻り、redo で吹抜けの復活まで再現される', async () => {
  const ctx = await setupChain();
  const p3Before = ctx.store.get('p3');
  const { promise } = runOn2F(ctx);
  assert.equal((await promise).status, 'removed');
  const p3After = ctx.store.get('p3');
  assert.notDeepEqual(p3After, p3Before, '前提: 3階は削除で変わっている');

  undoManager.undo();
  await flush();
  assert.equal(ctx.g2.stairs.length, 1, 'undo で2階の階段が戻る');
  assert.equal(voidRooms(ctx.g2).length, 0, 'undo で復活した吹抜けも消える');
  assert.equal(ctx.g2.roomMap.get(ctx.g2.stairs[0].roomId)?.feature, RoomFeature.STAIR);
  assert.deepEqual(ctx.store.get('p3'), p3Before, 'undo で3階が戻る');

  undoManager.redo();
  await flush();
  assert.equal(ctx.g2.stairs.length, 0);
  assert.equal(voidRooms(ctx.g2).length, 1, 'redo で吹抜けの復活まで再現される');
  assert.deepEqual(ctx.store.get('p3'), p3After, 'redo で3階が after になる');
});

test('(e4) 2階で階段を削除するとき、直下階（1階）に階段が無ければ吹抜けは復活しない（直下階の peek は行う）', async () => {
  const ctx = await setupChain();
  // 1階の階段を取り除いた状態を保存データに反映する（2階の階段は残っている）
  removeStairOnFloor(ctx.g1, ctx.g1.stairs[0]);
  ctx.store.set('p1', serializeGraph(ctx.g1));
  const { promise, peekLog } = runOn2F(ctx);
  assert.equal((await promise).status, 'removed');
  assert.equal(voidRooms(ctx.g2).length, 0, '足元の階段が1階に無いので吹抜けは置かない');
  assert.ok(peekLog.includes('p1'));
});

test('(f) 同 footprint の STAIR_VOID が2階に2つ→両方未定義化される', async () => {
  const ctx = await setup(2);
  const d2 = decode(ctx.project, ctx.store, 'p2');
  const first = voidRooms(d2)[0];
  const dup = d2.addRoom(new Set(first.cells));
  dup.setFeature(RoomFeature.STAIR_VOID);
  ctx.store.set('p2', serializeGraph(d2));
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 2, '前提: 吹抜けが2つ');

  const { promise, saveLog } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 1 });
  assert.deepEqual(saveLog, ['p2']);
  const after2 = decode(ctx.project, ctx.store, 'p2');
  assert.equal(voidRooms(after2).length, 0);
  assert.equal(undefinedRooms(after2).length, 2);
});

// ================================================================
// undo / redo
// ================================================================

test('(g) undo→redo→undo の往復: 各段でストアのバイト列が before/after と一致し、onApplied の回数が期待どおり（3階は常に不変）', async () => {
  const ctx = await setup(3);
  const peek = makeStorePeek(ctx.project, ctx.store);
  const before2 = serializeGraph(peek(ctx.project.planeMap.get('p2')));
  const p3Before = ctx.store.get('p3');
  let applied = 0;

  const { promise } = run(ctx, { onApplied: () => { applied++; } });
  assert.equal((await promise).status, 'removed');
  assert.equal(applied, 1, '確定直後に1回');
  const after2 = ctx.store.get('p2');
  assert.notDeepEqual(after2, before2, '前提: 2階は削除で変わっている');

  undoManager.undo();
  await flush();
  assert.equal(applied, 2, 'undo後に2回');
  assert.deepEqual(ctx.store.get('p2'), before2, 'undoで2階が before のバイト列に戻る');
  assert.equal(ctx.g1.stairs.length, 1, '設置階も戻る');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1);

  undoManager.redo();
  await flush();
  assert.equal(applied, 3, 'redo後に3回');
  assert.deepEqual(ctx.store.get('p2'), after2, 'redoで2階が after のバイト列になる');
  assert.equal(ctx.g1.stairs.length, 0);

  undoManager.undo();
  await flush();
  assert.equal(applied, 4, '2度目のundo後に4回');
  assert.deepEqual(ctx.store.get('p2'), before2);
  assert.equal(ctx.g1.stairs.length, 1);
  assert.equal(ctx.store.get('p3'), p3Before, '3階は一度も書かれない');
});

// ================================================================
// 失敗系
// ================================================================

test('(h) 直上階（2階）の peek が失敗→識別コード付きで throw・ストア無変更・commitActive 0回（注入の発火は1回）', async () => {
  const ctx = await setup(3);
  const storeBefore = new Map(ctx.store);
  let fired = 0;
  const peekFn = async (plane) => {
    if (plane.id === 'p2') { fired++; throw new Error('IDB読込み失敗（意図した失敗）'); }
    return makeStorePeek(ctx.project, ctx.store)(plane);
  };
  const { promise, counter, saveLog } = run(ctx, { peekFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(fired, 1);
  assert.equal(counter.calls, 0);
  assert.deepEqual(saveLog, []);
  for (const [id, bytes] of storeBefore) assert.equal(ctx.store.get(id), bytes, `${id} のストアは不変`);
  assert.equal(ctx.g1.stairs.length, 1);
});

test('(h1) 2階の階段の削除で、直下階（1階）の peek が失敗→識別コード付きで throw・commitActive 0回・2階の階段は残る（確定前に済ませる）', async () => {
  const ctx = await setupChain();
  const storeBefore = new Map(ctx.store);
  let fired = 0;
  const base = makeStorePeek(ctx.project, ctx.store);
  const peekFn = async (plane) => {
    if (plane.id === 'p1') { fired++; throw new Error('IDB読込み失敗（意図した失敗）'); }
    return base(plane);
  };
  const { promise, counter, saveLog } = runOn2F(ctx, { peekFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(fired, 1);
  assert.equal(counter.calls, 0);
  assert.deepEqual(saveLog, []);
  assert.equal(ctx.g2.stairs.length, 1);
  for (const [id, bytes] of storeBefore) assert.equal(ctx.store.get(id), bytes, `${id} のストアは不変`);
});

test('(h4) 確定後の自階の吹抜け復元（6b）が throw→識別コード付きで reject。自階は確定直後の状態のまま、3階の未定義化は済み、undo 1回で2階・3階が before に戻る', async () => {
  const ctx = await setupChain();
  const p3Before = ctx.store.get('p3');
  const base = makeStorePeek(ctx.project, ctx.store);
  // 直下階（1階）の階段が cells を持たない壊れたグラフ→reconcileStairVoids が実際に throw する
  const peekFn = async (plane) => {
    const g = base(plane);
    if (plane.id !== 'p1') return g;
    return new Proxy(g, { get: (t, k) => (k === 'stairs' ? [{ cells: null, roomId: null }] : Reflect.get(t, k, t)) });
  };
  const { promise, counter, saveLog } = runOn2F(ctx, { peekFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });

  assert.equal(counter.calls, 1, '確定は済んでいる');
  assert.deepEqual(saveLog, ['p3'], '3階の保存は済んでいる');
  assert.equal(ctx.g2.stairs.length, 0, '2階の階段の削除は確定済み');
  assert.equal(voidRooms(ctx.g2).length, 0, '復元は行われない（確定直後の状態のまま）');
  assert.equal(undefinedRooms(ctx.g2).length, 1, 'ペア部屋は未定義化されたまま');
  const after3 = decode(ctx.project, ctx.store, 'p3');
  assert.equal(undefinedRooms(after3).length, 1, '3階の吹抜けは未定義化済み');

  undoManager.undo();
  await flush();
  assert.equal(ctx.g2.stairs.length, 1, 'undo 1回で2階の階段が戻る');
  assert.equal(ctx.g2.roomMap.get(ctx.g2.stairs[0].roomId)?.feature, RoomFeature.STAIR);
  assert.deepEqual(ctx.store.get('p3'), p3Before, 'undo 1回で3階が before に戻る');
});

test('(h2) 2階の保存が失敗→識別コード付きで throw・commitActive 0回・ストア無変更（注入の発火は1回）', async () => {
  const ctx = await setup(3);
  const storeBefore = new Map(ctx.store);
  const failing = makeStoreSave(ctx.store, [], { failOn: 'p2' });
  let fired = 0;
  const saveFloorFn = async (id, bytes) => { if (id === 'p2') fired++; return failing(id, bytes); };
  const { promise, counter } = run(ctx, { saveFloorFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(fired, 1);
  assert.equal(counter.calls, 0);
  for (const [id, bytes] of storeBefore) assert.equal(ctx.store.get(id), bytes, `${id} のストアは不変`);
  assert.equal(ctx.g1.stairs.length, 1);
});

test('(h3) 2階の変更処理が例外→commitActive 0回・undo 件数不変・識別コード付きで throw（注入の発火は1回）', async () => {
  const ctx = await setup(3);
  const base = makeStorePeek(ctx.project, ctx.store);
  let fired = 0;
  const peekFn = async (plane) => {
    const g = base(plane);
    if (plane.id === 'p2') g.rooms.forEach(r => { r.setFeature = () => { fired++; throw new Error('注入した変更処理の失敗'); }; });
    return g;
  };
  const undoCount = undoManager._undoStack.length;
  const { promise, counter } = run(ctx, { peekFn });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(fired, 1, '注入は2階の吹抜けの未定義化で1回だけ発火する');
  assert.equal(counter.calls, 0);
  assert.equal(undoManager._undoStack.length, undoCount);
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1, '2階は変わらない');
});

test('(i) commitActive が throw→2階が before に戻る・識別コード付きで throw', async () => {
  const ctx = await setup(3);
  const counter = { calls: 0 };
  const saveLog = [];
  const { promise } = run(ctx, { counter, saveLog, commitActive: makeCommit(ctx.g1, ctx.stair.id, counter, { throws: true }) });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(counter.calls, 1, '注入（commitActive の例外）は1回発火');
  assert.deepEqual(saveLog, ['p2', 'p2'], '保存→巻き戻し');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1);
});

test('(i2) commitActive が undo エントリを返さない(null)→2階が before に戻る・識別コード付きで throw', async () => {
  const ctx = await setup(2);
  const counter = { calls: 0 };
  const { promise } = run(ctx, { counter, commitActive: makeCommit(ctx.g1, ctx.stair.id, counter, { returnsNull: true }) });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(counter.calls, 1);
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1);
});

test('(i3) commitActive が throw し、2階の巻き戻しも失敗→例外の code は ERR_STAIR_DELETE_FAILED（注入の発火は各1回）', async () => {
  const ctx = await setup(3);
  const base = makeStoreSave(ctx.store, []);
  let calls = 0;
  let rollbackFired = 0;
  const saveFloorFn = async (id, bytes) => {
    if (id === 'p2' && ++calls === 2) { rollbackFired++; throw new Error('巻き戻し失敗（意図した失敗）'); }
    return base(id, bytes);
  };
  const counter = { calls: 0 };
  const { promise } = run(ctx, { counter, saveFloorFn, commitActive: makeCommit(ctx.g1, ctx.stair.id, counter, { throws: true }) });
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.equal(counter.calls, 1);
  assert.equal(rollbackFired, 1);
});

test('(j) 世代の不一致（2階の peek 後に別処理が書込み）→aborted と ERR_STAIR_FLOORS_CHANGED（発火は1回）・保存0回・commitActive 0回', async () => {
  const ctx = await setup(3);
  const base = makeStorePeek(ctx.project, ctx.store);
  let fired = 0;
  const peekFn = async (plane) => {
    const g = base(plane);
    if (plane.id === 'p2') { noteFloorWrite(plane.id); fired++; }
    return g;
  };
  const { promise, counter, saveLog } = run(ctx, { peekFn });
  const result = await promise;
  assert.deepEqual(result, { status: 'aborted', message: ERR_STAIR_FLOORS_CHANGED });
  assert.equal(fired, 1);
  assert.equal(counter.calls, 0);
  assert.deepEqual(saveLog, []);
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 1);
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
  assert.deepEqual(r2.saveLog, ['p2', 'p2'], '保存→巻き戻し');
  assert.equal(r2.counter.calls, 0);
  assert.equal(voidRooms(decode(second.project, second.store, 'p2')).length, 1);
});

test('連動削除の対象にアクティブ階が含まれる（project のアクティブ階が上の階）→黙って上書きせず throw・書込みゼロ', async () => {
  const ctx = await setup(3);
  runInAction(() => { ctx.project.activePlaneId = 'p2'; }); // 不整合: activeGraph(1階)と project のアクティブ階が食い違う
  const { promise, counter, saveLog } = run(ctx);
  await assert.rejects(promise, (err) => { assert.equal(err.code, ERR_STAIR_DELETE_FAILED); return true; });
  assert.deepEqual([saveLog, counter.calls], [[], 0]);
});

test('(k) 同じ階に階段が2つ（別位置）、片方だけ削除→もう片方の2階の吹抜けが無傷', async () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const a = placeStair(project, g1, { pts: LEFT_HALF });
  const b = placeStair(project, g1, { pts: [[750, 500]] });
  assert.notEqual(a.stair.id, b.stair.id);
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  await syncUpperFloors(project, g1, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  store.set('p1', serializeGraph(g1));
  assert.equal(voidRooms(decode(project, store, 'p2')).length, 2, '前提: 2階に吹抜けが2つ');
  const p3Before = store.get('p3');

  const ctx = { project, g1, store, stair: a.stair };
  const { promise } = run(ctx);
  assert.deepEqual(await promise, { status: 'removed', upperCount: 1 });

  const after2 = decode(project, store, 'p2');
  assert.equal(voidRooms(after2).length, 1, '2階の吹抜けはもう片方だけ残る');
  assert.equal(undefinedRooms(after2).length, 1, '2階の消えた側は未定義化');
  const keptBounds = cellBoundsFromKey([...refreshCells(voidRooms(after2)[0].cells, after2)][0], after2);
  assert.ok(keptBounds.x1 >= 500, '残った吹抜けは右半分 [500,1000]（B の足元）');
  assert.equal(g1.stairs.length, 1);
  assert.equal(g1.stairs[0].id, b.stair.id);
  assert.equal(store.get('p3'), p3Before, '3階は不変');
});

test('(ii) 直進（STRAIGHT）階段＋階段下の分割CL→設置階の分割CLは階段と一緒に消え、2階の吹抜けは未定義化されセルが解決できる。per-floor 中心線は残る', async () => {
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
  ensureUnderStairSplit(stair, g1, null);
  assert.equal(findUnderStairSplitCLs(stair, g1).length, 1, '前提: 1階に階段下の分割CLがある');
  store.set('p1', serializeGraph(g1));
  const clBefore1 = g1.centerLines.length;
  const before2 = decode(project, store, 'p2');
  assert.equal(voidRooms(before2).length, 1, '前提: 2階に吹抜け');

  const { promise } = run({ project, g1, store, stair });
  assert.equal((await promise).status, 'removed');

  assert.equal(g1.centerLines.length, clBefore1 - 1, '階段下の分割CLだけ1本消える');
  const after2 = decode(project, store, 'p2');
  assert.equal(after2.centerLines.length, before2.centerLines.length, '2階の per-floor 中心線は残る');
  const undefs = undefinedRooms(after2);
  assert.equal(undefs.length, 1);
  for (const key of undefs[0].cells) assert.ok(cellBoundsFromKey(key, after2), `未定義部屋のセル ${key} が解決できる`);
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
// (l) 削除→再指定
// ================================================================

test('(l) 削除→同じ位置へ再指定（syncUpperFloors を再実行）→2階に STAIR_VOID が再び置かれ、未定義部屋は引き抜かれて残らない', async () => {
  const ctx = await setup(3);
  const { promise } = run(ctx);
  assert.equal((await promise).status, 'removed');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 0, '前提: 吹抜けは未定義化済み');

  const again = placeStair(ctx.project, ctx.g1);
  assert.equal(again.stair.cells.size > 0, true);
  await syncUpperFloors(ctx.project, ctx.g1, {
    peekFn: makeStorePeek(ctx.project, ctx.store), saveFloorFn: makeStoreSave(ctx.store, []),
  });

  const after2 = decode(ctx.project, ctx.store, 'p2');
  assert.equal(after2.stairs.length, 0, '2階に階段実体は置かれない');
  assert.equal(voidRooms(after2).length, 1, '2階に階段吹抜け');
  assert.equal(undefinedRooms(after2).length, 0, '2階の未定義部屋は引き抜かれて残らない');
});

// ================================================================
// 部屋カードの削除（commitActive が deleteRoom。件B 裁定2: 自階の結果は従来の deleteRoom と同じ）
// ================================================================

test('commitActive が FinishModeState.deleteRoom（部屋カードの削除）でも、2階の吹抜けが未定義化され、undo 1回で全階が戻る', async () => {
  const ctx = await setup(3);
  const state = new FinishModeState(ctx.g1, ctx.project);
  const before2 = ctx.store.get('p2');
  const counter = { calls: 0 };
  const commitActive = () => { counter.calls++; state.deleteRoom(ctx.room.id); return state.lastRoomUndoEntry; };

  const { promise, saveLog } = run(ctx, { commitActive });
  assert.deepEqual(await promise, { status: 'removed', upperCount: 1 });
  assert.deepEqual(saveLog, ['p2']);
  assert.equal(counter.calls, 1);
  assert.equal(ctx.g1.stairs.length, 0, '設置階の階段が消える');
  assert.equal(ctx.g1.roomMap.get(ctx.room.id)?.feature, RoomFeature.UNDEFINED, '設置階のペア部屋は deleteRoom と同じ未定義化');
  assert.equal(voidRooms(decode(ctx.project, ctx.store, 'p2')).length, 0, '2階の吹抜けが未定義化される');

  undoManager.undo(); // 1回で設置階・2階が戻る
  await flush();
  assert.equal(ctx.g1.stairs.length, 1);
  assert.equal(ctx.g1.roomMap.get(ctx.room.id)?.feature, RoomFeature.STAIR);
  assert.deepEqual(ctx.store.get('p2'), before2, 'undo 1回で2階が before のバイト列に戻る');
});

test('部屋カードの削除でも2階（続きの階段）は拒否されない→removed・2階には吹抜けが復活する', async () => {
  const ctx = await setupChain();
  runInAction(() => { ctx.project.activePlaneId = 'p2'; });
  const state = new FinishModeState(ctx.g2, ctx.project);
  const roomId = ctx.g2.stairs[0].roomId;
  const counter = { calls: 0 };
  const commitActive = () => { counter.calls++; state.deleteRoom(roomId); return state.lastRoomUndoEntry; };
  const saveLog = [];
  const result = await runStairRemoval({
    project: ctx.project, activeGraph: ctx.g2, stairId: ctx.g2.stairs[0].id, commitActive,
    isStillValid: alwaysValid, onApplied: () => {},
    peekFn: makeStorePeek(ctx.project, ctx.store), saveFloorFn: makeStoreSave(ctx.store, saveLog),
  });
  assert.deepEqual(result, { status: 'removed', upperCount: 1 });
  assert.equal(counter.calls, 1);
  assert.deepEqual(saveLog, ['p3']);
  assert.equal(ctx.g2.stairs.length, 0);
  assert.equal(voidRooms(ctx.g2).length, 1, '1階の階段の吹抜けが2階に復活する');
});
