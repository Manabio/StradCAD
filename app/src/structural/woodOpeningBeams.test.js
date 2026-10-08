// woodOpeningBeams.js（在来木造の吹抜け小梁。吹抜け小梁の共通仕様ステップ S3）の単体・統合テスト。
// 実 core.js（Plane/PlanGraph/Room）で在来木造の階を組み、本番の生成経路（autoFillStructuralGrid／
// recomputeStructuralForGraph）を通して検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline, RoomFeature, StairType, StructuralMaterialType } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { autoFillStructuralGrid } from './structuralAutoFill.js';
import { autoFillWoodWallBeams, autoFillWoodFloorBeams, autoFillWoodBeamDepths } from './woodAutoFill.js';
import { autoFillWoodOpeningBeams } from './woodOpeningBeams.js';
import { openingEdgeComponents, edgeTarget } from './openingBeamAxes.js';
import { selfWallSegments, wallBeamAxisExcludeKey } from './wallBeamAxes.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const GRID = { labeled: true, discipline: Discipline.STRUCT };

// 2階（在来）。通り芯 X:0,3640,7280 / Y:0,3640,10920。親部屋「A」は4セル全部（外周だけ壁）。
// 部分指定の吹抜けは隅のセル(x0..3640, y0..3640)。外周側の2辺（x=0・y=0）は親の壁＝壁線の通し梁が覆い、
// 内側の2辺（x=3640・y=3640）は壁なし＝梁のない辺。
// スパン: 横辺 y=3640 は X 通し梁(x=0..7280)の間＝7280、縦辺 x=3640 は Y 通し梁(y=0..10920)の間＝10920。
// innerKind: 吹抜けの内側の境界線(x=3640・y=3640)の種類。GRID＝通り芯／ARCH＝意匠中心線（梁芯が新規に作られる）。
function makePartialVoidFixture({ withVoid = true, voidFeature = RoomFeature.VOID, innerKind = GRID } = {}) {
  const project = new Project('proj-wood-void', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(2400, '2階', 'p2');
  g1.structureOverride = WOOD;
  g2.structureOverride = WOOD;
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 3640, innerKind);
  const x2 = g2.addCenterLine(CenterLineType.VERTICAL, 7280, GRID);
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const y1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 3640, innerKind);
  const y2 = g2.addCenterLine(CenterLineType.HORIZONTAL, 10920, GRID);
  const cells = getAllCells(g2);
  const parent = g2.addRoom(new Set(cells.map(c => c.key)), 'A');
  generateRoomWallsFromOutline(g2, parent);
  let voidRoom = null;
  if (withVoid) {
    const voidKey = cells.find(c => c.x1 === 0 && c.x2 === 3640 && c.y1 === 0 && c.y2 === 3640).key;
    voidRoom = g2.addRoom(new Set([voidKey]), '吹抜け', crypto.randomUUID(), new Set([parent.id]));
    voidRoom.setFeature(voidFeature);
  }
  return { project, g1, g2, x0, x1, x2, y0, y1, y2, parent, voidRoom };
}

// 本番の autoFillStructuralGrid 経路（openingComponents は recompute と同じく openingEdgeComponents から）。
function fill(g, project) {
  const segs = selfWallSegments(g);
  const components = openingEdgeComponents(g);
  return autoFillStructuralGrid(g, project, WOOD, null, [], segs, [], [], [], undefined, undefined, undefined, [], null, undefined, undefined, null, components);
}

const smalls = g => g.beams.filter(b => b.role === 'secondary');
// 小梁を beamMap.delete で落とす（removeBeam と違い除外スロットを汚さない）。床梁は小梁が居た軸を避けて生成済みのまま。
function fillThenDropSmalls(g, project) {
  fill(g, project);
  for (const b of smalls(g)) g.beamMap.delete(b.id);
}
const brief = b => `${b.isVertical ? 'V' : 'H'}${Math.round(b.axisCL.effectiveValue)}:${Math.round(b.clStart.effectiveValue)}..${Math.round(b.clEnd.effectiveValue)}`;

async function recompute(f) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => f.project.graphMap.get(plane.id) ?? null;
  try {
    return await recomputeStructuralForGraph(f.g2, f.project, WOOD, f.g1);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
}

