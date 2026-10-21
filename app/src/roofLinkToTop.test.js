// 屋根専用平面の紐づけ（roofForPlaneId）は、最上階が入れ替わる全経路（最上階の上への追加・並べ替え・階変更・
// 最上階の削除）とその undo／redo で、常に「その時点の最上階（project.planes の末尾）」を指す。
// 規則は followRoofPlaneToTop の1か所。App.jsx の undoFloorOp／redoFloorOp と同じ順（状態を戻す→最後に follow）で往復させる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from './core.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from './floorOrderChange.js';
import { collectPlaneMetas, applyPlaneMetas } from './floorOps.js';
import { followRoofPlaneToTop, syncRoofPlane } from './structural/roofPlane.js';

const ui = { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} };
const roofOnly = floorOrderFollowers.filter(f => f.name === 'roofPlaneHeight');

/** p1(0)・p2(3000)・p3(6000)。屋根専用平面 'roof' は p3 に乗る（elevation 6001）。 */
function makeProject({ withRoof = true } = {}) {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  if (withRoof) project.addPlane(6001, '小屋伏', 'roof', 3, 1, false, null, 0, true, 'p3');
  project.activePlaneId = 'p1';
  return project;
}
const roofOf = (project) => {
  const r = project.roofPlane;
  return r ? { id: r.id, forId: r.roofForPlaneId, elevation: r.elevation, startFloor: r.startFloor, stories: r.stories } : null;
};
const topId = (project) => project.planes.at(-1).id;

/** 最上階の上へ p4(9000) を追加。undo／redo は App.jsx と同じ順。 */
async function insertTop(project) {
  const metasBefore = collectPlaneMetas(project);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.INSERT, updates: [], ui, newStartFloor: 4,
    addPlane: () => project.addPlane(9000, '4階', 'p4', 4, 1),
  }, roofOnly);
  const metasAfter = collectPlaneMetas(project);
  return {
    undo() { project.removePlane('p4'); applyPlaneMetas(project, metasBefore); followRoofPlaneToTop(project); },
    redo() {
      applyPlaneMetas(project, metasAfter);
      project.addPlane(9000, '4階', 'p4', 4, 1);
      followRoofPlaneToTop(project);
    },
  };
}

/** updates だけを適用する階操作（REORDER／CHANGE）。undo／redo は applyPlaneMetas + follow。 */
async function applyUpdates(project, kind, updates) {
  const metasBefore = collectPlaneMetas(project);
  await applyFloorOrderChange(project, { kind, updates, ui }, roofOnly);
  const metasAfter = collectPlaneMetas(project);
  return {
    undo() { applyPlaneMetas(project, metasBefore); followRoofPlaneToTop(project); },
    redo() { applyPlaneMetas(project, metasAfter); followRoofPlaneToTop(project); },
  };
}

/** 階 id を削除する（DELETE）。undo は同じ Plane／PlanGraph を戻す（restorePlane）。 */
async function deleteFloor(project, id, updates = []) {
  const metasBefore = collectPlaneMetas(project);
  const plane = project.planeMap.get(id);
  const graph = project.graphMap.get(id);
  await applyFloorOrderChange(project, {
    kind: FLOOR_ORDER_KIND.DELETE, updates, ui, removedPlane: plane,
    removePlane: async () => project.removePlane(id),
  }, roofOnly);
  const metasAfter = collectPlaneMetas(project);
  return {
    undo() { project.restorePlane(plane, graph); applyPlaneMetas(project, metasBefore); followRoofPlaneToTop(project); },
    redo() { project.removePlane(id); applyPlaneMetas(project, metasAfter); followRoofPlaneToTop(project); },
  };
}

const swapP2P3 = [
  { id: 'p2', name: '2階', startFloor: 3, elevation: 6000 },
  { id: 'p3', name: '3階', startFloor: 2, elevation: 3000 },
];

test('最上階の上への追加: 屋根平面は作り直さず新しい最上階 p4 へ付け替わり elevation も追従。undo で p3、redo で p4', async () => {
  const project = makeProject();
  const c = await insertTop(project);
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p4', elevation: 9001, startFloor: 4, stories: 1 });
  assert.equal(project.planeMap.size, 5, 'p1〜p4＋屋根平面。増えたのは p4 の1つだけ（作り直していない）');
  c.undo();
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p3', elevation: 6001, startFloor: 3, stories: 1 });
  c.redo();
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p4', elevation: 9001, startFloor: 4, stories: 1 });
  c.undo();
  assert.equal(roofOf(project).forId, 'p3', '2回目の undo');
});

