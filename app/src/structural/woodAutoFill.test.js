// woodAutoFill.js（在来木造ステップ3a: 壁交点柱・既存断面そろえ）の単体テスト。
// wallBeamAxes.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType, columnSlotKey, spanKey, centerLineKind as centerLineKindOf } from '../core.js';
import {
  wallIntersectionPoints, autoFillWoodColumns, conformWoodSections, conformWoodBacking, WALL_JUNCTION_TOL_MM,
  autoFillWoodBeamDepths, autoFillWoodWallBeams, autoFillWoodFloorBeams,
} from './woodAutoFill.js';
import { WOOD_STUD_CODE_BY_SIZE } from '../finish/materials/backingClass.js';
import { autoFillColumnsForStructure, autoFillStructuralGrid } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { selfWallSegments, autoFillWallBeamAxes, wallBeamAxisExcludeKey } from './wallBeamAxes.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { SECONDARY_BEAM_CLEARANCE_MM } from '../core/structuralEntities.js';
import { findSectionEntry } from './sectionCatalog.js';

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

// ================================================================
// 在来木造・上階柱直下の柱（ステップ3b）。フィクスチャ: 横壁 y=2000（x:0..4000）＋縦壁 x=1000（交点）・
// x=3000（T字）で、y=2000の壁線上に through-run [1000,3000] ができる（3aの交点は(1000,2000)・(3000,2000)）。
// 走行方向のアンカー用に通り芯 x=2000（壁は無い）も置く——3b候補(2000,2000)は3aの交点と別スロットになる。
// ================================================================
function makeWoodLineWithRunGraph() {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // 横壁 y=2000（halfDepth=60）
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });  // 縦壁 x=1000（交点）
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWall(graph, { axisValue: 3000, clStart: ym, clEnd: y2, isVertical: true });  // 縦壁 x=3000（T字）→run[1000,3000]
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  // 下階が無い前提のwallRunSegments代用（wallRunSegments(graph,null,structure)と同値＝selfのみ）。
  const wallSegments = selfWallSegments(graph);
  return { graph, x1, x2, y1, y2, wallSegments };
}

test('autoFillWoodColumns（3b・1）: 上階柱直下—壁線上（交点でない）・run内・アンカー有りなら1本、座標は(壁線coord, 上階柱along)', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 走行方向アンカー（壁は無い）
  const base = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments); // 3aのみ確定（交点2本）
  assert.equal(base.created.length, 2);
  const above = [{ x: 2000, y: 2000, role: 'standard' }];
  const { created, removed } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 1, '3b候補1本だけ新規に立つ');
  assert.deepEqual([created[0].x, created[0].y], [2000, 2000], '座標＝(壁線coord=2000, 上階柱along=2000)');
  assert.deepEqual(removed, []);
});

test('【失敗系】autoFillWoodColumns（3b・2）: 壁の無い位置には立たない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const above = [{ x: 2000, y: 500, role: 'standard' }]; // y=500は壁(y=2000)から遠い
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 2, '3aの交点2本のみ（3b候補は増えない）');
});

test('【失敗系】autoFillWoodColumns（3b・3）: 下地帯の外（halfDepth超）には立たない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2100, role: 'standard' }]; // halfDepth=60に対しperp差100
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 2);
});

test('【失敗系】autoFillWoodColumns（3b・4）: runの外（自由端側）には立たない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 3500, { labeled: true, discipline: Discipline.STRUCT });
  // x=3500は壁の物理範囲(0..4000)の内側だが、through-run[1000,3000]の外（自由端側）。
  const above = [{ x: 3500, y: 2000, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 2);
});

test('autoFillWoodColumns（3b・T1）: 下地帯の内側（中心から外れる）の上階柱は壁線へ寄せて立つ（QA F1）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 走行方向アンカー（壁は無い）
  // halfDepth=60に対しperp差40（帯の内側だが中心からは外れる）。
  const above = [{ x: 2000, y: 2040, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 3, '3a交点2本＋3b候補1本');
  const col3b = created.find(c => c.x === 2000 && c.y === 2000);
  assert.ok(col3b, '3b柱は壁線の座標(y=2000)へスナップして立つ（上階柱の生のy=2040ではない）');
});

