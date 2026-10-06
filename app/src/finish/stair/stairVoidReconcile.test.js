// finish/stair/stairVoidReconcile.js reconcileStairVoids（直下階の屋内階段と自階の階段吹抜けの整合）。
// 純関数のテスト（2グラフを渡すだけ。peek・保存は使わない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StairType, RoomFeature, RoomKind } from '../../core.js';
import { worldToCell, refreshCells } from '../gridCells.js';
import { translateCellSet, collectNeededCLs } from '../floorCLMap.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { makeRoomUndefined } from '../roomUndefined.js';
import { ensureStairRooms } from '../roomReinterpret.js';
import { reconcileStairVoids, stairVoidsTouching, addStairVoidRoom } from './stairVoidReconcile.js';

// X:[0,1000,2000] Y:[0,1000]（全階共通の通り芯）。per-floor CL H500 を両階に置く（階段の足元の上端）
function setup({ perFloorCL = true } = {}) {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  for (const x of [0, 1000, 2000]) project.structGraph.addCenterLine(CenterLineType.VERTICAL, x, grid);
  for (const y of [0, 1000]) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, y, grid);
  const { graph: below } = project.addPlane(0, '1階', 'p1');
  const { graph: above } = project.addPlane(3000, '2階', 'p2');
  const arch = { labeled: false, discipline: Discipline.ARCH };
  if (perFloorCL) below.addCenterLine(CenterLineType.HORIZONTAL, 500, arch);
  project.activePlaneId = 'p2';
  return { project, below, above, sg: project.structGraph };
}
const leftKey = (g) => worldToCell(500, 250, g).key;
const rightKey = (g) => worldToCell(1500, 250, g).key;
// 通り芯だけで囲まれたセル（per-floor CL を持たない）: left=[0,1000]x[0,1000]
const gridOnlyKey = (g) => worldToCell(500, 500, g).key;

function addStairAt(graph, key) {
  const s = graph.addStair({
    type: StairType.STRAIGHT, cells: new Set([key]),
    upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
  });
  ensureStairRooms(graph); // ペア Room（INTERIOR）
  return s;
}
const voidRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);
const hasCL = (g, type, value) => [...g.shapeMap.values()].some(c => c.centerLineType === type && c.value === value);

test('追加: 中心線で囲まれた屋内階段 → 上階に STAIR_VOID が1つ置かれ、中心線も補完される', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  assert.equal(hasCL(above, CenterLineType.HORIZONTAL, 500), false, '前提: 上階に H500 が無い');
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.equal(voidRooms(above).length, 1);
  assert.equal(r.added.length, 1);
  assert.equal(hasCL(above, CenterLineType.HORIZONTAL, 500), true, '中心線が補完される');
  const raw = translateCellSet(below.stairs[0].cells, below, sg, above);
  assert.deepEqual([...voidRooms(above)[0].cells], [...raw]);
});

test('追加: 通り芯だけで囲まれた階段でも STAIR_VOID が置かれる（旧 syncUpperFloors の needed.size===0 早期 return の回帰）', () => {
  const { below, above, sg } = setup({ perFloorCL: false });
  addStairAt(below, gridOnlyKey(below));
  assert.equal(collectNeededCLs(below.stairs.flatMap(s => [...s.cells]), below).size, 0, '前提: per-floor 中心線を要しない');
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.equal(voidRooms(above).length, 1);
  assert.equal(r.added.length, 1);
});

test('冪等: 2回呼んで2回目は changed=false・部屋数もバイト列も不変', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  reconcileStairVoids(above, below, sg);
  const bytes = serializeGraph(above);
  const n = above.rooms.length;
  const r2 = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r2, { changed: false, added: [], removed: [], skipped: [], carved: [] });
  assert.equal(above.rooms.length, n);
  assert.deepEqual(serializeGraph(above), bytes);
});

