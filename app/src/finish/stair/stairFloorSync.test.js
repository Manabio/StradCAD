// finish/stair/stairFloorSync.js addNewFloorRoomFromSource の単体テスト。
//
// addNewFloorRoomFromSource の変換後のセル（translatedCells）は refreshCells を通していないと、
// 新階の格子が元の階より細かいとき、既に割当済み（昇降機の複製等）のセルのキーの粒度が合わず、
// 除外できない可能性がある。この落とし穴を固定するテストを含む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoomFeature, RoomKind } from '../../core.js';
import { worldToCell, refreshCells } from '../gridCells.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { makeStorePeek, makeStoreSave, decodeFloor, assertShaftInvariant } from '../equipment/equipmentTestFixtures.js';
import { installEquipment } from '../equipment/equipmentOps.js';
import { copyElevatorsToNewFloor } from '../equipment/equipmentFloorSync.js';
import { addNewFloorRoomFromSource } from './stairFloorSync.js';

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
