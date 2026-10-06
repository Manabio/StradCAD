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
import { reconcileStairVoids, stairVoidsTouching } from './stairVoidReconcile.js';

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
  assert.deepEqual(r2, { changed: false, added: [], removed: [], skipped: [] });
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

test('overlap: 名前付き部屋と部分的に重なる → skipped(overlap)・部屋数不変', () => {
  const { below, above, sg } = setup();
  addStairAt(below, leftKey(below));
  reconcileStairVoids(above, below, sg); // CL 補完のため一度走らせ、吹抜けは外す
  above.removeRoom(voidRooms(above)[0].id);
  // 足元 left=[0,1000]x[0,500] と、上の段 [0,1000]x[500,1000] をまたぐ部屋（足元の一部だけ重なる）
  const atoms = [...refreshCells(translateCellSet(below.stairs[0].cells, below, sg, above), above)];
  above.addRoom(new Set([atoms[0], worldToCell(500, 750, above).key]), '居室');
  const n = above.rooms.length;
  const before = serializeGraph(above);
  const r = reconcileStairVoids(above, below, sg);
  assert.equal(r.changed, false);
  assert.deepEqual(r.skipped.map(s => s.reason), ['overlap']);
  assert.equal(above.rooms.length, n);
  assert.deepEqual(serializeGraph(above), before);
});

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
  // 直下階では分割線、上階では同座標が補助線（破線＝分割線ではない）。変換は通るが上階の区画に解決できない
  // （補完は同座標の CL が既にあるため足されない。stairFloorSync.void.test.js の同名の前提と同じ形）
  below.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.ARCH });
  above.addCenterLine(CenterLineType.VERTICAL, -1000, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  addStairAt(below, worldToCell(-500, 500, below).key);
  const probe = translateCellSet(below.stairs[0].cells, below, sg, above);
  assert.equal(probe?.size, 1, '前提: 変換はできる');
  assert.equal(refreshCells(probe, above).size, 0, '前提: 上階では解決できる区画が無い');
  const before = serializeGraph(above);
  const r = reconcileStairVoids(above, below, sg);
  assert.deepEqual(r.skipped.map(s => s.reason), ['untranslatable']);
  assert.equal(r.added.length, 0);
  assert.equal(above.rooms.length, 0);
  assert.equal(r.changed, false);
  assert.deepEqual(serializeGraph(above), before);
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
