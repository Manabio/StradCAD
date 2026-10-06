// finish/stair/stairFloorSync.js addNewFloorRoomFromSource の単体テスト。
//
// addNewFloorRoomFromSource の変換後のセル（translatedCells）は refreshCells を通していないと、
// 新階の格子が元の階より細かいとき、既に割当済み（昇降機の複製等）のセルのキーの粒度が合わず、
// 除外できない可能性がある。この落とし穴を固定するテストを含む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Project, CenterLineType, Discipline, RoomFeature, RoomKind, StairType } from '../../core.js';
import { worldToCell, refreshCells } from '../gridCells.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { makeStorePeek, makeStoreSave, decodeFloor, assertShaftInvariant } from '../equipment/equipmentTestFixtures.js';
import { installEquipment } from '../equipment/equipmentOps.js';
import { copyElevatorsToNewFloor } from '../equipment/equipmentFloorSync.js';
import { addNewFloorRoomFromSource, syncUpperFloors, syncUpperStairInteriors } from './stairFloorSync.js';
import { undoManager } from '../../undoManager.js';
import { collectNeededCLs } from '../floorCLMap.js';
import { placeStair, addPerFloorV } from './stairRemovalTestFixtures.js';

// X:[0,1000,2000] Y:[0,1000]（全階共通の通り芯）。left=[0,1000]x[0,1000]・right=[1000,2000]x[0,1000]。
function setupProject(floorCount) {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   1000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000, grid);
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * 3000, `${i + 1}階`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}
function leftKey(graph)  { return worldToCell(500, 500, graph).key; }
function rightKey(graph) { return worldToCell(1500, 500, graph).key; }

test('【結合】addNewFloorRoomFromSource: 昇降機の複製後、外壁内側の部屋のセルと昇降路のセルが交わらず、I1が成り立つ（新階の格子が元の階と同じ粒度）', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  installEquipment(g1, { id: 'ev-a', category: 'ev', usage: 'passenger', no: 1, cells: new Set([leftKey(g1)]) });
  g1.addRoom(new Set([rightKey(g1)]), 'ホール');
  const { plane: p2 } = project.addPlane(3000, '2階', 'p2');
  const store = new Map();
  store.set(g1.plane.id, serializeGraph(g1));
  const peekFn = makeStorePeek(project, store);
  const saveFloorFn = makeStoreSave(store, []);

  const copyResult = await copyElevatorsToNewFloor({ project, activeGraph: g1, newPlane: p2, peekFn, saveFloorFn });
  assert.equal(copyResult.status, 'copied');
  await addNewFloorRoomFromSource(project, g1, p2, '2階', peekFn, saveFloorFn);

  const decoded = decodeFloor(project, p2, store.get('p2'));
  assertShaftInvariant(decoded, '2階');
  const shaftRoom = decoded.rooms.find(r => r.feature === RoomFeature.ELEVATOR_EQUIPMENT);
  const namedRoom = decoded.rooms.find(r => r.name === '2階');
  assert.ok(shaftRoom, '前提: 昇降路Roomが複製されている');
  assert.ok(namedRoom, '前提: 外壁内側の部屋が作られている');
  const shaftCells = refreshCells(shaftRoom.cells, decoded);
  const namedCells = refreshCells(namedRoom.cells, decoded);
  for (const key of shaftCells) {
    assert.ok(!namedCells.has(key), `部屋のセルと昇降路のセルが重なっている（key=${key}）`);
  }
});

