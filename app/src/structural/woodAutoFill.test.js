// woodAutoFill.js（在来木造ステップ3a: 壁交点柱・既存断面そろえ）の単体テスト。
// wallBeamAxes.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType, columnSlotKey, spanKey, centerLineKind as centerLineKindOf } from '../core.js';
import {
  wallIntersectionPoints, autoFillWoodColumns, conformWoodSections, conformWoodBacking, WALL_JUNCTION_TOL_MM,
  autoFillWoodBeamDepths, autoFillWoodWallBeams,
} from './woodAutoFill.js';
import { WOOD_STUD_CODE_BY_SIZE } from '../finish/materials/backingClass.js';
import { autoFillColumnsForStructure, autoFillStructuralGrid } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { selfWallSegments, autoFillWallBeamAxes } from './wallBeamAxes.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';

function makeGridGraph(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  return { graph, x1, x2, y1, y2 };
}
const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };

// 本番の呼び出し側（autoFillStructuralGrid／orchestrationの下階経路）と同じ前提: 壁由来の梁芯CLを先に生成してから柱を立てる。
function fillWoodColumns(graph, project = PROJECT, wallGate = null) {
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  return autoFillWoodColumns(graph, project, wallGate);
}

// 下地オーナー壁を1本追加（wallBeamAxes.test.js の addBackingWall と同じ。backingOffset=0＝下地帯中心が axisValue）。
function addBackingWall(graph, { axisValue, clStart, clEnd, isVertical }) {
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL, axisValue, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
}

test('wallIntersectionPoints: 縦壁×横壁の交点・T字・コーナーを返し、平行な壁同士・範囲外は返さない', () => {
  const segs = [
    { isVertical: false, coord: 2000, lo: 0, hi: 4000 },    // 横壁 y=2000（x 0..4000）
    { isVertical: true,  coord: 1000, lo: 0, hi: 4000 },    // 縦壁 x=1000（y 0..4000）→ 交点 (1000,2000)
    { isVertical: true,  coord: 3000, lo: 2000, hi: 4000 }, // 縦壁 x=3000（y 2000..4000）→ T字 (3000,2000)
    { isVertical: false, coord: 4000, lo: 3000, hi: 4000 }, // 横壁 y=4000（x 3000..4000）→ コーナー (3000,4000)
    { isVertical: true,  coord: 3500, lo: 2500, hi: 3500 }, // 縦壁 x=3500（y 2500..3500）→ どの横壁にも許容(150)以上離れて掛からない
  ];
  const pts = wallIntersectionPoints(segs).map(p => `${p.x},${p.y}`).sort();
  assert.deepEqual(pts, ['1000,2000', '3000,2000', '3000,4000']);
  assert.deepEqual(wallIntersectionPoints([segs[1], segs[2]]), [], '縦壁同士は交わらない');
  assert.deepEqual(wallIntersectionPoints([]), []);
});

test('wallIntersectionPoints: 取り合う壁の半厚ぶん控えられた端（実機の壁生成）もコーナー・T字として拾い、許容を超えて離れた端は拾わない', () => {
  // 実機: x=0 の縦壁（半厚57.5）に突き当たる横壁は x=57.5 から始まる。逆も同じ。
  const segs = [
    { isVertical: true,  coord: 0,    lo: 57.5, hi: 3942.5 },
    { isVertical: false, coord: 0,    lo: 57.5, hi: 3942.5 }, // コーナー (0,0)
    { isVertical: false, coord: 2000, lo: 57.5, hi: 1942.5 }, // T字 (0,2000)
  ];
  const pts = wallIntersectionPoints(segs).map(p => `${p.x},${p.y}`).sort();
  assert.deepEqual(pts, ['0,0', '0,2000']);
  // 【失敗系】許容（WALL_JUNCTION_TOL_MM）を超えて離れた端は交わっていない。
  const far = [segs[0], { isVertical: false, coord: 2000, lo: WALL_JUNCTION_TOL_MM + 1, hi: 1942.5 }];
  assert.deepEqual(wallIntersectionPoints(far), []);
  assert.equal(WALL_JUNCTION_TOL_MM, 150);
});

test('autoFillWoodColumns: 自階の壁の交点・T字に柱（120角）が立ち、壁の梁芯CLがアンカーになる', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // 横壁 y=2000
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });  // 縦壁 x=1000（交点）
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWall(graph, { axisValue: 3000, clStart: ym, clEnd: y2, isVertical: true });  // 縦壁 x=3000（y 2000..4000＝T字）
  const { created, removed } = fillWoodColumns(graph);
  assert.equal(created.length, 2, `交点(1000,2000)とT字(3000,2000)の2本のはず（実際:${created.map(c => `${c.x},${c.y}`)}）`);
  assert.deepEqual(created.map(c => `${c.x},${c.y}`).sort(), ['1000,2000', '3000,2000']);
  for (const c of created) {
    assert.equal(c.materialType, StructuralMaterialType.WOOD);
    assert.equal(c.sectionDefId, 'WOOD-120x120', '在来木造の柱は120角');
    assert.equal(c.verticalCL.discipline, Discipline.FUSE, '縦アンカーは壁由来の梁芯CL');
    assert.equal(c.horizontalCL.discipline, Discipline.FUSE, '横アンカーは壁由来の梁芯CL');
  }
  assert.deepEqual(removed, []);
  // 冪等: もう一度呼んでも増減しない。
  const again = fillWoodColumns(graph);
  assert.deepEqual([again.created.length, again.removed.length], [0, 0]);
});

test('autoFillWoodColumns: 通り芯交点に生成されていた自動柱は撤去され、手動固定の柱と除外スロットは尊重される', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });
  addBackingWall(graph, { axisValue: 3000, clStart: y1, clEnd: y2, isVertical: true });
  // 旧方式（通り芯交点）の自動柱と、手動固定の柱。
  const gridAuto = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {});
  const gridLocked = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y2, {});
  gridLocked.setDimensionStatus('locked');
  const first = fillWoodColumns(graph);
  assert.equal(first.created.length, 2);
  assert.deepEqual(first.removed, [gridAuto.id], '壁交点に無い自動柱は撤去される');
  assert.ok(graph.columnMap.has(gridLocked.id), '手動固定の柱は残る');
  assert.equal(graph.excludedColumnSlots.has(columnSlotKey(x1, y1)), false, '撤去は除外集合に記録しない（可逆）');
  // ユーザーが壁交点の柱を削除（除外集合へ記録）→ 再補完で復活しない。
  const col = first.created.find(c => c.x === 1000);
  graph.removeColumn(col.id);
  const second = fillWoodColumns(graph);
  assert.deepEqual(second.created, [], '除外スロットには生成しない');
});