test('【失敗系】autoFillWoodColumns（3b・T3）: 上階の基礎柱（role=\'foundation\'）は候補にしない（QA F3）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, role: 'foundation' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 2, '基礎柱（杭）の直下には3b柱を立てない（3aの2本のみ）');
});

test('autoFillWoodColumns（3b・T6）: 1点が複数の壁線に一致しても選ぶ線は決定的（graph.wallsの追加順に依存しない・QA F6）', () => {
  // 横壁2本を近接させ、y=2000（run[1000,3000]あり）とy=2100（runなし。交差する縦壁が無いため
  // 単独の壁＝runが作れない）のどちらの帯にも入る点(x=2000,y=2055)を作る（halfDepth=60ずつ）。
  // dist（|perp-coord|）だけを見るとy=2100側（dist=45）がy=2000側（dist=55）より近いため、
  // run優先を効かせないと誤ってrunの無いy=2100側を選んでしまう——run優先が効いているかを固定する。
  // selfWallSegments/wallIntersectionPointsはgraph.wallsの追加順をそのまま辿るため、addY2000/addY2100
  // の呼び出し順（＝graph.wallsへの追加順）を入れ替えて、結果が変わらないことを確認する。
  function buildGraph(y2100First) {
    const { graph, x1, x2, y1, y2 } = makeGridGraph();
    const addY2000 = () => {
      addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
      addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });
      const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
      addBackingWall(graph, { axisValue: 3000, clStart: ym, clEnd: y2, isVertical: true });
    };
    const addY2100 = () => {
      // x:1500..2500のみ（交差する縦壁が無いため孤立した壁＝runが作れない）。
      const y2100Start = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });
      const y2100End = graph.addCenterLine(CenterLineType.VERTICAL, 2500, { labeled: false, discipline: Discipline.ARCH });
      addBackingWall(graph, { axisValue: 2100, clStart: y2100Start, clEnd: y2100End, isVertical: false });
    };
    if (y2100First) { addY2100(); addY2000(); } else { addY2000(); addY2100(); }
    graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 走行方向アンカー
    autoFillWallBeamAxes(graph, selfWallSegments(graph));
    return { graph, wallSegments: selfWallSegments(graph) };
  }

  const above = [{ x: 2000, y: 2055, role: 'standard' }];
  const results = new Set();
  for (const y2100First of [false, true]) {
    const { graph, wallSegments } = buildGraph(y2100First);
    const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
    const col3b = created.find(c => c.x === 2000);
    results.add(col3b ? `${col3b.x},${col3b.y}` : 'none');
  }
  assert.equal(results.size, 1, `graph.wallsの追加順を入れ替えても選ばれる線は同じはず（実際: ${[...results]}）`);
  assert.deepEqual([...results], ['2000,2000'], 'distはy=2100側が近い(45<55)がrunに入る線(y=2000)が優先して選ばれる');
});

test('【失敗系】autoFillWoodColumns（3b・5）: 走行方向にCLが無い（0.5mm一致なし）と立たず、CLも新設しない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const clCountBefore = graph.centerLines.length;
  const above = [{ x: 2500, y: 2000, role: 'standard' }]; // x=2500は近傍の通り芯・梁芯から500mm以上離れている
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 2, 'アンカー解決不能な3b候補は見送られる（QA裁定F2で寄せは廃止済み。0.5mm一致が無ければ即見送り）');
  assert.equal(graph.centerLines.length, clCountBefore, 'CLは新設しない');
});

test('autoFillWoodColumns（3b・6）: 3aの交点と同スロットなら重複生成しない（created 0）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const above = [{ x: 1000, y: 2000, role: 'standard' }]; // 既に3aの交点そのもの
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 2, '3aの2本のみ（3b分の追加は無い）');
});