test('屋外階段: 何も置かず、中心線も補完しない', () => {
  const { below, above, sg } = setup();
  const s = addStairAt(below, leftKey(below));
  below.roomMap.get(s.roomId).setKind(RoomKind.EXTERIOR);
  const before = serializeGraph(above);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, false);
  assert.equal(above.rooms.length, 0);
  assert.equal(hasCL(above, CenterLineType.HORIZONTAL, 500), false);
  assert.deepEqual(serializeGraph(above), before);
});

test('own-stair: 上階に同 footprint の階段＋ペア部屋があれば skipped で、STAIR_VOID は作らない', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  reconcileStairVoids(above, below, sg); // CL を補完＋吹抜けを置く
  // 上階でユーザーが階段を指定した形: 吹抜けをペア部屋へ転用してから、吹抜けが無い状態に直す
  const raw = translateCellSet(below.stairs[0].cells, below, sg, above);
  above.addStair({ type: StairType.STRAIGHT, cells: new Set(raw), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 });
  ensureStairRooms(above);
  assert.equal(voidRooms(above).length, 0, '前提: 吹抜けはペア部屋へ転用された');
  const n = above.rooms.length;
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, false);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, 'covered-by-own-stair');
  assert.equal(voidRooms(above).length, 0);
  assert.equal(above.rooms.length, n);
});

// 足元の吹抜けを外し、足元の原子セル atoms を返す（CL 補完のため一度 reconcile を走らせる）
function clearedFootprint(below, above, sg) {
  reconcileStairVoids(above, below, sg);
  above.removeRoom(voidRooms(above)[0].id);
  return [...refreshCells(translateCellSet(below.stairs[0].cells, below, sg, above), above)];
}
const roomCellsOf = (g, room) => refreshCells(room.cells, g);

test('引き抜き: 名前付き部屋が足元を全面覆う → 足元を部屋から引き抜いて吹抜けを置く（部屋は残りのセルを持つ）', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  const atoms = clearedFootprint(below, above, sg);
  const extra = worldToCell(500, 750, above).key;
  const room = above.addRoom(new Set([...atoms, extra]), '居室');
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.carved.map(c => [c.roomId, [...c.cells].sort()]), [[room.id, [...atoms].sort()]]);
  assert.equal(voidRooms(above).length, 1);
  const rest = roomCellsOf(above, above.roomMap.get(room.id));
  assert.ok(atoms.every(k => !rest.has(k)), '足元は部屋から引き抜かれている');
  assert.ok(rest.has(extra), '足元の外のセルは部屋に残る');
});

test('引き抜き: 部分重なり（足元の一部が部屋・残りは未割当）→ 全体に吹抜けが置かれ、部屋は重なり分だけ減る', () => {
  const { below, above, sg } = setup({ perFloorCL: false });
  addStairAt(below, gridOnlyKey(below));
  reconcileStairVoids(above, below, sg);
  above.removeRoom(voidRooms(above)[0].id);
  // 足元 [0,1000]x[0,1000] を H500 で割り、下半分だけ部屋で覆う
  above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const lower = worldToCell(500, 750, above).key;
  const room = above.addRoom(new Set([lower]), '居室');
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.skipped, []);
  assert.equal(above.roomMap.has(room.id), false, '部屋は足元の内側だけだったので空になり除去');
  assert.deepEqual(r.carved.map(c => c.roomId), [room.id]);
  const foot = refreshCells(voidRooms(above)[0].cells, above);
  assert.ok(foot.has(lower) && foot.has(worldToCell(500, 250, above).key), '吹抜けは足元の全体');
});

test('引き抜き: 部屋のセルが空になる → 部屋ごと除去（空の部屋を残さない）。冪等', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  const atoms = clearedFootprint(below, above, sg);
  const room = above.addRoom(new Set(atoms), '居室');
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.equal(above.roomMap.has(room.id), false);
  assert.ok(above.rooms.every(x => x.cells.size > 0));
  const bytes = serializeGraph(above);
  const r2 = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r2, { changed: false, added: [], removed: [], skipped: [], carved: [] });
  assert.deepEqual(serializeGraph(above), bytes);
});