test('autoFillWoodColumns: wallGate が建物外と判定した交点には柱を立てない', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });
  const gate = { intersectionInBuilding: () => false, spanInBuilding: () => false };
  const { created } = fillWoodColumns(graph, PROJECT, gate);
  assert.deepEqual(created, []);
});

test('【失敗系】autoFillWoodColumns: 壁が無い階（壁未生成）は柱を生成せず、既存の自動柱も撤去しない（保全。裁定2026-09-14）', () => {
  const { graph, x1, y1 } = makeGridGraph();
  const gridAuto = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {});
  const { created, removed } = fillWoodColumns(graph);
  assert.deepEqual(created, []);
  assert.deepEqual(removed, []);
  assert.ok(graph.columnMap.has(gridAuto.id), '壁が無い階の既存柱は残る');
});

test('autoFillColumnsForStructure: 在来木造は壁交点方式、それ以外は従来の通り芯交点方式', () => {
  const wood = makeGridGraph();
  addBackingWall(wood.graph, { axisValue: 2000, clStart: wood.x1, clEnd: wood.x2, isVertical: false });
  addBackingWall(wood.graph, { axisValue: 1000, clStart: wood.y1, clEnd: wood.y2, isVertical: true });
  autoFillWallBeamAxes(wood.graph, selfWallSegments(wood.graph));
  const w = autoFillColumnsForStructure(wood.graph, PROJECT);
  assert.deepEqual(w.created.map(c => `${c.x},${c.y}`), ['1000,2000']);
  const steel = makeGridGraph('S造');
  addBackingWall(steel.graph, { axisValue: 2000, clStart: steel.x1, clEnd: steel.x2, isVertical: false });
  addBackingWall(steel.graph, { axisValue: 1000, clStart: steel.y1, clEnd: steel.y2, isVertical: true });
  const s = autoFillColumnsForStructure(steel.graph, PROJECT);
  assert.equal(s.created.length, 4, 'S造は通り芯交点4か所');
  assert.deepEqual(s.removed, []);
  assert.ok(s.created.every(c => c.materialType === StructuralMaterialType.STEEL));
});

test('autoFillStructuralGrid: 在来木造では壁線上に通し梁(role:primary)が生成され、通り芯グリッドの小梁は生成されない（柱の壁交点への移動は別テストで固定済み）', () => {
  // 単純な十字（自由端2本）は交点が線ごとに1点しか無く通し梁の対象外（要2点以上）のため、
  // 2部屋（コーナー・T字が複数できる）の実壁フィクスチャ（makeTwoRoomGraph、下の
  // autoFillWoodWallBeams テスト群で定義）を使う。
  const { graph } = makeTwoRoomGraph();
  // 自階を最下階(rank0)にしない（最下階だと基礎伏図扱いになり梁のroleが'foundation'固定になるため。
  // isFoundationPlane は project.planes 内の並び順で判定する）。
  const project = { planes: [new Plane('p0', -3000, '0階', 0, 1), graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  // wallSources/wallSegments は本番では collectWallBeamSources/wallRunSegments（マージ済み・下階込み）。
  // ここでは自階の壁だけを渡す（既存の他テストと同じ簡略化）。
  const segs = selfWallSegments(graph);
  const r = autoFillStructuralGrid(graph, project, TRADITIONAL_WOOD_STRUCTURE, null, segs, segs);
  const primaries = graph.beams.filter(b => b.role === 'primary');
  assert.ok(primaries.length > 0, '壁線上の通し梁(role:primary)が生成される');
  // 上端(y=0)の壁線は途中(x=3640)で分割されず0..7280の通し1本になっているはず（スパンそのものを検証）。
  const top = primaries.filter(b => !b.isVertical && Math.abs(b.axisValue) < 1);
  assert.equal(top.length, 1, '上端(y=0)は1本のはず');
  assert.deepEqual([top[0].clStart.effectiveValue, top[0].clEnd.effectiveValue].sort((a, b) => a - b), [0, 7280]);
  // MobX観測オブジェクト（循環参照あり）を assert.deepEqual に直接渡すと、不一致時の差分生成で
  // 大量アロケーション（util.inspectの循環参照検出がMobXプロキシで効かず暴走）が起きるため、
  // 常に本数(.length)で比較する（他アサーションも同様の理由でプレーン値へ落とす）。
  assert.equal(graph.beams.filter(b => b.role === 'secondary').length, 0, '在来木造は梁芯CL上の小梁を生成しない（壁線通し梁に置き換え）');
  assert.ok(r.newColumns.length > 0, '柱も壁交点へ生成される（既存テストと同じ経路）');
});

// 梁芯CL上の小梁(role:secondary)がhostを持つフィクスチャ（beamAxisMove.test.jsのsetupHostGainFixtureと
// 同型: 通り芯x0/x10000・y1/y2を全幅の大梁(role:primary)がカバーし、その内側(x=5000)に梁芯CLを置く）。
function makeSecondaryBeamFixture(structure) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  const x10000 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const rules = rulesFor(structure);
  graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, y1, false, x0, x10000, { role: 'primary' });
  graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, y2, false, x0, x10000, { role: 'primary' });
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 4000 });
  return { graph, x0, x10000, y1, y2 };
}