test('autoFillWoodColumns（3b・7）: excludedColumnSlotsに記録された位置は復活しない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, role: 'standard' }];
  const first = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const col3b = first.created.find(c => c.x === 2000 && c.y === 2000);
  assert.ok(col3b, '前提: 3b柱が立っている');
  graph.removeColumn(col3b.id); // 除外集合へ記録される（既存の3aテストと同じ規律）
  const second = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.deepEqual(second.created, [], '除外スロットには生成しない');
});

test('autoFillWoodColumns（3b・8）: lockedにした3b柱は aboveColumns=[] でも撤去されない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, role: 'standard' }];
  const first = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const col3b = first.created.find(c => c.x === 2000 && c.y === 2000);
  col3b.setDimensionStatus('locked');
  const { removed } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments); // 上階柱が消えても
  assert.deepEqual(removed, []);
  assert.ok(graph.columnMap.has(col3b.id), 'locked済みの3b柱は残る');
});

test('autoFillWoodColumns（3b・9）: 冪等（同じ入力で2回目はcreated 0・removed 0）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, role: 'standard' }];
  const first = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(first.created.length, 3, '3a(2)+3b(1)');
  const second = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0]);
});

test('autoFillWoodColumns（3b・10）: aboveColumns未指定・null・[]はいずれも従来（3aのみ）と同結果', () => {
  const omitted = autoFillWoodColumns(makeWoodLineWithRunGraph().graph, PROJECT, null);
  assert.equal(omitted.created.length, 2, '未指定（既定[]）は3aのみ');
  const { graph: g2, wallSegments: ws2 } = makeWoodLineWithRunGraph();
  const nulled = autoFillWoodColumns(g2, PROJECT, null, null, ws2);
  assert.equal(nulled.created.length, 2, 'null明示も3aのみ');
  const { graph: g3, wallSegments: ws3 } = makeWoodLineWithRunGraph();
  const empty = autoFillWoodColumns(g3, PROJECT, null, [], ws3);
  assert.equal(empty.created.length, 2, '空配列明示も3aのみ');
});

test('【失敗系】autoFillWoodColumns（3b・11）: wallGateで外れる3b候補は立たない（3aは影響を受けない）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, role: 'standard' }];
  const gate = {
    intersectionInBuilding: (v, h) => !(v.effectiveValue === 2000 && h.effectiveValue === 2000),
    spanInBuilding: () => true,
  };
  const { created } = autoFillWoodColumns(graph, PROJECT, gate, above, wallSegments);
  assert.equal(created.length, 2, '3aの2本は通り、3b候補だけがゲートで弾かれる');
});

test('【対照】autoFillColumnsForStructure（3b・12）: 非在来（S造）ではaboveColumnsが無視される', () => {
  const steel = makeGridGraph('S造');
  addBackingWall(steel.graph, { axisValue: 2000, clStart: steel.x1, clEnd: steel.x2, isVertical: false });
  addBackingWall(steel.graph, { axisValue: 1000, clStart: steel.y1, clEnd: steel.y2, isVertical: true });
  const above = [{ x: 999999, y: 999999, role: 'standard' }]; // 通り芯交点方式では影響し得ない値
  const withAbove = autoFillColumnsForStructure(steel.graph, PROJECT, null, above, []);
  const steel2 = makeGridGraph('S造');
  addBackingWall(steel2.graph, { axisValue: 2000, clStart: steel2.x1, clEnd: steel2.x2, isVertical: false });
  addBackingWall(steel2.graph, { axisValue: 1000, clStart: steel2.y1, clEnd: steel2.y2, isVertical: true });
  const withoutAbove = autoFillColumnsForStructure(steel2.graph, PROJECT);
  assert.equal(withAbove.created.length, withoutAbove.created.length);
  assert.deepEqual(withAbove.created.map(c => `${c.x},${c.y}`).sort(), withoutAbove.created.map(c => `${c.x},${c.y}`).sort());
});