test('引き抜き: 親のセルがすべて足元で、部分指定の子が足元の外にもセルを持つ → 親は削除され、子の referenceRoomIds に削除済み id が残らない（子は残る）', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  const atoms = clearedFootprint(below, above, sg);
  const extra = worldToCell(500, 750, above).key;
  const parent = above.addRoom(new Set(atoms), '親');
  const child = above.addRoom(new Set([...atoms, extra]), '子', undefined, new Set([parent.id]));
  assert.equal(child.referenceRoomIds.has(parent.id), true, '前提');
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.added.length, 1);
  assert.equal(above.roomMap.has(parent.id), false, '親（セルが空）は削除');
  const kept = above.roomMap.get(child.id);
  assert.ok(kept, '子は足元の外のセルを持つので残る');
  assert.equal(kept.referenceRoomIds.has(parent.id), false, '削除済みの親 id を指さない');
  assert.ok([...kept.referenceRoomIds].every(id => above.roomMap.has(id)), 'referenceRoomIds は全部実在する部屋');
});

test('引き抜き: ユーザー指定の吹抜け（VOID）からも引き抜く', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  const atoms = clearedFootprint(below, above, sg);
  const extra = worldToCell(500, 750, above).key;
  const v = above.addRoom(new Set([...atoms, extra]), '吹抜け');
  v.setFeature(RoomFeature.VOID);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.added.length, 1);
  assert.equal(voidRooms(above).length, 1);
  const rest = roomCellsOf(above, above.roomMap.get(v.id));
  assert.ok(atoms.every(k => !rest.has(k)) && rest.has(extra));
});

// 上階にも H500 はあるが区間が x 1000..2000 だけ＝足元（[0,1000]x[0,500]）の辺では分割線が働かず、
// 上階の原子セルが足元より大きい（[0,1000]x[0,1000]）。居室がその粗いセルを持つ。
function coarseAbove() {
  const ctx = setup();
  const { below, above, sg } = ctx;
  const h500 = above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH, extentLo: 1000, extentHi: 2000 });
  const coarse = worldToCell(500, 250, above).key;
  const room = above.addRoom(new Set([coarse]), '居室');
  addStairAt(below, leftKey(below));
  const foot = [...refreshCells(translateCellSet(below.stairs[0].cells, below, sg, above), above)];
  assert.deepEqual(foot, [coarse], '前提: 足元の原子セルは足元より大きい上階の粗いセル（[0,1000]x[0,1000]）');
  return { ...ctx, h500, coarse, room };
}

test('粗い格子: 上階の中心線の区間を足元の辺まで延ばして格子を割り、足元ちょうどに吹抜けを置く（居室は足元の外のセルを残す）', () => {
  const { below, above, sg, h500, room } = coarseAbove();
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.added.length, 1);
  assert.equal(h500.extentLo, 0, '区間が足元の辺（x 0..1000）まで延びた');
  const foot = refreshCells(voidRooms(above)[0].cells, above);
  assert.deepEqual([...foot], [worldToCell(500, 250, above).key], '吹抜けは足元ちょうどの1セル（[0,1000]x[0,500]）');
  const rest = refreshCells(above.roomMap.get(room.id).cells, above);
  assert.deepEqual([...rest], [worldToCell(500, 750, above).key], '居室は足元の外（上の段）だけ残る');
  const r2 = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r2, { changed: false, added: [], removed: [], skipped: [], carved: [] }, '冪等（2回目は区間も延びない）');
});