test('【対照】autoFillStructuralGrid: 在来木造は梁芯CL上の小梁(role:secondary)を生成しないが、同一フィクスチャをS造にすると1本以上生成される', () => {
  const wood = makeSecondaryBeamFixture(TRADITIONAL_WOOD_STRUCTURE);
  const projWood = { planes: [new Plane('p0', -3000, '0階', 0, 1), wood.graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  autoFillStructuralGrid(wood.graph, projWood, TRADITIONAL_WOOD_STRUCTURE, null, [], []);
  // 本数(.length)で比較する（MobX観測オブジェクトの配列をdeepEqualに渡すと不一致時の差分生成で暴走するため）。
  assert.equal(wood.graph.beams.filter(b => b.role === 'secondary').length, 0, '在来木造はbeamPlacement:wallRunsのためautoFillSecondaryBeamsを呼ばない');

  const steel = makeSecondaryBeamFixture('S造');
  const projSteel = { planes: [new Plane('p0', -3000, '0階', 0, 1), steel.graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  autoFillStructuralGrid(steel.graph, projSteel, 'S造', null, [], []);
  assert.ok(steel.graph.beams.filter(b => b.role === 'secondary').length >= 1, 'S造(beamPlacement:gridEdges)は同じ梁芯CLから小梁が生成される');
});

// ---- autoFillWoodWallBeams（ステップ3c-2: 壁線上の通し梁 role:'primary'）----
// wallIntersectionPoints・selfWallSegments と同じ実壁フィクスチャ（部屋2つ、共有辺が交点になる）。
function makeTwoRoomGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const roomA = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  const roomB = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');
  generateRoomWallsFromOutline(graph, roomA);
  generateRoomWallsFromOutline(graph, roomB);
  return { graph, x0, x1, x2, y0, y1 };
}

test('autoFillWoodWallBeams: 壁線上の通し梁(role:primary)は途中の壁交点で分割されず1本になる（3交点→1本）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 1, '上端(y=0)は途中(x=3640)で分割されず1本のはず');
  assert.deepEqual([top[0].clStart.id, top[0].clEnd.id].sort(), [x0.id, x2.id].sort(), '0..7280の通し1本');
  assert.equal(top[0].role, 'primary');
  assert.equal(top[0].beamType, '大梁');
  assert.equal(top[0].materialType, StructuralMaterialType.WOOD);
  // 冪等: もう一度呼んでも増減しない。
  const again = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.deepEqual([again.created.length, again.removed.length], [0, 0]);
});

test('autoFillWoodWallBeams: 候補スロットに旧方式の小梁(role:secondary)が居座っていても道を空けてrole:primaryへ置き換える（実データmoku1で再発した頭つなぎ・壁下梁の欠落の回帰）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  // 旧・梁芯CL方式で生成されていた小梁が、候補スロット（y=0, x0..x2）にちょうど居座っている状況を再現。
  const stale = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'secondary', beamType: '小梁' });
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, segs);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 1, '旧小梁に阻まれず通し梁(role:primary)が生成される');
  assert.deepEqual(removed, [stale.id], '道を空けた旧小梁が撤去される');
  assert.equal(graph.beamMap.has(stale.id), false);
  assert.deepEqual(graph.beams.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1).map(b => b.role), ['primary'], '同じ位置に重複して残らない');
});

test('【失敗系】autoFillWoodWallBeams: 候補スロットの占有物が手動固定(locked)なら重複させず生成を見送り、占有物も撤去しない', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'secondary', beamType: '小梁' });
  locked.setDimensionStatus('locked');
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.equal(created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1).length, 0, '手動固定を巻き込んで重複生成しない');
  assert.deepEqual(removed, []);
  assert.ok(graph.beamMap.has(locked.id), '手動固定の梁は保持される');
});

test('【失敗系】autoFillWoodWallBeams: wallGate.spanInBuilding が false を返す位置には通し梁を生成せず、呼び出し引数は(axisCL,isVertical,startCL,endCL)', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const calls = [];
  const gateAllOut = {
    intersectionInBuilding: () => false,
    spanInBuilding: (...args) => { calls.push(args); return false; },
  };
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, gateAllOut);
  assert.equal(created.length, 0, 'wallGateが全位置を建物外と判定すれば1本も生成しない');
  assert.ok(calls.length > 0, 'spanInBuildingが呼ばれるはず');
  const [axisCL, isVertical, startCL, endCL] = calls[0];
  assert.equal(typeof isVertical, 'boolean');
  assert.ok(axisCL && typeof axisCL.effectiveValue === 'number', '第1引数はCLオブジェクト(axisCL)');
  assert.ok(startCL && typeof startCL.effectiveValue === 'number', '第3引数はCLオブジェクト(startCL)');
  assert.ok(endCL && typeof endCL.effectiveValue === 'number', '第4引数はCLオブジェクト(endCL)');
});

test('【対照】autoFillWoodWallBeams: wallGate.spanInBuilding が isVertical で判定を分ければ、横梁(isVertical=false)だけが生成される', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const gateHorizOnly = { intersectionInBuilding: () => false, spanInBuilding: (axis, isV) => !isV };
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, gateHorizOnly);
  assert.ok(created.length > 0, '横梁は生成されるはず');
  assert.ok(created.every(b => !b.isVertical), '縦梁(isVertical=true)は生成されないはず');
});

test('autoFillWoodWallBeams: 除外スロット（excludedBeamSlots）に居座る旧方式の自動小梁は候補扱いにならず撤去される（生成も撤去もされず残り続ける事故の回帰）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const stale = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'secondary', beamType: '小梁' });
  graph.excludedBeamSlots.add(spanKey(y0, x0, x2)); // ユーザーがこのスロットを明示削除済みという想定
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.equal(created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1).length, 0, '除外スロットには生成しない');
  assert.deepEqual(removed, [stale.id], '除外スロットに居座る旧・自動小梁は撤去される（候補扱いにしないことで撤去対象に含める）');
  assert.equal(graph.beamMap.has(stale.id), false);
});

test('【裁定】autoFillWoodWallBeams: 構造リストから手動追加した梁（role:primary・dimensionStatus:auto）は壁線上に無ければ次の再計算で撤去される。lockedにすれば残る（3aの柱と同じ規律）', () => {
  const { graph, x1, x2, y1 } = makeGridGraph(); // 4000角の通り芯グリッド（壁なし）
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // wallSegmentsを非空にするためのダミー壁
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  const xFar = graph.addCenterLine(CenterLineType.VERTICAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  // 壁線上に無い位置（通り芯y=9000・x=9000）へ構造リストの「＋追加」相当（role:primary・既定dimensionStatus=auto）で手動追加。
  const manualAuto = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yFar, false, x1, xFar, { role: 'primary' });
  const manualLocked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, xFar, { role: 'primary' });
  manualLocked.setDimensionStatus('locked');
  const { removed } = autoFillWoodWallBeams(graph, PROJECT, selfWallSegments(graph));
  assert.ok(removed.includes(manualAuto.id), '壁線上に無いauto梁は次の再計算で撤去される');
  assert.equal(graph.beamMap.has(manualAuto.id), false);
  assert.ok(graph.beamMap.has(manualLocked.id), 'lockedにすれば壁線上に無くても残る');
});