test('【S3-1】部分指定の吹抜け: 壁のない辺だけに小梁が架かり、壁のある辺は壁線の通し梁が覆って生成されない。最短スパンの辺が先で、後の辺はその小梁に取りつく', () => {
  const { project, g2, x0, x2, y0 } = makePartialVoidFixture();
  assert.equal(openingEdgeComponents(g2).length, 1, '前提: 矩形の吹抜け1成分');
  const r = fill(g2, project);

  const got = smalls(g2);
  assert.deepEqual(got.map(brief).sort(), ['H3640:0..7280', 'V3640:0..3640'], `実際: ${got.map(brief)}`);
  assert.ok(got.every(b => b.beamType === '小梁' && b.materialType === StructuralMaterialType.WOOD));
  assert.equal(r.newBeams.filter(b => b.role === 'secondary').length, 2);
  // 壁のある辺（x=0・y=0）には小梁を作らない（壁線の通し梁 role:primary が既に乗っている）。
  assert.ok(g2.beams.some(b => b.role === 'primary' && b.isVertical && b.axisCL.id === x0.id), '前提: x=0 の壁線に通し梁');
  assert.ok(!got.some(b => b.axisCL.id === x0.id || b.axisCL.id === y0.id));

  const h = got.find(b => !b.isVertical);
  const v = got.find(b => b.isVertical);
  // 先に架かる横辺（span 7280）は壁線の通し梁(x=0・x=7280)の軸CLを両端にする。
  assert.deepEqual([h.clStart.id, h.clEnd.id], [x0.id, x2.id]);
  // 縦辺は y=0 の壁線の通し梁と、先に架けた小梁(横辺)の梁芯CLを両端にする。
  assert.deepEqual([v.clStart.id, v.clEnd.id], [y0.id, h.axisCL.id]);
  assert.equal(h.axisCL.value, 3640);
  // 梁芯CLは通り芯(y=3640)を再利用する（新規CLを作らない）。
  assert.equal(g2.centerLines.filter(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === 3640).length, 1);
});

test('【S3-1】手順の順序: 横辺の次に縦辺の順（スパン昇順）で、生成順＝配列順になる', () => {
  const { project, g2 } = makePartialVoidFixture();
  const r = fill(g2, project);
  const order = r.newBeams.filter(b => b.role === 'secondary').map(brief);
  assert.deepEqual(order, ['H3640:0..7280', 'V3640:0..3640']);
});

test('【S3-2】独立した吹抜け（4辺とも壁）: 壁線の通し梁が全辺を覆うので小梁は生成されない', () => {
  const project = new Project('proj-wood-void-indep', 'test');
  project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(2400, '2階', 'p2');
  g2.structureOverride = WOOD;
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 3640, GRID);
  const x2 = g2.addCenterLine(CenterLineType.VERTICAL, 7280, GRID);
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const y1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 3640, GRID);
  void x0; void x1; void x2; void y0; void y1;
  const cells = getAllCells(g2);
  const voidKey = cells.find(c => c.x1 === 3640 && c.x2 === 7280 && c.y1 === 0 && c.y2 === 3640).key;
  const rest = cells.filter(c => c.key !== voidKey).map(c => c.key);
  const roomA = g2.addRoom(new Set(rest), 'A');
  const voidRoom = g2.addRoom(new Set([voidKey]), '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  generateRoomWallsFromOutline(g2, roomA);
  generateRoomWallsFromOutline(g2, voidRoom);
  assert.equal(openingEdgeComponents(g2).length, 1, '前提: 吹抜け成分あり');

  fill(g2, project);
  assert.equal(smalls(g2).length, 0, '4辺とも壁線の通し梁が覆う');
  assert.ok(g2.beams.filter(b => b.role === 'primary').length > 0, '前提: 通し梁は生成されている');
});

