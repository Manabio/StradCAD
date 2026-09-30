// lineIdUniqueness.js の単体テスト（線種変更の移籍一本化 指示書 §5.1・§6ステップ1）。
// findDuplicateLineIds は純関数のみに依存する完全な単体テスト。scanProjectLineIds は
// 「他の平面の読み出しを生きたグラフで代用すると壁の消失を検出できない」教訓（team-lessons）に
// 倣い、centerLineOps.test.js・lineKindTransfer.test.js と同じ「本番同型 peek」部品
// （centerLineTestFixtures.js。保存バイト列→PlanGraph復元）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from './core.js';
import { serializeGraph } from './graphSnapshot.js';
import { decodeFloor } from './transform/centerLineTestFixtures.js';
import { findDuplicateLineIds, scanProjectLineIds, lineIdsOfSnapshot } from './lineIdUniqueness.js';

// ---- findDuplicateLineIds ----

test('findDuplicateLineIds: 複数平面に同じidが無ければ空配列', () => {
  const entries = [
    { planeId: 'p1', planeName: '1階', ids: ['a', 'b'] },
    { planeId: 'p2', planeName: '2階', ids: ['c', 'd'] },
  ];
  assert.deepEqual(findDuplicateLineIds(entries), []);
});

test('findDuplicateLineIds: 2つの平面に同じidがあれば、それぞれの平面を挙げて1件報告する', () => {
  const entries = [
    { planeId: 'p1', planeName: '1階', ids: ['a', 'shared'] },
    { planeId: 'p2', planeName: '2階', ids: ['shared', 'd'] },
  ];
  const result = findDuplicateLineIds(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'shared');
  assert.deepEqual(result[0].planes, [
    { planeId: 'p1', planeName: '1階' },
    { planeId: 'p2', planeName: '2階' },
  ]);
});

test('findDuplicateLineIds: 通り芯（planeId:null）を含む3平面にまたがる重複も検出する', () => {
  const entries = [
    { planeId: 'p1', planeName: '1階', ids: ['a'] },
    { planeId: 'p2', planeName: '2階', ids: ['a'] },
    { planeId: null, planeName: '通り芯', ids: ['a'] },
  ];
  const result = findDuplicateLineIds(entries);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].planes.map(p => p.planeId), ['p1', 'p2', null]);
});

test('findDuplicateLineIds: 同一エントリ内の重複も1件として報告し、planesに同じ平面を2回入れる', () => {
  const entries = [{ planeId: 'p1', planeName: '1階', ids: ['a', 'a'] }];
  const result = findDuplicateLineIds(entries);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].planes, [
    { planeId: 'p1', planeName: '1階' },
    { planeId: 'p1', planeName: '1階' },
  ]);
});

test('findDuplicateLineIds: entriesが空配列なら空配列', () => {
  assert.deepEqual(findDuplicateLineIds([]), []);
});

test('【失敗系】findDuplicateLineIds: entries[].idsがIterableでなければthrow', () => {
  const entries = [{ planeId: 'p1', planeName: '1階', ids: 123 }];
  assert.throws(() => findDuplicateLineIds(entries));
});

test('【失敗系】findDuplicateLineIds: entries[].idsがnullならthrow', () => {
  const entries = [{ planeId: 'p1', planeName: '1階', ids: null }];
  assert.throws(() => findDuplicateLineIds(entries));
});

// ---- lineIdsOfSnapshot ----

test('lineIdsOfSnapshot: snapshot.centerLinesのid一覧を返す', () => {
  const snapshot = { centerLines: [{ id: 'cl-1' }, { id: 'cl-2' }] };
  assert.deepEqual(lineIdsOfSnapshot(snapshot), ['cl-1', 'cl-2']);
});

// ---- scanProjectLineIds（本番同型peek） ----

// 採用階2つ（1階・2階）を持つProjectを作り、storeにバイト列を保存する（本番のIDB相当）。
function makeTwoFloorProject() {
  const project = new Project('proj', 'test');
  const { graph: g1, plane: p1 } = project.addPlane(0, '1階', 'p1');
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH }, 'cl-1f-x0');
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH }, 'cl-1f-y0');
  void x0; void y0;

  const { graph: g2, plane: p2 } = project.addPlane(3000, '2階', 'p2');
  g2.addCenterLine(CenterLineType.VERTICAL,   0, { labeled: false, discipline: Discipline.ARCH }, 'cl-2f-x0');
  g2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH }, 'cl-2f-y0');

  const store = new Map([[p1.id, serializeGraph(g1)], [p2.id, serializeGraph(g2)]]);
  project.activePlaneId = p1.id; // 1階をアクティブ階とする（activeGraph=g1、2階はpeek対象）
  return { project, activeGraph: g1, store, p1, p2 };
}

