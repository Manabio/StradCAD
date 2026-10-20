// 階設定表を開くときに集める事実（floorSettingsFacts.js。階設定表 S8）。アクティブ階はライブのグラフ、他階は peek。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoomFeature } from './core.js';
import { collectFloorSettingsFacts, graphHasLeanTo } from './floorSettingsFacts.js';
import { createLeanToRoofSpec } from './finish/roof/roofDefaults.js';

function addRectRoom(graph, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  return graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
}

function makeProject() {
  const project = new Project('proj', 'test');
  const graphs = [0, 3000, 6000].map((el, i) => project.addPlane(el, `${i + 1}階`, `p${i + 1}`, i + 1, 1).graph);
  project.activePlaneId = 'p2'; // 中間階がアクティブ
  graphs[0].addStair({ totalSteps: 15, riser: 200 }, 'sa');
  graphs[1].addStair({ totalSteps: 14 }, 'sb');
  return { project, graphs };
}

test('全採用階の階段を要約する: 階 id・階段 id・総段数・明示 riser の有無・表示名（仕上げの階段タブと同じ「階段N（出発->到達階）」）', async () => {
  const { project } = makeProject();
  const peeked = [];
  const { stairItems } = await collectFloorSettingsFacts(project, {
    peekFn: async (plane) => { peeked.push(plane.id); return project.graphMap.get(plane.id); },
  });
  assert.deepEqual(peeked.sort(), ['p1', 'p3'], 'アクティブ階(p2)は peek せずライブのグラフを使う');
  assert.deepEqual(stairItems.map(i => [i.planeId, i.stairId, i.totalSteps, i.explicitRiser, i.label]), [
    ['p1', 'sa', 15, 200, '階段1（1->2階）'],
    ['p2', 'sb', 14, null, '階段2（2->3階）'],
  ]);
});

test('下屋のある階: roofSpec を持つ feature=roof の部屋がある階だけ。屋内の部屋だけの階・部屋の無い階は含めない', async () => {
  const { project, graphs } = makeProject();
  const room = addRectRoom(graphs[0], '下屋');
  room.setFeature(RoomFeature.ROOF);
  room.setRoofSpec(createLeanToRoofSpec());
  addRectRoom(graphs[2], '居室');
  const { leanToPlaneIds } = await collectFloorSettingsFacts(project, { peekFn: async (plane) => project.graphMap.get(plane.id) });
  assert.deepEqual(leanToPlaneIds, ['p1']);
  assert.equal(graphHasLeanTo(graphs[0]), true);
  assert.equal(graphHasLeanTo(graphs[2]), false);
  assert.equal(graphHasLeanTo(null), false);
});

test('アクティブ階が採用階に無い（検討案）なら全採用階を peek する', async () => {
  const { project } = makeProject();
  project.activePlaneId = null;
  const peeked = [];
  await collectFloorSettingsFacts(project, { peekFn: async (plane) => { peeked.push(plane.id); return project.graphMap.get(plane.id); } });
  assert.deepEqual(peeked.sort(), ['p1', 'p2', 'p3']);
});

test('【失敗系】他階の peek が throw / null なら reject する（階段・下屋を確かめられないまま確定させない）', async () => {
  const { project } = makeProject();
  await assert.rejects(collectFloorSettingsFacts(project, { peekFn: async () => { throw new Error('IDB 失敗'); } }), /IDB 失敗/);
  await assert.rejects(collectFloorSettingsFacts(project, { peekFn: async () => null }), /階の読込みに失敗/);
});