test('【S3-3】冪等性: 2回目の呼び出しは何も生成・撤去せず、梁id・梁芯CLの数が変わらない', () => {
  const { project, g2 } = makePartialVoidFixture();
  fill(g2, project);
  const ids = smalls(g2).map(b => b.id).sort();
  const clCount = g2.centerLines.length;
  assert.equal(ids.length, 2, '前提: 小梁2本');

  const second = fill(g2, project);
  assert.equal(second.newBeams.filter(b => b.role === 'secondary').length, 0, '2回目は生成なし');
  assert.equal(second.removedBeams.filter(id => ids.includes(id)).length, 0, '2回目は撤去なし');
  assert.deepEqual(smalls(g2).map(b => b.id).sort(), ids);
  assert.equal(g2.centerLines.length, clCount, '梁芯CLも増えない');

  const direct = autoFillWoodOpeningBeams(g2, project, openingEdgeComponents(g2), selfWallSegments(g2));
  assert.deepEqual(direct, { created: [], removed: [] });
});

test('【S3-4・T1】生成された梁芯を削除（除外記録＋removeCenterLine）して再計算すると、その座標に梁も梁芯も復活せず、残る辺は別の支えへ計画し直される', async () => {
  // 吹抜けの内側の境界を意匠中心線にして、梁芯CLが新規に作られる配置にする（通り芯を再利用すると削除が通り芯削除になる）。
  const fx = makePartialVoidFixture({ innerKind: { labeled: false, discipline: Discipline.ARCH } });
  const h2 = fx.g2;

  await recompute(fx);
  const hBeam = smalls(h2).find(b => !b.isVertical);
  const vBeam = smalls(h2).find(b => b.isVertical);
  assert.ok(hBeam && vBeam, `前提: 小梁2本（実際: ${smalls(h2).map(brief)}）`);
  assert.equal(hBeam.axisCL.beamAxisOrigin, BeamAxisOrigin.FLOOR_BEAM, '前提: 梁芯は新規生成（由来 floorBeam）');
  assert.equal(vBeam.clEnd.id, hBeam.axisCL.id, '前提: 縦辺は先に架けた横辺の梁芯を支えにする');

  // centerLineOps.js の梁芯削除と同じ手順（除外記録→removeCenterLine。梁は連動して消える想定のため先に除く）。
  const removedId = hBeam.axisCL.id;
  runInAction(() => {
    h2.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, 3640));
    for (const b of h2.beams.filter(x => x.axisCL.id === removedId || x.clStart.id === removedId || x.clEnd.id === removedId)) h2.beamMap.delete(b.id);
    h2.removeCenterLine(removedId);
  });
  await recompute(fx);

  assert.ok(!h2.shapeMap.has(removedId), '除外された座標に梁芯は復活しない');
  assert.equal(h2.centerLines.filter(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === 3640 && c.discipline === Discipline.FUSE).length, 0);
  assert.equal(h2.beams.filter(b => !b.isVertical && Math.abs(b.axisCL.effectiveValue - 3640) < 1 && b.role === 'secondary').length, 0, 'その座標に小梁も無い');
  const vAfter = smalls(h2).find(b => b.isVertical);
  assert.ok(vAfter, '残る辺には引き続き小梁が架かる');
  // 支えは実在する梁の軸CL（削除した梁芯ではない）。
  for (const cl of [vAfter.clStart, vAfter.clEnd]) assert.ok(h2.shapeMap.has(cl.id), '支えの梁芯CLは実在する');
  assert.equal(Math.round(vAfter.clEnd.effectiveValue), 10920, '横辺を失ったので縦辺は壁線の通し梁(y=10920)に掛かる');
});

test('【S3-5・T2】生成された小梁を removeBeam して再計算すると、スロットは空のまま復活しない（梁芯は残る）。その小梁を支えにしていた辺は別の支えへ付け替わる', async () => {
  const f = makePartialVoidFixture();
  const { g2 } = f;
  await recompute(f);
  const h = smalls(g2).find(b => !b.isVertical);
  const v = smalls(g2).find(b => b.isVertical);
  assert.ok(h && v, `前提: 小梁2本（実際: ${smalls(g2).map(brief)}）`);
  const hCL = h.axisCL;
  assert.equal(v.clEnd.id, hCL.id, '前提: 縦辺は横辺を支えにする');

  runInAction(() => { g2.removeBeam(h.id); });
  await recompute(f);

  assert.ok(!smalls(g2).some(b => !b.isVertical), '除外スロットなので横辺の小梁は復活しない');
  assert.ok(g2.shapeMap.has(hCL.id), '梁芯CLは残る');
  assert.ok(g2.excludedBeamSlots.size >= 1);
  const vAfter = smalls(g2).find(b => b.isVertical);
  assert.ok(vAfter, '縦辺は引き続き架かる');
  assert.notEqual(vAfter.clEnd.id, hCL.id, '削除された小梁を支えにしない（壁線の通し梁へ付け替え）');
  assert.equal(Math.round(vAfter.clEnd.effectiveValue), 10920);
});