// 本番同型peek: floorSwapManager.peekと同じ手順（PlanGraph復元）で store から読み出す。
function makePeek(project, store) {
  return async (plane) => decodeFloor(project, plane, store.get(plane.id));
}

test('scanProjectLineIds: 重複が無ければ空配列（アクティブ階はactiveGraph、他の平面はpeekで読む）', async () => {
  const { project, activeGraph, store } = makeTwoFloorProject();
  const peek = makePeek(project, store);
  const result = await scanProjectLineIds(project, { activeGraph, peek });
  assert.deepEqual(result, []);
});

test('scanProjectLineIds: 1階と2階に同じidの中心線があれば重複として検出する', async () => {
  const { project, activeGraph, store, p2 } = makeTwoFloorProject();
  // 2階へ1階と同じid（'cl-1f-x0'）で中心線を追加してから再保存する（§2.3の分身相当の状態を再現）。
  const g2bytes = store.get(p2.id);
  const g2 = await decodeFloor(project, p2, g2bytes);
  g2.addCenterLine(CenterLineType.VERTICAL, 999, { labeled: false, discipline: Discipline.ARCH }, 'cl-1f-x0');
  store.set(p2.id, serializeGraph(g2));

  const peek = makePeek(project, store);
  const result = await scanProjectLineIds(project, { activeGraph, peek });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'cl-1f-x0');
  assert.deepEqual(result[0].planes.map(p => p.planeId).sort(), [project.activePlaneId, p2.id].sort());
});

test('scanProjectLineIds: 走査範囲は採用階だけでなく検討案・屋根専用平面も含む（project.planesへ絞る実装だと検出できない）', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1, plane: p1 } = project.addPlane(0, '1階', 'p1');
  g1.addCenterLine(CenterLineType.VERTICAL,   0, { labeled: false, discipline: Discipline.ARCH }, 'shared-with-alt');
  g1.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH }, 'shared-with-roof');

  // 検討案（isAlternative:true）。project.planes は採用階のみを返すため対象外になりやすい。
  const { graph: gAlt, plane: alt } = project.addPlane(0, '1階#a', 'alt1', 1, 1, true, 'p1', 0);
  gAlt.addCenterLine(CenterLineType.VERTICAL, 999, { labeled: false, discipline: Discipline.ARCH }, 'shared-with-alt');

  // 屋根専用平面（isRoofPlane:true）。同じく project.planes からは除外される。
  const { graph: gRoof, plane: roof } = project.addPlane(6000, '小屋伏', 'roof1', 1, 1, false, null, 0, true, 'p1');
  gRoof.addCenterLine(CenterLineType.HORIZONTAL, 999, { labeled: false, discipline: Discipline.ARCH }, 'shared-with-roof');

  const store = new Map([
    [p1.id, serializeGraph(g1)], [alt.id, serializeGraph(gAlt)], [roof.id, serializeGraph(gRoof)],
  ]);
  project.activePlaneId = p1.id;
  const peek = makePeek(project, store);

  const result = await scanProjectLineIds(project, { activeGraph: g1, peek });
  assert.deepEqual(result.map(r => r.id).sort(), ['shared-with-alt', 'shared-with-roof']);
  const altEntry = result.find(r => r.id === 'shared-with-alt');
  assert.ok(altEntry.planes.some(p => p.planeId === alt.id), '検討案の平面idが重複エントリに含まれる');
  const roofEntry = result.find(r => r.id === 'shared-with-roof');
  assert.ok(roofEntry.planes.some(p => p.planeId === roof.id), '屋根専用平面の平面idが重複エントリに含まれる');
});

test('scanProjectLineIds: 通り芯（project.structGraph）は各階に合流表示されても誤検出されない（1つの平面にのみ属するかのように扱われる）', async () => {
  const { project, activeGraph, store } = makeTwoFloorProject();
  // 通り芯を1本追加する（全floorのgraph.centerLinesゲッターに合流して見えるが、構造上は共有グラフの1本）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const peek = makePeek(project, store);
  const result = await scanProjectLineIds(project, { activeGraph, peek });
  assert.deepEqual(result, [], '通り芯は共有グラフの1エントリにのみ現れるため重複として検出されない');
});

test('【失敗系】scanProjectLineIds: peekがrejectしたら握らずそのままrejectする', async () => {
  const { project, activeGraph } = makeTwoFloorProject();
  const boom = new Error('peek失敗（IDB読み出し不良を模す）');
  const peek = async () => { throw boom; };
  await assert.rejects(() => scanProjectLineIds(project, { activeGraph, peek }), boom);
});