// ---- 【統合】3bで下階に柱ができると、上階の梁の受梁扱いが外れて成が下がる（3d伝播との結合）----
test('【統合・3b×3d】recomputeStructuralForGraph: 1階に3b柱ができると2階の梁は受梁扱いが外れ、成が下がる', async () => {
  const project = new Project('proj-3b-3d', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 3bの対象階（下階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 梁成の対象階（上階）
  project.activePlaneId = 'p2';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 2階: y=0の横大梁1本（x:0..3640）＋その軸上の自階柱(x=1820)。1階に支持が無い間は単一区間・荷重1（受梁）。
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  const beam = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x360', y0, false, x0, x1, { role: 'primary' });
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, y0, {});

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    const before = beam.sectionDefId;

    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col3b = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y) < 1);
    assert.ok(col3b, '1階に3b柱(1820,0)が立つ');

    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    const after = beam.sectionDefId;
    assert.notEqual(after, before, '1階に支持ができ受梁扱いが外れて成が変わる');
    const beforeHeight = findSectionEntry(before)?.height;
    const afterHeight = findSectionEntry(after)?.height;
    assert.ok(afterHeight < beforeHeight, `成が下がる: before=${beforeHeight} after=${afterHeight}`);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('structuralRecompute.js（3b・14）: 在来木造のときだけ1つ上の実体階をpeekし、非在来ではpeekしない', async () => {
  async function run(structure) {
    const project = new Project('proj-3b-peek', 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
    project.activePlaneId = 'p1';
    g1.structureOverride = structure;
    g2.structureOverride = structure;
    const graphMap = { p1: g1, p2: g2 };
    const calls = [];
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => { calls.push(plane.id); return graphMap[plane.id] ?? null; };
    try {
      await recomputeStructuralForGraph(g1, project, structure);
    } finally {
      floorSwapManager.peek = originalPeek;
    }
    return calls;
  }
  const woodCalls = await run(TRADITIONAL_WOOD_STRUCTURE);
  assert.ok(woodCalls.includes('p2'), '在来木造は1つ上の実体階(p2)をpeekする（上階柱直下の柱＝ステップ3b）');
  const steelCalls = await run('S造');
  assert.deepEqual(steelCalls, [], '非在来は1つ上の実体階をpeekしない');
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
  assert.ok(/autoFillStructuralGrid\(targetGraph, project, mainStructure, wallGate, wallSources, wallSegments, aboveColumns\)/.test(src),
    'autoFillStructuralGrid へ wallSegments・aboveColumns を渡していない');
  assert.ok(/removedBeams\.length > 0/.test(src), 'removedBeams が changed の判定に含まれていない');
});

// ---- autoFillWoodFloorBeams（ステップ3e-2: 床梁 role:'floor'、記号FB）----
// 短辺width×長辺heightの矩形を4辺すべてprimary梁で囲んだセル。structureを渡せる（非在来との対照に使う）。
function buildClosedCellGraph(structure, { width = 2730, height = 5460 } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const rules = rulesFor(structure);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, width, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, height, { labeled: true, discipline: Discipline.STRUCT });
  const top    = graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, y0, false, x0, x1, { role: 'primary' });
  const bottom = graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, y1, false, x0, x1, { role: 'primary' });
  const left   = graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, x0, true, y0, y1, { role: 'primary' });
  const right  = graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, x1, true, y0, y1, { role: 'primary' });
  return { graph, x0, x1, y0, y1, top, bottom, left, right };
}

test('autoFillWoodFloorBeams: 2730×5460のセル（短辺2730）に床梁2本を短辺方向（横梁）へ1820/3640の位置で生成する。冪等', () => {
  const { graph, x0, x1 } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const { created, removed } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.equal(created.length, 2);
  assert.deepEqual(removed, []);
  const sorted = created.slice().sort((a, b) => a.axisValue - b.axisValue);
  assert.deepEqual(sorted.map(b => b.axisValue), [1820, 3640]);
  for (const b of sorted) {
    assert.equal(b.isVertical, false, '短辺(x方向2730)と平行=横梁が材軸方向');
    assert.equal(b.role, 'floor');
    assert.equal(b.beamType, '床梁');
    assert.equal(b.materialType, StructuralMaterialType.WOOD);
    assert.equal(b.dimensionStatus, 'auto');
    assert.equal(centerLineKindOf(b.axisCL), 'beam', '自動生成した梁芯CL（fuse）');
    assert.equal(b.axisCL.labeled, false);
    assert.deepEqual([b.clStart.id, b.clEnd.id].sort(), [x0.id, x1.id].sort(), '直交端はセルの両辺を作る大梁自身のaxisCL');
  }
  // 冪等: もう一度呼んでも増減しない。
  const again = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual([again.created.length, again.removed.length], [0, 0]);
});

