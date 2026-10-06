// finish/stair/stairFloorSync.js addStairVoidRoom（ensureTopStairVoid・syncUpperFloors 経由）の重なり判定。
//
// 不良: 最上階の格子が直下階より細かい（階段の足元を per-floor 中心線で割っている）とき、
// translateCellSet の生キーと、既存の部屋の refreshCells 後の原子セルのキーが一致せず、
// 既存の階段吹抜けを見落として突入のたびに新しい吹抜けを足していた。
// 他階 peek は本番同型（バイト列の Map ＋ restoreGraph）で差し替える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Project, CenterLineType, Discipline, StairType, RoomFeature } from '../../core.js';
import { worldToCell, refreshCells } from '../gridCells.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { floorSwapManager } from '../../storage/FloorSwapManager.js';
import { translateCellSet } from '../floorCLMap.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../equipment/equipmentTestFixtures.js';
import { makeRoomUndefined } from '../roomUndefined.js';
import { ensureTopStairVoid, syncUpperFloors } from './stairFloorSync.js';

// X:[0,1000,2000] Y:[0,1000]（全階共通の通り芯）。left=[0,1000]x[0,1000]・right=[1000,2000]x[0,1000]。
function setupProject() {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   1000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000, grid);
  const { graph: below } = project.addPlane(0, '1階', 'p1');
  const { graph: above } = project.addPlane(3000, '2階', 'p2');
  // 階段の足元の上端を決める per-floor 中心線（syncUpperFloors が写す対象）。両階に置く。
  const arch = { labeled: false, discipline: Discipline.ARCH };
  below.addCenterLine(CenterLineType.HORIZONTAL, 500, arch);
  above.addCenterLine(CenterLineType.HORIZONTAL, 500, arch);
  project.activePlaneId = 'p2';
  return { project, below, above };
}
// 階段の足元: left=[0,1000]x[0,500]・right=[1000,2000]x[0,500]
const leftKey = (g) => worldToCell(500, 250, g).key;
const rightKey = (g) => worldToCell(1500, 250, g).key;

function addStairAt(graph, key) {
  graph.addStair({
    type: StairType.STRAIGHT, cells: new Set([key]),
    upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
  });
}
// 最上階の格子を細かくする（直下階に無い per-floor 中心線で階段の足元を割る）
function splitAbove(above) {
  above.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  above.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });
}
// 階段 left の足元（上階の現行格子での原子セル）
function footprintAtoms(ctx) {
  const raw = translateCellSet(ctx.below.stairs[0].cells, ctx.below, ctx.project.structGraph, ctx.above);
  return [...refreshCells(raw, ctx.above)];
}

function voidRooms(g) { return g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID); }