test('【結合】addNewFloorRoomFromSource: 新階の格子が元の階より細かい場合（新階にだけ余分な中心線がある）も、部屋のセルと昇降路のセルが交わらない', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  installEquipment(g1, { id: 'ev-a', category: 'ev', usage: 'passenger', no: 1, cells: new Set([leftKey(g1)]) });
  g1.addRoom(new Set([rightKey(g1)]), 'ホール');
  const { plane: p2, graph: g2 } = project.addPlane(3000, '2階', 'p2');
  // 新階(2階)にだけ、leftの領域を割る per-floor 中心線を先に足しておく（新階の格子が元の階より細かい状態）。
  g2.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const store = new Map();
  store.set(g1.plane.id, serializeGraph(g1));
  store.set(p2.id, serializeGraph(g2));
  const peekFn = makeStorePeek(project, store);
  const saveFloorFn = makeStoreSave(store, []);

  const copyResult = await copyElevatorsToNewFloor({ project, activeGraph: g1, newPlane: p2, peekFn, saveFloorFn });
  assert.equal(copyResult.status, 'copied');
  await addNewFloorRoomFromSource(project, g1, p2, '2階', peekFn, saveFloorFn);

  const decoded = decodeFloor(project, p2, store.get('p2'));
  assertShaftInvariant(decoded, '2階（細かい格子）');
  const shaftRoom = decoded.rooms.find(r => r.feature === RoomFeature.ELEVATOR_EQUIPMENT);
  const namedRoom = decoded.rooms.find(r => r.name === '2階');
  assert.ok(shaftRoom, '前提: 昇降路Roomが複製されている');
  assert.ok(namedRoom, '前提: 外壁内側の部屋が作られている');
  const shaftCells = refreshCells(shaftRoom.cells, decoded);
  const namedCells = refreshCells(namedRoom.cells, decoded);
  for (const key of shaftCells) {
    assert.ok(!namedCells.has(key), `部屋のセルと昇降路のセルが重なっている（key=${key}）——新階の格子が細かい場合の粒度不一致`);
  }
});

// ---- 屋根（RoomFeature.ROOF。ステップB1a）: 上に階を追加するときの複写から屋根セルを除く
// （屋根の上の階は建物の外。屋内部屋を作ると屋根の上に部屋ができてしまう）。 ----
function addRoof(graph, cellKey, name = '屋根') {
  const roof = graph.addRoom(new Set([cellKey]), name);
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  return roof;
}

test('【B1a】addNewFloorRoomFromSource: 元の階の屋根セルは新階の部屋に写さない（屋内部屋のセルだけが写る）', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  g1.addRoom(new Set([leftKey(g1)]), 'ホール');
  addRoof(g1, rightKey(g1));
  const { plane: p2 } = project.addPlane(3000, '2階', 'p2');
  const store = new Map();
  store.set(g1.plane.id, serializeGraph(g1));
  const peekFn = makeStorePeek(project, store);
  const saveFloorFn = makeStoreSave(store, []);

  await addNewFloorRoomFromSource(project, g1, p2, '2階', peekFn, saveFloorFn);

  const decoded = decodeFloor(project, p2, store.get('p2'));
  const named = decoded.rooms.find(r => r.name === '2階');
  assert.ok(named, '前提: 屋内部屋のセルから新階の部屋ができる');
  const cells = refreshCells(named.cells, decoded);
  assert.equal(cells.size, 1, '写るのは屋内部屋（左）の1セルだけ');
  assert.ok(!cells.has(rightKey(decoded)), '屋根セル（右）は新階の部屋に含まれない');
  assert.equal(decoded.rooms.some(r => r.feature === RoomFeature.ROOF), false, '新階に屋根は複写されない');
});

test('【B1a・失敗系】addNewFloorRoomFromSource: 元の階が屋根セルだけなら新階に部屋を作らず何も保存しない', async () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  addRoof(g1, leftKey(g1));
  const { plane: p2 } = project.addPlane(3000, '2階', 'p2');
  const store = new Map();
  store.set(g1.plane.id, serializeGraph(g1));
  const saved = [];
  const peekFn = makeStorePeek(project, store);
  const saveFloorFn = makeStoreSave(store, saved);

  await addNewFloorRoomFromSource(project, g1, p2, '2階', peekFn, saveFloorFn);

  assert.equal(store.has('p2'), false, '新階は保存されない');
  assert.equal(saved.length, 0);
});