test('【S3-6】手動梁（locked・role primary）が辺に乗っていればその辺は覆われ、直交辺はその梁を支えにする', () => {
  const { project, g2, x0, x1, x2, y1 } = makePartialVoidFixture();
  // 横辺 y=3640 に手動の大梁（x=0..7280）。
  runInAction(() => {
    g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x0, x2, { role: 'primary', beamType: '大梁', dimensionStatus: 'locked' });
  });
  fill(g2, project);

  const got = smalls(g2);
  assert.deepEqual(got.map(brief), ['V3640:0..3640'], `横辺は手動梁が覆うので縦辺だけ（実際: ${got.map(brief)}）`);
  assert.equal(got[0].clEnd.id, y1.id, '縦辺の支えは手動梁の軸CL');
  void x1;
});

test('【S3-6】失敗系: 手動梁が辺と区間で重ならなければ辺は覆われない（通常どおり架かる）', () => {
  const { project, g2, x1, x2, y1 } = makePartialVoidFixture();
  // 横辺 y=3640(x 0..3640) と重ならない区間(x 3640..7280)の手動梁。
  runInAction(() => {
    g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary', beamType: '大梁', dimensionStatus: 'locked' });
  });
  fill(g2, project);
  assert.ok(smalls(g2).some(b => !b.isVertical && Math.round(b.axisCL.effectiveValue) === 3640), '重ならない手動梁は辺を覆わない');
});

test('【S3-7】autoFillWoodWallBeams（実体階）は auto の小梁を撤去しない＝吹抜け小梁を巻き込まない。旧方式の auto 小梁は候補に無ければ吹抜け小梁の掃引で撤去される', () => {
  const { project, g2, y0, x0, x1 } = makePartialVoidFixture();
  fill(g2, project);
  const ids = smalls(g2).map(b => b.id).sort();
  assert.equal(ids.length, 2, '前提');

  // 壁線の通し梁の再計算だけを単独で回しても小梁は残る（removableRoles は primary のみ）。
  const wr = autoFillWoodWallBeams(g2, project, selfWallSegments(g2));
  assert.equal(wr.removed.filter(id => ids.includes(id)).length, 0);
  assert.deepEqual(smalls(g2).map(b => b.id).sort(), ids);

  // 旧方式の小梁（梁芯CL上の auto の小梁。候補に無い位置）を足す。
  let legacy;
  runInAction(() => {
    legacy = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'secondary', beamType: '小梁' });
  });
  assert.equal(legacy.dimensionStatus, 'auto', '前提: 旧方式の小梁は auto');
  // 壁線の通し梁の掃引は旧方式の小梁にも触れない。
  autoFillWoodWallBeams(g2, project, selfWallSegments(g2));
  assert.ok(g2.beamMap.has(legacy.id), 'autoFillWoodWallBeams は実体階の secondary を撤去しない');
  // 吹抜け小梁の掃引が撤去する。吹抜け小梁自身は残る（id不変）。
  const r = fill(g2, project);
  assert.ok(!g2.beamMap.has(legacy.id), '旧方式の auto 小梁は撤去される');
  assert.ok(r.removedBeams.includes(legacy.id));
  assert.deepEqual(smalls(g2).map(b => b.id).sort(), ids, '吹抜け小梁は id 不変');
});

test('【S3-7】手動固定（locked）の小梁は撤去されず保持される', () => {
  const { project, g2, x0, x1, y0 } = makePartialVoidFixture();
  let keep;
  runInAction(() => {
    keep = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'secondary', beamType: '小梁', dimensionStatus: 'locked' });
  });
  fill(g2, project);
  assert.ok(g2.beamMap.has(keep.id));
});