test('並べ替え(REORDER)で最上階が p3 から p2 に入れ替わる: 付け替え。undo／redo で往復', async () => {
  const project = makeProject();
  const c = await applyUpdates(project, FLOOR_ORDER_KIND.REORDER, swapP2P3);
  assert.equal(topId(project), 'p2');
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p2', elevation: 6001, startFloor: 3, stories: 1 });
  c.undo();
  assert.equal(topId(project), 'p3');
  assert.equal(roofOf(project).forId, 'p3');
  c.redo();
  assert.equal(roofOf(project).forId, 'p2');
});

test('階変更(CHANGE)で最上階が p1 に入れ替わる: 付け替え＋高さ追従。undo／redo で往復', async () => {
  const project = makeProject();
  const c = await applyUpdates(project, FLOOR_ORDER_KIND.CHANGE, [{ id: 'p1', name: '1階', startFloor: 4, elevation: 9000 }]);
  assert.equal(topId(project), 'p1');
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p1', elevation: 9001, startFloor: 4, stories: 1 });
  c.undo();
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p3', elevation: 6001, startFloor: 3, stories: 1 });
  c.redo();
  assert.equal(roofOf(project).forId, 'p1');
});

test('最上階の削除: 1つ下の p2 へ付け替わる。undo で復活した p3 へ付け替え直し、redo で p2', async () => {
  const project = makeProject();
  const c = await deleteFloor(project, 'p3');
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p2', elevation: 3001, startFloor: 2, stories: 1 });
  c.undo();
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p3', elevation: 6001, startFloor: 3, stories: 1 });
  c.redo();
  assert.equal(roofOf(project).forId, 'p2');
});

test('最上階が変わらない並べ替え(p1とp2の入替え)では紐づけは p3 のまま', async () => {
  const project = makeProject();
  const c = await applyUpdates(project, FLOOR_ORDER_KIND.REORDER, [
    { id: 'p1', name: '1階', startFloor: 2, elevation: 3000 },
    { id: 'p2', name: '2階', startFloor: 1, elevation: 0 },
  ]);
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p3', elevation: 6001, startFloor: 3, stories: 1 });
  c.undo();
  assert.equal(roofOf(project).forId, 'p3');
});

test('【失敗系】屋根平面が無い文書では全経路×undo／redo で屋根平面ができない', async () => {
  const cases = [
    (p) => insertTop(p),
    (p) => applyUpdates(p, FLOOR_ORDER_KIND.REORDER, swapP2P3),
    (p) => applyUpdates(p, FLOOR_ORDER_KIND.CHANGE, [{ id: 'p1', name: '1階', startFloor: 4, elevation: 9000 }]),
    (p) => deleteFloor(p, 'p3'),
  ];
  for (const run of cases) {
    const project = makeProject({ withRoof: false });
    const c = await run(project);
    assert.equal(project.roofPlane, null);
    c.undo();
    assert.equal(project.roofPlane, null);
    c.redo();
    assert.equal(project.roofPlane, null);
  }
});

test('syncRoofPlane: 紐づけが古い(p2)ままでも作り直さず、同じインスタンスを p3 へ付け替えて返す（平面数も増えない）', () => {
  const project = makeProject();
  project.roofPlane.roofForPlaneId = 'p2';
  project.roofPlane.elevation = 3001;
  const roof = project.roofPlane;
  const sizeBefore = project.planeMap.size;
  const ret = syncRoofPlane(project);
  assert.ok(ret === roof, '同じインスタンス');
  assert.equal(project.planeMap.size, sizeBefore);
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p3', elevation: 6001, startFloor: 3, stories: 1 });
});

test('syncRoofPlane: 屋根平面が無ければ最上階の上に作る', () => {
  const project = makeProject({ withRoof: false });
  const roof = syncRoofPlane(project);
  assert.equal(roof.roofForPlaneId, 'p3');
  assert.equal(roof.elevation, 6001);
});

test('【失敗系】最上階より高い elevation の検討案があっても、屋根は採用階（project.planes の末尾）に付く', () => {
  const project = makeProject();
  project.addPlane(9000, '3階#a', 'p3a', 3, 1, true, 'p3', 0);
  project.roofPlane.roofForPlaneId = 'p2';
  assert.equal(followRoofPlaneToTop(project), true);
  assert.deepEqual(roofOf(project), { id: 'roof', forId: 'p3', elevation: 6001, startFloor: 3, stories: 1 });
});

test('followRoofPlaneToTop: 付け替えだけして高さが合っているときも true（どれか1つでも書けば true）。2回目は false', () => {
  const project = makeProject();
  project.roofPlane.roofForPlaneId = 'p2'; // 高さ等は p3 に合っている
  assert.equal(followRoofPlaneToTop(project), true);
  assert.equal(project.roofPlane.roofForPlaneId, 'p3');
  assert.equal(followRoofPlaneToTop(project), false);
});