// 置けないことが確定している足元（引き抜けない部屋と重なる）では、上階の格子（中心線の区間）を延ばさない
for (const [label, make] of [
  ['ROOF', (r) => { r.setKind(RoomKind.EXTERIOR); r.setFeature(RoomFeature.ROOF); }],
  ['昇降路', (r) => { r.setFeature(RoomFeature.ELEVATOR_EQUIPMENT); }],
  ['屋外部屋', (r) => { r.setKind(RoomKind.EXTERIOR); }],
]) {
  test(`置けない足元（${label}と重なる）では上階の中心線の区間を延ばさない（skipped(overlap)・区間は不変）`, () => {
    const { below, above, sg, h500, coarse } = coarseAbove();
    make(above.addRoom(new Set([coarse]), label)); // 足元と面積のある重なり（粗い生キーが足元を覆う）
    const [lo, hi] = [h500.extentLo, h500.extentHi];
    const r = reconcileStairVoids(above, below, sg);
    assert.deepEqual(r.skipped.map(s => s.reason), ['overlap']);
    assert.deepEqual([h500.extentLo, h500.extentHi], [lo, hi], '区間は延びない');
    assert.equal(voidRooms(above).length, 0);
  });
}

test('粗い格子のガード: 原子セルが足元からはみ出すときは（区間を延ばさず直接 addStairVoidRoom を呼ぶと）通常の部屋から引き抜かず false・何も変えない', () => {
  const { below, above, sg, room } = coarseAbove();
  const raw = translateCellSet(below.stairs[0].cells, below, sg, above);
  const before = serializeGraph(above);
  const carved = [];
  assert.equal(addStairVoidRoom(above, raw, carved), false);
  assert.deepEqual(carved, []);
  assert.ok(above.roomMap.has(room.id));
  assert.deepEqual(serializeGraph(above), before);
});

// 引き抜いてはいけない相手（足元と重なると skipped 'overlap'・何も変えない）
for (const [label, make] of [
  ['ROOF', (r) => { r.setKind(RoomKind.EXTERIOR); r.setFeature(RoomFeature.ROOF); }],
  ['昇降路', (r) => { r.setFeature(RoomFeature.ELEVATOR_EQUIPMENT); }],
  ['別の階段のペア部屋（STAIR）', (r) => { r.setFeature(RoomFeature.STAIR); }],
  ['屋外部屋', (r) => { r.setKind(RoomKind.EXTERIOR); }],
]) {
  test(`overlap: ${label} と重なる → skipped(overlap)・何も変えない（他の部屋からも引き抜かない）`, () => {
    // 足元 [0,1000]x[0,1000] を H500 で上下に割り、上半分を通常の部屋・下半分を禁止相手が覆う
    const { below, above, sg } = setup({ perFloorCL: false });
    addStairAt(below, gridOnlyKey(below));
    reconcileStairVoids(above, below, sg);
    above.removeRoom(voidRooms(above)[0].id);
    above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
    above.addRoom(new Set([worldToCell(500, 250, above).key]), '居室');
    make(above.addRoom(new Set([worldToCell(500, 750, above).key]), label));
    const before = serializeGraph(above);
    const r = reconcileStairVoids(above, below, sg);
    assert.equal(r.changed, false);
    assert.deepEqual(r.skipped.map(s => s.reason), ['overlap']);
    assert.deepEqual(r.carved, []);
    assert.equal(voidRooms(above).length, 0);
    assert.deepEqual(serializeGraph(above), before);
  });
}

test('overlap: ROOF 部屋と重なる → skipped(overlap)・吹抜けは置かれない', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  reconcileStairVoids(above, below, sg);
  above.removeRoom(voidRooms(above)[0].id);
  const roof = above.addRoom(new Set([leftKey(above)]), '屋根');
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, false);
  assert.deepEqual(r.skipped.map(s => s.reason), ['overlap']);
  assert.equal(voidRooms(above).length, 0);
});

test('未定義部屋とだけ重なる → 足元を引き抜いて追加（足元の外のセルは未定義部屋に残る）', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  reconcileStairVoids(above, below, sg);
  above.removeRoom(voidRooms(above)[0].id);
  const atoms = [...refreshCells(translateCellSet(below.stairs[0].cells, below, sg, above), above)];
  const extra = worldToCell(500, 750, above).key;
  const u = above.addRoom(new Set([...atoms, extra]), '仮');
  makeRoomUndefined(u);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.equal(r.added.length, 1);
  assert.equal(voidRooms(above).length, 1);
  const rest = above.rooms.filter(x => x.feature === RoomFeature.UNDEFINED);
  assert.equal(rest.length, 1);
  const restCells = refreshCells(rest[0].cells, above);
  assert.ok(atoms.every(k => !restCells.has(k)), '足元のセルは引き抜かれている');
  assert.ok(restCells.has(extra), '足元の外のセルは残る');
});