test('【失敗系】autoFillWoodFloorBeams: 短辺がちょうど1820（floorBeamMaxPitchMm）以下のセルは床梁なし', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE, { width: 1820 });
  const { created, removed } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual(created, []);
  assert.deepEqual(removed, []);
});

test('【失敗系】autoFillWoodFloorBeams: セルが閉じない（1辺欠け）配置は床梁を生成しない', () => {
  const { graph, right } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  graph.beamMap.delete(right.id); // 4辺被覆を崩す
  const { created, removed } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual(created, []);
  assert.deepEqual(removed, []);
});

test('autoFillWoodFloorBeams: 位置に既存の通り芯があれば重複生成せずそれを再利用する（findBeamAnchorCLの重複ガード）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const before = graph.centerLines.length;
  const preExisting = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const at1820 = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  const at3640 = created.find(b => Math.abs(b.axisValue - 3640) < 1);
  assert.equal(at1820.axisCL.id, preExisting.id, '既存の通り芯をそのままアンカーに使う（新規CLを作らない）');
  assert.notEqual(at3640.axisCL.id, preExisting.id);
  assert.equal(graph.centerLines.length, before + 2, '事前追加の通り芯1本＋3640用の新規梁芯CL1本のみ（1820分は重複生成しない）');
});

test('autoFillWoodFloorBeams（F1・D1再ブラケット）: 位置に既存の非ラベル梁芯CL（床梁スパンより狭い静的extent）を再利用した場合、床梁スパンとの和集合を直交通り芯へ再ブラケットする（縮めない・冪等。CenterLinesLayerの描画・snap.jsの沿線スナップに必要）', () => {
  const { graph, x0, x1 } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  // 中間の通り芯（x=400,2400）を追加しておく——和集合を取り違えて縮める変異（例:
  // Math.min/maxを取り違えて交差[500,800]にする）があった場合、bracketExtentが誤って
  // これら中間の通り芯へブラケットするため検出できる（無ければ両端(x0,x1)の2択しか無く、
  // 縮めても結果的に同じ結論に落ちて変異を見逃す）。
  graph.addCenterLine(CenterLineType.VERTICAL, 400,  { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 2400, { labeled: true, discipline: Discipline.STRUCT });
  // 生成予定座標(y=1820)に、床梁スパン(0..2730)より狭い静的extent(500..800)を持つ既存の梁芯CL
  // （fuse・labeled:false）を先置きする。
  const pre = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 500, extentHi: 800,
  });
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  assert.equal(beam.axisCL.id, pre.id, '既存の梁芯CLを再利用する（前提）');
  // 和集合[min(500,0),max(800,2730)]=[0,2730]がセルの両辺(x0=0,x1=2730)と一致するため両側ref化される。
  assert.deepEqual(pre.extentLoRef, { clId: x0.id, offset: 0 }, 'lo側はx0(通り芯0)へ再ブラケットされる');
  assert.deepEqual(pre.extentHiRef, { clId: x1.id, offset: 0 }, 'hi側はx1(通り芯2730)へ再ブラケットされる');
  assert.equal(pre.extentLo, 0);
  assert.equal(pre.extentHi, 2730, '床梁スパン(0..2730)を覆う');
  // 冪等: もう一度呼んでもextentは変化しない（2回目はexistingFloorKeysで先にcontinueするため）。
  autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual(pre.extentLoRef, { clId: x0.id, offset: 0 });
  assert.deepEqual(pre.extentHiRef, { clId: x1.id, offset: 0 });
});

