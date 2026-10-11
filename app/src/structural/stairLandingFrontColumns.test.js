// 規則2（ユーザー指示2026-10-12「階段直進部と折返し接合辺が壁と取り合う場合、柱を設ける」）の単体・統合テスト。
// stairLandingFrontLine（stairPartition.js）・stairLandingFrontWallPoints（wallFreeEnds.js）・
// 柱の生成（woodAutoFill.js autoFillWoodColumns）・頭つなぎ/受梁の起点からの除外（本番経路 recomputeStructuralForGraph）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline, StairType, StructuralMaterialType, OpeningCategory, columnSlotKey } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { generateStairPartitionWalls } from '../finish/stair/stairPartitionWalls.js';
import { stairLandingFrontLine, stairPartitionLines } from '../finish/stair/stairPartition.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { stairLandingFrontWallPoints } from './wallFreeEnds.js';
import { autoFillWoodColumns } from './woodAutoFill.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
// 階段 footprint: 幅2000×奥行4000。EQUAL_UP は踊り場前縁 y=1000（踊り場側が lo）、EQUAL_DOWN は y=3000（hi）。
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];
const EQUAL_DOWN = [[0, 3000, 2000, 4000], [0, 0, 1000, 3000], [1000, 0, 2000, 3000]];

// 1階・2階とも外周だけ壁のある親部屋「A」と同じ位置の SWITCHBACK 階段（1階は隔て壁つき）。
function makeFixture({ rects = EQUAL_UP, upDirection = 'up', withStair2 = true, stairStructure = StructuralMaterialType.WOOD, structure2 = WOOD } = {}) {
  const project = new Project('proj-landing-front-cols', 'test');
  const mkFloor = (elevation, name, id, structure, withStair) => {
    const { graph } = project.addPlane(elevation, name, id);
    graph.structureOverride = structure;
    const vs = new Map(), hs = new Map();
    const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
    const keys = rects.map(([x1, y1, x2, y2]) =>
      `${mk(CenterLineType.VERTICAL, vs, x1).id}:${mk(CenterLineType.HORIZONTAL, hs, y1).id}:${mk(CenterLineType.VERTICAL, vs, x2).id}:${mk(CenterLineType.HORIZONTAL, hs, y2).id}`);
    if (withStair) graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(keys), sections: [6, 1, 6], flip: false, upDirection, structure: stairStructure });
    const parent = graph.addRoom(new Set(getAllCells(graph).map(c => c.key)), 'A');
    generateRoomWallsFromOutline(graph, parent);
    return graph;
  };
  const g1 = mkFloor(0, '1階', 'p1', WOOD, true);
  generateStairPartitionWalls(g1, { structure: WOOD, underEdges: [] });
  const g2 = mkFloor(3000, '2階', 'p2', structure2, withStair2);
  return { project, g1, g2 };
}
const cl = (g, type, v) => g.centerLines.find(c => c.centerLineType === type && Math.abs(c.value - v) < 0.5);
const colAt = (g, x, y) => g.columns.filter(c => Math.abs(c.axisX - x) < 1 && Math.abs(c.axisY - y) < 1);
const pts = (g, project) => stairLandingFrontWallPoints(g, project).map(p => [Math.round(p.x), Math.round(p.y)]).sort((a, b) => a[0] - b[0]);
// 平行な側壁（縦壁 x=0 または x=2000）を除く
function dropSideWall(g, x) {
  runInAction(() => { for (const w of [...g.walls]) if (w.isVertical && Math.abs(w.axisCL.effectiveValue - x) < 1) g.removeShape(w.id); });
}
async function recompute(g, project, belowGraph) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try {
    return await recomputeStructuralForGraph(g, project, WOOD, belowGraph);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
}

test('【stairLandingFrontLine】踊り場前縁の両端と走行座標（EQUAL_UP=y1000 / EQUAL_DOWN=y3000）。stairPartitionLines の landingAlong と一致', () => {
  for (const [rects, upDirection, along] of [[EQUAL_UP, 'up', 1000], [EQUAL_DOWN, 'down', 3000]]) {
    const { g1 } = makeFixture({ rects, upDirection });
    const line = stairLandingFrontLine(g1.stairs[0], g1);
    assert.equal(line.isVertical, true);
    assert.equal(line.along, along);
    assert.deepEqual([line.sideA, line.sideB].map(p => [p.x, p.y]).sort((a, b) => a[0] - b[0]), [[0, along], [2000, along]]);
    assert.equal(line.along, stairPartitionLines(g1)[0].landingAlong, '規則1の landingAlong と同じ値');
  }
});