test('【失敗系】autoFillWoodWallBeams: 壁の無い通り芯辺には梁を生成せず、既存の自動生成分（dimensionStatus=auto）は撤去する', () => {
  const { graph, x1, x2, y1 } = makeGridGraph(); // 4000角の通り芯グリッド
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // wallSegmentsを非空にするためのダミー壁（y=0とは別の辺）
  // 壁の無い y=0(y1) の辺に、旧方式（通り芯グリッド）の自動大梁を先置き。
  const gridAuto = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
  const { removed } = autoFillWoodWallBeams(graph, PROJECT, selfWallSegments(graph));
  assert.deepEqual(removed, [gridAuto.id], '壁の無い辺の自動大梁は候補に無いため撤去される');
  assert.equal(graph.beamMap.has(gridAuto.id), false);
});

test('autoFillWoodWallBeams: excludedBeamSlots にあるスパンは再生成しない（手動削除の尊重）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const first = autoFillWoodWallBeams(graph, PROJECT, segs);
  const top = first.created.find(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  graph.beamMap.delete(top.id);
  graph.excludedBeamSlots.add(spanKey(y0, x0, x2));
  const second = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.ok(!second.created.some(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1), '除外スロットには再生成しない');
});

test('【失敗系】autoFillWoodWallBeams: dimensionStatus=lockedの梁は候補に無くても撤去しない', () => {
  const { graph, x1, x2, y1 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // wallSegmentsを非空にするためのダミー壁
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
  locked.setDimensionStatus('locked');
  const { removed } = autoFillWoodWallBeams(graph, PROJECT, selfWallSegments(graph));
  assert.deepEqual(removed, []);
  assert.ok(graph.beamMap.has(locked.id), '手動固定の梁は保持される');
});

test('【失敗系】autoFillWoodWallBeams: 壁ゼロの階（wallSegments=[]）は生成も撤去もしない（既存部材を保全）', () => {
  const { graph, x1, x2, y1 } = makeGridGraph();
  const gridAuto = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, []);
  assert.deepEqual(created, []);
  assert.deepEqual(removed, []);
  assert.ok(graph.beamMap.has(gridAuto.id), '壁が無い階の既存梁は残る');
});

test('【失敗系】autoFillWoodWallBeams: どの通り芯・梁芯・中心線にも解決できない壁区間は例外を投げず無視する', () => {
  const { graph } = makeGridGraph();
  // 通り芯・梁芯・意匠中心線のいずれとも一致しない孤立した壁区間（アンカー解決不能）。
  const wallSegments = [{ isVertical: false, coord: 99999, lo: 0, hi: 1000 }];
  assert.doesNotThrow(() => {
    const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, wallSegments);
    assert.deepEqual(created, []);
    assert.deepEqual(removed, []);
  });
});

test('【失敗系】autoFillWoodWallBeams: 非在来（framingを持たない主構造）は何もしない', () => {
  const { graph } = makeGridGraph('S造');
  const wallSegments = [{ isVertical: false, coord: 0, lo: 0, hi: 4000 }];
  assert.deepEqual(autoFillWoodWallBeams(graph, PROJECT, wallSegments), { created: [], removed: [] });
});

test('autoFillWoodWallBeams: 同一線上の壁区間の隙間がWALL_JUNCTION_TOL_MM(150)以下ならmergeWallIntervalsが連結し1本、超えれば分割される', () => {
  function buildGraph() {
    const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
    graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    for (const x of [0, 1000, 1200, 2000]) {
      graph.addCenterLine(CenterLineType.VERTICAL, x, { labeled: true, discipline: Discipline.STRUCT });
    }
    graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
    return graph;
  }
  // 横壁(y=0)と交わる縦壁スタブ(x=0,1000,1200,2000)。横壁の隙間の有無に関わらず共通で使う交点源。
  const crossSegs = [0, 1000, 1200, 2000].map(x => ({ isVertical: true, coord: x, lo: -500, hi: 500 }));

  // 隙間100（≤150）: mergeWallIntervalsが連結し 0..2000 の通し1本になる。
  const gGap100 = buildGraph();
  const { created: created100 } = autoFillWoodWallBeams(gGap100, PROJECT, [
    ...crossSegs,
    { isVertical: false, coord: 0, lo: 0, hi: 1000 },
    { isVertical: false, coord: 0, lo: 1100, hi: 2000 },
  ]);
  const horiz100 = created100.filter(b => !b.isVertical);
  assert.equal(horiz100.length, 1, '隙間100は連結されて1本のはず');
  assert.deepEqual([horiz100[0].clStart.effectiveValue, horiz100[0].clEnd.effectiveValue].sort((a, b) => a - b), [0, 2000]);

  // 隙間200（>150）: 連結されず 0..1000 と 1200..2000 の2本に分かれる。
  const gGap200 = buildGraph();
  const { created: created200 } = autoFillWoodWallBeams(gGap200, PROJECT, [
    ...crossSegs,
    { isVertical: false, coord: 0, lo: 0, hi: 1000 },
    { isVertical: false, coord: 0, lo: 1200, hi: 2000 },
  ]);
  const horiz200 = created200.filter(b => !b.isVertical);
  assert.equal(horiz200.length, 2, '隙間200は連結されず2本に分かれるはず');
  const spans200 = horiz200
    .map(b => [b.clStart.effectiveValue, b.clEnd.effectiveValue].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(spans200, [[0, 1000], [1200, 2000]]);
});

test('【失敗系】autoFillWoodWallBeams: mergeWallIntervalsが3片を推移的に連結しないと通し梁が1本も生成されない（throughBeamRunsの端点tol単独では代替できない境界。mergeWallIntervalsの第2引数を既定(CL_OVERLAP_TOL_MM=0.5)にすると赤になる）', () => {
  // 壁が3片・隙間各100（≤150）で連続する線に対し、線上の交点は両端(0,2300)だけを置く
  // （中間の交点を持たせると throughBeamRuns 自身のtol境界チェックだけで1本になってしまい、
  // mergeWallIntervals による推移的な連結〔[0,700]+[800,1500]+[1600,2300]→[0,2300]〕を
  // 独立して検証できないため）。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 2300, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,   { labeled: true, discipline: Discipline.STRUCT });
  const wallSegments = [
    { isVertical: true, coord: 0,    lo: -500, hi: 500 },
    { isVertical: true, coord: 2300, lo: -500, hi: 500 },
    { isVertical: false, coord: 0, lo: 0,    hi: 700 },
    { isVertical: false, coord: 0, lo: 800,  hi: 1500 },
    { isVertical: false, coord: 0, lo: 1600, hi: 2300 },
  ];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, wallSegments);
  const horiz = created.filter(b => !b.isVertical);
  assert.equal(horiz.length, 1, '隙間100×2が推移的に連結され0..2300の通し1本になるはず');
  assert.deepEqual([horiz[0].clStart.effectiveValue, horiz[0].clEnd.effectiveValue].sort((a, b) => a - b), [0, 2300]);
});

