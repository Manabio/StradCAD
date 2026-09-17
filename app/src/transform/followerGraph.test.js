// centerLineOps.test.js と同じ方針: computeMoveRange/collectFollowerOffsets は純関数だが、
// effectiveValue・structGraph（project.structGraph=全階共通通り芯）連携の実挙動を再現するため実 core.js を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '../core.js';
import { computeMoveRange, collectFollowerOffsets, resolveMoveRange } from './followerGraph.js';

// project.structGraph（全階共通の通り芯）+ 自グラフ（階固有の中心線・補助線・梁芯）を持つ最小プロジェクト。
function makeProjectWithGraph() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// followerGraph.js 内部の gatherShapes は非 export のため、computeMoveRange 直呼び用の
// 最小 bundle は graph.centerLines（自グラフ+structGraphのマージ済みゲッター）から組む。
function bundleFrom(graph) {
  return { centerLines: graph.centerLines, walls: graph.walls, diagonals: [] };
}

test('computeMoveRange: 中心線の移動は同方向の梁芯（fuse）を障害物にしない', () => {
  const { graph } = makeProjectWithGraph();
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  const bundle = bundleFrom(graph);
  const { offsetOf } = collectFollowerOffsets(bundle, moving);
  const range = computeMoveRange(bundle, moving, offsetOf);

  assert.equal(range.max, 3000, '梁芯(V1000)を素通りし通り芯(V3000)で止まる');
  assert.equal(range.min, -Infinity);
});

test('computeMoveRange: 補助線（lineType:dashed）の移動も梁芯を障害物にしない', () => {
  const { graph } = makeProjectWithGraph();
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, lineType: 'dashed' });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  const bundle = bundleFrom(graph);
  const { offsetOf } = collectFollowerOffsets(bundle, moving);
  const range = computeMoveRange(bundle, moving, offsetOf);

  assert.equal(range.max, 3000, '梁芯(V1000)を素通りし通り芯(V3000)で止まる');
});

test('computeMoveRange: 通り芯の移動は梁芯を障害物のまま残す', () => {
  const { graph } = makeProjectWithGraph();
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });

  const bundle = bundleFrom(graph);
  const { offsetOf } = collectFollowerOffsets(bundle, moving);
  const range = computeMoveRange(bundle, moving, offsetOf);

  assert.equal(range.max, 1000, '通り芯の移動は梁芯(V1000)で止まる');
});

test('computeMoveRange回帰: 中心線の移動は同方向の中心線・通り芯・壁を従来どおり障害物にする', () => {
  const { graph } = makeProjectWithGraph();
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false });
  graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false }); // 他の中心線
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT }); // 通り芯

  const bundle = bundleFrom(graph);
  const { offsetOf } = collectFollowerOffsets(bundle, moving);
  const range = computeMoveRange(bundle, moving, offsetOf);

  assert.equal(range.max, 500, '同方向の中心線(V500)で止まる（従来どおり）');
});

test('resolveMoveRange（本番経路）: 中心線の移動は梁芯を素通りし通り芯で止まる', async () => {
  const { project, graph } = makeProjectWithGraph();
  const moving = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  const result = await resolveMoveRange(project, graph, moving);

  assert.equal(result.range.max, 3000, '呼び出し側が computeMoveRange に渡す bundle 経路でも梁芯を素通りする');
});