test('孤児: 直下階に階段が無いのに STAIR_VOID がある → 未定義化（セルは残り、削除ではない）', () => {
  const { below, above, sg } = setup();
  const room = above.addRoom(new Set([leftKey(above)]));
  room.setFeature(RoomFeature.STAIR_VOID);
  const cells = new Set(room.cells);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, [{ roomId: room.id, reason: 'orphan' }]);
  assert.equal(voidRooms(above).length, 0);
  const still = above.roomMap.get(room.id);
  assert.ok(still, '部屋は削除されず残る');
  assert.equal(still.feature, RoomFeature.UNDEFINED);
  assert.deepEqual([...still.cells], [...cells]);
});

test('孤児: 直下階の階段が別の足元なら、元の位置の吹抜けは未定義化され新しい足元に置かれる', () => {
  const { below, above, sg } = setup();
  addStairAt(below, rightKey(below));
  const old = above.addRoom(new Set([leftKey(above)]));
  old.setFeature(RoomFeature.STAIR_VOID);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.removed.map(x => x.reason), ['orphan']);
  assert.equal(above.roomMap.get(old.id).feature, RoomFeature.UNDEFINED);
  assert.equal(voidRooms(above).length, 1);
});

test('孤児: 古い足元の孤児と部分的に重なる新しい足元でも、1回の呼び出しで孤児1件・追加1件・吹抜けは新しい1つだけ', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below)); // 新しい足元 [0,1000]x[0,500]
  // 古い足元: 上階に H500 が無い間の区画 [0,1000]x[0,1000]。H500 の補完後は新しい足元を含む2つの原子セルに割れる
  const old = above.addRoom(new Set([worldToCell(500, 250, above).key]));
  old.setFeature(RoomFeature.STAIR_VOID);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, [{ roomId: old.id, reason: 'orphan' }]);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.skipped, []);
  assert.equal(voidRooms(above).length, 1);
  assert.notEqual(voidRooms(above)[0].id, old.id);
  assert.equal(above.roomMap.get(old.id).feature, RoomFeature.UNDEFINED);
  // 収束している
  assert.equal(reconcileStairVoids(above, below, sg).changed, false);
});

test('重複: 同 footprint の STAIR_VOID が2つ → rooms の並びで先頭だけ残る', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  reconcileStairVoids(above, below, sg);
  const first = voidRooms(above)[0];
  const dup = above.addRoom(new Set(first.cells));
  dup.setFeature(RoomFeature.STAIR_VOID);
  assert.equal(voidRooms(above).length, 2);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, [{ roomId: dup.id, reason: 'duplicate' }]);
  assert.deepEqual(voidRooms(above).map(x => x.id), [first.id]);
  assert.equal(above.roomMap.has(dup.id), false, '重複は removeRoom で消える（セルの二重所有を残さない）');
});

test('写せない（直下階の格子を上階へ写せない）→ skipped(untranslatable)・何も変えない', () => {
  const { below, above, sg } = setup({ perFloorCL: false });
  // 階段のセルが参照する直下階の中心線を消す（CL 削除で解決できなくなったキー）。変換が null になる
  const gone = below.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.ARCH });
  addStairAt(below, worldToCell(-500, 500, below).key);
  below.removeCenterLine(gone.id);
  assert.equal(translateCellSet(below.stairs[0].cells, below, sg, above), null, '前提: 変換できない');
  const before = serializeGraph(above);
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.skipped.map(s => s.reason), ['untranslatable']);
  assert.equal(r.added.length, 0);
  assert.equal(above.rooms.length, 0);
  assert.equal(r.changed, false);
  assert.deepEqual(serializeGraph(above), before);
});