test('【stairLandingFrontLine・失敗系】階段なし・U 字系以外（直進）は null', () => {
  const { g1 } = makeFixture();
  assert.equal(stairLandingFrontLine(null, g1), null);
  assert.equal(stairLandingFrontLine({ type: StairType.STRAIGHT, cells: g1.stairs[0].cells, sections: [6, 1, 6] }, g1), null);
});

test('【規則2・点源】在来木造の U 字階段の踊り場前縁と両側壁の取り合い 2 点（x=0・2000）を返す。逆向き（y=3000）でも返す', () => {
  const f = makeFixture();
  assert.deepEqual(pts(f.g1, f.project), [[0, 1000], [2000, 1000]]);
  const d = makeFixture({ rects: EQUAL_DOWN, upDirection: 'down' });
  assert.deepEqual(pts(d.g2, d.project), [[0, 3000], [2000, 3000]]);
});

test('【規則2・柱】両側壁の取り合いに階の柱寸の柱が立つ（由来 wall・個別柱寸 null）。下階（隔て壁つき）も同様', () => {
  const f = makeFixture();
  for (const g of [f.g1, f.g2]) {
    autoFillWoodColumns(g, f.project);
    for (const x of [0, 2000]) {
      const cs = colAt(g, x, 1000);
      assert.equal(cs.length, 1, `${g.plane.name} (${x},1000) に柱が1本`);
      assert.equal(cs[0].woodColumnOrigins, 'wall');
      assert.equal(cs[0].woodColumnWidthMm, null);
      assert.equal(cs[0].sectionDefId, 'WOOD-120x120');
    }
  }
});

test('【規則2・失敗系】側壁が無い側には立たない（片側だけ壁）', () => {
  const f = makeFixture();
  dropSideWall(f.g2, 2000);
  assert.deepEqual(pts(f.g2, f.project), [[0, 1000]]);
  autoFillWoodColumns(f.g2, f.project);
  assert.equal(colAt(f.g2, 0, 1000).length, 1);
  assert.equal(colAt(f.g2, 2000, 1000).length, 0);
});