// ---- syncUpperFloors（階段の新規指定時の展開）: 設置階の直上1階だけへ階段吹抜け（STAIR_VOID）を置く。
// 階段実体は上階に置かない。3階建ての fixture で「さらに上の階は何も変わらない（保存0回）」を固定する。
// peek・保存は本番同型（バイト列の Map ＋ restoreGraph）の注入。 ----
const voidRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);

// 全階の保存データ（バイト列）を Map へ控え、peek・保存・記録の注入口を返す
function makeSyncCtx(project, graphs) {
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const saved = [];
  const peeked = [];
  const inner = makeStorePeek(project, store);
  return {
    store, saved, peeked,
    peekFn: async (plane) => { peeked.push(plane.id); return inner(plane); },
    saveFloorFn: makeStoreSave(store, saved),
  };
}
const bytesOf = (store, id) => Buffer.from(store.get(id));

test('【syncUpperFloors】1階で指定→2階にだけ階段吹抜けが1つ・階段実体は無い。3階は何も変わらず保存0回・peek もしない', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addPerFloorV(graphs); // 足元が per-floor 中心線 x=500 を含む（左半分）
  placeStair(project, g1);
  const ctx = makeSyncCtx(project, graphs);
  const p3Before = bytesOf(ctx.store, 'p3');

  await syncUpperFloors(project, g1, { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  const d2 = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  assert.equal(voidRooms(d2).length, 1, '2階に階段吹抜けが1つ');
  assert.equal(d2.stairs.length, 0, '2階に階段実体は作られない');
  assert.deepEqual([...refreshCells(voidRooms(d2)[0].cells, d2)], [leftHalfKey(d2)], '足元は左半分');
  assert.deepEqual(ctx.saved, ['p2'], '保存は2階の1回だけ');
  assert.deepEqual(ctx.peeked, ['p2'], '3階は peek もしない');
  assert.ok(bytesOf(ctx.store, 'p3').equals(p3Before), '3階のバイト列は不変');
  assert.equal(decodeFloor(project, g3.plane, ctx.store.get('p3')).rooms.length, 0);
});
const leftHalfKey = (g) => worldToCell(250, 500, g).key;

test('【syncUpperFloors】2階（中間階）で指定→3階に階段吹抜け。1階は変わらない', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addPerFloorV(graphs);
  placeStair(project, g2);
  const ctx = makeSyncCtx(project, graphs);
  const p1Before = bytesOf(ctx.store, 'p1');

  await syncUpperFloors(project, g2, { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  const d3 = decodeFloor(project, g3.plane, ctx.store.get('p3'));
  assert.equal(voidRooms(d3).length, 1);
  assert.equal(d3.stairs.length, 0);
  assert.deepEqual(ctx.saved, ['p3']);
  assert.ok(bytesOf(ctx.store, 'p1').equals(p1Before), '1階は不変');
  assert.equal(g1.stairs.length, 0);
});

test('【syncUpperFloors】最上階で指定→何もしない（保存0回・peek 0回）', async () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  placeStair(project, graphs[2]);
  const ctx = makeSyncCtx(project, graphs);
  const before = new Map([...ctx.store].map(([k, v]) => [k, Buffer.from(v)]));

  await syncUpperFloors(project, graphs[2], { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  assert.deepEqual(ctx.saved, []);
  assert.deepEqual(ctx.peeked, []);
  for (const [k, v] of before) assert.ok(bytesOf(ctx.store, k).equals(v), `${k} は不変`);
});

test('【syncUpperFloors・回帰】通り芯だけで囲まれた階段（per-floor 中心線なし）でも2階に階段吹抜けが置かれる', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  placeStair(project, g1, { pts: [[500, 500]] }); // 通り芯 [0,1000]x[0,1000] だけ
  assert.equal(collectNeededCLs(g1.stairs[0].cells, g1).size, 0, '前提: 足元は per-floor 中心線を含まない（旧 needed.size === 0 の形）');
  const ctx = makeSyncCtx(project, graphs);

  await syncUpperFloors(project, g1, { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  assert.equal(voidRooms(decodeFloor(project, g2.plane, ctx.store.get('p2'))).length, 1);
  assert.deepEqual(ctx.saved, ['p2']);
});

test('【syncUpperFloors】2階に同 footprint の階段（ユーザー指定）が既にある→吹抜けは作らず、2階は保存しない', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  addPerFloorV(graphs);
  placeStair(project, g1);
  placeStair(project, g2); // 続きの階段をユーザーが2階で指定
  project.activePlaneId = 'p1';
  const ctx = makeSyncCtx(project, graphs);
  const p2Before = bytesOf(ctx.store, 'p2');

  await syncUpperFloors(project, g1, { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  const d2 = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  assert.equal(voidRooms(d2).length, 0, '吹抜けは作らない');
  assert.equal(d2.stairs.length, 1, 'ユーザーの階段は残る');
  assert.deepEqual(ctx.saved, []);
  assert.ok(bytesOf(ctx.store, 'p2').equals(p2Before));
});

test('【syncUpperFloors】2階に吹抜けがある状態で同 footprint の階段（ペア部屋なし）が現れたら、再同期で吹抜けがペア部屋へ転用される', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  addPerFloorV(graphs);
  placeStair(project, g1);
  const ctx = makeSyncCtx(project, graphs);
  await syncUpperFloors(project, g1, { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });
  const d2 = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  const voidId = voidRooms(d2)[0].id;
  d2.addStair({ type: StairType.STRAIGHT, cells: new Set([leftHalfKey(d2)]), upDirection: 'up', flip: false, totalSteps: 12, tread: 250 });
  ctx.store.set('p2', serializeGraph(d2));

  await syncUpperFloors(project, g1, { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  const after = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  assert.equal(voidRooms(after).length, 0, '吹抜けは残らない');
  assert.equal(after.stairs.length, 1);
  assert.equal(after.stairs[0].roomId, voidId, '吹抜けの Room がペア部屋へ転用されている（ensureStairRooms が reconcile の後に走った）');
  assert.equal(after.roomMap.get(voidId).feature, RoomFeature.STAIR);
});

test('【syncUpperFloors】屋外階段→2階に何も置かず保存しない', async () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  placeStair(project, graphs[0], { kind: RoomKind.EXTERIOR });
  const ctx = makeSyncCtx(project, graphs);

  await syncUpperFloors(project, graphs[0], { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  assert.equal(voidRooms(decodeFloor(project, graphs[1].plane, ctx.store.get('p2'))).length, 0);
  assert.deepEqual(ctx.saved, []);
});

test('【syncUpperFloors】undoEntry を渡すと、undo で2階の吹抜けが消え、redo で戻る（before/after の合成）', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  addPerFloorV(graphs);
  placeStair(project, g1);
  const ctx = makeSyncCtx(project, graphs);
  const p2Before = bytesOf(ctx.store, 'p2');
  const undoEntry = undoManager.push(() => {}, () => {});

  await syncUpperFloors(project, g1, { undoEntry, peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });
  assert.equal(voidRooms(decodeFloor(project, g2.plane, ctx.store.get('p2'))).length, 1, '前提: 吹抜けが置かれた');
  const p2After = bytesOf(ctx.store, 'p2');

  undoManager.undo();
  // 直列化は復号のたびにバイト列が揺れる（id 等）ため、undo 後は復号した内容で同期前と比べる
  const d2 = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  const d2Before = decodeFloor(project, g2.plane, p2Before);
  assert.equal(voidRooms(d2).length, 0, 'undo で吹抜けが消える');
  assert.equal(d2.rooms.length, d2Before.rooms.length);
  assert.equal(d2.centerLines.length, d2Before.centerLines.length, '補完した中心線も同期前に戻る');
  assert.deepEqual(ctx.saved, ['p2', 'p2'], 'undo は2階を IDB（注入の保存）へ書き戻す');

  undoManager.redo();
  assert.ok(bytesOf(ctx.store, 'p2').equals(p2After), 'redo で吹抜けが戻る');
  assert.equal(voidRooms(decodeFloor(project, g2.plane, ctx.store.get('p2'))).length, 1);
});

test('【syncUpperFloors】2階の既存部屋が足元を覆っていても吹抜けが置かれ、部屋は足元を失う。undo で部屋のセルが戻り、redo で再び削れる', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  addPerFloorV(graphs); // 足元＝左半分 [0,500]x[0,1000]
  placeStair(project, g1);
  const leftHalf = worldToCell(250, 500, g2).key;
  const rightHalf = worldToCell(750, 500, g2).key;
  const room = g2.addRoom(new Set([leftHalf, rightHalf]), '居室');
  const ctx = makeSyncCtx(project, graphs);
  const undoEntry = undoManager.push(() => {}, () => {});

  await syncUpperFloors(project, g1, { undoEntry, peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });
  const after = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  assert.equal(voidRooms(after).length, 1, '足元に吹抜けが置かれた');
  assert.deepEqual([...refreshCells(after.roomMap.get(room.id).cells, after)], [rightHalf], '居室は足元（左半分）を失い右半分だけ');
  const p2After = bytesOf(ctx.store, 'p2');

  undoManager.undo();
  const undone = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  assert.equal(voidRooms(undone).length, 0, 'undo で吹抜けが消える');
  assert.deepEqual([...refreshCells(undone.roomMap.get(room.id).cells, undone)].sort(), [leftHalf, rightHalf].sort(), 'undo で居室のセルが戻る');

  undoManager.redo();
  assert.ok(bytesOf(ctx.store, 'p2').equals(p2After), 'redo で再び吹抜け＋削れた居室');
});

test('【syncUpperFloors】2階の中心線の区間が足元の辺に届かないと区間が延び、undo で区間も戻る（before/after の合成）', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  addPerFloorV(graphs); // x=500（足元の右辺）
  placeStair(project, g1);
  const x500 = g2.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 500);
  g2.setCenterLineExtentRef(x500, 'lo', null, 0);
  g2.setCenterLineExtentRef(x500, 'hi', null, 300); // 足元（y 0..1000）の右辺に届かない
  const ctx = makeSyncCtx(project, graphs);
  const undoEntry = undoManager.push(() => {}, () => {});
  const extentOf = (g) => { const c = g.centerLines.find(x => x.centerLineType === CenterLineType.VERTICAL && x.value === 500); return [c.extentLo, c.extentHi]; };

  await syncUpperFloors(project, g1, { undoEntry, peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });
  const after = decodeFloor(project, g2.plane, ctx.store.get('p2'));
  assert.deepEqual(extentOf(after), [0, 1000], '区間が足元の辺（y 0..1000）まで延びた');
  assert.equal(voidRooms(after).length, 1);

  undoManager.undo();
  assert.deepEqual(extentOf(decodeFloor(project, g2.plane, ctx.store.get('p2'))), [0, 300], 'undo で区間が元に戻る');
});

test('【syncUpperFloors】直上階がアクティブ階のとき（起点探索経由）はメモリ上のグラフを直接更新し、saveFloor しない', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  addPerFloorV(graphs);
  placeStair(project, g1);
  project.activePlaneId = 'p2';
  const ctx = makeSyncCtx(project, graphs);

  await syncUpperFloors(project, g1, { peekFn: ctx.peekFn, saveFloorFn: ctx.saveFloorFn });

  assert.equal(voidRooms(project.activeGraph).length, 1, 'アクティブな2階のメモリ上のグラフに吹抜けが入る');
  assert.equal(project.activeGraph, g2);
  assert.deepEqual(ctx.saved, []);
  assert.deepEqual(ctx.peeked, []);
});

test('【syncUpperFloors・失敗系】直上階の peek が失敗したら握りつぶさず reject し、何も保存しない', async () => {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  placeStair(project, graphs[0]);
  const ctx = makeSyncCtx(project, graphs);

  await assert.rejects(
    () => syncUpperFloors(project, graphs[0], {
      peekFn: async () => { throw new Error('IDB read failed'); }, saveFloorFn: ctx.saveFloorFn,
    }),
    /IDB read failed/,
  );
  assert.deepEqual(ctx.saved, []);
});

// ---- syncUpperStairInteriors（仕上げ脱出時の内装コピー）: 直上1階の STAIR_VOID／同 footprint のペア部屋だけ。 ----
// 3階にも同 footprint の吹抜けを置いておき、コピーも peek も保存もされないことを見る。
async function interiorsCtx() {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addPerFloorV(graphs);
  const { room } = placeStair(project, g1);
  room.setTemplateKey('T1');
  room.customOverrides.set('ceilingHeight', 2400);
  const cells = new Set([leftHalfKey(g2)]);
  const v2 = g2.addRoom(cells); v2.setFeature(RoomFeature.STAIR_VOID);
  const v3 = g3.addRoom(new Set([leftHalfKey(g3)])); v3.setFeature(RoomFeature.STAIR_VOID);
  const ctx = makeSyncCtx(project, graphs);
  return { project, g1, g2, g3, v2, v3, ...ctx };
}

test('【syncUpperStairInteriors】直上階（2階）の吹抜けにだけ内装（templateKey・customOverrides）をコピーし、3階は peek も保存もしない', async () => {
  const c = await interiorsCtx();
  const p3Before = bytesOf(c.store, 'p3');

  await syncUpperStairInteriors(c.project, c.g1, { peekFn: c.peekFn, saveFloorFn: c.saveFloorFn });

  const d2 = decodeFloor(c.project, c.g2.plane, c.store.get('p2'));
  const room2 = voidRooms(d2)[0];
  assert.equal(room2.templateKey, 'T1');
  assert.equal(room2.customOverrides.get('ceilingHeight'), 2400);
  assert.deepEqual(c.saved, ['p2']);
  assert.deepEqual(c.peeked, ['p2']);
  assert.ok(bytesOf(c.store, 'p3').equals(p3Before), '3階は不変');
  assert.equal(decodeFloor(c.project, c.g3.plane, c.store.get('p3')).rooms[0].templateKey, null);
});

test('【syncUpperStairInteriors】2階が既に templateKey を持てば上書きせず、保存もしない', async () => {
  const c = await interiorsCtx();
  c.v2.setTemplateKey('EDITED');
  c.store.set('p2', serializeGraph(c.g2));

  await syncUpperStairInteriors(c.project, c.g1, { peekFn: c.peekFn, saveFloorFn: c.saveFloorFn });

  const room2 = voidRooms(decodeFloor(c.project, c.g2.plane, c.store.get('p2')))[0];
  assert.equal(room2.templateKey, 'EDITED', '編集済みの内装は上書きしない');
  assert.equal(room2.customOverrides.size, 0);
  assert.deepEqual(c.saved, []);
});

test('【syncUpperStairInteriors・失敗系】直上階の peek が失敗したら握りつぶさず reject し、保存しない', async () => {
  const c = await interiorsCtx();
  await assert.rejects(
    () => syncUpperStairInteriors(c.project, c.g1, { peekFn: async () => { throw new Error('IDB read failed'); }, saveFloorFn: c.saveFloorFn }),
    /IDB read failed/,
  );
  assert.deepEqual(c.saved, []);
});