test('【S3-8】2×4 と構造未定では吹抜け小梁を生成しない', () => {
  for (const structure of ['木造（2"×4"）', undefined]) {
    const { project, g2 } = makePartialVoidFixture();
    g2.structureOverride = structure ?? null;
    const segs = selfWallSegments(g2);
    const comps = openingEdgeComponents(g2);
    const r = autoFillStructuralGrid(g2, project, structure ?? '未定', null, [], segs, [], [], [], undefined, undefined, undefined, [], null, undefined, undefined, null, comps);
    assert.equal(r.newBeams.filter(b => b.role === 'secondary').length, 0, `${structure ?? '未定'}: 小梁なし`);
  }
});

test('【S3-8】失敗系: openingComponents が undefined なら何もしない（既存の小梁にも触れない）。[] なら auto の小梁を撤去する。壁区間が無い階は保全', () => {
  const { project, g2 } = makePartialVoidFixture();
  fill(g2, project);
  const ids = smalls(g2).map(b => b.id).sort();
  assert.equal(ids.length, 2, '前提');
  const segs = selfWallSegments(g2);

  assert.deepEqual(autoFillWoodOpeningBeams(g2, project, undefined, segs), { created: [], removed: [] });
  assert.deepEqual(smalls(g2).map(b => b.id).sort(), ids, 'undefined は何もしない');

  assert.deepEqual(autoFillWoodOpeningBeams(g2, project, [], []), { created: [], removed: [] });
  assert.deepEqual(smalls(g2).map(b => b.id).sort(), ids, '壁区間が無い階は保全（撤去しない）');

  const r = autoFillWoodOpeningBeams(g2, project, [], segs);
  assert.deepEqual(r.removed.sort(), ids, '[]（吹抜け無し）なら auto の小梁を撤去する');
  assert.equal(smalls(g2).length, 0);
});

