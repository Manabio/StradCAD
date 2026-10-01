// finish/roof/roofFloorCheck.js（屋根を付けた直後の「上の階に屋内部屋があるか」の判定）の単体テスト。
//
// peek のスタブは本番同型（保存バイト列から PlanGraph を復元する makeStorePeek。生きたグラフを返さない
// ——team-lessons「他階 peek のテストスタブが生きたグラフを返し…」）。呼び出し回数は log で assert する
// （干渉・スタブに依存するテストの空振り防止）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoomFeature, RoomKind } from '../../core.js';
import { worldToCell } from '../gridCells.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { makeStorePeek } from '../equipment/equipmentTestFixtures.js';
import { findUpperRoomsOverCells, upperAdoptedPlanes } from './roofFloorCheck.js';

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
const leftKey  = (g) => worldToCell(500, 500, g).key;
const rightKey = (g) => worldToCell(1500, 500, g).key;
const addPerFloorV = (g, x) => g.addCenterLine(CenterLineType.VERTICAL, x, { labeled: false, discipline: Discipline.ARCH });

function addRoom(graph, key, { kind = RoomKind.INTERIOR, feature = null, name = '部屋' } = {}) {
  const room = graph.addRoom(new Set([key]), name);
  room.setKind(kind);
  if (feature) room.setFeature(feature);
  return room;
}

// 全階を保存バイト列にして本番同型の peek を作る。log へ peek された planeId を記録する。
function makePeek(project, graphs, log) {
  const store = new Map();
  for (const g of graphs) store.set(g.plane.id, serializeGraph(g));
  const inner = makeStorePeek(project, store);
  return (plane) => { log.push(plane.id); return Promise.resolve(inner(plane)); };
}

test('上の階の同じ位置に屋内部屋がある→その階名が返る', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  const log = [];
  addRoom(g2, leftKey(g2), { name: '寝室' });
  const names = await findUpperRoomsOverCells(project, g1, new Set([leftKey(g1)]), makePeek(project, graphs, log));
  assert.deepEqual(names, ['2階']);
  assert.deepEqual(log, ['p2'], '上の階（2階）だけを peek する');
});

test('上の階が無割当・屋外部屋・屋根・未定義・別の位置の部屋なら該当なし（それぞれ peek は1回走る）', async () => {
  const cases = [
    ['無割当', () => {}],
    ['屋外部屋', (g) => addRoom(g, leftKey(g), { kind: RoomKind.EXTERIOR, name: 'バルコニー' })],
    ['屋根', (g) => addRoom(g, leftKey(g), { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF, name: '屋根' })],
    ['未定義', (g) => addRoom(g, leftKey(g), { feature: RoomFeature.UNDEFINED })],
    ['別の位置の屋内部屋', (g) => addRoom(g, rightKey(g))],
  ];
  for (const [label, setup] of cases) {
    const { project, graphs } = setupProject(2);
    const [g1, g2] = graphs;
    setup(g2);
    const log = [];
    const names = await findUpperRoomsOverCells(project, g1, new Set([leftKey(g1)]), makePeek(project, graphs, log));
    assert.deepEqual(names, [], `${label}: 該当なしのはず`);
    assert.equal(log.length, 1, `${label}: 上の階を1回 peek している（空振りでない）`);
  }
});

test('複数の階に該当すれば全部を階の順に返す／間の階が該当なしなら飛ばす', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRoom(g2, leftKey(g2));
  addRoom(g3, leftKey(g3));
  const all = await findUpperRoomsOverCells(project, g1, new Set([leftKey(g1)]), makePeek(project, graphs, []));
  assert.deepEqual(all, ['2階', '3階']);

  const { project: p2, graphs: gs2 } = setupProject(3);
  addRoom(gs2[2], leftKey(gs2[2]));
  const some = await findUpperRoomsOverCells(p2, gs2[0], new Set([leftKey(gs2[0])]), makePeek(p2, gs2, []));
  assert.deepEqual(some, ['3階'], '2階は該当なし・3階だけ該当');
});

test('自階より下の階は見ない（下の階に部屋があっても、peek もしない）', async () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2, g3] = graphs;
  addRoom(g1, leftKey(g1));
  addRoom(g3, leftKey(g3));
  const log = [];
  const names = await findUpperRoomsOverCells(project, g2, new Set([leftKey(g2)]), makePeek(project, graphs, log));
  assert.deepEqual(names, ['3階']);
  assert.deepEqual(log, ['p3'], '1階（下）・2階（自階）は peek しない');
});

test('最上階の屋根は上の階が無いので該当なし（peek もしない）', async () => {
  const { project, graphs } = setupProject(2);
  const log = [];
  const names = await findUpperRoomsOverCells(project, graphs[1], new Set([leftKey(graphs[1])]), makePeek(project, graphs, log));
  assert.deepEqual(names, []);
  assert.equal(log.length, 0);
});