test('autoFillWoodFloorBeams（F1b・D1再ブラケット）: 位置に既存の非ラベル梁芯CL（ref付きextent＝別の通り芯ブラケット）を再利用した場合も、和集合を再ブラケットする（実データmoku1/moku2 2階 x=5460の再現: wallBeamAxes.jsのbracketExtentが別の壁のために設定した通り芯ブラケットが床梁スパンと無関係に遠い）', () => {
  // 縦梁（isVertical:true）のセル（w=5460,h=3640。短辺=Y方向）。内部位置x=1820は実データx=5460と同型。
  const { graph, y1 } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE, { width: 5460, height: 3640 });
  const yFar1 = graph.addCenterLine(CenterLineType.HORIZONTAL, -2000, { labeled: true, discipline: Discipline.STRUCT });
  const yFar2 = graph.addCenterLine(CenterLineType.HORIZONTAL, -500,  { labeled: true, discipline: Discipline.STRUCT });
  const pre = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: false, discipline: Discipline.FUSE });
  graph.setCenterLineExtentRef(pre, 'lo', { clId: yFar1.id, offset: 0 });
  graph.setCenterLineExtentRef(pre, 'hi', { clId: yFar2.id, offset: 0 });
  assert.equal(pre.extentLo, -2000, '前提: ref経由で解決した下端');
  assert.equal(pre.extentHi, -500, '前提: ref経由で解決した上端。床梁スパン(0..3640)と無関係');
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  assert.equal(beam.axisCL.id, pre.id, '既存の梁芯CLを再利用する（前提）');
  // 和集合[min(-2000,0),max(-500,3640)]=[-2000,3640]。lo側はyFar1(-2000)自身がそのまま下限、
  // hi側はセルの上辺y1(3640)が上限としてブラケットされる（両側ref化）。
  assert.deepEqual(pre.extentLoRef, { clId: yFar1.id, offset: 0 }, 'lo側はyFar1(-2000)のまま（和集合の下限と一致）');
  assert.deepEqual(pre.extentHiRef, { clId: y1.id, offset: 0 }, 'hi側は床梁スパンの上限(3640)を覆うy1へ再ブラケットされる');
  assert.equal(pre.extentLo, -2000);
  assert.equal(pre.extentHi, 3640, '床梁スパン(0..3640)を覆う');
});

test('autoFillWoodFloorBeams（N2）: extent未確定（extentLo/Hiがnull＝全幅扱い）の既存梁芯CLは触らない（触ると全幅から有限範囲へ縮めることになるため）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const pre = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: false, discipline: Discipline.FUSE }); // extentLo/Hi省略＝null
  assert.equal(pre.extentLo, null, '前提: 全幅扱い');
  assert.equal(pre.extentHi, null);
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  assert.equal(beam.axisCL.id, pre.id, '既存の梁芯CLを再利用する（前提）');
  assert.equal(pre.extentLoRef, null, '触らない');
  assert.equal(pre.extentHiRef, null);
  assert.equal(pre.extentLo, null, '全幅のまま（縮められていない）');
  assert.equal(pre.extentHi, null);
});

test('autoFillWoodFloorBeams（N1）: locked指定した床梁は再呼び出しでcreated0・removed0のまま本数不変（existingFloorKeysが冪等性の番人であることを直接固定する）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const first = autoFillWoodFloorBeams(graph, PROJECT);
  assert.equal(first.created.length, 2);
  for (const b of first.created) b.setDimensionStatus('locked');
  const beforeCount = graph.beams.filter(b => b.role === 'floor').length;
  const second = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.removed, []);
  assert.equal(graph.beams.filter(b => b.role === 'floor').length, beforeCount);
});

test('autoFillWoodFloorBeams（F2）: 長辺÷maxPitchは切り上げ(ceil)で内部本数・ピッチを決める（floorだと2000超ピッチが生じ赤: 2730×4000セルでn=ceil(4000/1820)=3→内部2本、各区間は1820以下）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE, { height: 4000 });
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const ys = created.map(b => b.axisValue).sort((a, b) => a - b);
  assert.equal(ys.length, 2, 'n=ceil(4000/1820)=3の内部2本のはず（floorなら1本になり赤）');
  const bounds = [0, ...ys, 4000];
  for (let i = 0; i < bounds.length - 1; i++) {
    assert.ok(bounds[i + 1] - bounds[i] <= 1820 + 1, `区間[${bounds[i]},${bounds[i + 1]}]が1820を超えている`);
  }
});