test('上階の同座標が補助線だけ（分割線ではない）でも、足元の辺の分割線を足して吹抜けを置く（旧: 上階で解決できる区画が無く skipped(untranslatable)）', () => {
  const { below, above, sg } = setup({ perFloorCL: false });
  below.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.ARCH });
  above.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  addStairAt(below, worldToCell(-500, 500, below).key);
  const probe = translateCellSet(below.stairs[0].cells, below, sg, above);
  assert.equal(refreshCells(probe, above).size, 0, '前提: 足さなければ上階では解決できる区画が無い');
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.added.length, 1);
  assert.equal(voidRooms(above).length, 1);
});

test('写せない階段の既存吹抜けは消さない（孤児の判定を見送る）', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  reconcileStairVoids(above, below, sg);
  const v = voidRooms(above)[0];
  below.stairs[0].cells = new Set(['unknownA:unknownB']); // 未知の CL id へ差し替え（写せない）
  const before = serializeGraph(above);
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.skipped.map(s => s.reason), ['untranslatable']);
  assert.deepEqual(r.removed, []);
  assert.equal(r.changed, false);
  assert.equal(above.roomMap.get(v.id).feature, RoomFeature.STAIR_VOID);
  assert.deepEqual(serializeGraph(above), before);
});

test('孤児判定は原子セルで比べる（上階の格子が粗い間に作られた吹抜けのキーでも孤児にならない）', () => {
  const { below, above, sg } = setup();
  below.addStair({
    type: StairType.STRAIGHT,
    cells: new Set([worldToCell(500, 250, below).key, worldToCell(500, 750, below).key]),
    upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
  });
  ensureStairRooms(below);
  const coarse = worldToCell(500, 500, above).key; // 上階に H500 が無い時点の粗いキー
  const v = above.addRoom(new Set([coarse]));
  v.setFeature(RoomFeature.STAIR_VOID);
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.added, []);
  assert.equal(above.roomMap.get(v.id).feature, RoomFeature.STAIR_VOID);
  assert.equal(voidRooms(above).length, 1);
});

test('own-stair: 自階の階段（ペア部屋なし）が直下階の足元を部分的に含む → skipped(covered-by-own-stair)・部屋数不変', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  above.addStair({
    type: StairType.STRAIGHT, cells: new Set([leftKey(above), rightKey(above)]),
    upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
  });
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.skipped.map(s => s.reason), ['covered-by-own-stair']);
  assert.equal(above.rooms.length, 0);
  assert.equal(r.changed, false);
});

test('own-stair: 自階の階段（ペア部屋あり）が直下階の足元を部分的に含む → skipped(covered-by-own-stair)', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  addStairAt(above, leftKey(above));
  above.stairs[0].cells = new Set([leftKey(above), rightKey(above)]);
  const n = above.rooms.length;
  assert.equal(n, 1, '前提: ペア部屋あり');
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.skipped.map(s => s.reason), ['covered-by-own-stair']);
  assert.equal(above.rooms.length, n);
  assert.equal(voidRooms(above).length, 0);
});

test('同居: 自階の階段がペア部屋を持つなら重なる STAIR_VOID は removeRoom（duplicate）', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  addStairAt(above, leftKey(above)); // ペア部屋あり
  const v = above.addRoom(new Set([leftKey(above)]));
  v.setFeature(RoomFeature.STAIR_VOID);
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.removed, [{ roomId: v.id, reason: 'duplicate' }]);
  assert.equal(above.roomMap.has(v.id), false);
  assert.equal(above.rooms.length, 1, 'ペア部屋だけが残る');
});

test('同居: 自階の階段がペア部屋を持たなければ STAIR_VOID に触らない（ensureStairRooms の転用に任せる）', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  above.addStair({
    type: StairType.STRAIGHT, cells: new Set([leftKey(above)]),
    upDirection: 'up', flip: false, totalSteps: 12, tread: 250,
  });
  const v = above.addRoom(new Set([leftKey(above)]));
  v.setFeature(RoomFeature.STAIR_VOID);
  const before = serializeGraph(above);
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.removed, []);
  assert.equal(r.changed, false);
  assert.equal(above.roomMap.get(v.id).feature, RoomFeature.STAIR_VOID);
  assert.deepEqual(serializeGraph(above), before);
});