test('検討案の平面がアクティブなら上の階は無いものとする（階段・昇降機と同じ流儀）／屋根専用平面と検討案は上の階に数えない', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addRoom(g2, leftKey(g2));
  // 1階の検討案（採用フロアではない）
  const { graph: alt } = project.addPlane(0, '1階案', 'alt1', 1, 1, true, 'p1', 1);
  addRoom(alt, leftKey(alt));
  const log = [];
  const allGraphs = [...graphs, alt];
  const peekFn = makePeek(project, allGraphs, log);
  assert.deepEqual(await findUpperRoomsOverCells(project, alt, new Set([leftKey(alt)]), peekFn), [],
    '検討案がアクティブ: 上の階は無い扱い');
  assert.equal(log.length, 0, '検討案がアクティブなら peek しない');

  // 2階の検討案と屋根専用平面（どちらも project.planes に含まれない）に屋内部屋があっても数えない
  const { graph: alt2 } = project.addPlane(3000, '2階案', 'alt2', 1, 1, true, 'p2', 1);
  addRoom(alt2, leftKey(alt2));
  const { graph: roofPlane } = project.addPlane(6000, 'R階', 'rp', 1, 1, false, null, 0, true, 'p2');
  addRoom(roofPlane, leftKey(roofPlane));
  const log2 = [];
  const names = await findUpperRoomsOverCells(project, g1, new Set([leftKey(g1)]),
    makePeek(project, [...allGraphs, alt2, roofPlane], log2));
  assert.deepEqual(names, ['2階']);
  assert.deepEqual(log2, ['p2'], '採用フロア（2階）だけを peek する');
});

test('upperAdoptedPlanes: activePlane が採用フロアでない・null なら空', () => {
  const { project } = setupProject(3);
  const planes = project.planes;
  assert.deepEqual(upperAdoptedPlanes(planes, planes[0]).map(p => p.id), ['p2', 'p3']);
  assert.deepEqual(upperAdoptedPlanes(planes, planes[2]).map(p => p.id), []);
  assert.deepEqual(upperAdoptedPlanes(planes, null), []);
  assert.deepEqual(upperAdoptedPlanes(planes, { id: 'unknown' }), []);
});

// ---- セルの対応は世界座標（階ごとに CL 構成・格子の粒度が違う） ----

test('上の階の格子が細かい: 屋根セルの半分だけに重なる部屋でも当たる', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addPerFloorV(g2, 500); // 2階だけ x=500 で割る: [0,500]・[500,1000]
  const rightHalf = worldToCell(750, 500, g2).key;
  addRoom(g2, rightHalf, { name: '右半分' });
  const roofKey = leftKey(g1); // 1階は粗い [0,1000]
  assert.notEqual(roofKey, rightHalf, '前提: キーは階ごとに違う（キー一致では当たらない）');
  const names = await findUpperRoomsOverCells(project, g1, new Set([roofKey]), makePeek(project, graphs, []));
  assert.deepEqual(names, ['2階']);
});

test('上の階の格子が粗い: 屋根が細かい格子の1セルでも、それを含む粗い部屋に当たる', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addPerFloorV(g1, 500); // 1階だけ細かい
  const roofKey = worldToCell(250, 500, g1).key; // [0,500]
  addRoom(g2, leftKey(g2), { name: '粗い部屋' }); // 2階 [0,1000]
  const names = await findUpperRoomsOverCells(project, g1, new Set([roofKey]), makePeek(project, graphs, []));
  assert.deepEqual(names, ['2階']);
});

test('ずれ: 上の階の部屋が屋根セルに辺で接するだけ（面積の重なり0）なら該当なし', async () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  addPerFloorV(g2, 500);
  addPerFloorV(g1, 500);
  addRoom(g2, worldToCell(750, 500, g2).key, { name: '右半分' }); // 2階 [500,1000]
  const roofKey = worldToCell(250, 500, g1).key;                  // 1階 [0,500]
  const log = [];
  const names = await findUpperRoomsOverCells(project, g1, new Set([roofKey]), makePeek(project, graphs, log));
  assert.deepEqual(names, [], '[0,500] と [500,1000] は接するだけ');
  assert.equal(log.length, 1);
});

// ---- 失敗系 ----

test('【失敗系】peekFn が reject したら握りつぶさず reject する', async () => {
  const { project, graphs } = setupProject(2);
  let calls = 0;
  const peekFn = async () => { calls++; throw new Error('IDB read failed'); };
  await assert.rejects(
    () => findUpperRoomsOverCells(project, graphs[0], new Set([leftKey(graphs[0])]), peekFn),
    /IDB read failed/,
  );
  assert.equal(calls, 1);
});

test('【失敗系】peekFn が null を返したら（グラフが無い）reject する', async () => {
  const { project, graphs } = setupProject(2);
  let calls = 0;
  const peekFn = async () => { calls++; return null; };
  await assert.rejects(
    () => findUpperRoomsOverCells(project, graphs[0], new Set([leftKey(graphs[0])]), peekFn),
    /peek が階のグラフを返しませんでした/,
  );
  assert.equal(calls, 1);
});

test('【失敗系】屋根のセルが空・解決できないキーだけなら peek せず該当なし', async () => {
  const { project, graphs } = setupProject(2);
  const log = [];
  const peekFn = makePeek(project, graphs, log);
  assert.deepEqual(await findUpperRoomsOverCells(project, graphs[0], new Set(), peekFn), []);
  assert.deepEqual(await findUpperRoomsOverCells(project, graphs[0], new Set(['x:y:z:w']), peekFn), []);
  assert.equal(log.length, 0);
});