test('【S3-9】下階の階段吹抜け（STAIR_VOID）: 階段開口4辺は stairOpeningRuns の通し梁(primary)が覆うので小梁を生成しない', async () => {
  const project = new Project('proj-wood-stairvoid', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(2400, '2階', 'p2');
  g1.structureOverride = WOOD;
  g2.structureOverride = WOOD;
  const mk = (g, d) => {
    const a = g.addCenterLine(CenterLineType.VERTICAL, 0, d), b = g.addCenterLine(CenterLineType.VERTICAL, 1820, d);
    const c = g.addCenterLine(CenterLineType.HORIZONTAL, 0, d), e = g.addCenterLine(CenterLineType.HORIZONTAL, 3640, d);
    return `${a.id}:${c.id}:${b.id}:${e.id}`;
  };
  const arch = { labeled: false, discipline: Discipline.ARCH };
  g1.addStair({ type: StairType.STRAIGHT, cells: new Set([mk(g1, arch)]), sections: [2], upDirection: 'up', flip: false });
  g2.addRoom(new Set([mk(g2, GRID)])).setFeature(RoomFeature.STAIR_VOID);
  assert.ok(openingEdgeComponents(g2, { belowGraph: g1 }).length >= 1, '前提: 2階に床開口の成分がある');

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try {
    await recomputeStructuralForGraph(g2, project, WOOD, g1);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
  const primaries = g2.beams.filter(b => b.role === 'primary');
  assert.ok(primaries.length >= 4, `前提: 階段開口の縁梁（通し梁）が4辺に生成される（実際: ${primaries.length}）`);
  assert.equal(smalls(g2).length, 0, '全辺が通し梁で覆われるので小梁は 0 本');
});

test('【S3-1b】辺の角に同一軸の壁の端が壁厚ぶん入り込むだけなら辺の壁とはみなさず、梁芯は辺の座標のまま（目標座標が壁厚ぶん外へずれない）', () => {
  const { project, g2, x1, y1, y2 } = makePartialVoidFixture();
  // 辺 x=3640(y 0..3640) の下側（y 3640..10920）に同一軸の下地オーナー壁。端は角(y=3640)から 72.5 だけ辺へ入り込む。
  runInAction(() => {
    g2.addWall(x1, 0, true, y1, -72.5, y2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  });
  fill(g2, project);
  const v = smalls(g2).find(b => b.isVertical);
  assert.ok(v, '前提: 縦辺に小梁');
  assert.equal(Math.round(v.axisCL.effectiveValue), 3640, '辺の座標のまま（壁の外面+梁幅/2 の 3760 にならない）');
});

test('【S3-6b】隔て梁（折返し階段の隔て壁の真上）が開口辺に乗る計画なら、その辺は梁あり。隔て梁は支えにしない（横辺は壁線の通し梁の間を通す）', () => {
  const { project, g2 } = makePartialVoidFixture();
  fillThenDropSmalls(g2, project); // 壁線の通し梁だけが残る状態
  const segs = selfWallSegments(g2);
  const comps = openingEdgeComponents(g2);

  // 縦辺 x=3640(y 0..3640) に隔て梁がある計画。
  const r = autoFillWoodOpeningBeams(g2, project, comps, segs, [{ isVertical: true, axisValue: 3640, lo: 0, hi: 3640 }]);
  assert.deepEqual(r.created.map(brief), ['H3640:0..7280'], `縦辺は隔て梁が覆うので生成しない。横辺は隔て梁を支えにせず 0..7280（実際: ${r.created.map(brief)}）`);
});

test('【S3-6b】失敗系: 隔て梁の計画が辺と区間で重ならない・別の軸なら辺は覆われない', () => {
  const { project, g2 } = makePartialVoidFixture();
  fillThenDropSmalls(g2, project);
  const segs = selfWallSegments(g2);
  const comps = openingEdgeComponents(g2);
  const r = autoFillWoodOpeningBeams(g2, project, comps, segs, [
    { isVertical: true, axisValue: 3640, lo: 3640, hi: 7280 }, // 区間が外
    { isVertical: true, axisValue: 5000, lo: 0, hi: 3640 },    // 軸が外
  ]);
  assert.deepEqual(r.created.map(brief).sort(), ['H3640:0..7280', 'V3640:0..3640']);
});

test('【S3-10】床梁との二重防止: 吹抜け小梁と同じ軸・区間に床梁(role:floor)を重ねて作らない（axisSpanOccupied が secondary を数える）', () => {
  const { project, g2, x0, x2, y1 } = makePartialVoidFixture();
  fill(g2, project);
  const h = smalls(g2).find(b => !b.isVertical);
  assert.ok(h, '前提: 横辺の小梁');
  // 床梁生成を単独で回しても、小梁と同じ軸・区間の床梁は作られない（このセルは 3640 以下の短辺ではないが、占有判定は軸単位）。
  const before = g2.beams.length;
  autoFillWoodFloorBeams(g2, project);
  assert.ok(g2.beams.some(b => b.role === 'floor'), '前提: 床梁自体は生成される（他の候補軸1820・5460…）');
  assert.ok(!g2.beams.some(b => b.role === 'floor' && !b.isVertical && Math.abs(b.axisValue - h.axisValue) < 1
    && Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) < 7280 && Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue) > 0),
  '小梁と同軸の床梁は無い');
  void before; void x0; void x2; void y1;
});

test('【S3-12】recomputeStructuralForGraph の本番経路: 小梁は梁成（木造の断面）が付き、再計算を重ねても changed=false・梁id不変（後段の conform・梁成・採番で振動しない）', async () => {
  const f = makePartialVoidFixture();
  const r1 = await recompute(f);
  assert.equal(r1.changed, true, '前提: 初回は梁を生成する');
  const got = smalls(f.g2);
  assert.equal(got.length, 2, '前提: 小梁2本');
  for (const b of got) {
    assert.match(b.sectionDefId, /^WOOD-/, '木造の断面');
  }
  const ids = got.map(b => b.id).sort();
  const r2 = await recompute(f);
  assert.equal(r2.changed, false, '2回目は何も変わらない');
  assert.deepEqual(smalls(f.g2).map(b => b.id).sort(), ids);
});

// 受容した限界（設計書 限界8）の固定: 梁成の荷重・伝播の host は大梁(primary)だけ（woodAutoFill.js autoFillWoodBeamDepths
// の endHostBeam＝findHostPrimaryBeam）。2段目の小梁は1段目の小梁の中間荷重に数えられず、成も伝わらない。
test('【S3-12b・限界】1段目の小梁の成は、2段目の小梁があってもなくても変わらない（2段目は1段目の中間荷重に数えない）', async () => {
  const f = makePartialVoidFixture();
  await recompute(f);
  const h = smalls(f.g2).find(b => !b.isVertical);
  const v = smalls(f.g2).find(b => b.isVertical);
  assert.equal(v.clEnd.id, h.axisCL.id, '前提: 縦辺(2段目)は横辺(1段目)に掛かる');
  const withSecondTier = h.sectionDefId;
  runInAction(() => { f.g2.beamMap.delete(v.id); });
  runInAction(() => { autoFillWoodBeamDepths(f.g2, f.project, []); });
  assert.equal(h.sectionDefId, withSecondTier, '2段目を除いても1段目の成は同じ');
});

test('【S3-1c】座標に置けない辺（同軸・同区間に別の梁がある）では、小梁も新しい梁芯CLも作らない', () => {
  const { project, g2, x0, x2, y1 } = makePartialVoidFixture({ innerKind: { labeled: false, discipline: Discipline.ARCH } });
  fillThenDropSmalls(g2, project);
  // 小梁が居た軸の梁芯CL（FUSE）を取り除き、新設の有無を数えられる状態にする。
  runInAction(() => {
    for (const c of g2.centerLines.filter(c => c.discipline === Discipline.FUSE && c.centerLineType === CenterLineType.HORIZONTAL && Math.round(c.value) === 3640)) g2.removeCenterLine(c.id);
  });
  // y=3640 の意匠中心線(y1)を軸にした auto の床梁（host ではない。意匠中心線は findBeamAnchorCL には現れない）。
  runInAction(() => {
    g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x0, x2, { role: 'floor', beamType: '床梁' });
  });
  const hFuse = () => g2.centerLines.filter(c => c.centerLineType === CenterLineType.HORIZONTAL && c.discipline === Discipline.FUSE && Math.round(c.value) === 3640).length;
  const before = hFuse();
  const r = autoFillWoodOpeningBeams(g2, project, openingEdgeComponents(g2), selfWallSegments(g2));
  assert.ok(!r.created.some(b => !b.isVertical), '床梁が占有する軸に横辺の小梁は作らない');
  assert.equal(hFuse(), before, '置かなかった辺の梁芯CLを新設しない');
});