test('屋内と屋外の2階段: 屋内の分だけ置き、屋外の足元にある古い STAIR_VOID は孤児として未定義化。2回目は changed:false', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  const out = addStairAt(below, rightKey(below));
  below.roomMap.get(out.roomId).setKind(RoomKind.EXTERIOR);
  const old = above.addRoom(new Set([rightKey(above)]));
  old.setFeature(RoomFeature.STAIR_VOID);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.removed, [{ roomId: old.id, reason: 'orphan' }]);
  assert.equal(above.roomMap.get(old.id).feature, RoomFeature.UNDEFINED);
  assert.equal(voidRooms(above).length, 1);
  assert.equal(reconcileStairVoids(above, below, sg).changed, false);
});

test('失敗系: belowGraph が null / graph が null なら throw する（黙って no-op にしない）', () => {
  const { below, above, sg } = setup();
  assert.throws(() => reconcileStairVoids(above, null, sg), /belowGraph/);
  assert.throws(() => reconcileStairVoids(null, below, sg), /graph/);
});

// ---- stairVoidsTouching（続きの階段の指定が吸収する吹抜けと、拒否する部分重なりを分ける） ----

function addVoid(g, keys) {
  const room = g.addRoom(new Set(keys));
  room.setFeature(RoomFeature.STAIR_VOID);
  return room;
}

test('stairVoidsTouching: 吹抜けの全体が cells に含まれれば absorbed（partial=false）。吹抜けより広い cells でも同じ', () => {
  const { above } = setup();
  const v = addVoid(above, [leftKey(above)]);
  const exact = stairVoidsTouching(above, new Set([leftKey(above)]));
  assert.deepEqual(exact.absorbed.map(r => r.id), [v.id]);
  assert.equal(exact.partial, false);
  const wider = stairVoidsTouching(above, new Set([leftKey(above), rightKey(above)]));
  assert.deepEqual(wider.absorbed.map(r => r.id), [v.id]);
  assert.equal(wider.partial, false);
});

test('stairVoidsTouching: 吹抜けの一部だけ重なれば partial=true（absorbed に入れない）', () => {
  const { above } = setup();
  addVoid(above, [leftKey(above), rightKey(above)]);
  const r = stairVoidsTouching(above, new Set([leftKey(above)]));
  assert.deepEqual(r.absorbed, []);
  assert.equal(r.partial, true);
});

test('stairVoidsTouching: 全体を含む吹抜けと部分重なりの吹抜けが混在すれば absorbed と partial の両方が出る', () => {
  const { above } = setup();
  above.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const lowerLeft = worldToCell(500, 750, above).key;
  const whole = addVoid(above, [leftKey(above)]);
  addVoid(above, [rightKey(above), lowerLeft]);
  const r = stairVoidsTouching(above, new Set([leftKey(above), rightKey(above)]));
  assert.deepEqual(r.absorbed.map(x => x.id), [whole.id]);
  assert.equal(r.partial, true);
});

test('【失敗系】stairVoidsTouching: 重ならない吹抜け・吹抜けでない部屋・吹抜けが無い階は、どちらにも入らない', () => {
  const { above } = setup();
  assert.deepEqual(stairVoidsTouching(above, new Set([leftKey(above)])), { absorbed: [], partial: false }, '吹抜けが無い');
  addVoid(above, [rightKey(above)]);
  above.addRoom(new Set([leftKey(above)]), '居間');
  assert.deepEqual(stairVoidsTouching(above, new Set([leftKey(above)])), { absorbed: [], partial: false }, '重ならない吹抜け・通常の部屋は無視');
  assert.deepEqual(stairVoidsTouching(above, new Set()), { absorbed: [], partial: false }, 'cells が空');
});