test('autoFillWoodWallBeams: 撤去される梁に紐づくPenetrationSleeveはsleeveMapから連鎖削除され、excludedBeamSlotsにはキーが追加されない（graph.removeBeamは使わない規律）', () => {
  const { graph, x1, x2, y1 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // wallSegmentsを非空にするためのダミー壁
  const gridAuto = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
  const sleeve = graph.addSleeve('beam', { hostBeamId: gridAuto.id, hostAxisCL: y1, hostClStart: x1, hostClEnd: x2, localPos: 500 });
  const key = spanKey(y1, x1, x2);
  const { removed } = autoFillWoodWallBeams(graph, PROJECT, selfWallSegments(graph));
  assert.deepEqual(removed, [gridAuto.id]);
  assert.equal(graph.beamMap.has(gridAuto.id), false);
  assert.equal(graph.sleeveMap.has(sleeve.id), false, '梁の撤去に連鎖してスリーブも削除される');
  assert.equal(graph.excludedBeamSlots.has(key), false, 'graph.removeBeamは使わないのでexcludedBeamSlotsは汚されない');
});

test('conformWoodSections: 在来木造の既存の柱・梁を柱120角・柱同寸幅へそろえる（手動固定も含む）。基礎梁・他構造は触らない', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  const c = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {});
  c.setDimensionStatus('locked');
  const b1 = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', y1, false, x1, x2, { role: 'primary' });
  const b2 = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x240', y2, false, x1, x2, { role: 'secondary' });
  const b3 = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x300', x1, true, y1, y2, { role: 'primary' });
  const fg = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', x2, true, y1, y2, { role: 'foundation' });
  const updated = conformWoodSections(graph, PROJECT);
  assert.deepEqual(updated.sort(), [c.id, b1.id, b2.id].sort());
  assert.equal(c.sectionDefId, 'WOOD-120x120', '手動固定でも120角へ');
  assert.equal(b1.sectionDefId, 'WOOD-120x120');
  assert.equal(b2.sectionDefId, 'WOOD-120x240', '成は保ち幅だけ柱同寸へ');
  assert.equal(b3.sectionDefId, 'WOOD-120x300', '既に柱同寸幅なら不変');
  assert.equal(fg.sectionDefId, 'RC-300x300', '基礎梁はRCのまま');
  assert.deepEqual(conformWoodSections(graph, PROJECT), [], '2回目は変更なし');
});

test('【失敗系】conformWoodSections: カタログに無い断面の木造梁は変更しない（成を無言で縮めない）', () => {
  const { graph, x1, x2, y1 } = makeGridGraph();
  const b = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x400', y1, false, x1, x2, { role: 'primary' });
  assert.deepEqual(conformWoodSections(graph, PROJECT), []);
  assert.equal(b.sectionDefId, 'WOOD-120x400');
});

// 本番の壁生成（finish/wallGeneration.js。壁の端が取り合う壁の半厚ぶん控えられる）から、
// selfWallSegments → wallIntersectionPoints → 柱 まで通す（手書き区間だけの純関数テストでは
// 「呼び出し側が控えられた端を渡すか」を守れない）。
test('autoFillWoodColumns: 部屋外形から生成した実壁（端が半厚控え）でもコーナー・T字に柱が立つ', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const roomA = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  const roomB = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');
  generateRoomWallsFromOutline(graph, roomA);
  generateRoomWallsFromOutline(graph, roomB);
  const segs = selfWallSegments(graph);
  assert.ok(segs.length >= 6, `下地オーナー壁が生成されるはず（実際:${segs.length}）`);
  assert.ok(segs.some(sg => sg.lo > 0 && sg.lo < WALL_JUNCTION_TOL_MM), '端が半厚ぶん控えられた壁がある（前提）');
  const { created } = fillWoodColumns(graph);
  const at = created.map(c => `${Math.round(c.x)},${Math.round(c.y)}`).sort();
  for (const p of ['0,0', '3640,0', '7280,0', '0,3640', '3640,3640', '7280,3640']) {
    assert.ok(at.includes(p), `${p} に柱が立つはず（実際:${at}）`);
  }
});

test('autoFillWoodColumns: 梁芯CLを削除（除外集合）しても、壁の乗る意匠中心線があれば柱はそこへアンカーを移して立ち直す', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });
  const first = fillWoodColumns(graph);
  assert.equal(first.created.length, 1);
  assert.equal(centerLineKindOf(first.created[0].verticalCL), 'beam', '最初は梁芯CLがアンカー');
  // ユーザーが x=1000 の梁芯CLを削除（除外集合へ記録）→ 梁芯CLは無く再生成もされない。柱はCLの連鎖削除で消える。
  const fuse = graph.centerLines.find(cl => cl.discipline === Discipline.FUSE && cl.centerLineType === CenterLineType.VERTICAL);
  graph.excludedWallBeamAxes.add('X:1000');
  graph.removeCenterLine(fuse.id);
  assert.equal(graph.columns.length, 0, '梁芯CLの削除で柱も連鎖削除される（前提）');
  // 再補完: 壁の乗る意匠中心線（x=1000）を第2候補のアンカーにして立ち直す（「壁のある中心との交点にも柱」）。
  const second = fillWoodColumns(graph);
  assert.equal(second.created.length, 1);
  assert.equal(centerLineKindOf(second.created[0].verticalCL), 'center');
  assert.equal(Math.round(second.created[0].x), 1000);
});

