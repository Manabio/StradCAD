// 屋根専用平面（在来木造の小屋伏図）の再計算で、旧最上階の壁から作った auto の壁由来梁芯とその上の auto の梁を
// 撤去する（ユーザー裁定 F1=(b)・2026-10-21）。最上階が入れ替わる階操作で屋根専用平面は中身ごと新しい最上階へ
// 付け替えられるため、旧最上階の壁由来の梁芯・梁が孤児で残るのを防ぐ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline } from '../core.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { beamAxisCenterLines } from '../core/centerLineKindPolicy.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { removeStaleWallBeamAxes } from './wallBeamAxes.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;

/** 外周4壁（0..2000 の正方形）＋内壁 y=interiorY（省略時は内壁なし）を持つ階。withRoom=false は壁も部屋も無い空の階。 */
function addTopFloor(project, elevation, name, id, { interiorY = null, withRoom = true } = {}) {
  const { graph } = project.addPlane(elevation, name, id);
  graph.structureOverride = WOOD;
  if (!withRoom) return graph;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room);
  if (interiorY != null) {
    const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, interiorY, { labeled: false, discipline: Discipline.ARCH });
    graph.addWall(axisCL, 0, false, x0, 0, x1, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5, bandOffset: null });
  }
  return graph;
}

/** 屋根専用平面（外周と同じ通り芯を持つ）。roofForPlaneId で「今の最上階」を指す。 */
function addRoof(project, forId, structure = WOOD) {
  const { graph } = project.addPlane(6000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, forId);
  graph.structureOverride = structure;
  for (const v of [0, 2000]) {
    graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT });
    graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT });
  }
  return graph;
}

async function withPeek(graphs, fn) {
  const original = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => graphs[plane.id] ?? null;
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

const wallAxisKeys = (g) => beamAxisCenterLines(g)
  .filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.WALL)
  .map(cl => `${cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H'}:${Math.round(cl.effectiveValue)}`).sort();
const beamsOnAxisAt = (g, coord) => g.beams.filter(b => Math.abs(b.axisCL.effectiveValue - coord) < 1);
const recompute = (roof, project) => recomputeStructuralForGraph(roof, project, WOOD);

// 屋根を p1（内壁 y=1000 の最上階）で一度収束させた状態を作る。
async function convergedOnP1() {
  const project = new Project('proj-roof-stale', 'test');
  const g1 = addTopFloor(project, 0, '1階', 'p1', { interiorY: 1000 });
  const roof = addRoof(project, 'p1');
  project.activePlaneId = 'p1';
  const graphs = { p1: g1, roof1: roof };
  await withPeek(graphs, async () => { await recompute(roof, project); await recompute(roof, project); });
  return { project, g1, roof, graphs };
}

test('前提: p1 が最上階のとき、屋根に内壁 y=1000 の壁由来梁芯と、その上の auto の軒桁ができる', async () => {
  const { roof } = await convergedOnP1();
  assert.deepEqual(wallAxisKeys(roof), ['H:1000']);
  const onAxis = beamsOnAxisAt(roof, 1000);
  assert.ok(onAxis.length > 0, '内壁線上に軒桁がある');
  assert.ok(onAxis.every(b => b.dimensionStatus === 'auto' && b.role === 'primary'));
});

test('空の階を最上階の上へ追加（壁源が空）: 旧壁由来梁芯と、その梁芯・通り芯の上の auto の梁が全て撤去され、再計算は冪等', async () => {
  const { project, roof, graphs } = await convergedOnP1();
  const g2 = addTopFloor(project, 3000, '2階', 'p2', { withRoom: false });
  roof.plane.roofForPlaneId = 'p2'; // 最上階が入れ替わった（S1: 屋根専用平面を付け替える）
  graphs.p2 = g2;
  await withPeek(graphs, async () => {
    const r1 = await recompute(roof, project);
    assert.equal(r1.changed, true, '撤去は変化として報告される');
    assert.deepEqual(wallAxisKeys(roof), [], '旧最上階の壁由来梁芯は残らない');
    assert.equal(roof.beams.length, 0, 'auto の軒桁・小屋梁は残らない（新しい最上階に壁が無い）');
    const r2 = await recompute(roof, project);
    assert.equal(r2.changed, false, '2回目の再計算は差分が空（撤去と再生成を繰り返さない）');
    assert.deepEqual(wallAxisKeys(roof), []);
  });
});

test('壁配置の違う階が最上階になった（内壁 y=1000 → y=1500）: 旧座標の梁芯・梁は消え、新しい座標の梁芯・梁ができる。冪等', async () => {
  const { project, roof, graphs } = await convergedOnP1();
  const g2 = addTopFloor(project, 3000, '2階', 'p2', { interiorY: 1500 });
  roof.plane.roofForPlaneId = 'p2';
  graphs.p2 = g2;
  await withPeek(graphs, async () => {
    await recompute(roof, project);
    await recompute(roof, project);
    assert.deepEqual(wallAxisKeys(roof), ['H:1500'], '旧 H:1000 は消え、新しい最上階の H:1500 ができる');
    assert.equal(beamsOnAxisAt(roof, 1000).length, 0, '旧座標の梁は残らない');
    assert.ok(beamsOnAxisAt(roof, 1500).length > 0, '新座標の梁ができる');
    const r3 = await recompute(roof, project);
    assert.equal(r3.changed, false, '収束後の再計算は差分が空');
  });
});