test('【S3-1d】edgeTarget: 辺 3640 に 1000 重なる下地オーナー壁は辺の壁（逃げ後の座標）。壁厚(120)ぶん入り込むだけの壁は辺の壁ではない（辺座標のまま）', () => {
  const { g2, x1, y1, y2 } = makePartialVoidFixture();
  const rules = rulesFor(WOOD);
  const edge = { isVertical: true, axisCL: x1.id, coord: 3640, lo: 0, hi: 3640, outwardSign: 1 };
  runInAction(() => {
    g2.addWall(x1, 0, true, y1, -120, y2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  });
  assert.equal(edgeTarget(g2, edge, rules).coord, 3640, '120 入り込むだけ→辺座標のまま');
  runInAction(() => {
    g2.addWall(x1, 0, true, y1, -1000, y2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  });
  const t = edgeTarget(g2, edge, rules).coord;
  assert.ok(t > 3640 + 100, `1000 重なる壁は逃げ後の座標になる（実際 ${t}）`);
});

test('【S3-11】描画端部: 2段目の小梁(secondary)は1段目の小梁の縁で止まる（findHostBeam が secondary を許可）。1段目は壁線の通し梁の縁で止まる', () => {
  const { project, g2 } = makePartialVoidFixture();
  fill(g2, project);
  const h = smalls(g2).find(b => !b.isVertical);
  const v = smalls(g2).find(b => b.isVertical);
  const span = v.spanForHostBeams(g2.beams, 0);
  // 縦辺 v は y=0 の通し梁（primary）の縁から、横辺 h の縁まで。h の半幅は材幅/2。
  assert.ok(Math.abs(span.coord2 - (h.axisValue - h.sectionWidth / 2)) < 0.01, `2段目の端は1段目の縁（実際 ${span.coord2}）`);
});