test('【失敗系】conformWoodSections: 在来木造以外（S造・2×4）は何も変えない', () => {
  for (const structure of ['S造', '木造（2"×4"）']) {
    const { graph, x1, x2, y1 } = makeGridGraph(structure);
    const c = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {});
    const b = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', y1, false, x1, x2, { role: 'primary' });
    assert.deepEqual(conformWoodSections(graph, PROJECT), []);
    assert.equal(c.sectionDefId, 'WOOD-105x105');
    assert.equal(b.sectionDefId, 'WOOD-105x105');
  }
});

test('autoFillWoodColumns: 通り芯・梁芯が無い位置でも、壁のある意匠中心線との交点には柱が立つ（裁定2026-09-14）', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // 横壁 y=2000（中心線上）
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });  // 縦壁 x=1000（中心線上）
  // 梁芯CLを作らせない（除外集合）＝通り芯も梁芯も無い交点。
  graph.excludedWallBeamAxes.add('X:1000');
  graph.excludedWallBeamAxes.add('Y:2000');
  const { created } = fillWoodColumns(graph);
  assert.deepEqual(created.map(c => `${c.x},${c.y}`), ['1000,2000']);
  assert.equal(centerLineKindOf(created[0].verticalCL), 'center', 'アンカーは壁の乗る意匠中心線');
  assert.equal(centerLineKindOf(created[0].horizontalCL), 'center');
});

test('conformWoodBacking: 在来木造は共通仕様の外壁・内壁下地を柱同寸×30（□-120×30）へ自動選択し、2回目は変更なし', () => {
  const { graph } = makeGridGraph();
  assert.notEqual(graph.exteriorWallBacking, WOOD_STUD_CODE_BY_SIZE['120x30'], '前提: 既定は柱同寸ではない');
  const changed = conformWoodBacking(graph, PROJECT);
  assert.deepEqual(changed.map(c => c.field).sort(), ['exteriorWallBacking', 'interiorWallBacking']);
  assert.equal(graph.exteriorWallBacking, WOOD_STUD_CODE_BY_SIZE['120x30']);
  assert.equal(graph.interiorWallBacking, WOOD_STUD_CODE_BY_SIZE['120x30']);
  assert.deepEqual(conformWoodBacking(graph, PROJECT), []);
});

test('【失敗系】conformWoodBacking: 在来木造以外（S造・2×4）は下地材を変えない', () => {
  for (const structure of ['S造', '木造（2"×4"）']) {
    const { graph } = makeGridGraph(structure);
    const before = [graph.exteriorWallBacking, graph.interiorWallBacking];
    assert.deepEqual(conformWoodBacking(graph, PROJECT), []);
    assert.deepEqual([graph.exteriorWallBacking, graph.interiorWallBacking], before);
  }
});

test('不変条件: conformWoodBacking の呼び出し元は壁を直後に再生成する経路だけ（仕上げ突入境界／壁の再生成をFinishModeStateから独立させる計画のステップ4 wallRefresh.js）', async () => {
  // ステップ4以前は「構造再計算・反映経路は壁を再生成できないため下地材だけ変えると壁厚と
  // ズレる」という理由で仕上げ突入境界（finish/finishBoundary.js）だけに絞っていたが、
  // wallRefresh.js は conformWoodBacking の直後に鍵比較→不一致ならその場で regenerateWalls
  // まで行う（壁を古いまま残さない）ため、この経路が増えても「下地材だけ変えて壁が古いまま
  // 残る」事故にはならない。呼び出し元を「壁を直後に再生成する経路」に限定する不変条件として
  // 引き続き固定する。
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = path.resolve(here, '..');
  const callers = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx)$/.test(ent.name) || /\.test\.js$/.test(ent.name) || p.endsWith(path.join('structural', 'woodAutoFill.js'))) continue;
      const text = fs.readFileSync(p, 'utf-8');
      if (/conformWoodBacking\(/.test(text)) callers.push(path.relative(src, p).replace(/\\/g, '/'));
    }
  };
  walk(src);
  assert.deepEqual(callers.sort(), ['finish/finishBoundary.js', 'wallRefresh.js']);
});

// ---- autoFillWoodBeamDepths（ステップ3d: 大梁・小梁の成を支持区間ごとの梁成表引きで自動更新）----
// 実 core.js（Plane/PlanGraph/CenterLine/StructuralColumn/StructuralBeam）を使う（wallBeamAxes.test.js と同じ方針）。
// 通り芯 x=0/x=3640, y=0 の横大梁1本を基本形にする（3640は表の最終列＝荷重なしで成300）。
function makeBeamTestGraph(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  return { graph, x0, x1, y0 };
}

test('autoFillWoodBeamDepths B1: 通り芯間3640(荷重なし)の横大梁は成300（柱同寸120幅）へ更新される', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.deepEqual(updated, [beam.id]);
  assert.equal(beam.sectionDefId, 'WOOD-120x300');
});

test('autoFillWoodBeamDepths B2: 自階柱(x=1820)が内部荷重1か所のとき成330', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, y0, {});
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.deepEqual(updated, [beam.id]);
  assert.equal(beam.sectionDefId, 'WOOD-120x330');
});

test('autoFillWoodBeamDepths B3: 下階柱(x=1820。第3引数で渡す)は支持点になり2区間×1820で成120', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  // 下階柱なしなら成300（B1と同じ単一区間3640）になる断面を初期値にし、下階柱の効果を区別できるようにする。
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x300', y0, false, x0, x1, { role: 'primary' });
  const below = new PlanGraph(new Plane('p0', -3000, '0階', 1, 1));
  const bx = below.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const by = below.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  below.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', bx, by, {});
  const updated = autoFillWoodBeamDepths(graph, PROJECT, below.columns);
  assert.deepEqual(updated, [beam.id]);
  assert.equal(beam.sectionDefId, 'WOOD-120x120', '1820ずつ2区間・荷重なしはどちらも成120');
});

test('autoFillWoodBeamDepths B4: 他の梁がT字に取りつく端は1か所の荷重として数える', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const host = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  // leg: x=1820の縦梁。始端y0はhostの中間に取りつき（T字）、終端yFarは何にも取りつかない。
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y0, yFar, { role: 'primary' });
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.ok(updated.includes(host.id));
  assert.equal(host.sectionDefId, 'WOOD-120x330', 'T字1か所＝中間荷重1（成330）');
});