test('【規則2・失敗系】平行な側壁が無く直交する壁（前縁に沿う壁）しか無い位置では立たない', () => {
  const f = makeFixture();
  dropSideWall(f.g2, 0);
  dropSideWall(f.g2, 2000);
  runInAction(() => {
    f.g2.addWall(cl(f.g2, CenterLineType.HORIZONTAL, 1000), 0, false, cl(f.g2, CenterLineType.VERTICAL, 0), 0, cl(f.g2, CenterLineType.VERTICAL, 2000), 0,
      { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  });
  assert.deepEqual(pts(f.g2, f.project), [], '直交する壁は拾わない');
});

test('【規則2・失敗系】除外集合（ユーザーが消した位置）に入っていれば復活しない', () => {
  const f = makeFixture();
  autoFillWoodColumns(f.g2, f.project);
  const c = colAt(f.g2, 0, 1000)[0];
  runInAction(() => { f.g2.removeColumn(c.id); });
  assert.ok(f.g2.excludedColumnSlots.has(columnSlotKey(c.verticalCL, c.horizontalCL)), '前提: 除外に記録');
  autoFillWoodColumns(f.g2, f.project);
  assert.equal(colAt(f.g2, 0, 1000).length, 0, '除外位置は復活しない');
  assert.equal(colAt(f.g2, 2000, 1000).length, 1, '反対側は立つ');
});

test('【規則2・失敗系】階段の無い階（STAIR_VOID だけの階など）では立たない', () => {
  const f = makeFixture({ withStair2: false });
  assert.deepEqual(pts(f.g2, f.project), []);
  autoFillWoodColumns(f.g2, f.project);
  assert.equal(colAt(f.g2, 0, 1000).length, 0);
  assert.equal(colAt(f.g2, 2000, 1000).length, 0);
});

test('【規則2・失敗系】鉄骨階段・非在来（S造）の階では立たない', () => {
  const steelStair = makeFixture({ stairStructure: StructuralMaterialType.STEEL });
  assert.deepEqual(pts(steelStair.g2, steelStair.project), [], '鉄骨階段は隔て壁を持たない＝対象外');
  const steelFloor = makeFixture({ structure2: StructuralMaterialType.STEEL });
  assert.deepEqual(pts(steelFloor.g2, steelFloor.project), [], '非在来（rules.framing なし）は対象外');
});

test('【規則2・失敗系】側壁に建具が掛かる位置（建具の外形±(柱寸/2+jambClearance)）には立たない。外れた側は立つ', () => {
  const f = makeFixture();
  const x0 = cl(f.g2, CenterLineType.VERTICAL, 0), y0 = cl(f.g2, CenterLineType.HORIZONTAL, 0);
  // x=0 の壁に y=900..1100 の窓（前縁 y=1000 を覆う）
  runInAction(() => { f.g2.addOpening(x0, 1, true, y0, 900, 200, OpeningCategory.WINDOW, 'doubleSliding', {}); });
  autoFillWoodColumns(f.g2, f.project);
  assert.equal(colAt(f.g2, 0, 1000).length, 0, '建具の区間には立てない');
  assert.equal(colAt(f.g2, 2000, 1000).length, 1, '建具の無い側は立つ');
});

test('【規則2・本番経路】前縁の柱から頭つなぎ・受梁（踊り場前縁 y=1000 に沿う水平梁）が生まれない。壁線の通し梁は y=1000 の柱で分割される', async () => {
  const f = makeFixture();
  // 柱が先に立ち、次のパスで壁線の通し梁が柱で分割される（実機は sweepUntilConverged）。2 sweep 回す。
  for (let i = 0; i < 2; i++) {
    await recompute(f.g1, f.project, null);
    await recompute(f.g2, f.project, f.g1);
  }
  for (const g of [f.g1, f.g2]) {
    assert.equal(colAt(g, 0, 1000).length, 1, `${g.plane.name} に前縁の柱`);
    const front = g.beams.filter(b => !b.isVertical && b.role !== 'partitionBeam' && Math.abs(b.axisCL.effectiveValue - 1000) < 1);
    assert.deepEqual(front.map(b => `${b.role}:${b.clStart.effectiveValue}..${b.clEnd.effectiveValue}`), [], `${g.plane.name}: y=1000 に水平梁が無い`);
  }
  // 1階の足元は土台（sill。柱で分割しない）なので、通し梁の分割は 2階だけで見る
  const sideBeams = f.g2.beams.filter(b => b.isVertical && b.role === 'primary' && Math.abs(b.axisCL.effectiveValue) < 1)
    .map(b => [b.clStart.effectiveValue, b.clEnd.effectiveValue].sort((p, q) => p - q).join('..'));
  // 残りの 1000..4000 は支持長 1820 の柱（3i）で更に分かれるので、y=1000 を境にした 2 区間の継ぎ目だけを見る
  assert.ok(sideBeams.includes('0..1000') && sideBeams.some(r => r.startsWith('1000..')), `x=0 の通し梁が y=1000 の柱で区切られる（実際: ${sideBeams}）`);
});

// 注: 下階の壁も壁線の通し梁の源（wallSegments＝自階＋1つ下の階）なので、この構成でも側壁の梁は残り、受梁の除外
// （belowTieExcludePts／ownPartitionPts）を外しても結果は変わらない＝除外の検出力は無い（回帰ガード止まり。実データ moku4-3 でも差分0）。
test('【規則2・下階柱の受梁】2階に側壁が無く、下階の前縁の柱（0,1000）(2000,1000) を受ける梁が要る場合も、前縁 y=1000 に沿う水平の受梁は作らない', async () => {
  const f = makeFixture();
  dropSideWall(f.g2, 0);
  dropSideWall(f.g2, 2000);
  for (let i = 0; i < 3; i++) {
    await recompute(f.g1, f.project, null);
    await recompute(f.g2, f.project, f.g1);
  }
  assert.equal(colAt(f.g1, 0, 1000).length, 1, '前提: 下階に前縁の柱');
  const front = f.g2.beams.filter(b => !b.isVertical && Math.abs(b.axisCL.effectiveValue - 1000) < 1);
  assert.deepEqual(front.map(b => `${b.role}:${b.clStart.effectiveValue}..${b.clEnd.effectiveValue}`), [], '前縁に沿う水平梁が無い');
});