test('保護: 手動追加（USER 由来）の梁芯・locked の梁が乗る壁由来梁芯は残り、excludedWallBeamAxes は触らない', async () => {
  const { project, roof, graphs } = await convergedOnP1();
  // 旧壁由来梁芯 H:1000 の上の梁を1本 locked にする（手動固定）。
  const lockedBeam = beamsOnAxisAt(roof, 1000)[0];
  lockedBeam.setDimensionStatus('locked');
  // 手動追加の梁芯（USER）と、ユーザーが消した梁芯の座標。
  const userAxis = roof.addCenterLine(CenterLineType.HORIZONTAL, 700, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER, extentLo: 0, extentHi: 2000,
  });
  roof.excludedWallBeamAxes.add('Y:777');
  const g2 = addTopFloor(project, 3000, '2階', 'p2', { withRoom: false });
  roof.plane.roofForPlaneId = 'p2';
  graphs.p2 = g2;
  await withPeek(graphs, async () => {
    await recompute(roof, project);
    assert.ok(roof.beamMap.has(lockedBeam.id), 'locked の梁は残る');
    assert.deepEqual(wallAxisKeys(roof), ['H:1000'], 'locked の梁が乗る壁由来梁芯は保護されて残る');
    assert.ok(roof.shapeMap.has(userAxis.id), '手動追加の梁芯は残る');
    assert.deepEqual([...roof.excludedWallBeamAxes], ['Y:777'], 'excludedWallBeamAxes は持ち越す（触らない）');
  });
});

test('失敗系: 下の最上階 graph を解決できない（peek が null）ときは壁源の空を「壁が無い」と誤認して梁芯・梁を消さない', async () => {
  const { project, roof, graphs } = await convergedOnP1();
  const axesBefore = wallAxisKeys(roof);
  const primaryBefore = roof.beams.filter(b => b.role === 'primary').map(b => b.id).sort();
  assert.ok(primaryBefore.length > 0, '前提: 軒桁がある');
  roof.plane.roofForPlaneId = 'p_missing'; // 実体階が見つからない（防御的フォールバック）
  await withPeek(graphs, async () => {
    await assert.doesNotReject(() => recompute(roof, project));
  });
  assert.deepEqual(wallAxisKeys(roof), axesBefore);
  // 小屋梁（role:roofBeam）は region が無くなるため従来から撤去される（本変更の対象外）。軒桁（primary）は残る。
  assert.deepEqual(roof.beams.filter(b => b.role === 'primary').map(b => b.id).sort(), primaryBefore, '解決不能のときは auto の軒桁も撤去しない');
});

test('非在来（roofBeamPlacement:gridEaves）の屋根専用平面は撤去しない（Q3 裁定）', async () => {
  const project = new Project('proj-roof-stale-s', 'test');
  const g1 = addTopFloor(project, 0, '1階', 'p1', { interiorY: 1000 });
  g1.structureOverride = 'S造';
  const roof = addRoof(project, 'p1', 'S造');
  project.activePlaneId = 'p1';
  const stale = roof.addCenterLine(CenterLineType.HORIZONTAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.WALL, extentLo: 0, extentHi: 2000,
  });
  const g2 = addTopFloor(project, 3000, '2階', 'p2', { withRoom: false });
  g2.structureOverride = 'S造';
  roof.plane.roofForPlaneId = 'p2';
  await withPeek({ p1: g1, p2: g2, roof1: roof }, async () => {
    await recomputeStructuralForGraph(roof, project, 'S造');
  });
  assert.ok(roof.shapeMap.has(stale.id), 'S造の屋根の壁由来梁芯は撤去しない');
});

// ---- removeStaleWallBeamAxes 単体 ----
function unitGraph() {
  const graph = new PlanGraph(new Plane('u1', 0, 'u', 1, 1));
  const fuse = (coord, origin, extra = {}) => graph.addCenterLine(CenterLineType.HORIZONTAL, coord, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: origin, extentLo: 0, extentHi: 2000, ...extra,
  });
  return { graph, fuse };
}

test('removeStaleWallBeamAxes: 壁源に（許容差内で）一致する WALL は残し、一致しない WALL だけを撤去する', () => {
  const { graph, fuse } = unitGraph();
  const keep = fuse(1000, BeamAxisOrigin.WALL);
  const drop = fuse(1500, BeamAxisOrigin.WALL);
  const removed = removeStaleWallBeamAxes(graph, [{ isVertical: false, coord: 1000.2, lo: 0, hi: 2000 }]);
  assert.deepEqual(removed.map(c => c.id), [drop.id]);
  assert.ok(graph.shapeMap.has(keep.id));
  assert.ok(!graph.shapeMap.has(drop.id));
});

test('removeStaleWallBeamAxes: WALL 以外の由来（roofBeam・floorBeam・USER・旧データ null）は壁源が空でも撤去しない', () => {
  const { graph, fuse } = unitGraph();
  const others = [BeamAxisOrigin.ROOF_BEAM, BeamAxisOrigin.FLOOR_BEAM, BeamAxisOrigin.USER, null].map((o, i) => fuse(100 * (i + 1), o));
  const removed = removeStaleWallBeamAxes(graph, []);
  assert.deepEqual(removed, []);
  for (const cl of others) assert.ok(graph.shapeMap.has(cl.id));
});

test('removeStaleWallBeamAxes: 除外集合のキーが参照する梁芯は撤去しない（ユーザーが消した梁の記録を失効させない）', () => {
  const { graph, fuse } = unitGraph();
  const cl = fuse(1500, BeamAxisOrigin.WALL);
  graph.excludedBeamSlots.add(`primary:${cl.id}:a:b`);
  assert.deepEqual(removeStaleWallBeamAxes(graph, []), []);
  assert.ok(graph.shapeMap.has(cl.id));
});

test('removeStaleWallBeamAxes: 壁源・梁芯とも空なら何もしない（例外なし）', () => {
  const { graph } = unitGraph();
  assert.deepEqual(removeStaleWallBeamAxes(graph, []), []);
});