test('autoFillWoodBeamDepths B5: 同位置で両方向から取りつく十字貫通は荷重に数えない', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const host = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yNeg = graph.addCenterLine(CenterLineType.HORIZONTAL, -1820, { labeled: true, discipline: Discipline.STRUCT });
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640,  { labeled: true, discipline: Discipline.STRUCT });
  // hostを挟んで両側から取りつく2本の縦梁（同一の通り抜け小梁がhostで分断された表現）。
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, yNeg, y0, { role: 'secondary' });
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y0, yFar, { role: 'secondary' });
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.ok(updated.includes(host.id));
  assert.equal(host.sectionDefId, 'WOOD-120x300', '十字貫通は荷重に数えない＝荷重0か所（成300）');
});

test('【失敗系】autoFillWoodBeamDepths B6: dimensionStatus=lockedの梁は成を更新しない', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  beam.setDimensionStatus('locked');
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.deepEqual(updated, []);
  assert.equal(beam.sectionDefId, 'WOOD-120x120', '成表なら300のはずだがlockedのため不変');
});

test('【失敗系】autoFillWoodBeamDepths B7: 非在来（S造）はframingを持たないため[]で断面も不変', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph('S造');
  const beam = graph.addBeam(StructuralMaterialType.STEEL, 'S-H300x150', y0, false, x0, x1, { role: 'primary' });
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.deepEqual(updated, []);
  assert.equal(beam.sectionDefId, 'S-H300x150');
});

test('autoFillWoodBeamDepths B8: 冪等（同じ入力で2回目は更新0件）', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const first = autoFillWoodBeamDepths(graph, PROJECT);
  assert.equal(first.length, 1);
  const second = autoFillWoodBeamDepths(graph, PROJECT);
  assert.deepEqual(second, []);
});

// ---- QA指摘: role/materialType絞り込み・下階柱roleの除外・belowColumns=nullの防御が未固定だった分の追加テスト ----

test('【失敗系】autoFillWoodBeamDepths: 対象外role（foundation/eaves）・対象外材種（STEEL）の梁は更新されず、荷重源にもならない', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const target = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const yFoundation = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const foundationBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yFoundation, false, x0, x1, { role: 'foundation' });
  const yEaves = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const eavesBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yEaves, false, x0, x1, { role: 'eaves' });
  const ySteel = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const steelBeam = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', ySteel, false, x0, x1, { role: 'primary' });

  const updated = autoFillWoodBeamDepths(graph, PROJECT);

  assert.deepEqual(updated, [target.id], '更新されるのはWOOD_DEPTH_BEAM_ROLESかつ主構造材種の対象梁だけ');
  assert.equal(target.sectionDefId, 'WOOD-120x300', '対象梁自体は単一区間3640・荷重なしで成300へ更新される');
  assert.equal(foundationBeam.sectionDefId, 'WOOD-120x120', 'foundation梁は対象外で不変');
  assert.equal(eavesBeam.sectionDefId, 'WOOD-120x120', 'eaves梁は対象外で不変');
  assert.equal(steelBeam.sectionDefId, 'STEEL-H200x100', 'STEEL（非対象材種）の梁は対象外で不変');
});

test('【失敗系】autoFillWoodBeamDepths: 下階柱がrole:foundation（杭）なら支持点に数えない（B3の対照＝2区間に分割されず成300）', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const below = new PlanGraph(new Plane('p0', -3000, '0階', 1, 1));
  const bx = below.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const by = below.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  below.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', bx, by, { role: 'foundation' });
  const updated = autoFillWoodBeamDepths(graph, PROJECT, below.columns);
  assert.deepEqual(updated, [beam.id]);
  assert.equal(beam.sectionDefId, 'WOOD-120x300', '杭（foundation）は支持点に数えず単一区間3640のまま＝成300');
});

test('【失敗系】autoFillWoodBeamDepths: belowColumnsにnullを渡しても例外を投げない（端2点だけで評価=成300）', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  assert.doesNotThrow(() => autoFillWoodBeamDepths(graph, PROJECT, null));
  assert.equal(beam.sectionDefId, 'WOOD-120x300');
});

// ---- ステップ3c-3: 受梁（自階柱はあるが真下に下階柱の無い梁）の成をhost梁へ不動点まで伝播する ----
// carrier（受梁）: 縦梁 x=1820, y=0..3640。始端(y=0)がhost（横大梁 x=0..3640, y=0）にTで取りつく。
// carrier区間内部に自階柱3本（y=910/1820/2730）を置き、carrier自身の成を最大(360)にする
// （host自身が"T字1か所"だけから引く成330より大きくし、直接伝播の効果を分離して確認する）。
function makeCarrierTestGraph(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y910 = graph.addCenterLine(CenterLineType.HORIZONTAL, 910,  { labeled: true, discipline: Discipline.STRUCT });
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y2730 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2730, { labeled: true, discipline: Discipline.STRUCT });
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const host = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const carrier = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y0, yFar, { role: 'primary' });
  const columns = [y910, y1820, y2730].map(y => graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, y, {}));
  return { graph, x0, x1, xMid, y0, y910, y1820, y2730, yFar, host, carrier, columns };
}

test('autoFillWoodBeamDepths C1: 受梁1本(自階柱3本・真下に下階柱なし)がTで取りつくhostは受梁と同寸(360)になる', () => {
  const { graph, carrier, host } = makeCarrierTestGraph();
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.equal(carrier.sectionDefId, 'WOOD-120x360', '受梁自身は区間内部の自階柱3本で成360');
  assert.equal(host.sectionDefId, 'WOOD-120x360', 'hostは自身の成330(T字1か所)より大きい受梁の成へ引き上がる');
  assert.deepEqual(updated.sort(), [carrier.id, host.id].sort());
});

// 対照フィクスチャ: carrier（縦梁 x=910, y=0..3640）の区間内部の自階柱1本(y=100)の真下に下階柱がある
// ＝受梁ではない。真下の柱がcarrier自身の支持点になり、長い方の区間(100..3640=3540)は荷重なしで
// 成300まで上がる——それでも host（横大梁 x=0..1820, y=0。T字1か所で自身の成150）へは伝播しない
// ことを、carrier自身の成（300）がhostの成（150）より明確に大きい状況で確認する（carrier自身の成が
// 小さいと「伝播していないから」なのか「伝播元の値がそもそも小さいから」なのか区別できないため）。
function makeNonCarrierTestGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 910, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y100 = graph.addCenterLine(CenterLineType.HORIZONTAL, 100,  { labeled: true, discipline: Discipline.STRUCT });
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const host = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const carrier = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y0, yFar, { role: 'primary' });
  const selfColumn = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, y100, {});
  return { graph, xMid, y100, host, carrier, selfColumn };
}