// floorSwapManager.peek を「バイト列の Map ＋ restoreGraph」へ差し替えて fn を走らせる
async function withStorePeek(project, store, fn) {
  const original = floorSwapManager.peek;
  const peek = makeStorePeek(project, store);
  floorSwapManager.peek = async (plane) => peek(plane);
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

function setupSplit({ stairs = ['left'] } = {}) {
  const ctx = setupProject();
  const { project, below, above } = ctx;
  for (const s of stairs) addStairAt(below, s === 'left' ? leftKey(below) : rightKey(below));
  splitAbove(above);
  const store = new Map([[below.plane.id, serializeGraph(below)]]);
  return { ...ctx, store, project };
}

// 空振り防止: 生キー（translateCellSet）と refreshCells 後のキーが実際に違う fixture であること
function assertRawDiffersFromRefreshed({ project, below, above }) {
  for (const stair of below.stairs) {
    const raw = translateCellSet(stair.cells, below, project.structGraph, above);
    const refreshed = refreshCells(raw, above);
    assert.ok(refreshed.size > raw.size, `前提: 生キー(${raw.size})より原子セル(${refreshed.size})が多い`);
    assert.ok([...raw].every(k => !refreshed.has(k)), '前提: 生キーは原子セルのキーに含まれない');
  }
}

test('ensureTopStairVoid: 格子が細かい最上階で3回呼んでも階段吹抜けは1つだけ（1回目 true・以降 false・バイト列不変）', async () => {
  const ctx = setupSplit();
  assertRawDiffersFromRefreshed(ctx);
  const { project, above, store } = ctx;
  await withStorePeek(project, store, async () => {
    assert.equal(await ensureTopStairVoid(project, above), true);
    assert.equal(voidRooms(above).length, 1);
    const after1 = serializeGraph(above);
    assert.equal(await ensureTopStairVoid(project, above), false);
    assert.equal(await ensureTopStairVoid(project, above), false);
    assert.equal(voidRooms(above).length, 1);
    assert.deepEqual(serializeGraph(above), after1, '2回目以降でグラフが変わらない');
  });
});

test('ensureTopStairVoid: 保存・復元をはさんだ再突入（復帰時）でも足さない', async () => {
  const ctx = setupSplit();
  const { project, above, store } = ctx;
  await withStorePeek(project, store, async () => {
    await ensureTopStairVoid(project, above);
    let bytes = serializeGraph(decodeFloor(project, above.plane, serializeGraph(above)));
    for (let i = 0; i < 3; i++) {
      const g = decodeFloor(project, above.plane, bytes);
      assert.equal(await ensureTopStairVoid(project, g), false, `復元後 ${i + 1} 回目`);
      assert.equal(voidRooms(g).length, 1);
      assert.deepEqual(serializeGraph(g), bytes);
      bytes = serializeGraph(decodeFloor(project, above.plane, serializeGraph(g)));
    }
  });
});

test('ensureTopStairVoid: 階段が2つ（moku2-1 と同じ）でも、吹抜けは階段ごとに1つで増えない', async () => {
  const ctx = setupSplit({ stairs: ['left', 'right'] });
  assertRawDiffersFromRefreshed(ctx);
  const { project, above, store } = ctx;
  await withStorePeek(project, store, async () => {
    assert.equal(await ensureTopStairVoid(project, above), true);
    assert.equal(voidRooms(above).length, 2);
    const after1 = serializeGraph(above);
    assert.equal(await ensureTopStairVoid(project, above), false);
    assert.equal(await ensureTopStairVoid(project, above), false);
    assert.equal(voidRooms(above).length, 2);
    assert.deepEqual(serializeGraph(above), after1);
  });
});

test('ensureTopStairVoid: 名前付きの部屋と一部だけ重なる場合は足さない', async () => {
  const ctx = setupSplit();
  const { project, above, store } = ctx;
  // 階段の足元（left）を割った原子セルのうち1つだけを名前付きの部屋が持つ
  const atoms = footprintAtoms(ctx);
  assert.ok(atoms.length > 1, '前提: left は複数の原子セルに分かれている');
  above.addRoom(new Set([atoms[0]]), '居室');
  const before = serializeGraph(above);
  await withStorePeek(project, store, async () => {
    assert.equal(await ensureTopStairVoid(project, above), false);
  });
  assert.equal(voidRooms(above).length, 0);
  assert.deepEqual(serializeGraph(above), before);
});

test('ensureTopStairVoid: 未定義の部屋とだけ重なる場合は、引き抜いてから作る', async () => {
  const ctx = setupSplit();
  const { project, above, store } = ctx;
  const atoms = footprintAtoms(ctx);
  // 未定義の部屋は階段の足元の外（上の段）も持つ。足元ぶんだけ引き抜かれ、残りは残る
  const extra = worldToCell(500, 750, above).key;
  const u = above.addRoom(new Set([...atoms, extra]), '仮');
  makeRoomUndefined(u);
  await withStorePeek(project, store, async () => {
    assert.equal(await ensureTopStairVoid(project, above), true);
  });
  assert.equal(voidRooms(above).length, 1);
  const stillUndefined = above.rooms.filter(r => r.feature === RoomFeature.UNDEFINED);
  assert.equal(stillUndefined.length, 1);
  const rest = refreshCells(stillUndefined[0].cells, above);
  assert.ok([...atoms].every(k => !rest.has(k)), '足元のセルは未定義の部屋から引き抜かれている');
  assert.ok(refreshCells(new Set([extra]), above).size > 0 && [...refreshCells(new Set([extra]), above)].every(k => rest.has(k)),
    '足元の外のセルは未定義の部屋に残る');
});

test('ensureTopStairVoid: 格子が割れていない通常の場合は、生キーのセル1つの吹抜けが1つ作られる', async () => {
  const { project, below, above } = setupProject();
  addStairAt(below, leftKey(below));
  const store = new Map([[below.plane.id, serializeGraph(below)]]);
  const raw = translateCellSet(below.stairs[0].cells, below, project.structGraph, above);
  assert.deepEqual([...refreshCells(raw, above)], [...raw], '前提: 割れていない（生キー＝原子セル）');
  await withStorePeek(project, store, async () => {
    assert.equal(await ensureTopStairVoid(project, above), true);
    assert.equal(await ensureTopStairVoid(project, above), false);
  });
  const voids = voidRooms(above);
  assert.equal(voids.length, 1);
  assert.deepEqual([...voids[0].cells], [...raw]);
});

test('ensureTopStairVoid: 失敗系 — 直下階の階段が上階へ変換できない（解決不能なセル）なら何も足さない', async () => {
  const ctx = setupProject();
  const { project, below, above } = ctx;
  // 直下階だけにある per-floor CL(V250) を端にもつセルの階段。上階には同 type:value の CL が無く、変換不能になる
  below.addCenterLine(CenterLineType.VERTICAL, 250, { labeled: false, discipline: Discipline.ARCH });
  const key = worldToCell(100, 250, below).key;
  assert.equal(translateCellSet(new Set([key]), below, project.structGraph, above), null, '前提: 変換不能');
  addStairAt(below, key);
  const store = new Map([[below.plane.id, serializeGraph(below)]]);
  const before = serializeGraph(above);
  await withStorePeek(project, store, async () => {
    assert.equal(await ensureTopStairVoid(project, above), false);
  });
  assert.deepEqual(serializeGraph(above), before);
});

test('syncUpperFloors: 格子が細かい最上階へ2回同期しても階段吹抜けは1つ（addStairVoidRoom 経由）', async () => {
  const ctx = setupSplit();
  assertRawDiffersFromRefreshed(ctx);
  const { project, below, above, store } = ctx;
  store.set(above.plane.id, serializeGraph(above));
  project.activePlaneId = 'p1';
  const saved = [];
  const peekFn = makeStorePeek(project, store);
  const saveFloorFn = makeStoreSave(store, saved);

  await syncUpperFloors(project, below, { peekFn, saveFloorFn });
  assert.equal(voidRooms(decodeFloor(project, above.plane, store.get('p2'))).length, 1);
  assert.deepEqual(saved, ['p2'], '1回目は上階を保存する');

  const bytes1 = store.get('p2');
  await syncUpperFloors(project, below, { peekFn, saveFloorFn });
  await syncUpperFloors(project, below, { peekFn, saveFloorFn });
  assert.equal(voidRooms(decodeFloor(project, above.plane, store.get('p2'))).length, 1);
  assert.deepEqual(saved, ['p2'], '2回目以降は保存しない（変更なし）');
  assert.deepEqual(store.get('p2'), bytes1);
});

test('ensureTopStairVoid: 格子が細かい最上階で作る吹抜けのセルは生キー（translateCellSet の結果）のまま', async () => {
  const ctx = setupSplit();
  assertRawDiffersFromRefreshed(ctx);
  const { project, below, above, store } = ctx;
  const raw = translateCellSet(below.stairs[0].cells, below, project.structGraph, above);
  await withStorePeek(project, store, async () => {
    assert.equal(await ensureTopStairVoid(project, above), true);
  });
  const voids = voidRooms(above);
  assert.equal(voids.length, 1);
  assert.equal(raw.size, 1);
  assert.deepEqual([...voids[0].cells], [...raw], '原子セル（複数）ではなく生キー1つを持つ');
});

test('ensureTopStairVoid: 失敗系 — 変換はできるが上階で解決できる区画が無い（refreshCells 後が空）なら足さない', async () => {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  for (const x of [0, 1000, 2000]) project.structGraph.addCenterLine(CenterLineType.VERTICAL, x, grid);
  for (const y of [0, 1000]) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, y, grid);
  const { graph: below } = project.addPlane(0, '1階', 'p1');
  const { graph: above } = project.addPlane(3000, '2階', 'p2');
  // 直下階では分割線、上階では同座標が補助線（分割線ではない）。変換は通るが上階の区画に解決できない
  below.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.ARCH });
  above.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  addStairAt(below, worldToCell(-500, 500, below).key);
  project.activePlaneId = 'p2';
  const raw = translateCellSet(below.stairs[0].cells, below, project.structGraph, above);
  assert.equal(raw?.size, 1, '前提: 変換できる（生キー1つ）');
  assert.equal(refreshCells(raw, above).size, 0, '前提: 上階では解決できる区画が無い');

  const store = new Map([['p1', serializeGraph(below)], ['p2', serializeGraph(above)]]);
  const g = decodeFloor(project, above.plane, store.get('p2'));
  const before = serializeGraph(g);
  await withStorePeek(project, store, async () => {
    for (let i = 0; i < 3; i++) assert.equal(await ensureTopStairVoid(project, g), false, `${i + 1}回目`);
  });
  assert.equal(g.rooms.length, 0);
  assert.deepEqual(serializeGraph(g), before);

  project.activePlaneId = 'p1';
  const saved = [];
  const peekFn = makeStorePeek(project, store);
  const saveFloorFn = makeStoreSave(store, saved);
  await syncUpperFloors(project, below, { peekFn, saveFloorFn });
  assert.deepEqual(saved, [], 'syncUpperFloors は上階を保存しない');
});

test('syncUpperFloors: 3階建て・格子が細かい2階へ2回同期しても吹抜けは1つ。3階は peek も保存もしない', async () => {
  const ctx = setupSplit();
  const { project, below, above, store } = ctx;
  const { graph: top } = project.addPlane(6000, '3階', 'p3');
  store.set(above.plane.id, serializeGraph(above));
  store.set(top.plane.id, serializeGraph(top));
  project.activePlaneId = 'p1';
  const saved = [];
  const peeked = [];
  const inner = makeStorePeek(project, store);
  const peekFn = async (plane) => { peeked.push(plane.id); return inner(plane); };
  const saveFloorFn = makeStoreSave(store, saved);
  const p3Before = Buffer.from(store.get('p3'));

  await syncUpperFloors(project, below, { peekFn, saveFloorFn });
  await syncUpperFloors(project, below, { peekFn, saveFloorFn });

  assert.equal(voidRooms(decodeFloor(project, above.plane, store.get('p2'))).length, 1);
  assert.deepEqual(saved, ['p2'], '2回目は変更なしで保存しない・3階は保存しない');
  assert.deepEqual(peeked, ['p2', 'p2'], '3階は peek しない');
  assert.ok(Buffer.from(store.get('p3')).equals(p3Before));
});
