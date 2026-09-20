// centerLineOps.test.js と同じ方針: computeMoveRange/collectFollowerOffsets は純関数だが、
// effectiveValue・structGraph（project.structGraph=全階共通通り芯）連携の実挙動を再現するため実 core.js を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '../core.js';
import { computeMoveRange, collectFollowerOffsets, resolveMoveRange, isSharedCL } from './followerGraph.js';

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

// ---- isSharedCL: 「全階共有（project.structGraph）か」の判定（種別ベース。isGridCenterLine） ----
test('isSharedCL: 4種別×labeled2値の総当り（通り芯=labeled必須、それ以外は常にfalse）', () => {
  const { graph, project } = makeProjectWithGraph();
  let v = 0;
  const cases = [
    ['struct', Discipline.STRUCT, 'center'],
    ['center', Discipline.ARCH,   'center'],
    ['aux',    Discipline.ARCH,   'dashed'],
    ['beam',   Discipline.FUSE,   'center'],
  ];
  for (const [kind, discipline, lineType] of cases) {
    for (const labeled of [true, false]) {
      const cl = kind === 'struct'
        ? project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled, discipline })
        : graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled, discipline, lineType });
      v += 1000;
      const expected = kind === 'struct' && labeled;
      assert.equal(isSharedCL(cl), expected, `kind=${kind} labeled=${labeled}`);
    }
  }
});

test('【旧データ限定・種別ベースへ統一】isSharedCL: {discipline:STRUCT, labeled:true, lineType:dashed}はHEADの共有(true)から、移行後は非共有(false)になる', () => {
  const { graph } = makeProjectWithGraph();
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 0,
    { labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(isSharedCL(legacy), false,
    '旧実装（discipline===STRUCT&&labeled）はtrueだったが、種別ベース（isGridCenterLine。' +
    'centerLineKindがlineType:dashedを先に見る）ではfalseになる');
});