test('【対照】autoFillWoodBeamDepths C2: 自階柱の真下に下階柱があれば受梁ではないため、carrier自身の成(300)がhostの成(150)より大きくても伝播しない', () => {
  const { graph, xMid, y100, host, carrier } = makeNonCarrierTestGraph();
  const below = new PlanGraph(new Plane('p0', -3000, '0階', 1, 1));
  const bx = below.addCenterLine(CenterLineType.VERTICAL, xMid.value, { labeled: true, discipline: Discipline.STRUCT });
  const by = below.addCenterLine(CenterLineType.HORIZONTAL, y100.value, { labeled: true, discipline: Discipline.STRUCT });
  const belowColumns = [below.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', bx, by, {})];
  autoFillWoodBeamDepths(graph, PROJECT, belowColumns);
  assert.equal(carrier.sectionDefId, 'WOOD-120x300', '真下の柱がcarrier自身の支持点になり、長い方の区間(3540)は荷重なしで成300');
  assert.equal(host.sectionDefId, 'WOOD-120x150', 'hostは自身のT字1か所ぶん(150)のまま——真下に下階柱がある自階柱は受梁の荷重として伝播しない');
});

test('【失敗系】autoFillWoodBeamDepths C3: hostがdimensionStatus=lockedなら受梁の成が伝播しても据え置き（受梁自身は更新される）', () => {
  const { graph, carrier, host } = makeCarrierTestGraph();
  host.setDimensionStatus('locked');
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.equal(host.sectionDefId, 'WOOD-120x120', 'lockedのhostは伝播で更新されない');
  assert.equal(carrier.sectionDefId, 'WOOD-120x360', '受梁自身(auto)は更新される');
  assert.deepEqual(updated, [carrier.id]);
});

test('autoFillWoodBeamDepths C4: 冪等（受梁伝播込みで2回目の更新は0件）', () => {
  const { graph } = makeCarrierTestGraph();
  const first = autoFillWoodBeamDepths(graph, PROJECT);
  assert.equal(first.length, 2);
  const second = autoFillWoodBeamDepths(graph, PROJECT);
  assert.deepEqual(second, []);
});

// ---- 【統合】recomputeStructuralForGraphへの配線（下階peekの共有・changedへの反映）を固定する ----
// wallRefresh.test.js:285付近と同じ手法（floorSwapManagerのシングルトンpeekを一時差し替え）。
test('【統合】recomputeStructuralForGraph: 在来木造の梁成が更新され changed=true になる（下階柱は支持点として効く）', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（柱1本）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 対象階（活性）
  project.activePlaneId = 'p2';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 2階: 通り芯 x=0/3640, y=0 の横大梁1本。初期断面は300/120いずれとも異なる値にして、
  // どちらの結果になっても「実際に更新された」ことが分かるようにする。
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  const beam = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x360', y0, false, x0, x1, { role: 'primary' });

  // 1階: x=1820 の柱1本（2階の梁と同じ通り上・軸上）。
  const bx = g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const by = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  const belowColumn = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', bx, by, {});

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const { changed } = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(changed, true, '梁成の更新がchangedのORに反映されている');
    assert.equal(beam.sectionDefId, 'WOOD-120x120', '下階柱1820が支持点になり2区間×1820・荷重なし＝成120');

    // 対照: 1階の柱を消すと支持点は両端2点だけになり、単一区間3640・荷重なし＝成300になる
    // （第3引数belowColumnsが実際に効いていること・固定値[]に配線されていないことの確認）。
    g1.columnMap.delete(belowColumn.id);
    beam.setField('sectionDefId', 'WOOD-120x360'); // 再度差分が出るよう初期値へ戻す
    const { changed: changed2 } = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(changed2, true);
    assert.equal(beam.sectionDefId, 'WOOD-120x300', '1階の柱を消した対照では単一区間3640＝成300');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 【統合】recomputeStructuralForGraphへの配線（壁線上の通し梁・候補に無い自動梁の撤去）を固定する（ステップ3c-2） ----
test('【統合】recomputeStructuralForGraph: 在来木造は壁線上に通し梁を生成し、壁の無い旧方式(通り芯グリッド)の自動梁を撤去してchanged=trueになる', async () => {
  const project = new Project('proj3', 'test');
  // 2階建てにする（1階のみだと基礎伏図扱いになり梁のroleが'foundation'固定になってしまうため、
  // role:'primary'が生成される対象階＝最下階でない階を作る）。
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT }); // 部屋の外（壁が無い）
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room);
  // 壁の無い x1..x2（部屋の外）に、旧方式（通り芯グリッド）の自動大梁を残置（撤去されるはず）。
  const staleBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x1, x2, { role: 'primary' });

  // 1階（非アクティブ）のpeekはfloorSwapManagerのシングルトンpeekを一時差し替える
  // （wallRefresh.test.js:285付近・本ファイル既存の【統合】テストと同じ手法）。
  const peekMap = { p1: g1, p2: graph };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const { changed } = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(changed, true);
    assert.equal(graph.beamMap.has(staleBeam.id), false, '壁の無い辺の自動大梁は撤去される');
    const wallBeams = graph.beams.filter(b => b.role === 'primary' && b.materialType === StructuralMaterialType.WOOD);
    assert.ok(wallBeams.length > 0, '部屋の壁線上に通し梁が生成される');
    assert.ok(wallBeams.every(b => b.id !== staleBeam.id));
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 不変条件: structuralRecompute.js が wallRunSegments を autoFillStructuralGrid に渡し、removedBeams を changed に含める ----
test('【不変条件】structuralRecompute.js: wallRunSegments を autoFillStructuralGrid に渡し、removedBeams を changed に含める（ステップ3c-2）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralRecompute.js'), 'utf8');
  assert.ok(/wallRunSegments\(targetGraph,\s*belowGraph,\s*structure\)/.test(src),
    'wallRunSegments(targetGraph, belowGraph, structure) の呼び出しが無い');
  assert.ok(/autoFillStructuralGrid\(targetGraph, project, mainStructure, wallGate, wallSources, wallSegments\)/.test(src),
    'autoFillStructuralGrid へ wallSegments を渡していない');
  assert.ok(/removedBeams\.length > 0/.test(src), 'removedBeams が changed の判定に含まれていない');
});