test('autoFillWoodFloorBeams（F3）: 正方形セル(3640×3640)は材軸X（横梁・isVertical:false）が唯一の実装（h<=wにすると同寸の境界値3640===3640で赤になる）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE, { width: 3640, height: 3640 });
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.equal(created.length, 1);
  assert.equal(created[0].isVertical, false, '正方形は材軸X（横梁）');
  assert.equal(created[0].axisValue, 1820, 'セル中央');
});

test('autoFillWoodFloorBeams（F4）: 撤去される床梁に紐づくPenetrationSleeveはsleeveMapから連鎖削除され、excludedBeamSlotsにはキーが追加されない（graph.removeBeamは使わない規律。壁線通し梁の同名テストを床梁へ移植）', () => {
  const { graph, right } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const first = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = first.created.find(b => Math.abs(b.axisValue - 1820) < 1);
  const sleeve = graph.addSleeve('beam', {
    hostBeamId: beam.id, hostAxisCL: beam.axisCL, hostClStart: beam.clStart, hostClEnd: beam.clEnd, localPos: 500,
  });
  const key = spanKey(beam.axisCL, beam.clStart, beam.clEnd);
  graph.beamMap.delete(right.id); // セルを開放し候補を空にする（撤去を誘発）
  const { removed } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.ok(removed.includes(beam.id));
  assert.equal(graph.beamMap.has(beam.id), false);
  assert.equal(graph.sleeveMap.has(sleeve.id), false, '床梁の撤去に連鎖してスリーブも削除される');
  assert.equal(graph.excludedBeamSlots.has(key), false, 'graph.removeBeamは使わないのでexcludedBeamSlotsは汚されない');
});

test('【失敗系】autoFillWoodFloorBeams: excludedWallBeamAxesに記録された座標には生成しない（手動削除の尊重）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, 1820)); // 床梁は横梁(isVertical:false)なのでY:1820
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual(created.map(b => b.axisValue), [3640], '除外座標(1820)には生成せず、3640だけ生成される');
});

test('【失敗系】autoFillWoodFloorBeams: excludedBeamSlotsにあるスパンは再生成しない（手動削除の尊重）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const first = autoFillWoodFloorBeams(graph, PROJECT);
  const at1820 = first.created.find(b => Math.abs(b.axisValue - 1820) < 1);
  const key = spanKey(at1820.axisCL, at1820.clStart, at1820.clEnd);
  graph.beamMap.delete(at1820.id);
  graph.excludedBeamSlots.add(key);
  const second = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual(second.created, [], '除外スロットには再生成しない（3640は既存のため再生成不要で0件）');
  assert.deepEqual(second.removed, []);
});

test('【裁定】autoFillWoodFloorBeams: 候補に無い自動生成の床梁は撤去され、locked指定した床梁は残る', () => {
  const { graph, right } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const first = autoFillWoodFloorBeams(graph, PROJECT);
  assert.equal(first.created.length, 2);
  const locked = first.created.find(b => Math.abs(b.axisValue - 1820) < 1);
  const autoOnly = first.created.find(b => Math.abs(b.axisValue - 3640) < 1);
  locked.setDimensionStatus('locked');
  graph.beamMap.delete(right.id); // セルを開放し候補を空にする
  const second = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.removed, [autoOnly.id], '候補に無いauto床梁は撤去される');
  assert.ok(graph.beamMap.has(locked.id), 'locked指定した床梁は候補が無くなっても残る');
  assert.equal(graph.beamMap.has(autoOnly.id), false);
});

test('autoFillWoodFloorBeams: 床梁の端はhost（セルの両辺を作る大梁）の縁＋クリアランス(50mm)で止まる（coord1/coord2）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  const half = 120 / 2 + SECONDARY_BEAM_CLEARANCE_MM; // WOOD-120x120の縁+クリアランス
  assert.deepEqual(beam.spanForColumns(graph.columns), { coord1: half, coord2: 2730 - half });
});

test('【失敗系】autoFillWoodFloorBeams: 同一軸上に既存の木造梁（primary/floor）が生成スパンと重なっていれば二重防御で生成しない（findBeamAnchorCL再利用時にspanKeyが別物になりすり抜ける事故の対策。実データmoku1.stqの壁下梁・頭つなぎとの二重梁の回帰）', () => {
  const { graph, x0 } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  // y=1820に、生成対象の軸と同一だが範囲が異なる（spanKeyは別物になる）既存の木造梁を先置きする
  // （clStart=x0は共通・clEndだけ別CL＝生成予定のclEnd(セル右辺)とは異なるスパン）。
  const yPre = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: false, discipline: Discipline.FUSE });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yPre, false, x0, xMid, { role: 'floor', beamType: '床梁' });
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.ok(!created.some(b => Math.abs(b.axisValue - 1820) < 1), 'y=1820は既存梁とスパンが重なるため生成されない（spanKeyは別物のためexistingFloorKeysでは検出できないケース）');
  assert.equal(created.filter(b => Math.abs(b.axisValue - 3640) < 1).length, 1, 'y=3640は重ならないため影響を受けず生成される');
});

test('【失敗系】autoFillWoodFloorBeams: 非在来（framingを持たない主構造）は何もしない', () => {
  const { graph } = buildClosedCellGraph('S造');
  assert.deepEqual(autoFillWoodFloorBeams(graph, PROJECT), { created: [], removed: [] });
});

test('【対照】autoFillStructuralGrid: 非在来（S造）は同じ閉じたセルがあっても床梁(role:floor)を生成しない（beamPlacementゲート）', () => {
  const { graph } = buildClosedCellGraph('S造');
  const project = { planes: [new Plane('p0', -3000, '0階', 0, 1), graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  autoFillStructuralGrid(graph, project, 'S造', null, [], []);
  assert.equal(graph.beams.filter(b => b.role === 'floor').length, 0);
});

// 【統合・3d】大梁の両側から取りつく床梁2本が十字貫通と誤判定されて荷重から消えないことの確認（ステップ3e-2）。
// 中央の縦大梁(host)を挟んで左右2つのセル（それぞれ2730×3640・内部床梁1本ずつ・同じy=1820）を作る。
// 左セルの床梁の終端・右セルの床梁の始端はどちらもhostへ取りつく（互いに逆方向からの取り合い）——
// 旧実装（crossingBeamLoadCoordsをそのまま通す）だと+1/−1が同位置で相殺し荷重0（成300）になっていたはず。
test('【統合・3d】autoFillWoodBeamDepths: 大梁の両側から取りつく床梁2本はhostの荷重1か所として数えられる（十字貫通と誤判定されない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const xHost = graph.addCenterLine(CenterLineType.VERTICAL, 2730, { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'primary' }); // 上端（左右セル共通）
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x0, x2, { role: 'primary' }); // 下端（左右セル共通）
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, true, y0, y1, { role: 'primary' });  // 左端
  const host = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xHost, true, y0, y1, { role: 'primary' }); // 中央（両側から床梁が取りつく）
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x2, true, y0, y1, { role: 'primary' }); // 右端

  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.equal(created.length, 2, '左右セルにそれぞれ1本ずつ床梁が生成される（各セル2730×3640、内部位置1820は1か所）');
  assert.ok(created.every(b => Math.abs(b.axisValue - 1820) < 1), '両方ともy=1820の同一座標で中央のhostへ両側から取りつく');
  assert.ok(created.every(b => b.clStart.id === xHost.id || b.clEnd.id === xHost.id),
    '両方の床梁がhostのaxisCLを端に持つ（片方はclEnd、もう片方はclStart。逆方向からの取り合い）');

  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.ok(updated.includes(host.id), 'hostの成も更新される');
  assert.equal(host.sectionDefId, 'WOOD-120x330', 'hostは荷重1か所（同位置2本をdedupしたもの）として成330。誤って十字貫通扱い（荷重0・成300）になっていない');
});
