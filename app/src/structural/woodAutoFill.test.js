// woodAutoFill.js（在来木造ステップ3a: 壁交点柱・既存断面そろえ）の単体テスト。
// wallBeamAxes.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType, OpeningCategory, columnSlotKey, columnAnchorKey, spanKey, beamExclusionKey, centerLineKind as centerLineKindOf, edgeKey } from '../core.js';
import {
  wallIntersectionPoints, autoFillWoodColumns, conformWoodSections, conformWoodBacking, WALL_JUNCTION_TOL_MM,
  autoFillWoodBeamDepths, autoFillWoodWallBeams, autoFillWoodFloorBeams, conformWoodColumnEccentricity,
  autoFillWoodSillBeams, nearestAnchorCL,
} from './woodAutoFill.js';
import { wallRunFreeEnds } from './woodFraming.js';
import { WOOD_STUD_CODE_BY_SIZE } from '../finish/materials/backingClass.js';
import { autoFillColumnsForStructure, autoFillStructuralGrid, autoFillBeamsForStructure, convertMembersToEffectiveMaterial } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { selfWallSegments, autoFillWallBeamAxes, wallBeamAxisExcludeKey, createWallSourceCache } from './wallBeamAxes.js';
import { createFootprintCache } from './wallGate.js';
import { createStructuralResolveContext } from './structuralResolveContext.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { SECONDARY_BEAM_CLEARANCE_MM } from '../core/structuralEntities.js';
import { findSectionEntry } from './sectionCatalog.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';

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

// F-1（2026-09-19裁定）: 3b/3h-2/3i/袖柱を孤立させて検証するための多くのフィクスチャは、境界CLへ
// 繋ぐだけで対辺の壁を作らない「開いた」壁形状を使っている。そのため fixture の物理端が自由端
// （直交する下地オーナー壁が無い端）として検出され、各テストの対象と無関係な柱が付随して生成される
// ことがある。対象の座標群（targetCoords）だけを抜き出し、それ以外がすべて自由端であることを
// 検証してから（対象外の柱が紛れ込んでいれば失敗＝検出力を落とさない）targetを返す——総数だけを
// 機械的に書き換えると「何が増えたか」が読めなくなるため、この関数を経由して意図を明示する。
function splitFreeEndColumns(graph, created, targetCoords) {
  const targetKeys = new Set(targetCoords.map(([x, y]) => `${x},${y}`));
  const target = created.filter(c => targetKeys.has(`${c.x},${c.y}`));
  const other = created.filter(c => !targetKeys.has(`${c.x},${c.y}`));
  const freeEndKeys = new Set(wallRunFreeEnds(selfWallSegments(graph)).map(fe => `${fe.x},${fe.y}`));
  for (const c of other) {
    assert.ok(freeEndKeys.has(`${c.x},${c.y}`), `対象外の柱(${c.x},${c.y})はF-1の自由端（フィクスチャの開放端）であるはず`);
  }
  return target;
}

// 下地オーナー壁を1本追加（wallBeamAxes.test.js の addBackingWall と同じ。backingOffset=0＝下地帯中心が axisValue）。
// bandOffset（柱寸法が基準120より細い階の外壁下地帯シフト量。ステップ2）は既定null
// （帯シフト無し＝従来どおりの内壁相当）。外壁シナリオを模すテストだけ明示的に渡す。
function addBackingWall(graph, { axisValue, clStart, clEnd, isVertical, bandOffset = null }) {
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL, axisValue, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5, bandOffset });
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
  // このfixtureは対辺の壁が無い開いた形状のため、3aの交点2本のほかにF-1の自由端5本
  // （(0,2000)・(4000,2000)＝横壁の両端、(1000,0)・(1000,4000)＝縦壁x=1000の両端、
  // (3000,4000)＝縦壁x=3000の上端）が付随する。
  const target = splitFreeEndColumns(graph, created, [[1000, 2000], [3000, 2000]]);
  assert.equal(target.length, 2, `交点(1000,2000)とT字(3000,2000)の2本のはず（実際:${target.map(c => `${c.x},${c.y}`)}）`);
  assert.deepEqual(target.map(c => `${c.x},${c.y}`).sort(), ['1000,2000', '3000,2000']);
  for (const c of target) {
    assert.equal(c.materialType, StructuralMaterialType.WOOD);
    assert.equal(c.sectionDefId, 'WOOD-120x120', '在来木造の柱は120角');
    assert.equal(c.verticalCL.discipline, Discipline.FUSE, '縦アンカーは壁由来の梁芯CL');
    assert.equal(c.horizontalCL.discipline, Discipline.FUSE, '横アンカーは壁由来の梁芯CL');
  }
  assert.deepEqual(removed, []);
  // 冪等: もう一度呼んでも増減しない（F-1の自由端分も含め、初回で確定済み）。
  const again = fillWoodColumns(graph);
  assert.deepEqual([again.created.length, again.removed.length], [0, 0]);
});

// ---- F-1（2026-09-19裁定）: 壁の自由端（直交する下地オーナー壁が無い端）にも柱を立てる ----
// （2026-09-14裁定「壁の自由端には柱を立てない」の撤回。実データmoku4で階段開口の上り口・下り口の
// 開口辺に接する壁が自由端のまま止まる事例を確認。詳細は .claude/structural-model.md）。

test('autoFillWoodColumns（F-1）: 壁runの自由端（直交する壁が無い端）にも柱が立つ', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0,    clStart: y0, clEnd: y1000, isVertical: true });  // 縦壁 x=0, y:0..1000（下端(0,0)が自由端）
  addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false }); // 横壁 y=1000, x:0..1000（右端(1000,1000)が自由端）
  const { created } = fillWoodColumns(graph);
  assert.deepEqual(created.map(c => `${c.x},${c.y}`).sort(), ['0,0', '0,1000', '1000,1000'],
    '交点(0,1000)＋自由端2本（(0,0)・(1000,1000)）');
  // 冪等: もう一度呼んでも増減しない。
  const again = fillWoodColumns(graph);
  assert.deepEqual([again.created.length, again.removed.length], [0, 0]);
});

test('【失敗系】autoFillWoodColumns（F-1）: 腰壁・垂れ壁の指定がある辺の自由端には柱を立てない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0,    clStart: y0, clEnd: y1000, isVertical: true });
  const hWall = addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false });
  graph.setKneeDropWall(edgeKey(hWall.axisCL.id, x0.id, x1000.id), { knee: { topHeight: 900 } });
  const { created } = fillWoodColumns(graph);
  assert.deepEqual(created.map(c => `${c.x},${c.y}`).sort(), ['0,0', '0,1000'],
    '腰壁指定のある横壁の自由端(1000,1000)には立たない。縦壁の自由端(0,0)は指定が無いので対象のまま');
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
  // 3辺とも対辺の壁が無い開いた形状のため、交点2本のほかにF-1の自由端6本
  // （y=2000壁の両端・x=1000壁の両端・x=3000壁の両端）が付随する。
  const firstTarget = splitFreeEndColumns(graph, first.created, [[1000, 2000], [3000, 2000]]);
  assert.equal(firstTarget.length, 2);
  assert.deepEqual(first.removed, [gridAuto.id], '壁交点に無い自動柱は撤去される');
  assert.ok(graph.columnMap.has(gridLocked.id), '手動固定の柱は残る');
  assert.equal(graph.excludedColumnSlots.has(columnSlotKey(x1, y1)), false, '撤去は除外集合に記録しない（可逆）');
  // ユーザーが壁交点の柱を削除（除外集合へ記録）→ 再補完で復活しない。
  const col = firstTarget.find(c => c.x === 1000);
  graph.removeColumn(col.id);
  const second = fillWoodColumns(graph);
  assert.equal(second.created.length, 0, '除外スロットには生成しない');
});

test('autoFillWoodColumns: wallGate が建物外と判定した交点には柱を立てない', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });
  const gate = { intersectionInBuilding: () => false, spanInBuilding: () => false };
  const { created } = fillWoodColumns(graph, PROJECT, gate);
  assert.equal(created.length, 0);
});

test('【失敗系】autoFillWoodColumns: 壁が無い階（壁未生成）は柱を生成せず、既存の自動柱も撤去しない（保全。裁定2026-09-14）', () => {
  const { graph, x1, y1 } = makeGridGraph();
  const gridAuto = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {});
  const { created, removed, jambSkipped, iiPicks } = fillWoodColumns(graph);
  assert.equal(created.length, 0);
  assert.deepEqual(removed, []);
  assert.ok(graph.columnMap.has(gridAuto.id), '壁が無い階の既存柱は残る');
  // 早期returnでもjambSkipped/iiPicksは（空配列で）必ず返す——呼び出し側（probe等）が
  // 分岐なしで分割代入できるようにするため（QA指摘: 早期returnにこのフィールドが無くTypeErrorになる回帰）。
  assert.deepEqual(jambSkipped, []);
  assert.deepEqual(iiPicks, []);
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

// makeWoodLineWithRunGraph()は対辺の壁が無い開いた形状のため、3aの交点2本
// （[1000,2000]・[3000,2000]）のほかにF-1の自由端5本（(0,2000)・(4000,2000)＝y=2000壁の両端、
// (1000,0)・(1000,4000)＝x=1000壁の両端、(3000,4000)＝x=3000壁の上端）が常に付随する。
const WOOD_LINE_3A_TARGET = [[1000, 2000], [3000, 2000]];

test('autoFillWoodColumns（3b・1）: 上階柱直下—壁線上（交点でない）・run内・アンカー有りなら1本、座標は(壁線coord, 上階柱along)', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 走行方向アンカー（壁は無い）
  const base = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments); // 3aのみ確定（交点2本＋F-1自由端5本）
  assert.equal(splitFreeEndColumns(graph, base.created, WOOD_LINE_3A_TARGET).length, 2);
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  // baseの呼び出しで3a・自由端は既にgraphへ確定済みのため、ここでの新規created分は3b候補のみ。
  const { created, removed } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(created.length, 1, '3b候補1本だけ新規に立つ');
  assert.deepEqual([created[0].x, created[0].y], [2000, 2000], '座標＝(壁線coord=2000, 上階柱along=2000)');
  assert.deepEqual(removed, []);
});

test('【失敗系】autoFillWoodColumns（3b・2）: 壁の無い位置には立たない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const above = [{ x: 2000, y: 500, axisX: 2000, axisY: 500, role: 'standard' }]; // y=500は壁(y=2000)から遠い
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2, '3aの交点2本のみ（3b候補は増えない）');
});

test('【失敗系】autoFillWoodColumns（3b・3）: 下地帯の外（halfDepth超）には立たない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2100, axisX: 2000, axisY: 2100, role: 'standard' }]; // halfDepth=60に対しperp差100
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2);
});

test('【裁定変更・2026-09-19】autoFillWoodColumns（3b・4）: F-2でrunが自由端まで伸びるため、壁の物理範囲内（旧runの外）の候補も立つ', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 3500, { labeled: true, discipline: Discipline.STRUCT });
  // x=3500は壁の物理範囲(0..4000)の内側。旧仕様（2026-09-14裁定時点）はthrough-runを交点
  // [1000,3000]に限定し、x=3500を「run外（自由端側）」として見送っていた——F-2（自由端まで
  // 通し梁/土台のrunを伸ばす裁定・2026-09-19）の帰結として3b/3h-2のinRun判定もrunの自由端
  // （x=4000）まで広がり、この候補も立つようになった。壁が本当に存在しない位置（3b・2・3b・3）は
  // 従来どおり見送られる——変わったのは「壁はあるが旧runの外」だった範囲だけ。
  const above = [{ x: 3500, y: 2000, axisX: 3500, axisY: 2000, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const target = splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [3500, 2000]]);
  assert.equal(target.length, 3, '3a(2)+3b候補(1、run拡張後は自由端側でも立つ)');
});

test('autoFillWoodColumns（3b・T1）: 下地帯の内側（中心から外れる）の上階柱は壁線へ寄せて立つ（QA F1）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 走行方向アンカー（壁は無い）
  // halfDepth=60に対しperp差40（帯の内側だが中心からは外れる）。
  const above = [{ x: 2000, y: 2040, axisX: 2000, axisY: 2040, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const target = splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [2000, 2000]]);
  assert.equal(target.length, 3, '3a交点2本＋3b候補1本');
  const col3b = target.find(c => c.x === 2000 && c.y === 2000);
  assert.ok(col3b, '3b柱は壁線の座標(y=2000)へスナップして立つ（上階柱の生のy=2040ではない）');
});

test('【失敗系】autoFillWoodColumns（3b・T3）: 上階の基礎柱（role=\'foundation\'）は候補にしない（QA F3）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'foundation' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2, '基礎柱（杭）の直下には3b柱を立てない（3aの2本のみ）');
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

  const above = [{ x: 2000, y: 2055, axisX: 2000, axisY: 2055, role: 'standard' }];
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

// B-3（2026-09-19裁定）: 走行方向のCLが厳密一致しない3b候補は、旧仕様では見送られていたが、
// 現在はオフセットアンカー（nearestAnchorCL＋woodAxisOffset）で立つ——CLは新設しない点は変わらない
// （.claude/structural-model.md「B-3」節参照）。
test('autoFillWoodColumns（B-3・3b・5）: 走行方向にCLが無い（0.5mm一致なし）でもオフセットアンカーで立ち、CLは新設しない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const clCountBefore = graph.centerLines.length;
  const above = [{ x: 2500, y: 2000, axisX: 2500, axisY: 2000, role: 'standard' }]; // x=2500は近傍の通り芯・梁芯から500mm以上離れている
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const target = splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [2500, 2000]]);
  assert.equal(target.length, 3, '3a(2)+3b由来のオフセット候補(1)');
  assert.ok(target.some(c => c.woodAxisOffset), '前提: オフセット柱が含まれる');
  assert.equal(graph.centerLines.length, clCountBefore, 'CLは新設しない');
});

test('autoFillWoodColumns（3b・6）: 3aの交点と同スロットなら重複生成しない（created 0）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const above = [{ x: 1000, y: 2000, axisX: 1000, axisY: 2000, role: 'standard' }]; // 既に3aの交点そのもの
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2, '3aの2本のみ（3b分の追加は無い）');
});

test('autoFillWoodColumns（3b・7）: excludedColumnSlotsに記録された位置は復活しない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const first = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const col3b = first.created.find(c => c.x === 2000 && c.y === 2000);
  assert.ok(col3b, '前提: 3b柱が立っている');
  graph.removeColumn(col3b.id); // 除外集合へ記録される（既存の3aテストと同じ規律）
  const second = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(second.created.length, 0, '除外スロットには生成しない');
});

test('autoFillWoodColumns（3b・8）: lockedにした3b柱は aboveColumns=[] でも撤去されない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
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
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const first = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.equal(splitFreeEndColumns(graph, first.created, [...WOOD_LINE_3A_TARGET, [2000, 2000]]).length, 3, '3a(2)+3b(1)');
  // 冪等の本体: 2回目は自由端分も含めcreated/removedとも空（初回で全確定済み）。
  const second = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0]);
});

test('autoFillWoodColumns（3b・10）: aboveColumns未指定・null・[]はいずれも従来（3aのみ）と同結果', () => {
  const { graph: g1 } = makeWoodLineWithRunGraph();
  const omitted = autoFillWoodColumns(g1, PROJECT, null);
  assert.equal(splitFreeEndColumns(g1, omitted.created, WOOD_LINE_3A_TARGET).length, 2, '未指定（既定[]）は3aのみ');
  const { graph: g2, wallSegments: ws2 } = makeWoodLineWithRunGraph();
  const nulled = autoFillWoodColumns(g2, PROJECT, null, null, ws2);
  assert.equal(splitFreeEndColumns(g2, nulled.created, WOOD_LINE_3A_TARGET).length, 2, 'null明示も3aのみ');
  const { graph: g3, wallSegments: ws3 } = makeWoodLineWithRunGraph();
  const empty = autoFillWoodColumns(g3, PROJECT, null, [], ws3);
  assert.equal(splitFreeEndColumns(g3, empty.created, WOOD_LINE_3A_TARGET).length, 2, '空配列明示も3aのみ');
});

test('【失敗系】autoFillWoodColumns（3b・11）: wallGateで外れる3b候補は立たない（3aは影響を受けない）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const gate = {
    intersectionInBuilding: (v, h) => !(v.effectiveValue === 2000 && h.effectiveValue === 2000),
    spanInBuilding: () => true,
  };
  const { created } = autoFillWoodColumns(graph, PROJECT, gate, above, wallSegments);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2, '3aの2本は通り、3b候補だけがゲートで弾かれる');
});

test('【対照】autoFillColumnsForStructure（3b・12）: 非在来（S造）ではaboveColumnsが無視される', () => {
  const steel = makeGridGraph('S造');
  addBackingWall(steel.graph, { axisValue: 2000, clStart: steel.x1, clEnd: steel.x2, isVertical: false });
  addBackingWall(steel.graph, { axisValue: 1000, clStart: steel.y1, clEnd: steel.y2, isVertical: true });
  const above = [{ x: 999999, y: 999999, axisX: 999999, axisY: 999999, role: 'standard' }]; // 通り芯交点方式では影響し得ない値
  const withAbove = autoFillColumnsForStructure(steel.graph, PROJECT, null, above, []);
  const steel2 = makeGridGraph('S造');
  addBackingWall(steel2.graph, { axisValue: 2000, clStart: steel2.x1, clEnd: steel2.x2, isVertical: false });
  addBackingWall(steel2.graph, { axisValue: 1000, clStart: steel2.y1, clEnd: steel2.y2, isVertical: true });
  const withoutAbove = autoFillColumnsForStructure(steel2.graph, PROJECT);
  assert.equal(withAbove.created.length, withoutAbove.created.length);
  assert.deepEqual(withAbove.created.map(c => `${c.x},${c.y}`).sort(), withoutAbove.created.map(c => `${c.x},${c.y}`).sort());
});

// ================================================================
// 在来木造・上階の頭つなぎ／受梁が壁を横切る位置の柱（ステップ3h-2）。3bと同じフィクスチャ
// （makeWoodLineWithRunGraph）を使い、aboveTieBeams（1つ上の実体階の頭つなぎ・受梁の区間。
// beamWallCrossPointsで自階の壁と「壁とみなして」交わる点を求める）だけを渡す——3bのaboveColumns
// は使わない（両者が同じ点源へ合流することの確認は3h-2・12で別途行う）。
// ================================================================

test('autoFillWoodColumns（3h-2・1）: 上階の頭つなぎ／受梁が壁線を横切る位置—run内・アンカー有りなら1本', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 走行方向アンカー
  const base = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments); // 3aのみ確定（交点2本＋F-1自由端5本）
  assert.equal(splitFreeEndColumns(graph, base.created, WOOD_LINE_3A_TARGET).length, 2);
  // 上階の頭つなぎ（縦方向、x=2000、y:1000..3000）が自階の横壁(y=2000)を横切る。
  // baseの呼び出しで3a・自由端は既にgraphへ確定済みのため、ここでの新規created分は3h-2候補のみ。
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const { created, removed } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  assert.equal(created.length, 1, '3h-2候補1本だけ新規に立つ');
  assert.deepEqual([created[0].x, created[0].y], [2000, 2000]);
  assert.deepEqual(removed, []);
});

test('【失敗系】autoFillWoodColumns（3h-2・2）: 壁を横切らない（beamWallCrossPointsが空）位置には立たない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  // y:5000..6000は自階の壁(y=2000)の走行範囲・下地帯のどちらとも交わらない。
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 5000, hi: 6000 }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2, '3aの交点2本のみ（3h-2候補は増えない）');
});

test('【裁定変更・2026-09-19】autoFillWoodColumns（3h-2・3）: F-2でrunが自由端まで伸びるため、壁の物理範囲内（旧runの外）を横切る位置も立つ', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 3500, { labeled: true, discipline: Discipline.STRUCT });
  // x=3500は壁の物理範囲(0..4000)の内側。3b・4と同じ理由（F-2でrunが自由端x=4000まで伸びる）で、
  // 旧仕様（through-run[1000,3000]の外＝見送り）から立つ側へ変わった。
  const aboveTieBeams = [{ isVertical: true, coord: 3500, lo: 1000, hi: 3000 }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const target = splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [3500, 2000]]);
  assert.equal(target.length, 3, '3a(2)+3h-2候補(1、run拡張後は自由端側でも立つ)');
});

test('autoFillWoodColumns（3h-2・4）: excludedColumnSlotsに記録された位置は復活しない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const first = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const col = first.created.find(c => c.x === 2000 && c.y === 2000);
  assert.ok(col, '前提: 3h-2柱が立っている');
  graph.removeColumn(col.id); // 除外集合へ記録される（3aと同じ規律）
  const second = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  assert.equal(second.created.length, 0, '除外スロットには生成しない');
});

test('autoFillWoodColumns（3h-2・5）: lockedにした3h-2柱は aboveTieBeams=[] でも撤去されない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const first = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const col = first.created.find(c => c.x === 2000 && c.y === 2000);
  col.setDimensionStatus('locked');
  const { removed } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, []); // 上階の梁が消えても
  assert.deepEqual(removed, []);
  assert.ok(graph.columnMap.has(col.id), 'locked済みの3h-2柱は残る');
});

test('autoFillWoodColumns（3h-2・6）: 冪等（同じ入力で2回目はcreated 0・removed 0）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const first = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  assert.equal(splitFreeEndColumns(graph, first.created, [...WOOD_LINE_3A_TARGET, [2000, 2000]]).length, 3, '3a(2)+3h-2(1)');
  // 冪等の本体: 2回目は自由端分も含めcreated/removedとも空（初回で全確定済み）。
  const second = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0]);
});

test('autoFillWoodColumns（3h-2・7）: aboveTieBeams未指定・null・[]はいずれも従来（3aのみ）と同結果', () => {
  const { graph: g1, wallSegments: ws1 } = makeWoodLineWithRunGraph();
  const omitted = autoFillWoodColumns(g1, PROJECT, null, [], ws1);
  assert.equal(splitFreeEndColumns(g1, omitted.created, WOOD_LINE_3A_TARGET).length, 2, '未指定（既定[]）は3aのみ');
  const { graph: g2, wallSegments: ws2 } = makeWoodLineWithRunGraph();
  const nulled = autoFillWoodColumns(g2, PROJECT, null, [], ws2, null);
  assert.equal(splitFreeEndColumns(g2, nulled.created, WOOD_LINE_3A_TARGET).length, 2, 'null明示も3aのみ');
  const { graph: g3, wallSegments: ws3 } = makeWoodLineWithRunGraph();
  const empty = autoFillWoodColumns(g3, PROJECT, null, [], ws3, []);
  assert.equal(splitFreeEndColumns(g3, empty.created, WOOD_LINE_3A_TARGET).length, 2, '空配列明示も3aのみ');
});

test('【失敗系】autoFillWoodColumns（3h-2・8）: wallGateで外れる3h-2候補は立たない（3aは影響を受けない）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const gate = {
    intersectionInBuilding: (v, h) => !(v.effectiveValue === 2000 && h.effectiveValue === 2000),
    spanInBuilding: () => true,
  };
  const { created } = autoFillWoodColumns(graph, PROJECT, gate, [], wallSegments, aboveTieBeams);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2, '3aの2本は通り、3h-2候補だけがゲートで弾かれる');
});

test('autoFillWoodColumns（3h-2・9）: 受梁（横方向の頭つなぎ相当）が壁線に載って終わる位置（同軸端点）にも立つ', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  // 横壁 y=2000 の上に載って x=2000 で終わる横方向の受梁（同軸端点＝beamWallCrossPointsのもう1つの経路）。
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const aboveTieBeams = [{ isVertical: false, coord: 2000, lo: 500, hi: 2000 }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  // 受梁のもう一方の端(x=500)も同軸端点として候補になる——F-2でrunが自由端(x=0/4000)まで伸びた
  // ため、旧仕様では見送られていたx=500（走行方向に厳密一致するCLが無くオフセットアンカー
  // x=0+500）も立つようになった（2026-09-19裁定）。
  const target = splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [2000, 2000], [500, 2000]]);
  assert.equal(target.length, 4, '3a(2)+3h-2(2、端点2000,2000と500,2000)');
  assert.ok(target.some(c => c.x === 2000 && c.y === 2000));
});

test('autoFillWoodColumns（3h-2・10）: 3bのaboveColumnsと同じslotへ合流すれば重複生成しない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }]; // 同じ(2000,2000)
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments, aboveTieBeams);
  assert.equal(splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [2000, 2000]]).length, 3, '3aの2本＋(2000,2000)は3b・3h-2が同じslotへ合流して1本のみ');
});

// ================================================================
// 変更2（2026-09-18裁定）: 3h-2限定のオフセットアンカー。走行方向のCL（crossCL）が解決できない
// 候補を、3bは従来どおり見送るが、3h-2は見送らず走行方向の最寄りの解決可能なCL（nearestAnchorCL。
// 袖柱と同じプレースホルダ）＋オフセット（WoodColumn.woodAxisOffset）で立てる。CLは新設しない。
// フィクスチャ makeWoodLineWithRunGraph の壁線（x=1000, x=3000 に縦壁の中心線）を使い、その間の
// x=2500（どちらのCLとも一致しない）を横切らせることで crossCL 解決失敗を作る。
// ================================================================

test('autoFillWoodColumns（3h-2・オフセット1）: 走行方向のCLが解決できない候補は最寄りのCL＋オフセットで立つ（woodAxisOffset）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  // x=2500には走行方向のCLを用意しない——最寄りは x=3000（距離500）。x=1000は距離1500。
  const aboveTieBeams = [{ isVertical: true, coord: 2500, lo: 1000, hi: 3000 }];
  const { created, removed } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const target = splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [2500, 2000]]);
  assert.equal(target.length, 3, '3a(2)+3h-2オフセット(1)');
  const col = target.find(c => c.woodAxisOffset);
  assert.ok(col, '前提: オフセット柱が含まれる');
  assert.deepEqual([col.axisX, col.axisY], [2500, 2000], 'AXISが実位置(2500,2000)そのもの（袖柱と同じ規律）');
  assert.deepEqual([col.x, col.y], [2500, 2000], '偏心0なのでACTUALもAXISと同じ');
  assert.deepEqual(col.woodAxisOffset, { isVertical: true, offset: -500 }, '最寄りのx=3000から-500のオフセット（X軸＝isVertical:true）');
  assert.equal(col.horizontalCL.effectiveValue, 2000, '法線方向（壁自身の軸）は通常どおりCL解決');
  assert.equal(col.verticalCL.effectiveValue, 3000, 'verticalCLは走行方向の最寄りのプレースホルダ(x=3000)のまま（実位置には使わない）');
  assert.deepEqual(removed, []);
});

// B-3（2026-09-19裁定「柱の追加は最上階から順に、最下階まで可能な限り同位置に」）: 3b由来の候補も
// オフセットアンカーを使うようになった（旧仕様「3b由来はオフセットしない」は撤回。上階柱の直下
// （袖柱直下・ポーチ等）にも、走行方向に厳密一致するCLが無い位置があるため、最下階まで柱を連鎖させる
// にはこの解禁が必要——.claude/structural-model.md「B-3」節参照）。
test('autoFillWoodColumns（B-3）: 3b由来の候補（aboveColumns）も走行方向のCLが無ければオフセットアンカーで立つ', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  // 3h-2・オフセット1と全く同じ座標(2500,2000)を3b経路（aboveColumns）から与える。
  const above = [{ x: 2500, y: 2000, axisX: 2500, axisY: 2000, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const target = splitFreeEndColumns(graph, created, [...WOOD_LINE_3A_TARGET, [2500, 2000]]);
  assert.equal(target.length, 3, '3a(2)+3b由来のオフセット候補(1)——B-3で3bもオフセットアンカーを使えるようになった');
  const col = target.find(c => c.woodAxisOffset);
  assert.ok(col, '前提: オフセット柱が含まれる');
  assert.deepEqual([col.axisX, col.axisY], [2500, 2000], 'AXISが実位置(2500,2000)そのもの（3h-2オフセットと同じ規律）');
});

test('【失敗系】autoFillWoodColumns（3h-2・オフセット3）: 既存柱（AXIS基準）と重なるオフセット候補は生成しない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const yCL = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && Math.abs(cl.effectiveValue - 2000) < 1);
  // 補助線（lineType:'dashed'）はresolveWoodColumnAnchorCL/nearestAnchorCLの対象外——柱自体は
  // どんなCLにもアンカーできるため、意図的に「解決不能な位置に既存柱だけがある」状況を作れる。
  const auxCL = graph.addCenterLine(CenterLineType.VERTICAL, 2500, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', auxCL, yCL, {});
  const aboveTieBeams = [{ isVertical: true, coord: 2500, lo: 1000, hi: 3000 }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  assert.equal(splitFreeEndColumns(graph, created, WOOD_LINE_3A_TARGET).length, 2, '3aの2本のみ——オフセット候補(2500,2000)は既存柱と重なり見送られる');
});

test('【Minor】autoFillWoodColumns（3h-2・オフセット）: wallGate判定はプレースホルダCL（アンカー座標）ではなく実位置（AXIS）で行う', () => {
  // 実位置(2500,2000)をゲート外・プレースホルダ位置(3000,2000)をゲート内にすると、実位置基準なら
  // 生成しない（プレースホルダ基準のバグなら誤って生成してしまう）。
  const { graph: g1, wallSegments: ws1 } = makeWoodLineWithRunGraph();
  const aboveTieBeams = [{ isVertical: true, coord: 2500, lo: 1000, hi: 3000 }];
  const gateBlocksReal = {
    intersectionInBuilding: (v, h) => {
      if (Math.abs(v.value - 2500) < 1 && Math.abs(h.value - 2000) < 1) return false; // 実位置はゲート外
      if (Math.abs(v.value - 3000) < 1 && Math.abs(h.value - 2000) < 1) return true;  // プレースホルダはゲート内
      return true; // 3aの他候補には影響しない
    },
    spanInBuilding: () => true,
  };
  const { created: created1 } = autoFillWoodColumns(g1, PROJECT, gateBlocksReal, [], ws1, aboveTieBeams);
  assert.equal(created1.some(c => c.woodAxisOffset), false, '実位置がゲート外なら、プレースホルダ位置がゲート内でも生成しない');

  // 逆（実位置をゲート内・プレースホルダ位置をゲート外にすると、実位置基準なら生成する）。
  const { graph: g2, wallSegments: ws2 } = makeWoodLineWithRunGraph();
  const gateAllowsReal = {
    intersectionInBuilding: (v, h) => {
      if (Math.abs(v.value - 2500) < 1 && Math.abs(h.value - 2000) < 1) return true;  // 実位置はゲート内
      if (Math.abs(v.value - 3000) < 1 && Math.abs(h.value - 2000) < 1) return false; // プレースホルダはゲート外
      return true;
    },
    spanInBuilding: () => true,
  };
  const { created: created2 } = autoFillWoodColumns(g2, PROJECT, gateAllowsReal, [], ws2, aboveTieBeams);
  assert.equal(created2.some(c => c.woodAxisOffset), true, '実位置がゲート内なら、プレースホルダ位置がゲート外でも生成する');
});

test('autoFillWoodColumns（3h-2・オフセット4）: removeColumnでoff:キーが記録され、再計算しても復活しない（同じCL交点の正規柱とも干渉しない）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const aboveTieBeams = [{ isVertical: true, coord: 2500, lo: 1000, hi: 3000 }];
  const first = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const offCol = first.created.find(c => c.woodAxisOffset);
  assert.ok(offCol, '前提: オフセット柱が立っている');
  assert.ok(columnAnchorKey(offCol).startsWith('off:'), 'columnAnchorKeyがoff:形式');
  graph.removeColumn(offCol.id);
  const second = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  assert.equal(second.created.length, 0, '除外スロット(off:キー)には生成しない');
  // 同じCL交点(x=3000の縦壁とy=2000の横壁=T字)の正規の3a柱は引き続き存在する（干渉しない）。
  assert.ok(graph.columns.some(c => c.axisX === 3000 && c.axisY === 2000 && !c.woodAxisOffset));
});

test('autoFillWoodColumns（3h-2・オフセット5）: 上階の梁端が消えたら撤去される', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const aboveTieBeams = [{ isVertical: true, coord: 2500, lo: 1000, hi: 3000 }];
  const first = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const offCol = first.created.find(c => c.woodAxisOffset);
  assert.ok(offCol);
  const { removed } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, []);
  assert.deepEqual(removed, [offCol.id], '上階の頭つなぎ・受梁が消えれば自動生成のオフセット柱は撤去される');
});

test('【統合・FBS往復】autoFillWoodColumns（3h-2・オフセット6）: woodAxisOffsetとAXISはserializeGraph→restoreGraphで保たれる', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  const aboveTieBeams = [{ isVertical: true, coord: 2500, lo: 1000, hi: 3000 }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const offCol = created.find(c => c.woodAxisOffset);
  assert.ok(offCol);
  const bytes = serializeGraph(graph);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, bytes);
  const restoredCol = restored.columnMap.get(offCol.id);
  assert.ok(restoredCol, '前提: 復元後に同一IDの柱が存在する');
  assert.deepEqual(restoredCol.woodAxisOffset, { isVertical: true, offset: -500 });
  assert.deepEqual([restoredCol.axisX, restoredCol.axisY], [2500, 2000], 'AXISも復元後に保たれる');
});

// ================================================================
// QA指摘Major-2（2026-09-18）: nearestAnchorCLのタイブレーク決定性＋columnAnchorKeyの実位置基準化。
// 実測: moku1/2/3の1階(7280,-5460)は最寄りCLが-3640と-7280の完全同距離タイで、旧実装（先着勝ち）は
// graph.centerLinesの走査順（CL追加順）が変わるとアンカーCLの選び方自体が変わってしまっていた。
// ================================================================

test('nearestAnchorCL: 同距離の候補が2本あるとき、CenterLineの追加順に依らず決定的に同じCLを選ぶ（effectiveValue昇順）', () => {
  function makeTiedGraph(reversed) {
    const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
    const values = reversed ? [-7280, -3640] : [-3640, -7280]; // 追加順を逆にした2グラフ
    for (const v of values) graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT });
    return graph;
  }
  const g1 = makeTiedGraph(false);
  const g2 = makeTiedGraph(true);
  // -5460は-3640からも-7280からも距離1820で完全同距離タイ。
  const c1 = nearestAnchorCL(g1, CenterLineType.VERTICAL, -5460);
  const c2 = nearestAnchorCL(g2, CenterLineType.VERTICAL, -5460);
  assert.equal(c1.effectiveValue, -7280, 'タイはeffectiveValue昇順（より小さい値）が勝つ');
  assert.equal(c2.effectiveValue, -7280, 'CenterLineの追加順を逆にしても同じCLが選ばれる（走査順に依存しない）');
});

test('【旧データ限定・種別ベースへ統一】nearestAnchorCL: {labeled:true, lineType:dashed}（種別aux）のみが近傍にある場合、移行後は解決不能（null）になる——移行前はcl.labeledで一致していた', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const legacyAux = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, lineType: 'dashed' });
  assert.equal(centerLineKindOf(legacyAux), 'aux', '前提: lineType=dashedなのでaux種別（labeled:trueだが種別は補助線の旧データ）');
  assert.equal(nearestAnchorCL(graph, CenterLineType.VERTICAL, 1000), null,
    '種別ベース（tier:any=[struct,center,beam]）は補助線を対象にしないため候補が無い（移行前はcl.labeledで一致し返していた）');
});

test('【旧データ限定・種別ベースへ統一】nearestAnchorCL: {labeled:true, discipline:STRUCT, lineType:dashed}（種別aux）は候補から外れ、より遠い通り芯が最寄りとして選ばれる——移行前は近いaux(labeled)が優先されていた', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const legacyAux = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  const farStruct = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(centerLineKindOf(legacyAux), 'aux', '前提: lineType=dashedが優先されaux種別になる（labeled:true・discipline:STRUCTでも通り芯ではない旧データ）');
  assert.equal(nearestAnchorCL(graph, CenterLineType.VERTICAL, 1000), farStruct,
    '種別ベースは補助線を候補から外すため、より遠い通り芯(1500)が最寄りとして選ばれる（移行前は近いaux(labeled、距離0)が優先されていた）');
});

test('【旧データ限定・種別ベースへ統一】nearestAnchorCL: {labeled:false, discipline:STRUCT}（種別struct・旧データ）が候補に加わり、より近いそのCLが選ばれる——移行前はlabeledがfalseのため候補外で遠い中心線が選ばれていた', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const legacyStruct = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH }); // farCenter（移行前に選ばれていた側。距離500）
  assert.equal(centerLineKindOf(legacyStruct), 'struct', '前提: discipline=STRUCTなのでstruct種別（labeled:falseだが通り芯として作図されない旧データ）');
  assert.equal(nearestAnchorCL(graph, CenterLineType.VERTICAL, 1000), legacyStruct,
    '種別ベース（tier:any）はlabeledを問わずstruct種別を候補にするため、距離0のlegacyStructが選ばれる（移行前はcl.labeled===falseのため候補外になり、距離500のfarCenterが選ばれていた）');
});

test('【Major-2】autoFillWoodColumns（3h-2・オフセット）: 走行方向のアンカーCLが同距離タイのときeffectiveValue昇順で決定的に選ぶ', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  // x=2000はx=1000・x=3000の両方から距離1000で完全同距離タイ。
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const offCol = created.find(c => c.woodAxisOffset);
  assert.ok(offCol, '前提: オフセット柱が立つ');
  assert.equal(offCol.verticalCL.effectiveValue, 1000, 'タイはeffectiveValue昇順（x=1000）が勝つ');
  assert.deepEqual([offCol.axisX, offCol.axisY], [2000, 2000], 'AXISは実位置(2000,2000)のまま');
});

test('【Major-2】autoFillWoodColumns（3h-2・オフセット）: アンカーCLの選択が変わっても（タイの片方を削除→もう片方に付け替わる）除外キーが実位置基準で効き続ける', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  // x=1500・x=2500を追加し、x=2000からの距離500で完全同距離タイにする
  // （x=1000/x=3000は距離1000でこちらより遠いため候補から外れる）。
  const clNear = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 2500, { labeled: true, discipline: Discipline.STRUCT });
  const aboveTieBeams = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const first = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const offCol = first.created.find(c => c.woodAxisOffset);
  assert.ok(offCol, '前提: オフセット柱が立つ');
  assert.equal(offCol.verticalCL.effectiveValue, 1500, '前提: タイはx=1500（effectiveValue昇順）が勝つ');
  const excludeKey = columnAnchorKey(offCol);
  assert.equal(excludeKey, 'off:2000:2000', '前提: 除外キーは実位置基準');

  graph.removeColumn(offCol.id); // 除外集合へ実位置基準のキーで記録される
  graph.removeCenterLine(clNear.id); // タイの片方（旧アンカー）を削除——もう片方(x=2500)へ選択が変わる
  const second = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveTieBeams);
  const revived = second.created.find(c => c.woodAxisOffset);
  assert.equal(revived, undefined, 'アンカーCLの選択が変わっても、実位置が同じなら除外キーが効き続けて復活しない');
});

// ================================================================
// 建具の袖柱（ユーザー指示2026-09-18「建具の両袖には、5mmずつクリアランスをとって柱を建てる。
// 但し、他の柱と重なる場合は、省略する」）。フィクスチャ: 横壁 y=2000（x:0..4000）に開口1つ
// （幅900・中心x=2000→coord1/2=1550/2450）。柱寸120・クリアランス5 → 袖座標=1550-65=1485 / 2450+65=2515。
// ================================================================
function makeWoodWallWithOpeningGraph({ refOffset = 2000, width = 900, id } = {}) {
  const { graph, x1, x2 } = makeGridGraph();
  const wall = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  const opening = graph.addOpening(wall.axisCL, 1, false, x1, refOffset, width, OpeningCategory.WINDOW, 'doubleSliding', {}, id);
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  return { graph, x1, x2, wall, opening };
}

// makeWoodWallWithOpeningGraphは対辺の壁が無い単独の壁（対辺は接続なし）のため、開口の袖柱の
// ほかにF-1の自由端2本（(0,2000)・(4000,2000)＝壁自身の両端）が付随する。
test('autoFillWoodColumns（建具の袖柱・1）: 開口の両袖にクリアランス5mm+柱寸/2で柱が立ち、AXIS・woodJambRefが正しい', () => {
  const { graph, opening } = makeWoodWallWithOpeningGraph();
  const { created: allCreated, removed } = autoFillWoodColumns(graph, PROJECT, null);
  const created = splitFreeEndColumns(graph, allCreated, [[1485, 2000], [2515, 2000]]);
  assert.equal(created.length, 2, '両袖2本');
  assert.deepEqual(removed, []);
  const bySide = Object.fromEntries(created.map(c => [c.woodJambRef.side, c]));
  assert.ok(bySide[-1] && bySide[1]);
  assert.equal(bySide[-1].x, 1485, 'coord1(1550)-クリアランス5-柱寸半分60');
  assert.equal(bySide[-1].y, 2000);
  assert.equal(bySide[1].x, 2515, 'coord2(2450)+クリアランス5+柱寸半分60');
  assert.equal(bySide[1].y, 2000);
  assert.deepEqual(bySide[-1].woodJambRef, { openingId: opening.id, side: -1, isVertical: false });
  assert.deepEqual(bySide[1].woodJambRef, { openingId: opening.id, side: 1, isVertical: false });
  assert.equal(findSectionEntry(bySide[-1].sectionDefId)?.width, 120, '階の柱寸(既定120)と同寸の断面');
  assert.notEqual(columnAnchorKey(bySide[-1]), columnAnchorKey(bySide[1]), '両袖は別の同一性キーを持つ');

  const second = autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(second.created.length, 0, '冪等');
  assert.deepEqual(second.removed, [], '冪等');
});

test('【失敗系】autoFillWoodColumns（建具の袖柱・2）: 候補柱・既存柱（locked含む）の断面と重なれば省略する', () => {
  const { graph } = makeWoodWallWithOpeningGraph();
  const vBlock = graph.addCenterLine(CenterLineType.VERTICAL, 1485, { labeled: true, discipline: Discipline.STRUCT });
  const hBlock = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', vBlock, hBlock, { dimensionStatus: 'locked' });
  const { created: allCreated } = autoFillWoodColumns(graph, PROJECT, null);
  // 手動固定の柱(1485,2000)自体は袖柱でもF-1自由端でもないため、対象=+1側の袖柱1本だけ。
  const created = splitFreeEndColumns(graph, allCreated, [[2515, 2000]]);
  assert.equal(created.length, 1, 'jamb側(-1・1485,2000)は既存のlocked柱と重なるため省略、+1側のみ生成');
  assert.equal(created[0].woodJambRef.side, 1);
  assert.equal(created[0].x, 2515);
});

test('【失敗系】autoFillWoodColumns（建具の袖柱・3）: 隣接する開口どうしの袖が重なる場合は開口id昇順→sideで先着1本', () => {
  const { graph, x1, x2 } = makeGridGraph();
  const wall = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  // A: 中心1000幅200→coord1/2=900/1100→袖=835/1165。B: 中心1300幅200→coord1/2=1200/1400→袖=1135/1465。
  // Aの+1側(1165)とBの-1側(1135)は柱寸120（半幅60）どうしで重なる（30mm差）。
  const openingA = graph.addOpening(wall.axisCL, 1, false, x1, 1000, 200, OpeningCategory.WINDOW, 'doubleSliding', {}, 'aaa-opening');
  const openingB = graph.addOpening(wall.axisCL, 1, false, x1, 1300, 200, OpeningCategory.WINDOW, 'doubleSliding', {}, 'bbb-opening');
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  const { created: allCreated } = autoFillWoodColumns(graph, PROJECT, null);
  // 対辺の壁が無い単独の壁（対辺は接続なし）のため、袖柱のほかにF-1の自由端2本
  // （(0,2000)・(4000,2000)＝壁自身の両端）が付随する。
  const created = splitFreeEndColumns(graph, allCreated, [[835, 2000], [1165, 2000], [1465, 2000]]);
  assert.equal(created.length, 3, 'Aの両袖2本＋Bの外側の袖1本（内側は重なって省略）');
  const xs = created.map(c => c.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [835, 1165, 1465]);
  const bRemaining = created.find(c => c.woodJambRef.openingId === openingB.id);
  assert.equal(bRemaining.woodJambRef.side, 1, 'Bはid順で後着のため、Aと重なる-1側だけ省略されhi側(1465)が残る');
  assert.equal(created.filter(c => c.woodJambRef.openingId === openingA.id).length, 2, 'Aは先着のため両袖とも生成される');
});

test('autoFillWoodColumns（建具の袖柱・4）: 開口を削除すると袖柱は自動撤去される', () => {
  const { graph, opening } = makeWoodWallWithOpeningGraph();
  const first = autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(splitFreeEndColumns(graph, first.created, [[1485, 2000], [2515, 2000]]).length, 2);
  graph.removeShape(opening.id);
  const { created, removed } = autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(created.length, 0);
  assert.equal(removed.length, 2, '削除されるのは袖柱2本のみ（F-1自由端は開口と無関係なので残る）');
  assert.equal(graph.columns.filter(c => c.woodJambRef).length, 0);
});

test('autoFillWoodColumns（建具の袖柱・5）: 開口を移動すると同じ柱(id不変)が新しい座標へ追従する（再生成ではない）', () => {
  const { graph, opening } = makeWoodWallWithOpeningGraph();
  const first = autoFillWoodColumns(graph, PROJECT, null);
  // F-1自由端2本はwoodJambRefを持たないため、idsBeforeは袖柱2本だけに絞る。
  const idsBefore = first.created.filter(c => c.woodJambRef).map(c => c.id).sort();

  opening.setProps({ refOffset: 2400 }); // 中心x=2000→2400（幅900のまま）→coord1/2=1950/2850→袖=1885/2915
  const { created, removed } = autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(created.length, 0, '同じ柱がそのまま使われるため新規生成は無い');
  assert.deepEqual(removed, [], '同じ柱のまま撤去もされない');

  const jambs = graph.columns.filter(c => c.woodJambRef);
  assert.deepEqual(jambs.map(c => c.id).sort(), idsBefore, '柱の同一性(id)は変わらない');
  assert.deepEqual(jambs.map(c => c.x).sort((a, b) => a - b), [1885, 2915], 'AXISは開口の新しい位置へ自動追従する（override getter）');
});

test('autoFillWoodColumns（建具の袖柱・6）: woodJambRefはserializeGraph→restoreGraphの往復で保持され、AXISは復元後も開口位置から正しく導出される', () => {
  // 通り芯（labeled）はstructGraph経由の別枠（serializeStructCLs）で永続化される前提のため、
  // 単体のPlanGraphだけで往復させるこのテストではARCH（意匠中心線）のCLを使う
  // （makeArchCLGraphと同じ規律。B-1 woodOffsetSide往復テスト参照）。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const wall = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  const opening = graph.addOpening(wall.axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  autoFillWoodColumns(graph, PROJECT, null);

  const bytes = serializeGraph(graph);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, bytes);

  const jambs = restored.columns.filter(c => c.woodJambRef);
  assert.equal(jambs.length, 2);
  const bySide = Object.fromEntries(jambs.map(c => [c.woodJambRef.side, c]));
  assert.deepEqual(bySide[-1].woodJambRef, { openingId: opening.id, side: -1, isVertical: false });
  assert.equal(bySide[-1].x, 1485);
  assert.equal(bySide[1].x, 2515);
});

test('autoFillWoodColumns（建具の袖柱・7）: 縦壁（isVertical:true）の開口でも走行方向AXIS（Y）が袖位置になる', () => {
  const { graph, y1, y2 } = makeGridGraph();
  const wall = addBackingWall(graph, { axisValue: 2000, clStart: y1, clEnd: y2, isVertical: true });
  const opening = graph.addOpening(wall.axisCL, 1, true, y1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  const { created: allCreated } = autoFillWoodColumns(graph, PROJECT, null);
  // 対辺の壁が無い単独の壁のため、袖柱のほかにF-1の自由端2本（(2000,0)・(2000,4000)＝壁自身の両端）が付随する。
  const created = splitFreeEndColumns(graph, allCreated, [[2000, 1485], [2000, 2515]]);
  assert.equal(created.length, 2);
  const bySide = Object.fromEntries(created.map(c => [c.woodJambRef.side, c]));
  assert.ok(bySide[-1] && bySide[1]);
  assert.deepEqual([bySide[-1].x, bySide[-1].y], [2000, 1485], '法線方向(X)は壁の座標のまま、走行方向(Y)がcoord1側の袖座標');
  assert.deepEqual([bySide[1].x, bySide[1].y], [2000, 2515], '走行方向(Y)がcoord2側の袖座標');
  assert.equal(bySide[-1].woodJambRef.isVertical, true);
  assert.equal(bySide[1].woodJambRef.isVertical, true);
  assert.deepEqual(bySide[-1].woodJambRef, { openingId: opening.id, side: -1, isVertical: true });
});

test('【失敗系】autoFillWoodColumns（建具の袖柱・8）: findHostWallが仕上げのみの薄壁（backingRange===null）を返す開口でも、同軸の下地オーナー壁を見つけて袖柱が立つ（例外を投げない）', () => {
  const { graph, x1, x2 } = makeGridGraph();
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // 下地オーナー壁（backingRange!=null）。abs(axisOffset)=180——薄壁より外側に置き、findHostWallの
  // 「wallSide一致・abs(axisOffset)最小」優先で薄壁に負ける配置にする。
  const owner = graph.addWall(axisCL, 180, false, x1, 0, x2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  // 仕上げのみの薄壁（backingDepth:0→backingRange===null）。同じwallSide・abs(axisOffset)=60で
  // ownerより小さいため、findHostWallはこちらを返す（実データmoku2/moku3の2階窓と同型の状況）。
  const thin = graph.addWall(axisCL, 60, false, x1, 0, x2, 0, { backingDepth: 0, wallFinish: 12.5 });
  assert.equal(thin.backingRange, null, '前提: 薄壁はbackingRangeを持たない');
  assert.notEqual(owner.backingRange, null, '前提: ownerは下地オーナー壁');
  graph.addOpening(axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  let result;
  assert.doesNotThrow(() => { result = autoFillWoodColumns(graph, PROJECT, null); });
  // ownerは対辺の壁が無い単独の壁のため、袖柱のほかにF-1の自由端2本（owner自身の両端）が付随する。
  const created = splitFreeEndColumns(graph, result.created, [[1485, 2000], [2515, 2000]]);
  assert.equal(created.length, 2, '下地オーナー壁(owner)を見つけて両袖が立つ（薄壁が返っても例外にならない）');
  const bySide = Object.fromEntries(created.map(c => [c.woodJambRef.side, c]));
  assert.equal(bySide[-1].y, 2000, '法線方向はownerの下地帯中心（backingOffset=0→軸=2000）');
  assert.equal(bySide[1].y, 2000);
});

test('【失敗系】autoFillWoodColumns（建具の袖柱・9）: 下地オーナー壁が1本も無い開口（同軸に薄壁のみ）は見送る（created空・removed空・例外なし）', () => {
  const { graph, x1, x2 } = makeGridGraph();
  // 他の位置に下地オーナー壁を1本置く（segments.length>0にして「壁ゼロの階は保全」ガードを回避する
  // ためだけの壁。開口とは無関係）。
  addBackingWall(graph, { axisValue: 500, clStart: x1, clEnd: x2, isVertical: false });
  // 開口のホスト壁の位置(y=2000)には仕上げのみの薄壁しか無い（下地オーナー壁が同軸に1本も無い）。
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 0, false, x1, 0, x2, 0, { backingDepth: 0, wallFinish: 12.5 });
  graph.addOpening(axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  let result;
  assert.doesNotThrow(() => { result = autoFillWoodColumns(graph, PROJECT, null); });
  // y=500の壁（対辺の壁が無い単独の壁。開口とは無関係）自身の自由端2本（(0,500)・(4000,500)）は
  // 付随するが、開口の袖柱（対象）は0本のはず。
  assert.equal(splitFreeEndColumns(graph, result.created, []).length, 0);
  assert.deepEqual(result.removed, []);
});

// ================================================================
// 袖柱の除外キー分離（columnAnchorKey）。フィクスチャ: 横壁 y=2000（x:0..4000）に開口
// （中心2000・幅900→coord1/2=1550/2450→袖=1485/2515）＋縦壁 x=0（y:0..4000）。x=0の縦壁が
// 横壁と交わる(0,2000)は3aコーナー柱になる。袖柱side=-1の走行方向crossCL（nearestAnchorCL）は
// x=0にある2本のCL（通り芯x1と、縦壁自身の中心線）が候補として完全同座標のタイになりうる——
// QA指摘Major-2（2026-09-18）でnearestAnchorCLのタイブレークを決定的（effectiveValue昇順→id昇順）
// にしたため、座標が同一な2本のタイはeffectiveValueでは discriminateできず乱数UUIDのid比較に
// 委ねられ、どちらが選ばれるかは実行のたびに変わりうる（旧実装は走査順での先着勝ちだったため、
// たまたま3aコーナー柱と同じCLペアになっていた）。そのため本テストは「袖柱とコーナー柱のCLペアが
// 一致するか」を前提にせず、columnAnchorKeyが袖柱を常に`jamb:`キーへ隔離すること（CLペアがどちらに
// 決まっても正規柱のスロットキーを汚さないこと）だけを検証する。
// ================================================================
test("removeColumn: 袖柱の削除は 'jamb:<openingId>:<side>' を記録し、正規柱スロットは除外しない（袖柱削除→再autoFill→正規柱は存在し続け、袖柱は復活しない）", () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  const hWall = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 0, clStart: y1, clEnd: y2, isVertical: true }); // x=0の縦壁→(0,2000)に3aコーナー
  const opening = graph.addOpening(hWall.axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  autoFillWoodColumns(graph, PROJECT, null);

  const corner = graph.columns.find(c => !c.woodJambRef && Math.abs(c.x) < 1 && Math.abs(c.y - 2000) < 1);
  const jamb1 = graph.columns.find(c => c.woodJambRef?.side === -1);
  assert.ok(corner, '前提: (0,2000)に3aコーナー柱がある');
  assert.ok(jamb1, '前提: 袖柱(side=-1)がある');
  assert.notEqual(jamb1.id, corner.id);

  graph.removeColumn(jamb1.id);
  assert.ok(graph.excludedColumnSlots.has(`jamb:${opening.id}:-1`), "'jamb:'キーが記録される");
  assert.ok(!graph.excludedColumnSlots.has(columnSlotKey(corner.verticalCL, corner.horizontalCL)),
    '正規柱のCLペアキーは除外集合に入らない（袖柱と別の同一性）');

  autoFillWoodColumns(graph, PROJECT, null);
  assert.ok(graph.columnMap.has(corner.id), '正規柱(コーナー柱)は存在し続ける');
  assert.equal(graph.columns.some(c => c.woodJambRef?.side === -1), false, '袖柱(side=-1)は復活しない');
  assert.equal(graph.columns.some(c => c.woodJambRef?.side === 1), true, 'side=1の袖柱は影響を受けない');
});

test('removeColumn: 正規柱の削除は袖柱の除外に干渉しない', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  const hWall = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 0, clStart: y1, clEnd: y2, isVertical: true });
  const opening = graph.addOpening(hWall.axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  autoFillWoodColumns(graph, PROJECT, null);

  const corner = graph.columns.find(c => !c.woodJambRef && Math.abs(c.x) < 1 && Math.abs(c.y - 2000) < 1);
  const jamb1 = graph.columns.find(c => c.woodJambRef?.side === -1);
  const cornerKey = columnSlotKey(corner.verticalCL, corner.horizontalCL);

  graph.removeColumn(corner.id);
  assert.ok(graph.excludedColumnSlots.has(cornerKey));
  assert.ok(!graph.excludedColumnSlots.has(`jamb:${opening.id}:-1`), '袖柱の除外キーには影響しない');

  autoFillWoodColumns(graph, PROJECT, null);
  assert.equal(graph.columnMap.has(corner.id), false, '正規柱は復活しない（除外済み）');
  assert.ok(graph.columnMap.has(jamb1.id), '袖柱(side=-1)は削除されず存在し続ける（idも不変）');
});

test('removeCenterLine: 袖柱・オフセットアンカー柱は、走行方向のプレースホルダCLの削除で連鎖削除される', () => {
  // 袖柱: verticalCL/horizontalCLはただのCL参照のため、_structuralRefsToCL（core/planGraph.js）の
  // 汎用の柱フィルタ（c.verticalCL.id===id || c.horizontalCL.id===id）がwoodJambRef/woodAxisOffsetの
  // 有無を問わずそのまま働く——新しい連鎖削除ロジックは要らない（既存の一般機構がそのまま保証する）。
  const { graph: g1, x1, x2, y1, y2 } = makeGridGraph();
  const hWall = addBackingWall(g1, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(g1, { axisValue: 0, clStart: y1, clEnd: y2, isVertical: true });
  g1.addOpening(hWall.axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(g1, selfWallSegments(g1));
  autoFillWoodColumns(g1, PROJECT, null);
  const jamb1 = g1.columns.find(c => c.woodJambRef?.side === -1);
  assert.ok(jamb1, '前提: 袖柱がある');
  g1.removeCenterLine(jamb1.verticalCL.id); // 走行方向のプレースホルダCL（crossCL）
  assert.equal(g1.columnMap.has(jamb1.id), false, '走行方向のプレースホルダCLを削除すると袖柱も連鎖削除される');

  // オフセット柱: 走行方向のプレースホルダCL（crossCL＝nearestAnchorCLの結果）を削除すると連鎖削除される。
  const { graph: g2, wallSegments } = makeWoodLineWithRunGraph();
  const aboveTieBeams = [{ isVertical: true, coord: 2500, lo: 1000, hi: 3000 }];
  const offCol1 = autoFillWoodColumns(g2, PROJECT, null, [], wallSegments, aboveTieBeams).created.find(c => c.woodAxisOffset);
  assert.ok(offCol1, '前提: オフセット柱がある');
  g2.removeCenterLine(offCol1.verticalCL.id);
  assert.equal(g2.columnMap.has(offCol1.id), false, '走行方向のプレースホルダCLを削除するとオフセット柱も連鎖削除される');

  // オフセット柱: 法線方向の実CL（axisCL＝壁自身の軸）を削除しても同様に連鎖削除される。
  const { graph: g3, wallSegments: wallSegments3 } = makeWoodLineWithRunGraph();
  const offCol2 = autoFillWoodColumns(g3, PROJECT, null, [], wallSegments3, aboveTieBeams).created.find(c => c.woodAxisOffset);
  assert.ok(offCol2, '前提: オフセット柱がある');
  g3.removeCenterLine(offCol2.horizontalCL.id);
  assert.equal(g3.columnMap.has(offCol2.id), false, '法線方向の実CLを削除してもオフセット柱は連鎖削除される');
});

test("addColumn: 袖柱を再追加すると 'jamb:' キーが解除される", () => {
  const { graph } = makeWoodWallWithOpeningGraph();
  autoFillWoodColumns(graph, PROJECT, null);
  const jamb1 = graph.columns.find(c => c.woodJambRef?.side === -1);
  const { verticalCL, horizontalCL, woodJambRef, sectionDefId } = jamb1;
  graph.removeColumn(jamb1.id);
  const key = `jamb:${woodJambRef.openingId}:-1`;
  assert.ok(graph.excludedColumnSlots.has(key));

  graph.addColumn(StructuralMaterialType.WOOD, sectionDefId, verticalCL, horizontalCL, { woodJambRef });
  assert.ok(!graph.excludedColumnSlots.has(key), '再追加（+追加相当）で除外は解除される');
});

test("autoFillWoodColumns（建具の袖柱・10）: serializeGraph→restoreGraphの往復でexcludedColumnSlotsの'jamb:'キーが保持される", () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const wall = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  const opening = graph.addOpening(wall.axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  autoFillWoodColumns(graph, PROJECT, null);
  const jamb1 = graph.columns.find(c => c.woodJambRef?.side === -1);
  graph.removeColumn(jamb1.id);
  const key = `jamb:${opening.id}:-1`;
  assert.ok(graph.excludedColumnSlots.has(key));

  const bytes = serializeGraph(graph);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, bytes);
  assert.ok(restored.excludedColumnSlots.has(key), '復元後も除外キーが保持される');

  const { created } = autoFillWoodColumns(restored, PROJECT, null);
  assert.equal(created.length, 0, '除外済みのside=-1は再生成されず、side=1は既存のまま（新規生成なし）');
});

test('autoFillWoodColumns（建具の袖柱・11／Minor-1）: 重なり判定はAXIS基準——既存柱の偏心（105角外壁の±7.5相当）は判定に影響しない', () => {
  const { graph } = makeWoodWallWithOpeningGraph();
  const fuseCL = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && Math.abs(cl.effectiveValue - 2000) < 1);
  assert.ok(fuseCL, '前提: 壁の梁芯CLが(y=2000)に生成されている');
  // AXIS=1700・ACTUAL=1700+(-215)=1485（袖柱side=-1の実位置x=1485と同じ）。
  // 重なり判定がACTUAL基準だと誤って重なる扱いになり-1側が省略されてしまう。
  const vCL = graph.addCenterLine(CenterLineType.VERTICAL, 1700, { labeled: true, discipline: Discipline.STRUCT });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', vCL, fuseCL, {
    dimensionStatus: 'locked', eccentricity: { x: -215, y: 0 },
  });
  const { created: allCreated } = autoFillWoodColumns(graph, PROJECT, null);
  // 対辺の壁が無い単独の壁のため、袖柱のほかにF-1の自由端2本（壁自身の両端）が付随する。
  const created = splitFreeEndColumns(graph, allCreated, [[1485, 2000], [2515, 2000]]);
  assert.equal(created.length, 2, 'AXIS基準なら重ならないため両袖とも生成される（ACTUAL基準だと-1側が誤って省略される）');
  assert.ok(created.some(c => c.woodJambRef.side === -1), 'side=-1も生成される（AXIS 1700 vs 1485は重ならない）');
});

test('autoFillWoodColumns（建具の袖柱・12／Minor-2）: wallGateが建物外と判定するCLペアでも袖柱は立つ（フットプリントゲートは掛けない）', () => {
  const { graph } = makeWoodWallWithOpeningGraph();
  // side=-1のプレースホルダCLペア（crossCL=x1(0)・axisCL=横壁の梁芯CL(2000)）を建物外と判定するゲート。
  // 3h-2・8（wallGateで外れる3h-2候補は立たない）と対で、袖柱はこの種のゲートを掛けないことを固定する。
  const gate = {
    intersectionInBuilding: (v, h) => !(v.effectiveValue === 0 && h.effectiveValue === 2000),
    spanInBuilding: () => true,
  };
  const { created: allCreated } = autoFillWoodColumns(graph, PROJECT, gate);
  // このゲートは(x=0,y=2000)を建物外と判定するため、壁自身の自由端のうち(0,2000)側はF-1でも
  // 生成されない（wallGateは自由端にも掛かる）。残る自由端(4000,2000)は生成される。
  const created = splitFreeEndColumns(graph, allCreated, [[1485, 2000], [2515, 2000]]);
  assert.equal(created.length, 2, '袖柱はwallGateを掛けない（ホスト壁が自階の下地オーナー壁＝フットプリント内のため）');
});

test('【対照】autoFillColumnsForStructure（3h-2・11）: 非在来（S造）ではaboveTieBeamsが無視される', () => {
  const steel = makeGridGraph('S造');
  addBackingWall(steel.graph, { axisValue: 2000, clStart: steel.x1, clEnd: steel.x2, isVertical: false });
  addBackingWall(steel.graph, { axisValue: 1000, clStart: steel.y1, clEnd: steel.y2, isVertical: true });
  const aboveTieBeams = [{ isVertical: true, coord: 999999, lo: 0, hi: 1 }]; // 通り芯交点方式では影響し得ない値
  const withTie = autoFillColumnsForStructure(steel.graph, PROJECT, null, [], [], aboveTieBeams);
  const steel2 = makeGridGraph('S造');
  addBackingWall(steel2.graph, { axisValue: 2000, clStart: steel2.x1, clEnd: steel2.x2, isVertical: false });
  addBackingWall(steel2.graph, { axisValue: 1000, clStart: steel2.y1, clEnd: steel2.y2, isVertical: true });
  const withoutTie = autoFillColumnsForStructure(steel2.graph, PROJECT);
  assert.equal(withTie.created.length, withoutTie.created.length);
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

    // ステップ1（下階柱分割）: 1階の壁が2階のwallSegments（自階＋1つ下の階）に含まれるため、
    // 1階に3b柱ができると2階のy0の壁線通し梁も(x0,xm)(xm,x1)の2本に分割され、元の1本(beam)は
    // 撤去される——「受梁扱いが外れて成が下がる」という結果は同じだが、対象が1本→2本に変わる。
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g2.beamMap.has(beam.id), false, '下階柱で分割され元の1本は撤去される');
    const splitBeams = g2.beams.filter(b => !b.isVertical && Math.abs(b.axisValue) < 1);
    assert.equal(splitBeams.length, 2, '分割後は2本になる');
    for (const b of splitBeams) {
      const beforeHeight = findSectionEntry(before)?.height;
      const afterHeight = findSectionEntry(b.sectionDefId)?.height;
      assert.ok(afterHeight < beforeHeight, `成が下がる: before=${beforeHeight} after=${afterHeight}`);
    }
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【統合・3h-2】recomputeStructuralForGraph: 1つ上の実体階の頭つなぎが自階の壁を横切る位置に柱が立つ（peekAboveGraph→columnSeedBeamSegments→autoFillWoodColumnsの本番配線）', async () => {
  const project = new Project('proj-3h2-recompute', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 3h-2の対象階（下階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 頭つなぎを持つ階（上階）
  project.activePlaneId = 'p1';
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

  // 2階: 頭つなぎ（縦方向、x=1820、y:-1000..1000）——1階のy=0の壁を(1820,0)で横切る。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yA = g2.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yB = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, yA, yB, { role: 'primary', beamType: '頭つなぎ' });

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y) < 1);
    assert.ok(col, '1階に3h-2柱(1820,0)が立つ（上階の頭つなぎが自階の壁を横切る位置）');
    assert.equal(col.materialType, StructuralMaterialType.WOOD);

    // 冪等: もう一度呼んでも増減しない。
    const columnCountBefore = g1.columns.length;
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g1.columns.length, columnCountBefore, '2回目は柱本数が変わらない（冪等）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 小屋伏図にも梁・柱ルールを適用する計画（ステップ6）: 最上階のaboveGraphに屋根を入れて3h-2/3iを効かせる ----
test('【統合・ステップ6】recomputeStructuralForGraph: 最上階を直接recomputeすると、屋根専用平面の軒桁(壁線方式)が最上階の壁を横切る位置に柱が立つ（peekRoofGraphAbove→columnSeedBeamSegments→autoFillWoodColumnsの本番配線）', async () => {
  const project = new Project('proj-step6-roof-above', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // 唯一の実体階＝最上階
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階（＝最上階）: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 屋根専用平面（roofForPlaneId=p1）: 壁線方式の軒桁（縦方向、role:'primary', beamType:'軒桁'、
  // x=1820、y:-1000..1000）——1階のy=0の壁を(1820,0)で横切る。
  const { graph: roofGraph } = project.addPlane(3000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, 'p1');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const xm = roofGraph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yA = roofGraph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yB = roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, yA, yB, { role: 'primary', beamType: '軒桁' });

  const peekMap = { p1: g1, roof1: roofGraph };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y) < 1);
    assert.ok(col, '最上階に3h-2柱(1820,0)が立つ（屋根の壁線方式の軒桁が自階の壁を横切る位置）');
    assert.equal(col.materialType, StructuralMaterialType.WOOD);

    // 冪等: もう一度呼んでも増減しない。
    const columnCountBefore = g1.columns.length;
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g1.columns.length, columnCountBefore, '2回目は柱本数が変わらない（冪等）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【失敗系・ステップ6】recomputeStructuralForGraph: 最上階でない実体階（1つ上に別の実体階がある）はpeekAboveGraphが優先され、屋根専用平面をpeekしない（追加peek0回）', async () => {
  const project = new Project('proj-step6-not-top', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階（roofForPlaneId=p2）
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const { graph: roofGraph } = project.addPlane(6000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, 'p2');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  let roofPeeked = false;
  const peekMap = { p1: g1, p2: g2, roof1: roofGraph };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => {
    if (plane.id === 'roof1') roofPeeked = true;
    return peekMap[plane.id] ?? null;
  };
  try {
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(roofPeeked, false, '1階（最上階でない）の再計算では屋根専用平面をpeekしない（peekAboveGraphが2階を返すため）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【統合・3h-2・変更1】recomputeStructuralForGraph: 1つ上の実体階の床梁(role:floor)の端が自階の壁を横切る位置に柱が立つ（peekAboveGraph→columnSeedBeamSegments→autoFillWoodColumnsの本番配線）', async () => {
  const project = new Project('proj-3h2-floor-recompute', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 3h-2の対象階（下階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 床梁を持つ階（上階）
  project.activePlaneId = 'p1';
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

  // 2階: 床梁（縦方向、role:'floor'、x=1820、y:-1000..1000）——1階のy=0の壁を(1820,0)で横切る。
  // beamType:'頭つなぎ'|'受梁'ではない（role:'floor'の点源への追加＝変更1が無ければ拾われない）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yA = g2.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yB = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, yA, yB, { role: 'floor', beamType: '床梁' });

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y) < 1);
    assert.ok(col, '1階に3h-2柱(1820,0)が立つ（上階の床梁の端が自階の壁を横切る位置）');
    assert.equal(col.materialType, StructuralMaterialType.WOOD);

    // 冪等: もう一度呼んでも増減しない。
    const columnCountBefore = g1.columns.length;
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g1.columns.length, columnCountBefore, '2回目は柱本数が変わらない（冪等）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- A-2（2026-09-19）: 点源の一般化（beamTypeを見ない）----
// moku3.stq「3階 X2,Y4(1820,-9100)：階段を支える梁はあるが下階に柱がない」の再現構成。
// 実際の指摘点は壁線由来の「大梁」（role:'primary', beamType:'大梁'。階段の床開口4辺由来の縁梁が
// この形で生成される）が、旧beamType限定（頭つなぎ・受梁のみ）の点源から漏れていたことが原因——
// A-2でrole:'primary'全体（beamTypeを問わない）へ一般化したことで、大梁の端が自階の壁を横切る位置にも
// 柱が立つようになる。
test('【統合・A-2】recomputeStructuralForGraph: 1つ上の実体階の壁線由来の大梁(beamType:大梁)の端が自階の壁を横切る位置に柱が立つ（moku3.stq「階段を支える梁はあるが下階に柱がない」の再現構成）', async () => {
  const project = new Project('proj-a2-mainbeam-recompute', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 3h-2の対象階（下階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 大梁（階段縁梁相当）を持つ階（上階）
  project.activePlaneId = 'p1';
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

  // 2階: 大梁（縦方向、role:'primary'、beamType:'大梁'、x=1820、y:-1000..1000）——1階のy=0の壁を
  // (1820,0)で横切る。beamType:'頭つなぎ'|'受梁'ではない（旧beamType限定の点源では拾われない）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yA = g2.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yB = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, yA, yB, { role: 'primary', beamType: '大梁' });

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y) < 1);
    assert.ok(col, '1階に3h-2柱(1820,0)が立つ（上階の壁線由来の大梁の端が自階の壁を横切る位置）');
    assert.equal(col.materialType, StructuralMaterialType.WOOD);

    // 冪等: もう一度呼んでも増減しない。
    const columnCountBefore = g1.columns.length;
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g1.columns.length, columnCountBefore, '2回目は柱本数が変わらない（冪等）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【失敗系・A-2】recomputeStructuralForGraph: 1つ上の実体階のrole:secondary（小梁）の端は自階の壁を横切っても柱を立てない（beamTypeが同名でも対象外の境界は一般化後も不変）', async () => {
  const project = new Project('proj-a2-secondary-recompute', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 2階: role:'secondary'（小梁）——大梁と同じ位置・beamTypeでも対象外（columnSeedBeamSegmentsの
  // フィルタはrole:'primary'|'floor'のみ。secondaryは一般化後も引き続き除外される）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yA = g2.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yB = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, yA, yB, { role: 'secondary', beamType: '大梁' });

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y) < 1);
    assert.ok(!col, '1階に3h-2柱(1820,0)は立たない（role:secondaryは点源から除外）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// m11・【統合・3h-2×3c-2b】: 3h-2が下階(g1)に立てた柱が、次の自階(g2)recomputeで壁線上の通し梁
// （3c-2b・columnSplitPoints）の内部分割点として働く（旧spanKeyの1本が撤去され新規2本になる）。
// 【統合・3h-2】と同じ配置（頭つなぎがg1のy=0の壁を(1820,0)で横切る）に、g2自身にもg1と同じ通り芯
// （x=0,x=3640,y=0,y=1820）を足し、wallRunSegments(g2,g1,...)で合成されるg1由来の壁線通し梁が
// g2のグラフ上にも実体化されるようにする。**頭つなぎ自身の両端の外形はemitted∪locked（フェーズAで
// 確定した壁線通し梁の候補区間＋手動固定の同材種梁。columnSupportBeamCandidatesのsegments引数）で
// 決まる**——交点を作る壁の候補区間がemittedに入っている（QA第2巡指摘: excludedBeamSlots・wallGate
// 不通過でemittedから漏れていない）場合、その壁は頭つなぎ自身の支持候補にも同時に入るため、内部の
// 分割点ではなく端点そのものに落ち着く（実データ「正味の新規柱0本」はこの帰結）。**逆に、交点を作る
// 壁の候補区間がexcludedBeamSlots・wallGate不通過でemittedに入らなければ、頭つなぎ自身の支持候補には
// 現れないため、頭つなぎは元のまま生成され、3h-2柱がその内部を素直に分割しうる**（下記の
// 【統合・3h-2】除外系テストで直接固定）。以下のテストは、交点を作る壁がemittedに入る通常経路
// （頭つなぎとは別の、その柱の位置を通る壁線上の通し梁が分割される）を検証する——これは3bが3c-2bへ
// 渡す経路（既存の3b×3c-2bテスト）と全く同じ合流点（columnSplitPointsのbelowPts）を通る。
test('【統合・3h-2×3c-2b】recomputeStructuralForGraph: 3h-2で立った下階柱が次の自階recomputeで壁線上の通し梁の内部分割点になり、旧spanKeyが撤去され新spanKeyが生成される。3回目以降は冪等', async () => {
  const project = new Project('proj-3h2-3c2b', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 3h-2の対象階（下階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 頭つなぎを持つ階（上階）
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  // 【統合・3h-2】と同じ配置——y=0の壁(x:0..3640)を頭つなぎが(1820,0)で横切る。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 2階: 1階と同じ通り芯（x=0,x=3640,y=0,y=1820）——wallRunSegments(g2,g1,...)で合成される1階の
  // 壁線通し梁のアンカー解決に使う。頭つなぎ（縦方向、x=1820、y:-1000..1000）は手動固定にして
  // 自階recomputeの撤去・relabelの対象から外す（columnSeedBeamSegmentsはdimensionStatusを見ないため
  // 3h-2の候補列挙には影響しない）。
  g2.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  g2.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  g2.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yA = g2.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yB = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  const tieBeam = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, yA, yB, { role: 'primary', beamType: '頭つなぎ' });
  tieBeam.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // 1回目: 自階(g2)は1階の壁（wallRunSegmentsで合成）から壁線通し梁(y=0,x:0..3640)を1本生成する
    // （1階にまだ柱が無いため分割されない）。
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    const wallBeamBefore = g2.beams.filter(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue) < 1);
    assert.equal(wallBeamBefore.length, 1, '前提: 1階に柱がまだ無いため壁線通し梁(y=0)は1本のまま');
    assert.deepEqual([Math.round(wallBeamBefore[0].coord1), Math.round(wallBeamBefore[0].coord2)].sort((a, b) => a - b), [0, 3640]);

    // 2回目: 1階(g1)の3h-2——2階の頭つなぎ(x=1820)が1階のy=0の壁を(1820,0)で横切る位置に新規柱。
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col3h2 = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y) < 1);
    assert.ok(col3h2, '前提: 1階に3h-2柱(1820,0)が新規に立った');

    // 3回目: 自階(g2)を再計算し直すと、3h-2柱(1820,0)がbelowPtsに加わり、壁線通し梁(y=0)が
    // columnSplitPoints（3c-2b）でその位置から分割される——旧spanKey(0..3640)は撤去され、
    // 新spanKey 2本(0..1820・1820..3640)が生成される。
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g2.beamMap.has(wallBeamBefore[0].id), false, '旧spanKey(0..3640)の壁線通し梁は撤去される');
    const splitBeams = g2.beams.filter(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue) < 1);
    assert.equal(splitBeams.length, 2, '3h-2柱(1820,0)の位置で2本に分割される');
    const xs = splitBeams.map(b => [b.coord1, b.coord2].sort((a, b2) => a - b2)).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(xs.map(([lo]) => Math.round(lo)), [0, 1820]);
    assert.deepEqual(xs.map(([, hi]) => Math.round(hi)), [1820, 3640]);
    for (const b of splitBeams) assert.equal(b.beamType, '大梁');
    // 頭つなぎ自身（手動固定）は触られない。
    assert.equal(tieBeam.beamType, '頭つなぎ');
    assert.ok(g2.beamMap.has(tieBeam.id));

    // 4回目以降（3h-2×3c-2bとも収束済み）は created0/removed0（冪等）。
    const columnCountBefore = g1.columns.length;
    const beamIdsBefore = new Set(g2.beams.map(b => b.id));
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g1.columns.length, columnCountBefore, '1階の柱本数は不変（冪等）');
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.deepEqual(new Set(g2.beams.map(b => b.id)), beamIdsBefore, '2階の梁本数・idとも不変（冪等）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// QA第2巡・(c): 頭つなぎを横切る下階壁の候補区間がexcludedBeamSlotsで除外されemittedに入らなければ、
// その壁は頭つなぎ自身の支持候補にもならない——頭つなぎは元の全長のまま生成され、3h-2柱がその内部を
// 分割しうる（上のm11テストのJSDoc「⚠不変条件」参照）。
// 配置: 1階は2部屋（0,0)-(1820,5460)・(1820,0)-(3640,5460)、中央の間仕切り壁（x=1820,y:0..5460）が
// 頭つなぎ（2階、y=2730、x:0..3640）を(1820,2730)で横切る。この間仕切り壁のフェーズA区間
// spanKey（2階のx=1820・y=0・y=5460 CLで組む）をexcludedBeamSlotsへ加えてから2階を再計算すると、
// 間仕切り壁はemittedに入らず、頭つなぎは全長(0..3640)のまま生成される（1階にまだ3h-2柱が無いため）。
test('【統合・3h-2】頭つなぎを横切る下階壁の区間がexcludedBeamSlotsなら支持に入らず、頭つなぎは3h-2柱で内部分割される（分割後も冪等）', async () => {
  const project = new Project('proj-3h2-excluded', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 3h-2の対象階（下階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 頭つなぎを持つ階（上階）
  project.activePlaneId = 'p1';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 2部屋（間仕切り壁x=1820,y:0..5460が頭つなぎを横切る壁になる）＋自階柱の起点となる
  // 「頭つなぎの起点」用の柱を1本、間仕切りとは無関係な内部位置(2700,2730)に置く。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const gx2 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  const roomA = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  const roomB = g1.addRoom(new Set([`${gx1.id}:${gy0.id}:${gx2.id}:${gy1.id}`]), 'B');
  generateRoomWallsFromOutline(g1, roomA);
  generateRoomWallsFromOutline(g1, roomB);
  const seedX = g1.addCenterLine(CenterLineType.VERTICAL, 2700, { labeled: true, discipline: Discipline.STRUCT });
  const seedY = g1.addCenterLine(CenterLineType.HORIZONTAL, 2730, { labeled: true, discipline: Discipline.STRUCT });
  const seedColumn = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', seedX, seedY, {});
  seedColumn.setDimensionStatus('locked');

  // 2階: 1階と同じ外周通り芯（頭つなぎの支持＝左右の壁線通し梁のアンカー）＋頭つなぎ自身の軸
  // アンカー(y=2730)。間仕切り(x=1820)のフェーズA区間を明示的にexcludedBeamSlotsへ加える。
  g2.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const hx1 = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  g2.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const hy0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const hy1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  g2.addCenterLine(CenterLineType.HORIZONTAL, 2730, { labeled: true, discipline: Discipline.STRUCT }); // 頭つなぎ自身の軸アンカー
  g2.excludedBeamSlots.add(spanKey(hx1, hy0, hy1));

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // 1回目: 間仕切り壁の候補区間が除外されているため、フェーズBの頭つなぎ候補は左右の壁（x=0,x=3640）
    // だけを支持にとり、全長(0..3640)のまま生成される（1階にまだ3h-2柱が無いため分割もされない）。
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    const tieBefore = g2.beams.find(b => b.beamType === '頭つなぎ');
    assert.ok(tieBefore, '前提: 頭つなぎ(y=2730)が生成される');
    assert.deepEqual([Math.round(tieBefore.coord1), Math.round(tieBefore.coord2)].sort((a, b) => a - b), [0, 3640],
      '前提: 除外された間仕切りは支持に入らないため全長のまま');

    // 2回目: 1階(g1)の3h-2——2階の頭つなぎ(y=2730)が1階の間仕切り壁(x=1820)を(1820,2730)で横切る
    // 位置に新規柱。
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const col3h2 = g1.columns.find(c => c.role !== 'foundation' && Math.abs(c.x - 1820) < 1 && Math.abs(c.y - 2730) < 1);
    assert.ok(col3h2, '前提: 1階に3h-2柱(1820,2730)が新規に立った');

    // 3回目: 自階(g2)を再計算し直すと、3h-2柱(1820,2730)がbelowPtsに加わり、頭つなぎ自身
    // （除外により支持を持たなかった軸）がcolumnSplitPoints（3c-2b）でその位置から分割される
    // ——旧spanKey(0..3640)は撤去され、新spanKey 2本(0..1820・1820..3640)とも頭つなぎになる。
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g2.beamMap.has(tieBefore.id), false, '旧spanKey(0..3640)の頭つなぎは撤去される');
    const splitTies = g2.beams.filter(b => b.beamType === '頭つなぎ');
    assert.equal(splitTies.length, 2, '3h-2柱(1820,2730)の位置で頭つなぎが2本に分割される');
    const xs = splitTies.map(b => [b.coord1, b.coord2].sort((a, b2) => a - b2)).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(xs.map(([lo]) => Math.round(lo)), [0, 1820]);
    assert.deepEqual(xs.map(([, hi]) => Math.round(hi)), [1820, 3640]);
    for (const b of splitTies) assert.equal(b.role, 'primary');

    // 4回目以降（3h-2×分割後の頭つなぎとも収束済み）は冪等——beam id集合が不変。
    const columnCountBefore = g1.columns.length;
    const beamIdsBefore = new Set(g2.beams.map(b => b.id));
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(g1.columns.length, columnCountBefore, '1階の柱本数は不変（冪等）');
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.deepEqual(new Set(g2.beams.map(b => b.id)), beamIdsBefore, '2階の梁id集合は不変（冪等）');
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
  // 対辺の壁が無い開いた形状のため、交点(1000,2000)のほかにF-1の自由端4本
  // （y=2000壁の両端・x=1000壁の両端）が付随する。
  const wTarget = splitFreeEndColumns(wood.graph, w.created, [[1000, 2000]]);
  assert.deepEqual(wTarget.map(c => `${c.x},${c.y}`), ['1000,2000']);
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

test('【Major5・裁定(a)・2026-09-18】autoFillWoodWallBeams: 自階に部屋が無い階では下階の壁由来runがゲートなしで生成される（旧wallGateと同条件のpre-existing挙動）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1)); // 部屋を1つも追加しない＝自階フットプリント未定義
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // アンカーCL（labeled）として存在させるだけでよいので変数へは受けない。
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  // 本番ではwallRunSegments(graph, belowGraph, structure)が下階の壁区間を合流させる。ここでは
  // 「自階に壁が1本も無いが、下階由来のrunだけがwallSegmentsに含まれる」状況を直接模する。
  const wallSegments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 3640 },
    { isVertical: false, coord: 3640, lo: 0, hi: 3640 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 3640 },
    { isVertical: true,  coord: 3640, lo: 0, hi: 3640 },
  ];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, wallSegments);
  assert.equal(created.length, 4,
    '自階フットプリント未定義（部屋が無い）階はゲートなしで下階由来runがそのまま4辺とも生成される');
});

// ---- F-2（2026-09-19裁定）integration: 自由端まで通し梁・土台のrunが伸びる ----
// L字（縦壁x=0,y:0..2000＋横壁y=2000,x:0..2000）は交点(0,2000)が1点しか無く、
// wallIntersectionPointsだけではx=0線のthrough-runが2点未満（run無し＝梁が1本も生成されない）。
// F-2で自由端(0,0)がrunの端点候補に加わることで、x=0線に[0,2000]のrunができ通し梁・土台が
// 自由端まで届くようになる（2026-09-19以前は0本だった）。
function makeLShapeFreeEndGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0,    clStart: y0, clEnd: y1, isVertical: true });  // 縦壁 x=0（自由端(0,0)）
  addBackingWall(graph, { axisValue: 2000, clStart: x0, clEnd: x1, isVertical: false }); // 横壁 y=2000（自由端(2000,2000)）
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  return { graph, x0, x1, y0, y1 };
}

test('【F-2統合】autoFillWoodWallBeams: 通し梁(role:primary)のrunが自由端(0,0)まで伸びる（旧仕様では交点1点のみでrun無し＝0本）', () => {
  const { graph, x0, y0, y1 } = makeLShapeFreeEndGraph();
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs);
  const vBeam = created.find(b => b.isVertical && Math.abs(b.axisValue - x0.value) < 1);
  assert.ok(vBeam, `x=0線に通し梁が自由端まで生成されるはず（実際:${created.map(b => `${b.isVertical}:${b.axisValue}`)}）`);
  assert.deepEqual([vBeam.clStart.id, vBeam.clEnd.id].sort(), [y0.id, y1.id].sort(), '自由端(y=0)から交点(y=2000)まで通し1本');
  assert.equal(vBeam.role, 'primary');
  assert.equal(vBeam.beamType, '大梁');
});

test('【F-2統合・失敗系】autoFillWoodWallBeams: 非在来（framingを持たない主構造）は自由端まで伸びる通し梁を生成しない', () => {
  const { graph } = makeLShapeFreeEndGraph();
  graph.structureOverride = 'S造';
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.deepEqual(created, [], '非在来はautoFillWoodWallBeams自体が何もしない（rules.framing無し）');
});

// ---- F-1×F-3是正 統合テスト（2026-09-19裁定）: 実際のwallGeneration.js出力（階段開口辺の
// 除外で自由端が生じる本物のシナリオ）で、壁の再生成の前後（wrapFreeEnds:false=旧い保存済み壁
// 相当／true=柱包みで延長済み）に関わらず柱位置が不変であることを固定する。
// フィクスチャはfinish/wallGeneration.test.jsのmakeSingleRoomGraphWithTopOpeningと同型
// （1辺1000mm四方の部屋、上辺(y=0)を階段開口として除外——左右の縦壁の上端が自由端になる）。
function buildRoomWithFreeEndWalls(wrapFreeEnds) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  const stairOpenings = [{ isVertical: false, value: 0, lo: 0, hi: 1000 }]; // 上辺(y=0)
  generateRoomWallsFromOutline(graph, room, { wallBase: 120, wallFinish: 12.5, wrapFreeEnds }, stairOpenings);
  return { graph, x0, x1, y0 };
}

test('【F-1×F-3是正・統合】autoFillWoodColumns: wallGeneration.jsの本物の自由端（開口辺除外）でも、柱包みの延長有無(wrapFreeEnds)に関わらず柱は設計上の端（CL位置）に立つ', () => {
  const flush = buildRoomWithFreeEndWalls(false);
  const extended = buildRoomWithFreeEndWalls(true);
  const flushCols = fillWoodColumns(flush.graph).created.map(c => `${c.x},${c.y}`).sort();
  const extendedCols = fillWoodColumns(extended.graph).created.map(c => `${c.x},${c.y}`).sort();
  assert.deepEqual(extendedCols, flushCols,
    `柱包み延長（wrapFreeEnds:true）の有無で柱位置が変わってはいけない（flush:${flushCols}, extended:${extendedCols}）`);
  // 前提: 自由端(0,0)・(1000,0)に柱が立ち、y=0（design CL。物理端ではない）に居ること。
  assert.ok(flushCols.includes('0,0') && flushCols.includes('1000,0'),
    `自由端(0,0)・(1000,0)に柱が立つはず（実際:${flushCols}）`);
});

test('【F-2統合】autoFillWoodSillBeams: 土台(role:sill)のrunが自由端(0,0)まで伸びる（旧仕様では交点1点のみでrun無し＝0本）', () => {
  const { graph, x0, y0, y1 } = makeLShapeFreeEndGraph();
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const vSill = created.find(b => b.isVertical && Math.abs(b.axisValue - x0.value) < 1);
  assert.ok(vSill, `x=0線に土台が自由端まで生成されるはず（実際:${created.map(b => `${b.isVertical}:${b.axisValue}:${b.role}`)}）`);
  assert.deepEqual([vSill.clStart.id, vSill.clEnd.id].sort(), [y0.id, y1.id].sort(), '自由端(y=0)から交点(y=2000)まで通し1本');
  assert.equal(vSill.role, 'sill');
});

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

test('【裁定1・2026-09-18】autoFillWoodWallBeams: wallGate引数（自階＋直下全階のAND）はフェーズA・Bとも使わない——下階が屋外部屋(false)扱いでも自階に床があれば生成', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  // 旧仕様なら「下階がポーチ等で建物外」を模すこのgateで全て弾かれていたはずだが、現仕様は
  // この引数自体を使わないため生成に一切影響しない（QA指摘: 免除で通っていた19区間中15区間が
  // 自階に部屋の無い位置だったため、ゲートを自階フットプリント単独へ差し替えた）。
  const gateAllOut = { intersectionInBuilding: () => false, spanInBuilding: () => false };
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, gateAllOut);
  assert.ok(created.length > 0, 'wallGate引数がfalseを返しても自階フットプリント内なら生成される');
});

test('【裁定1】autoFillWoodWallBeams: 自階フットプリント外の壁線は下階柱が両端にあっても生成しない', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph(); // roomA/roomBはy:0..3640の範囲のみ（自階フットプリントの権威）
  // 部屋の外（y=10000）に独立した壁の矩形を作る——この位置はどの部屋にも属さないため自階フットプリント外。
  const yA = graph.addCenterLine(CenterLineType.HORIZONTAL, 9000,  { labeled: true, discipline: Discipline.STRUCT });
  const yB = graph.addCenterLine(CenterLineType.HORIZONTAL, 11000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 10000, clStart: x0, clEnd: x1, isVertical: false });
  addBackingWall(graph, { axisValue: 0,     clStart: yA,  clEnd: yB,  isVertical: true });
  addBackingWall(graph, { axisValue: 3640,  clStart: yA,  clEnd: yB,  isVertical: true });
  const segs = selfWallSegments(graph);
  const belowColumns = [
    { x: 0, y: 10000, axisX: 0, axisY: 10000, role: 'standard' },
    { x: 3640, y: 10000, axisX: 3640, axisY: 10000, role: 'standard' },
  ];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.equal(created.filter(b => !b.isVertical && Math.abs(b.axisValue - 10000) < 1).length, 0,
    '自階フットプリント外（部屋の無い位置）は下階柱が両端にあっても生成しない');
});

test('【裁定1】autoFillWoodWallBeams: 自階フットプリント内なら下階に柱が無くても壁線上の通し梁が生成される（moku3 y=-11704相当）', () => {
  const { graph, y0 } = makeTwoRoomGraph(); // roomA/roomBの壁線は自階フットプリント内
  const segs = selfWallSegments(graph);
  // belowColumns省略（[]既定）——下階柱の有無は生成条件にしない。
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(top.length > 0, '自階フットプリント内なら下階柱が無くても壁線上の通し梁が生成される');
});

// QA第2巡・Major1: 旧実装（部屋外に縦「壁」2本だけを置く構成）は、壁が自由端のまま（交差する
// 横壁が無くwallIntersectionPointsが0件）でrunが立たず、phase Aのemittedが空のまま——phase Bの
// columnSupportBeamCandidatesが支持方向を1つも見つけられず候補自体が発生しない「空振り」だった
// （selfGate=nullへ変異しても緑のまま、という指摘どおり）。Major5テスト（3h・指摘B）と同型で、
// 「横梁2本（locked。phase Aを経由させず直接lockedSegmentsへ載せる）＋その間の下階柱1点」を
// 部屋外座標へ平行移動した構成に差し替える——これなら支持方向が実在し、selfGateの有無だけが
// 生成・非生成を分ける。
test('【裁定1・失敗系】autoFillWoodWallBeams（フェーズB）: 自階フットプリント外の候補は頭つなぎ・受梁も生成しない', () => {
  const { graph } = makeTwoRoomGraph(); // roomA(x:0..3640,y:0..3640)が自階フットプリントの権威
  const xLo = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const xHi = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT }); // 候補軸(x=1820)のアンカーCL
  // 部屋の外（y=9000/11000。roomAのy範囲0..3640から大きく外れる）に支持2本を置く。
  const yLo = graph.addCenterLine(CenterLineType.HORIZONTAL, 9000,  { labeled: true, discipline: Discipline.STRUCT });
  const yHi = graph.addCenterLine(CenterLineType.HORIZONTAL, 11000, { labeled: true, discipline: Discipline.STRUCT });
  const hLo = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yLo, false, xLo, xHi, { role: 'primary' });
  const hHi = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yHi, false, xLo, xHi, { role: 'primary' });
  hLo.setDimensionStatus('locked');
  hHi.setDimensionStatus('locked');
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 10000, axisX: 1820, axisY: 10000, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.equal(created.filter(b => b.beamType === '頭つなぎ').length, 0,
    '自階フットプリント外の位置は頭つなぎも生成しない');
});

test('【裁定1・対照】autoFillWoodWallBeams（フェーズB）: 同じ構成を自階フットプリント内に置けば頭つなぎが生成される', () => {
  const { graph } = makeTwoRoomGraph(); // roomA(x:0..3640,y:0..3640)が自階フットプリントの権威
  const xLo = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const xHi = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT }); // 候補軸(x=1820)のアンカーCL
  // 直前の【裁定1・失敗系】と同型の構成をroomAの内側（y:500/1500）へ平行移動しただけ。
  const yLo = graph.addCenterLine(CenterLineType.HORIZONTAL, 500,  { labeled: true, discipline: Discipline.STRUCT });
  const yHi = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: true, discipline: Discipline.STRUCT });
  const hLo = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yLo, false, xLo, xHi, { role: 'primary' });
  const hHi = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yHi, false, xLo, xHi, { role: 'primary' });
  hLo.setDimensionStatus('locked');
  hHi.setDimensionStatus('locked');
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1000, axisX: 1820, axisY: 1000, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.ok(created.filter(b => b.beamType === '頭つなぎ').length > 0,
    '自階フットプリント内なら同じ構成で頭つなぎが生成される（失敗系テストが空振りでないことの対照）');
});

// ---- A-1（2026-09-19）: フットプリント境界での分割（中点判定の粒度依存の解消）----
// 2026模試.stq「2階 V x=0 [-10794..-7280]」の再現構成の縮小版: フットプリントの外まで伸びる
// run（下階由来の壁を想定）を、footprint境界(y=0)より外側にある下階柱1点だけで分割すると、
// 分割後の区間[下階柱..run上端]の**中点**がfootprintの外に出てしまい、区間の一部（footprint内側の
// [0,1000]）が丸ごと落ちる（A-1が無いと再現する退行）。A-1はfootprint境界そのもの（y=0の通り芯）を
// 分割点へ先に足すことで、[下階柱..y=0]（外・破棄）と[y=0..run上端]（内・残る）に厳密に分かれる。
function makeFootprintBoundaryRunGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT }); // footprint境界（room上端）
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // room下端
  const yCol = graph.addCenterLine(CenterLineType.HORIZONTAL, -1500, { labeled: true, discipline: Discipline.STRUCT }); // 下階柱のアンカー
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, -3000, { labeled: true, discipline: Discipline.STRUCT }); // runの遠端
  // room（x:0..2000, y:0..1000）だけがfootprintの権威——y<0は建物外。
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  // wallSegmentsは自階の壁生成を経由せず直接与える（下階由来の壁がfootprintを超えて伸びる状況を模す。
  // 【Major5】テストと同型の「4辺の矩形」構成で、x=0のrunが[-3000,1000]に通しでまとまるようにする）。
  const wallSegments = [
    { isVertical: false, coord: -3000, lo: 0, hi: 2000 },
    { isVertical: false, coord: 1000,  lo: 0, hi: 2000 },
    { isVertical: true,  coord: 0,     lo: -3000, hi: 1000 },
    { isVertical: true,  coord: 2000,  lo: -3000, hi: 1000 },
  ];
  const belowColumns = [{ x: 0, y: -1500, axisX: 0, axisY: -1500, role: 'standard' }];
  return { graph, x0, y0, y1, yCol, yFar, wallSegments, belowColumns };
}

test('【A-1】autoFillWoodWallBeams: footprint境界より外側の下階柱で分割しても、境界の内側[0,1000]の区間は落ちない', () => {
  const { graph, wallSegments, belowColumns } = makeFootprintBoundaryRunGraph();
  const { created } = autoFillWoodWallBeams(graph, PROJECT, wallSegments, null, belowColumns);
  const onX0 = created.filter(b => b.isVertical && Math.abs(b.axisValue - 0) < 1);
  const inside = onX0.find(b => {
    const lo = Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
    const hi = Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
    return Math.abs(lo - 0) < 1 && Math.abs(hi - 1000) < 1;
  });
  assert.ok(inside, 'footprint境界(y=0)で切られ、内側[0,1000]の区間が生成される（分割粒度に依らず残る）');
  const spansOutside = onX0.some(b => {
    const lo = Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
    return lo < -1 && lo > -1499; // -1500(下階柱)より内側かつ0より外（[-1500,1000]のような境界跨ぎ区間）
  });
  assert.ok(!spansOutside, '境界をまたいだままの区間（外側を含む）は残らない');
});

test('【Minor・QA2026-09-19】footprintBreakPoints: ドラッグ中（pendingDelta≠0）の境界CLでも分割点はeffectiveValueに乗る', () => {
  const { graph, wallSegments, belowColumns, y0 } = makeFootprintBoundaryRunGraph();
  y0.pendingDelta = 50; // ドラッグ中の未確定変位（確定前）——分割点はvalue(0)ではなくeffectiveValue(50)を使うべき
  const { created } = autoFillWoodWallBeams(graph, PROJECT, wallSegments, null, belowColumns);
  const onX0 = created.filter(b => b.isVertical && Math.abs(b.axisValue - 0) < 1);
  const boundaries = onX0.flatMap(b => [b.clStart.effectiveValue, b.clEnd.effectiveValue]);
  assert.ok(boundaries.some(v => Math.abs(v - 50) < 1), `分割点にy0のeffectiveValue(50)が使われていない（実際: ${boundaries}）`);
  assert.ok(!boundaries.some(v => Math.abs(v - 0) < 1), 'y0のvalue(0)そのものは分割点に使われない');
});

test('【失敗系・A-1】autoFillWoodWallBeams: footprint境界を挟まない区間（外側のみ）は従来どおり生成しない', () => {
  const { graph, wallSegments, belowColumns, yFar } = makeFootprintBoundaryRunGraph();
  const { created } = autoFillWoodWallBeams(graph, PROJECT, wallSegments, null, belowColumns);
  const outsideOnly = created.some(b => b.isVertical && Math.abs(b.axisValue - 0) < 1
    && Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) <= yFar.value + 1);
  assert.ok(!outsideOnly, 'footprint境界の外側だけの区間([-3000,-1500]相当)は生成されない（従来どおり）');
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
  assert.equal(created.length, 0);
  assert.deepEqual(removed, []);
  assert.ok(graph.beamMap.has(gridAuto.id), '壁が無い階の既存梁は残る');
});

test('【失敗系】autoFillWoodWallBeams: どの通り芯・梁芯・中心線にも解決できない壁区間は例外を投げず無視する', () => {
  const { graph } = makeGridGraph();
  // 通り芯・梁芯・意匠中心線のいずれとも一致しない孤立した壁区間（アンカー解決不能）。
  const wallSegments = [{ isVertical: false, coord: 99999, lo: 0, hi: 1000 }];
  assert.doesNotThrow(() => {
    const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, wallSegments);
    assert.equal(created.length, 0);
    assert.deepEqual(removed, []);
  });
});

test('【失敗系】autoFillWoodWallBeams: 軸（通り）自体は解決できても、run の端（走行方向）がどの通り芯・梁芯・意匠中心線にも解決できなければ例外を投げず生成せず、CLも新設しない（既存の「軸自体が解決不能」テストとの対照）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 軸(y=0)には通り芯がある。runの走行方向の端はx=0側にだけ通り芯があり、x=3640側には通り芯・梁芯・
  // 意匠中心線のいずれも無い（交点を作るための縦壁だけを置き、CLは意図的に置かない）。
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 0,   { labeled: true, discipline: Discipline.STRUCT });
  const wallSegments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 3640 }, // 横壁本体（軸=y0は解決できる）
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 }, // 左端の縦壁（交点用。x=0はCLあり）
    { isVertical: true,  coord: 3640, lo: 0, hi: 1000 }, // 右端の縦壁（交点用。x=3640はCLなし＝アンカー解決不能）
  ];
  const clCountBefore = graph.centerLines.length;
  assert.doesNotThrow(() => {
    const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, wallSegments);
    assert.equal(created.length, 0, 'runの端が解決不能なら丸ごと生成しない');
    assert.deepEqual(removed, []);
  });
  assert.equal(graph.centerLines.length, clCountBefore, '新しいCLは作らない（アンカー解決不能な端に新設しない規律）');
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

// ---- autoFillWoodWallBeams（ステップ3c-2b: 下階柱の位置でrunを分割する。ユーザー裁定2026-09-16）----
test('autoFillWoodWallBeams（3c-2b・1）: 下階柱1本でrunが2本に分割され、端CLは柱位置、両方role:primaryで別spanKey', () => {
  const { graph, x0, x1, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 2, '下階柱1本で2本に分割される');
  const spans = top.map(b => [b.clStart.id, b.clEnd.id].sort()).sort();
  assert.deepEqual(spans, [[x0.id, x1.id].sort(), [x1.id, x2.id].sort()].sort());
  assert.ok(top.every(b => b.role === 'primary'));
  const keys = top.map(b => spanKey(b.axisCL, b.clStart, b.clEnd));
  assert.notEqual(keys[0], keys[1], '別spanKey');
});

test('autoFillWoodWallBeams（3c-2b・2）: 冪等（同じbelowColumnsで2回目はcreated0・removed0）', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'standard' }];
  autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const second = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0]);
});

test('autoFillWoodWallBeams（3c-2b・3）: 既存の全長auto梁（分割前の旧方式）は撤去され、分割後の2本が生成される（移行専用処理は無し）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const stale = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'primary' });
  const belowColumns = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'standard' }];
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.deepEqual(removed, [stale.id], '旧・全長梁のspanKeyはもう候補に無いため撤去される');
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 2);
});

test('【失敗系】autoFillWoodWallBeams（3c-2b・4）: 手動固定した全長梁があれば分割後の区間は幾何的重なりで生成せず、固定梁を保持する', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'primary' });
  locked.setDimensionStatus('locked');
  const belowColumns = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 0, '手動固定の全長梁と幾何的に重なる区間は生成しない');
  assert.ok(graph.beamMap.has(locked.id), '固定梁は保持される');
});

test('【対照】autoFillWoodWallBeams（QA F2）: 下階柱が無い（分割されない）runでは幾何的重なりガードを効かせず、旧来どおりspanKey占有だけで判定する', () => {
  // x0..x1(3640)にだけ手動固定した梁を置き、run全長(x0..x2=7280)はbelowColumns=[]で分割されない
  // （cls.length===2）。旧spanKeyオンリーの規律なら、固定梁とspanKeyが異なるx0..x2は生成される
  // （F1以前のlockedFullBeamOverlapを分割runにも適用すると、この幾何的重なりで見送られてしまっていた）。
  const { graph, x0, x1, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  locked.setDimensionStatus('locked');
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, []);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 1, '非分割runは幾何的重なりガードの対象外＝x0..x2は生成される（旧来どおり）');
  assert.deepEqual([top[0].clStart.id, top[0].clEnd.id].sort(), [x0.id, x2.id].sort());
  assert.ok(graph.beamMap.has(locked.id), '固定梁(x0..x1)も残る');
});

test('autoFillWoodWallBeams（3c-2b・5）: run全長のキーがexcludedBeamSlotsにあれば分割後の区間を1本も生成しない', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  graph.excludedBeamSlots.add(spanKey(y0, x0, x2)); // ユーザーが分割前の1本を丸ごと削除済みという想定
  const belowColumns = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.equal(created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1).length, 0, '全長キー除外で分割後も生成しない');
});

test('【対照】autoFillWoodWallBeams（3c-2b・5b）: 分割後の区間キー単体の除外は、その区間だけ生成しない（もう一方は生成される）', () => {
  const { graph, x0, x1, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  graph.excludedBeamSlots.add(spanKey(y0, x0, x1)); // 分割後の片方（x0..x1）だけ明示削除済み
  const belowColumns = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 1, '除外されていないもう一方(x1..x2)だけ生成される');
  assert.deepEqual([top[0].clStart.id, top[0].clEnd.id].sort(), [x1.id, x2.id].sort());
});

test('【失敗系】autoFillWoodWallBeams（3c-2b・6）: アンカー解決できない下階柱は分割点にせず隣とつなぐ。新しいCLも作らない', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const clCountBefore = graph.centerLines.length;
  const belowColumns = [{ x: 2000, y: 0, axisX: 2000, axisY: 0, role: 'standard' }]; // x=2000には通り芯・梁芯・意匠中心線が無い
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 1, 'アンカー解決できない分割点は隣とつながり1本のまま');
  assert.deepEqual([top[0].clStart.id, top[0].clEnd.id].sort(), [x0.id, x2.id].sort());
  assert.equal(graph.centerLines.length, clCountBefore, '新しいCLは作らない（柱アンカーと共有する述語のため）');
});

test('【失敗系】autoFillWoodWallBeams（3c-2b・7）: role:foundation（杭）の下階柱は分割点にしない', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'foundation' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 1, '杭は分割点にしない');
  assert.deepEqual([top[0].clStart.id, top[0].clEnd.id].sort(), [x0.id, x2.id].sort());
});

test('【対照】autoFillBeamsForStructure（3c-2b・8）: S造（beamPlacement:gridEdges）はbelowColumnsを渡しても無視される', () => {
  const steel = makeGridGraph('S造'); // 4000角の通り芯グリッド（x1,x2,y1,y2）
  const belowColumns = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const withBelow = autoFillBeamsForStructure(steel.graph, PROJECT, 'primary', null, [], belowColumns);
  const without = autoFillBeamsForStructure(makeGridGraph('S造').graph, PROJECT, 'primary', null, [], []);
  assert.equal(withBelow.created.length, without.created.length, 'S造は従来どおり通り芯グリッド辺（beamPlacement:gridEdges）でbelowColumnsは読まない');
  assert.equal(withBelow.created.length, 4, '4000角グリッドの辺4本');
});

test('【統合・3c×3d】autoFillWoodWallBeams→autoFillWoodBeamDepths: 3640のrunが中間(1820)の下階柱で分割されると、各梁は単一区間1820として成を引く', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,   { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room);
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 0, axisX: 1820, axisY: 0, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const top = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(top.length, 2, '3640のrunが1820で2本に分割される');
  autoFillWoodBeamDepths(graph, PROJECT, belowColumns);
  for (const b of top) {
    assert.equal(b.sectionDefId, 'WOOD-120x120', '各梁は単一区間1820・荷重なし＝成120（3dは変更していないので分割後も同じ述語で支持点を数える）');
  }
});

// ---- autoFillWoodWallBeams（ステップ3h: 頭つなぎ・受梁。下階柱／自階柱を両端支持する梁の生成）----
// makeTwoRoomGraph（x0=0,x1=3640,x2=7280,y0=0,y1=3640）の壁線通し梁（top:y0 x0..x2 / bottom:y1 x0..x2 /
// left:x0 y0..y1 / middle:x1 y0..y1 / right:x2 y0..y1）が支持集合になる。roomA内(x:0..3640,y:0..3640)の
// 点(1820,1820)は縦横どちらも支持間3640で同長のため横梁(isVertical:false)が採用され、支持はleft(x0)・
// middle(x1)＝候補区間[x0,x1]になる（columnSupportBeamCandidatesの「同長は横梁優先」テストと同じ幾何）。
test('autoFillWoodWallBeams（3h・1）: 下階柱の直上に頭つなぎ（beamType:頭つなぎ、両端CLは支持梁のaxisCLそのもの）が生成される', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const ties = created.filter(b => b.beamType === '頭つなぎ');
  assert.equal(ties.length, 1, '頭つなぎが1本生成される');
  const tie = ties[0];
  assert.equal(tie.role, 'primary');
  assert.equal(tie.isVertical, false, '縦横同長は横梁を優先');
  assert.equal(tie.axisCL, y1820, '軸CLは通り芯y=1820');
  assert.equal(tie.clStart, x0, '始端CLはleft壁のaxisCLそのもの（座標からの引き直しではない）');
  assert.equal(tie.clEnd, x1, '終端CLはmiddle壁のaxisCLそのもの');
  assert.equal(tie.materialType, StructuralMaterialType.WOOD);
});

test('autoFillWoodWallBeams（3h・2）: 自階柱の直下に受梁（beamType:受梁）が生成され、2回目は増減0、柱を消すと撤去される', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const x1820 = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1820, y1820, {});
  const segs = selfWallSegments(graph);
  const first = autoFillWoodWallBeams(graph, PROJECT, segs);
  const carriers = first.created.filter(b => b.beamType === '受梁');
  assert.equal(carriers.length, 1, '受梁が1本生成される');
  const carrier = carriers[0];
  assert.equal(carrier.role, 'primary');
  assert.equal(carrier.isVertical, false);
  assert.equal(carrier.clStart, x0);
  assert.equal(carrier.clEnd, x1);

  const second = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0], '2回目は created0・removed0（冪等）');

  graph.removeColumn(column.id);
  const third = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.ok(third.removed.includes(carrier.id), '自階柱を消すと受梁は候補から外れ撤去される');
  assert.equal(graph.beamMap.has(carrier.id), false);
});

test('autoFillWoodWallBeams（3h・3）: 内部にアンカー解決可能な下階柱があれば頭つなぎもそこで分割される（3c-2bと同一関数）', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const x1820 = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y1820c = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  const ties = created.filter(b => b.beamType === '頭つなぎ');
  assert.equal(ties.length, 2, '下階柱位置(x=1820)で2本に分割される');
  const spans = ties.map(b => [b.clStart.id, b.clEnd.id].sort()).sort();
  assert.deepEqual(spans, [[x0.id, x1820.id].sort(), [x1820.id, x1.id].sort()].sort());
  assert.ok(ties.every(b => b.axisCL === y1820c));
});

test('autoFillWoodWallBeams（3h・3b）: 受梁の両端CLは支持梁のaxisCLそのもの——支持梁が偏心していて座標(axisValue)と一致しなくても座標から引き直さない', () => {
  // 2000×2000の単純なbay。手動固定(locked)の4辺で候補計算の支持集合を作る（Phase Aの壁線検出を経由
  // させない＝lockedSegments経由の支持であることを固定する）。left(x=0)だけ偏心30（axisValue=30）を
  // 持たせ、座標ベースで端点CLを引き直すと x=30 にはCLが無いため解決できないことを利用する。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const top    = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  const bottom = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x0, x1, { role: 'primary' });
  const left   = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, true,  y0, y1, { role: 'primary', eccentricity: 30 });
  const right  = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, true,  y0, y1, { role: 'primary' });
  for (const b of [top, bottom, left, right]) b.setDimensionStatus('locked');
  assert.equal(left.axisValue, 30, '前提: leftのaxisValueは偏心込みで30（axisCL.effectiveValue=0とは一致しない）');

  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, yMid, {}); // 自階柱(1000,1000)
  // wallSegmentsは非空にするためのダミー（どの線とも交わらずPhase Aは何も生成しない）。
  const { created } = autoFillWoodWallBeams(graph, PROJECT, [{ isVertical: false, coord: 99999, lo: 0, hi: 1000 }]);
  const carriers = created.filter(b => b.beamType === '受梁');
  assert.equal(carriers.length, 1, '横方向(支持間1970)が縦方向(支持間2000)より短く採用される');
  assert.equal(carriers[0].clStart, x0, '始端CLはleftのaxisCLそのもの（座標30ではなくCL自体）');
  assert.equal(carriers[0].clEnd, x1);
});

test('【Major5・2026-09-18】autoFillWoodWallBeams（3h・指摘B）: 延長候補の端点CLは、重なった既存梁の端点CLオブジェクトそのものを使う', () => {
  // 縦方向の支持窓[y=0,y=2000]（横梁2本、手動固定）の内側、x=2000の同軸に既存の手動固定梁
  // [y=100,y=2000]が既にある。自階柱は(2000,100)——既存梁の端(lo=100)に一致するが無支持
  // （supportPoints省略）のため候補評価へ進み、Pを含む側[0,100]へトリムした延長候補になる
  // （横方向は支持梁が無く候補外＝縦方向だけが候補）。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const xAxis = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const xLo   = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const xHi   = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const yLo   = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const yA    = graph.addCenterLine(CenterLineType.HORIZONTAL, 100,  { labeled: true, discipline: Discipline.STRUCT });
  const yHi   = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const hLo = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yLo, false, xLo, xHi, { role: 'primary' });
  const hHi = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yHi, false, xLo, xHi, { role: 'primary' });
  const existing = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xAxis, true, yA, yHi, { role: 'primary' });
  for (const b of [hLo, hHi, existing]) b.setDimensionStatus('locked');
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xAxis, yA, {}); // 自階柱(2000,100)

  const { created } = autoFillWoodWallBeams(graph, PROJECT, [{ isVertical: false, coord: 99999, lo: 0, hi: 1000 }]);
  const carriers = created.filter(b => b.beamType === '受梁');
  assert.equal(carriers.length, 1, '延長候補が1本生成される');
  const carrier = carriers[0];
  assert.equal(carrier.clEnd, existing.clStart, 'clEndは重なった既存梁(existing)のclStart(x=100側CL)そのもの（参照一致）');
  assert.equal(carrier.clStart, yLo, 'clStartは支持梁hLoのaxisCLそのもの');
  assert.equal(carrier.axisCL, xAxis);
  assert.equal(Math.min(carrier.clStart.effectiveValue, carrier.clEnd.effectiveValue), 0);
  assert.equal(Math.max(carrier.clStart.effectiveValue, carrier.clEnd.effectiveValue), 100);
  assert.ok(graph.beamMap.has(existing.id), '既存梁(existing)自体は変更されず残る');
  assert.equal(existing.clStart, yA, '既存梁の端点は書き換わらない（spanKey不変）');
});

test('【失敗系】autoFillWoodWallBeams（3h・4a）: 区間キーがexcludedBeamSlotsにあれば頭つなぎを生成しない', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  graph.excludedBeamSlots.add(spanKey(y1820, x0, x1)); // ユーザーが既に削除済みという想定
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.equal(created.filter(b => b.beamType === '頭つなぎ').length, 0, '除外スロットには生成しない');
});

test('【失敗系】autoFillWoodWallBeams（3h・4b）: 分割された頭つなぎでも、run全長のキーがexcludedBeamSlotsにあれば分割後の区間を1本も生成しない', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  graph.excludedBeamSlots.add(spanKey(y1820, x0, x1)); // 分割前の全長キー（x0..x1）を丸ごと削除済み
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.equal(created.filter(b => b.beamType === '頭つなぎ').length, 0, '全長キー除外で分割後の2区間とも生成しない');
});

test('【裁定1・2026-09-18】autoFillWoodWallBeams（3h・5改）: wallGate引数はフェーズBでも使わない——falseを返しても自階フットプリント内なら頭つなぎが生成される', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];
  const gate = {
    intersectionInBuilding: () => true,
    spanInBuilding: (axisCL, isVertical, startCL, endCL) => !(startCL === x0 && endCL === x1),
  };
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, gate, belowColumns);
  assert.ok(created.some(b => b.beamType === '頭つなぎ'), 'wallGate引数がfalseを返しても自階フットプリント内なら頭つなぎが生成される');
  assert.ok(created.some(b => b.beamType === '大梁'), '壁線通し梁も生成される');
});

test('【失敗系】autoFillWoodWallBeams（3h・6）: 候補スロットの占有物が手動固定(locked)なら頭つなぎを生成せず、占有物も撤去しない', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1820, false, x0, x1, { role: 'secondary', beamType: '小梁' });
  locked.setDimensionStatus('locked');
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.equal(created.filter(b => b.beamType === '頭つなぎ').length, 0, '手動固定を巻き込んで重複生成しない');
  assert.deepEqual(removed, []);
  assert.ok(graph.beamMap.has(locked.id), '手動固定の梁は保持される');
});

test('【対照】autoFillWoodWallBeams（3h・7）: 非在来（S造）は頭つなぎ・受梁を生成しない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = 'S造';
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const roomA = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  const roomB = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');
  generateRoomWallsFromOutline(graph, roomA);
  generateRoomWallsFromOutline(graph, roomB);
  const { created } = autoFillWoodWallBeams(graph, PROJECT, selfWallSegments(graph));
  assert.equal(created.length, 0, 'S造はrules.framingを持たないため何もしない（フェーズBも含め早期return）');
});

test('autoFillWoodWallBeams（3h・8）: 冪等性の核——前回生成した頭つなぎ自身は支持集合に数えず、別の下階柱の候補計算は毎回同じ結果になる（チャーン防止）', () => {
  // makeTwoRoomGraphの壁線通し梁(top/bottom/left/middle/right)のみを支持集合の基礎にする。
  // 1回目: 下階柱A(1820,1820)だけで頭つなぎT1(y=1820, x0..x1)が生成される（3h・1と同じ幾何）。
  // 2回目: 下階柱B(1820,2730)を追加。T1が支持集合に数えられる（バグ）と、Bの縦方向候補
  // （支持=T1(y=1820)〜bottom(y=3640)、長さ1820）が横方向（支持=left〜middle、長さ3640）より短くなり
  // 縦方向が採用されてしまう——正しくはT1を数えないため両方向とも長さ3640で同長・横梁優先のまま。
  const { graph, x0, x1 } = makeTwoRoomGraph();
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const segs = selfWallSegments(graph);
  const belowA = { x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' };
  const first = autoFillWoodWallBeams(graph, PROJECT, segs, null, [belowA]);
  const t1 = first.created.find(b => b.beamType === '頭つなぎ');
  assert.ok(t1, '前提: 1回目でT1(y=1820)が生成される');

  graph.addCenterLine(CenterLineType.HORIZONTAL, 2730, { labeled: true, discipline: Discipline.STRUCT });
  const belowB = { x: 1820, y: 2730, axisX: 1820, axisY: 2730, role: 'standard' };
  const second = autoFillWoodWallBeams(graph, PROJECT, segs, null, [belowA, belowB]);
  const t2 = second.created.find(b => b.axisValue === 2730 && b.beamType === '頭つなぎ');
  assert.ok(t2, '下階柱Bの頭つなぎがy=2730の横梁として生成される（T1を支持に数えていれば縦梁になるか生成されない）');
  assert.equal(t2.isVertical, false);
  assert.equal(t2.clStart, x0);
  assert.equal(t2.clEnd, x1);
  assert.ok(graph.beamMap.has(t1.id), 'T1自身は2回目でも残る');
});

// ---- B1（QAブロッカー・2026-09-18裁定案(a)）: 占有物が既にrole:'primary'でもbeamTypeが今回の
// 生成意図と食い違っていれば、撤去→再生成ではなくin-placeでラベルだけ揃える ----
test('autoFillWoodWallBeams（3h・9a・B1）: 候補区間に旧autoの大梁が居座っていると、撤去→再生成せずbeamTypeが頭つなぎへin-place relabelされ、2回目は変化0', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  // 旧方式・別配線などで残った「本来は頭つなぎになるべき」auto大梁を模す（makeTwoRoomGraphのy=1820には
  // 実壁が無いため、フェーズAはこの位置に触れない＝フェーズBだけがこのspanKeyへ到達する）。
  const stale = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1820, false, x0, x1, { role: 'primary', beamType: '大梁' });
  assert.equal(stale.dimensionStatus, 'auto', '前提: 自動生成分（撤去対象になりうる）');
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];

  const first = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.equal(first.created.filter(b => b.axisCL === y1820 && !b.isVertical).length, 0, '既存role:primaryが占有済みのため新規生成しない');
  assert.deepEqual(first.removed, [], '撤去もしない（撤去→再生成ではなくin-place）');
  assert.ok(graph.beamMap.has(stale.id), '同じidのまま残る');
  assert.equal(stale.beamType, '頭つなぎ', 'beamTypeがin-placeで頭つなぎへ揃う');
  assert.equal(stale.clStart, x0, 'clStart・clEnd・axisCLは不変（座標からの引き直しではない）');
  assert.equal(stale.clEnd, x1);
  assert.equal(stale.axisCL, y1820);

  const second = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0], '2回目はbeamTypeが既に一致するためno-op（冪等）');
  assert.equal(stale.beamType, '頭つなぎ');
});

// QA第2巡・(a): 9aの逆方向——壁ができてフェーズAの候補区間になった位置に残る auto の頭つなぎが
// 大梁へin-place relabelされることを固定する（relabelはB1で双方向に効くはずだが、9a・9bとも
// 「フェーズBの候補区間に旧'大梁'が残る」向きしか検証しておらず無試験だった）。
// makeTwoRoomGraphのy0（実壁）の候補spanKeyは全長(x0..x2)——x0..x1（両室の境界まで）ではフェーズAの
// 候補spanKey(x0..x2)と一致せず撤去→別spanKeyで新規生成という別の経路になってしまうため、
// フェーズAが実際に候補にするx0..x2（実測確認済み）を使う。
test('autoFillWoodWallBeams（3h・9c・B1）: 壁ができてフェーズAの候補区間になった位置に残るautoの頭つなぎは、撤去されずbeamTypeが大梁へin-place relabelされる', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const stale = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'primary', beamType: '頭つなぎ' });
  assert.equal(stale.dimensionStatus, 'auto', '前提: 自動生成分（撤去対象になりうる）');
  const segs = selfWallSegments(graph);

  const first = autoFillWoodWallBeams(graph, PROJECT, segs); // belowColumnsなし
  assert.equal(first.created.filter(b => b.axisCL === y0 && !b.isVertical).length, 0, '既存role:primaryが占有済みのため新規生成しない');
  assert.deepEqual(first.removed, [], '撤去もしない（撤去→再生成ではなくin-place）');
  assert.ok(graph.beamMap.has(stale.id), '同じidのまま残る');
  assert.equal(stale.beamType, '大梁', 'beamTypeがin-placeで大梁へ揃う');
  assert.equal(stale.clStart, x0, 'clStart・clEnd・axisCLは不変（座標からの引き直しではない）');
  assert.equal(stale.clEnd, x2);
  assert.equal(stale.axisCL, y0);

  const second = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.equal(second.created.length, 0, '2回目はbeamTypeが既に一致するためno-op（冪等）');
  assert.equal(second.removed.length, 0);
  assert.equal(stale.beamType, '大梁');
});

test('【失敗系】autoFillWoodWallBeams（3h・9d・B1）: 手動固定(locked)の占有物（頭つなぎのまま）はフェーズAの候補区間になってもbeamTypeを書き換えない', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'primary', beamType: '頭つなぎ' });
  locked.setDimensionStatus('locked');
  const segs = selfWallSegments(graph);
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.equal(created.filter(b => b.axisCL === y0 && !b.isVertical).length, 0);
  assert.deepEqual(removed, []);
  assert.equal(locked.beamType, '頭つなぎ', '手動固定はbeamTypeを触らない');
});

// QA第2巡・(b)不変条件: フェーズBの候補点源は下階柱(belowTiePts)を自階柱(selfCarrierPts)より前に
// 並べる（columnSupportBeamCandidatesは同一区間へ複数点が到達したとき先着を採用するため、この順序が
// 「頭つなぎ（below）が受梁（self）より優先される」m10の規律の実体）。structuralRecompute.jsの
// 同種テストと同じ手法（fs.readFileSync+正規表現）。
test('【不変条件・ソース走査】woodAutoFill.js: フェーズBがcolumnSupportBeamCandidatesへ渡す点源はbelowTiePtsをselfCarrierPtsより前に並べている', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'woodAutoFill.js'), 'utf8');
  assert.ok(/columnSupportBeamCandidates\(\[\.\.\.belowTiePts, \.\.\.selfCarrierPts\], supportSegments, belowPts\)/.test(src),
    'columnSupportBeamCandidates へ [...belowTiePts, ...selfCarrierPts] の順で渡していない（下階柱＝頭つなぎが自階柱＝受梁より優先される順序が崩れている可能性）');
});

test('【失敗系】autoFillWoodWallBeams（3h・9b・B1）: 手動固定(locked)の占有物はbeamTypeを書き換えない', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1820, false, x0, x1, { role: 'primary', beamType: '大梁' });
  locked.setDimensionStatus('locked');
  const segs = selfWallSegments(graph);
  const belowColumns = [{ x: 1820, y: 1820, axisX: 1820, axisY: 1820, role: 'standard' }];
  const { created, removed } = autoFillWoodWallBeams(graph, PROJECT, segs, null, belowColumns);
  // makeTwoRoomGraphの実壁（周囲4辺＋間仕切り）自体はフェーズAが生成するため created は空にならない
  // （3h・6と同じ理由でフィルタして確認する。全体を[]とdeepEqualすると、返る5本のStructuralBeam
  // インスタンス——循環参照を持つMobX observableオブジェクト——を非strictなassert.deepEqualが
  // 深く比較しようとしてメモリを使い果たす。3h・9bの失敗系テストで実際に再現した（QA第1巡のヒープ枯渇の原因）。
  assert.equal(created.filter(b => b.beamType === '頭つなぎ').length, 0, '手動固定を巻き込んで重複生成しない');
  assert.deepEqual(removed, []);
  assert.equal(locked.beamType, '大梁', '手動固定はbeamTypeを触らない');
});

// ---- M4・【統合・3h×3e-2】: フェーズBが生成する受梁（自階柱起因）がセルの1辺を閉じ、その区画に
// 3e-2（autoFillWoodFloorBeams）が床梁を生成する。壁は使わず、3辺(上・左・右)を手動固定の大梁として
// 直接置き、4辺目(下辺)を自階柱からの受梁で閉じる——受梁の生成源（3h）と床梁の生成源（3e-2。
// beamGridCellsはrole:'primary'の梁だけを見る）が独立の関数のため、両者をこの順で直列に呼んで結合を見る。
test('【統合・3h×3e-2】autoFillWoodWallBeams→autoFillWoodFloorBeams: 自階柱から生成された受梁がセルの1辺を閉じ、その区画に床梁が生成される。2回目はcreated0/removed0', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT }); // 自階柱・受梁の内部分割アンカー
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });

  // 3辺（上・左・右）を手動固定の大梁として直接置く（実壁は使わず幾何のみ再現。lockedなのでフェーズBの
  // 支持集合＝lockedSegmentsに入る）。
  const top = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x2, { role: 'primary', beamType: '大梁' });
  top.setDimensionStatus('locked');
  const left = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, true, y0, y1, { role: 'primary', beamType: '大梁' });
  left.setDimensionStatus('locked');
  const right = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', x2, true, y0, y1, { role: 'primary', beamType: '大梁' });
  right.setDimensionStatus('locked');
  // 4辺目(下辺 y=5460)は無い——自階柱(1820,5460)だけを起因にする。
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, y1, {});

  const wallSegments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 3640 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 5460 },
    { isVertical: true,  coord: 3640, lo: 0, hi: 5460 },
  ];
  const { created: wallCreated } = autoFillWoodWallBeams(graph, PROJECT, wallSegments);
  const carrier = wallCreated.find(b => b.beamType === '受梁');
  assert.ok(carrier, '前提: 自階柱(1820,5460)から受梁(y=5460,x:0..3640)が生成される');
  assert.equal(carrier.isVertical, false);
  assert.deepEqual([Math.round(carrier.coord1), Math.round(carrier.coord2)].sort((a, b) => a - b), [0, 3640]);

  const { created: floorCreated } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.ok(floorCreated.length > 0, '受梁でセル(3640×5460)が閉じたことにより床梁が生成される（短辺3640>1820）');
  for (const b of floorCreated) assert.equal(b.role, 'floor');

  // 2回目: 受梁・床梁とも冪等（created0・removed0）。
  const wallSecond = autoFillWoodWallBeams(graph, PROJECT, wallSegments);
  assert.deepEqual([wallSecond.created.length, wallSecond.removed.length], [0, 0], '受梁の生成は冪等');
  const floorSecond = autoFillWoodFloorBeams(graph, PROJECT);
  assert.deepEqual([floorSecond.created.length, floorSecond.removed.length], [0, 0], '床梁の生成も冪等');
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

// ---- 柱の個別柱寸（column.woodColumnWidthMm。ステップ3・2026-09-17裁定「共通と個別指定の2層」）----
test('conformWoodSections: 個別柱寸（column.woodColumnWidthMm）を持つ柱はその値へ、それ以外の柱は階の値（共通）へそろう。梁幅は個別柱寸に影響されない', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  const individual = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, y1, { woodColumnWidthMm: 105 });
  const common = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, {});
  // 梁は既定(105)からずらしておく——個別柱寸(105)と偶然一致すると「個別柱寸に影響されていない」ことを
  // 検証できないため、階の値(既定120)だけに追従することを見分けられる値(105)から始める。
  const b = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x240', y2, false, x1, x2, { role: 'primary' });
  const updated = conformWoodSections(graph, PROJECT);
  assert.deepEqual(updated.sort(), [individual.id, common.id, b.id].sort());
  assert.equal(individual.sectionDefId, 'WOOD-105x105', '個別指定の柱はその値(105)へ');
  assert.equal(common.sectionDefId, 'WOOD-120x120', '個別指定の無い柱は階の値(既定120)へ');
  assert.equal(b.sectionDefId, 'WOOD-120x240', '梁幅は階の値(既定120)へ——個別柱(105)の存在に影響されない');
  assert.deepEqual(conformWoodSections(graph, PROJECT), [], '2回目は変更なし');
});

test('【失敗系】conformWoodSections: 個別柱寸がカタログ外（例100）の柱は無効として扱い階の値へそろう（woodColumnWidthMmと同じ規約）', () => {
  const { graph, x1, y1 } = makeGridGraph();
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, { woodColumnWidthMm: 100 });
  const updated = conformWoodSections(graph, PROJECT);
  assert.deepEqual(updated, [column.id]);
  assert.equal(column.sectionDefId, 'WOOD-120x120', 'カタログ外の個別値は無効＝階の値(既定120)へ');
});

// 柱の verticalCL/horizontalCL は通り芯（Discipline.STRUCT・labeled:true）で作ると、serializeGraph の
// 階スナップショットからは除外される（通り芯は project.structGraph が別チャンネルで持つ。
// structuralOrchestration.test.js の同種コメント参照）。ここでは往復対象を柱に絞るため、
// 中心線（Discipline.ARCH。graphSnapshot.test.js の makeGraphWithWindow と同じ規約）で組む。
function makeArchCLGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   0, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  return { graph, x1, y1 };
}

test('serializeGraph/restoreGraph: 柱の個別柱寸（woodColumnWidthMm）が往復で保持される（extras漏れ検出。packExtraFieldsからwoodColumnWidthMmを削ると失敗する）', () => {
  const { graph, x1, y1 } = makeArchCLGraph();
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, { woodColumnWidthMm: 105 });
  const bytes = serializeGraph(graph);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, bytes);
  const c2 = restored.columnMap.get(column.id);
  assert.ok(c2, '復元後に同一IDの柱が存在する');
  assert.equal(c2.woodColumnWidthMm, 105, '個別柱寸が復元後も保持される');
});

test('【失敗系】serializeGraph/restoreGraph: 個別柱寸を設定していない柱（共通）はnullのまま往復する', () => {
  const { graph, x1, y1 } = makeArchCLGraph();
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, y1, {});
  const bytes = serializeGraph(graph);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, bytes);
  const c2 = restored.columnMap.get(column.id);
  assert.equal(c2.woodColumnWidthMm, null);
});

// ---- autoFillWoodColumns: 個別柱寸を持つ柱は撤去ループの対象判定に影響されない（dimensionStatusと独立） ----
test('autoFillWoodColumns: 個別柱寸（woodColumnWidthMm）を持つ柱もdimensionStatus="auto"のままで、候補から外れれば他のauto柱と同様に撤去される', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  // 交点(1000,2000)は両壁とも全長(0..4000)の内部にある——横壁を丸ごと取り除けばその壁自身の
  // 自由端も一緒に消えるため、交点の位置に新たな自由端が湧かない（コーナー等、壁の端そのものを
  // 交点にすると、片方の壁を消したときにもう片方の壁の端が自由端として残り候補が消えない）。
  const horiz = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });
  const { created } = fillWoodColumns(graph);
  const target = splitFreeEndColumns(graph, created, [[1000, 2000]]);
  assert.equal(target.length, 1, '前提: 壁交点に柱が1本生成される');
  const column = target[0];
  column.setField('woodColumnWidthMm', 105); // 個別指定（dimensionStatusはautoのまま＝架空の「固定」にしない）
  assert.equal(column.dimensionStatus, 'auto', '前提: 個別指定してもdimensionStatusはautoのまま');
  // 横壁を取り除いて交点そのものを消す（縦壁は残るためsegments.length>0＝壁ゼロの保全ガードには触れない）。
  // graph.removeWall は耐力壁（StructuralWall・wallMap）用——架構の壁（addWallの戻り値）は removeShape で消す。
  graph.removeShape(horiz.id);
  const second = fillWoodColumns(graph);
  assert.ok(second.removed.includes(column.id), '個別柱寸を持っていても候補から外れれば撤去される（dimensionStatusと独立）');
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
  const firstTarget = splitFreeEndColumns(graph, first.created, [[1000, 2000]]);
  assert.equal(firstTarget.length, 1);
  assert.equal(centerLineKindOf(firstTarget[0].verticalCL), 'beam', '最初は梁芯CLがアンカー');
  // ユーザーが x=1000 の梁芯CLを削除（除外集合へ記録）→ 梁芯CLは無く再生成もされない。x=1000の
  // 線上の柱（交点(1000,2000)＋x=1000壁自身のF-1自由端2本）は全て同じ梁芯CLをアンカーに
  // 持つため連鎖削除される。y=2000壁の自由端2本（x=0/4000側、別のCLがアンカー）は影響を受けない。
  const fuse = graph.centerLines.find(cl => cl.discipline === Discipline.FUSE && cl.centerLineType === CenterLineType.VERTICAL);
  graph.excludedWallBeamAxes.add('X:1000');
  graph.removeCenterLine(fuse.id);
  assert.equal(graph.columns.length, 2, 'x=1000線の柱3本（交点＋自由端2本）が連鎖削除され、別線のy=2000壁自由端2本だけ残る（前提）');
  // 再補完: 壁の乗る意匠中心線（x=1000）を第2候補のアンカーにして立ち直す（「壁のある中心との交点にも柱」）。
  // x=1000線の自由端2本もこの意匠中心線へアンカーを移して立ち直る。
  const second = fillWoodColumns(graph);
  const secondTarget = splitFreeEndColumns(graph, second.created, [[1000, 2000]]);
  assert.equal(secondTarget.length, 1);
  assert.equal(centerLineKindOf(secondTarget[0].verticalCL), 'center');
  assert.equal(Math.round(secondTarget[0].x), 1000);
});

test('【旧データ限定・種別ベースへ統一】autoFillWoodColumns: 縦壁の軸CLが{labeled:true, discipline:ARCH}（種別center。旧UI由来のデータ）でも、resolveWoodColumnAnchorCLの合成結果（findBeamAnchorCL ?? findCenterAnchorCL）は変化しない——同じCLがアンカーとして選ばれる', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  // 通常経路（addCenterLineFromDialog）は種別centerをlabeled:falseで生成するため現行では発生しないが、
  // 旧UI由来のデータで壁の軸CL自体がlabeled:trueのまま残っているケースを模す。
  const legacyAxis = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.ARCH });
  graph.addWall(legacyAxis, 0, true, y1, 0, y2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5, bandOffset: null });
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // 横壁 y=2000（交点(1000,2000)）
  // 壁由来の梁芯CL（autoFillWallBeamAxes）はまだ生成していない状態でresolveWoodColumnAnchorCLの
  // ??チェーン単独の挙動を見る（フルパイプライン=fillWoodColumnsだとD2でx=1000に新規梁芯が
  // 生成され別の検証になる。wallBeamAxes.test.jsのD2ピン留め参照）。
  const { created } = autoFillWoodColumns(graph, PROJECT);
  const target = splitFreeEndColumns(graph, created, [[1000, 2000]]);
  assert.equal(target.length, 1);
  assert.equal(target[0].verticalCL, legacyAxis,
    '第1候補(structuralAnchorAt tier:primary)はcenter種別を対象にしないためmissするが、第2候補(tier:secondary)が同じCLを返すため合成結果は変化しない（移行前はlabeled:trueで第1候補が直接同じCLに一致していた）');
});

test('【旧データ限定・種別ベースへ統一】autoFillWoodColumns: 縦壁の軸CLが{labeled:true, lineType:dashed}（種別aux。旧データ）だと、移行後はアンカー解決できず柱が立たない——移行前はcl.labeledで一致し柱が立っていた', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  const legacyAux = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, lineType: 'dashed' });
  assert.equal(centerLineKindOf(legacyAux), 'aux', '前提: lineType=dashedなのでaux種別（labeled:trueだが補助線の旧データ）');
  graph.addWall(legacyAux, 0, true, y1, 0, y2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5, bandOffset: null });
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false }); // 横壁 y=2000（交点(1000,2000)）
  const { created } = autoFillWoodColumns(graph, PROJECT);
  const atIntersection = created.filter(c => Math.abs(c.x - 1000) < 1 && Math.abs(c.y - 2000) < 1);
  assert.equal(atIntersection.length, 0,
    '種別ベース（primary=[struct,beam]・secondary=[center]のどちらも補助線を対象にしない）ではアンカー解決できず柱が立たない（移行前はlegacyAux.labeled=trueでfindBeamAnchorCLの第1候補に直接一致し柱が立っていた）');
});

test('【最大の罠】resolveWoodColumnAnchorCL（?? チェーン）: 同座標に中心線（壁自身の軸）と梁芯が両方あるとき、配列順に関係なく梁芯が優先される', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true }); // 縦壁の軸CL＝中心線（配列で先に追加）
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 同座標の梁芯（配列で後）
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  const { created } = autoFillWoodColumns(graph, PROJECT);
  const target = splitFreeEndColumns(graph, created, [[1000, 2000]]);
  assert.equal(target.length, 1);
  assert.equal(centerLineKindOf(target[0].verticalCL), 'beam',
    '配列で中心線が先でも梁芯（第1候補=tier:primary）が優先される（tier:anyの単発に畳むと配列順で中心線が返ってしまう）');
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
  const target = splitFreeEndColumns(graph, created, [[1000, 2000]]);
  assert.deepEqual(target.map(c => `${c.x},${c.y}`), ['1000,2000']);
  assert.equal(centerLineKindOf(target[0].verticalCL), 'center', 'アンカーは壁の乗る意匠中心線');
  assert.equal(centerLineKindOf(target[0].horizontalCL), 'center');
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

// ---- 各階柱寸法（graph.woodColumnWidthMm。ステップ4 C-2）が柱・梁の材幅・壁下地材に追従する ----
test('conformWoodSections/conformWoodBacking: graph.woodColumnWidthMm を105にすると柱・梁の材幅・下地材コードが105へ追従する', () => {
  const { graph, x1, x2, y1 } = makeGridGraph();
  graph.setWoodColumnWidthMm(105);
  const c = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, y1, {});
  const b = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', y1, false, x1, x2, { role: 'primary' });
  const updatedSections = conformWoodSections(graph, PROJECT);
  assert.deepEqual(updatedSections.sort(), [c.id, b.id].sort());
  assert.equal(c.sectionDefId, 'WOOD-105x105', '柱は105角へ');
  assert.equal(b.sectionDefId, 'WOOD-105x240', '梁は材幅だけ105へ・成は保つ');
  assert.deepEqual(conformWoodSections(graph, PROJECT), [], '2回目は変更なし');

  const changed = conformWoodBacking(graph, PROJECT);
  assert.deepEqual(changed.map(c2 => c2.field).sort(), ['exteriorWallBacking', 'interiorWallBacking']);
  assert.equal(graph.exteriorWallBacking, WOOD_STUD_CODE_BY_SIZE['105x30'], '下地材コードも105寸へ追従');
  assert.equal(graph.interiorWallBacking, WOOD_STUD_CODE_BY_SIZE['105x30']);
});

test('【失敗系】conformWoodSections/conformWoodBacking: graph.woodColumnWidthMm がカタログ外の幅（例100）なら無効として扱い、ルール既定（120角）で柱・梁・下地材ともそろえる（QA裁定: 無変化ではなく既定へフォールバック統一）', () => {
  const { graph, x1, x2, y1 } = makeGridGraph();
  graph.setWoodColumnWidthMm(100); // 90/105/120以外＝正角カタログに無い→無効
  const c = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {});
  const b = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x240', y1, false, x1, x2, { role: 'primary' });
  const updated = conformWoodSections(graph, PROJECT);
  assert.deepEqual(updated.sort(), [c.id, b.id].sort(), 'カタログ外の階の値は無効＝ルール既定(120)へそろえ直す対象になる');
  assert.equal(c.sectionDefId, 'WOOD-120x120');
  assert.equal(b.sectionDefId, 'WOOD-120x240');
  assert.deepEqual(conformWoodSections(graph, PROJECT), [], '2回目は変更なし（120で安定）');

  const changed = conformWoodBacking(graph, PROJECT);
  assert.deepEqual(changed.map(c2 => c2.field).sort(), ['exteriorWallBacking', 'interiorWallBacking']);
  assert.equal(graph.exteriorWallBacking, WOOD_STUD_CODE_BY_SIZE['120x30'], '下地材コードもルール既定(120)へ');
  assert.equal(graph.interiorWallBacking, WOOD_STUD_CODE_BY_SIZE['120x30']);
});

test('【失敗系】autoFillWoodColumns: graph.woodColumnWidthMm がカタログ外の幅（例100）でも新規柱はルール既定（120角）で生成される（conformとの不整合を作らない）', () => {
  const { graph } = makeGridGraph();
  graph.setWoodColumnWidthMm(100);
  addBackingWall(graph, { axisValue: 2000, clStart: graph.gridXs[0], clEnd: graph.gridXs[1], isVertical: false });
  addBackingWall(graph, { axisValue: 1000, clStart: graph.gridYs[0], clEnd: graph.gridYs[1], isVertical: true });
  const { created } = fillWoodColumns(graph);
  assert.ok(created.length > 0, '前提: 柱が生成される');
  for (const c of created) assert.equal(c.sectionDefId, 'WOOD-120x120', 'カタログ外の階の値は無効＝新規柱もルール既定(120)になる');
});

test('【失敗系】conformWoodSections/conformWoodBacking: 在来木造以外は graph.woodColumnWidthMm を設定していても無変化', () => {
  for (const structure of ['S造', '木造（2"×4"）']) {
    const { graph, x1, x2, y1 } = makeGridGraph(structure);
    graph.setWoodColumnWidthMm(105);
    const c = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, y1, {});
    const b = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'primary' });
    assert.deepEqual(conformWoodSections(graph, PROJECT), []);
    assert.equal(c.sectionDefId, 'WOOD-120x120');
    assert.equal(b.sectionDefId, 'WOOD-120x120');
    assert.deepEqual(conformWoodBacking(graph, PROJECT), []);
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

// ---- conformWoodColumnEccentricity（B-1・ユーザー裁定2026-09-17: 個別柱が壁の中で偏心する）----
// exterior は wallGate.js buildExteriorSide の代役（fixedExterior。ここでの sign は
// buildExteriorSide().outsideSign が実際に返す値（QA指摘・実測: 名前に反し内側方向の符号。
// JSDocどおり最小側+1）をそのまま模す——conformWoodColumnEccentricity 側で符号反転してから
// woodColumnEccentricity へ渡すため、fixedExterior(1)（内側+1）は s_face=-1 として効く。
// outsideSignを固定して純粋にconform側の配線＝columnWidthMm解決・segments収集・冪等・
// スキップ条件だけを検証する（woodColumnEccentricity自体の計算はwoodColumnOffset.test.jsで検証済み）。
function fixedExterior(sign) {
  return { outsideSign: () => sign };
}

test('conformWoodColumnEccentricity: 個別柱寸（105、階の値120と異なる）を持つ壁上の柱に偏心を書く', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  // x2(=4000)を通る縦壁を張り、柱をその壁上（x2, y1）に立てる。
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, { woodColumnWidthMm: 105 });
  const updated = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(updated, [column.id]);
  // fixedExterior(1)は「内側+1」（wallGateの実際の符号規約）。conform側が反転するためs_face=-1。
  assert.equal(column.eccentricity.x, -7.5, 's_face=-1（内側+1を反転）・-1*(120-105)/2=-7.5');
  assert.equal(column.eccentricity.y, 0, 'Y軸に一致する壁が無い');
});

test('conformWoodColumnEccentricity: 冪等（2回目は更新0件・同じ値のまま）', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, { woodColumnWidthMm: 105 });
  conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  const second = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(second, []);
});

// ステップ2で共通柱も帯シフト（bandOffset）分だけ非ゼロになりうるようになったため、この主張は
// 「bandOffset=0（帯シフト無し。addBackingWallの既定）の壁に乗る共通柱」に意味を狭める
// （bandOffsetが無ければ従来どおり常に偏心ゼロであることは変わらない）。
test('conformWoodColumnEccentricity: bandOffset=0の壁上の共通柱（woodColumnWidthMm未指定）は常に偏心ゼロ（既に非ゼロなら書き戻して正規化）', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x2, y1, { eccentricity: { x: 5, y: 5 } });
  const updated = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(updated, [column.id], '共通へ戻すため書く');
  assert.deepEqual(column.eccentricity, { x: 0, y: 0 });
});

// ---- ステップ2（ユーザー裁定2026-09-17）: 外壁上の共通柱は帯の寄せ（bandOffset）分だけ偏心する ----
test('【ステップ2】conformWoodColumnEccentricity: 外壁上の共通柱（woodColumnWidthMm未指定）でもbandOffset分の偏心を書く', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  // 柱寸法シフト（bandShift=7.5相当）を持つ外壁を模す。
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true, bandOffset: 7.5 });
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x2, y1, {}); // 共通柱（woodColumnWidthMm未指定）
  const updated = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(updated, [column.id], '共通柱でも帯の寄せ分の偏心を書く');
  assert.equal(column.eccentricity.x, 7.5, '共通柱＝第2項は常に0。bandOffsetだけがそのまま乗る');
  assert.equal(column.eccentricity.y, 0, 'Y軸に一致する壁が無い');
});

test('【ステップ2】conformWoodColumnEccentricity: bandOffset付き外壁上の共通柱も2回目はupdatedが空（冪等）', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true, bandOffset: 7.5 });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x2, y1, {});
  conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  const second = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(second, [], '目標値（bandOffset分）と現在値が既に一致しているため書かない');
});

test('【失敗系】conformWoodColumnEccentricity: 非在来（framingを持たない主構造）は何もしない', () => {
  const { graph, x2, y1, y2 } = makeGridGraph('S造');
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, { woodColumnWidthMm: 105 });
  assert.deepEqual(conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1)), []);
});

test('【失敗系】conformWoodColumnEccentricity: exterior未構築（null）は何もしない', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, { woodColumnWidthMm: 105 });
  assert.deepEqual(conformWoodColumnEccentricity(graph, PROJECT, null), []);
});

test('【失敗系】conformWoodColumnEccentricity: 杭（role:foundation）・他材種の柱はスキップする', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  const pile = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, { role: 'foundation', woodColumnWidthMm: 105 });
  const steel = graph.addColumn(StructuralMaterialType.STEEL, 'STEEL-SQ200x200x9.0', x2, y1, {});
  const updated = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(updated, []);
  assert.deepEqual(pile.eccentricity, { x: 0, y: 0 });
  assert.deepEqual(steel.eccentricity, { x: 0, y: 0 });
});

test('conformWoodColumnEccentricity: woodOffsetSideの明示指定はoutsideSignより優先される', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, { woodColumnWidthMm: 105, woodOffsetSide: { x: -1 } });
  conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.equal(column.eccentricity.x, -7.5, 'side.x=-1を優先（outsideSignは+1を返すが無視される）');
});

test('【QA指摘・B-1】conformWoodColumnEccentricity: 階の柱寸（各階柱寸法）を変えると個別柱（90）の偏心がW/wの新しい関係で再導出され、戻り値にidが載る', () => {
  const { graph, x2, y1, y2 } = makeGridGraph(); // 階の値の既定は120角
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-90x90', x2, y1, { woodColumnWidthMm: 90 });
  const first = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(first, [column.id]);
  assert.equal(column.eccentricity.x, -15, '初回はW=120/w=90・s_face=-1(内側+1の反転)・-1*(120-90)/2=-15');

  // 階の柱寸を105へ変更（個別柱の90はそのまま＝Wだけが変わる）。
  graph.setWoodColumnWidthMm(105);
  const second = conformWoodColumnEccentricity(graph, PROJECT, fixedExterior(1));
  assert.deepEqual(second, [column.id], '階の値が変わるとW/wの関係も変わるため再導出され、戻り値にidが載る');
  assert.equal(column.eccentricity.x, -7.5, '再導出後はW=105/w=90・-1*(105-90)/2=-7.5');
});

// ---- QA指摘（B-1）: AXIS/ACTUAL規律の振る舞い固定（3dの支持点・荷重点をACTUALへ戻す・conformへの
// 入力をACTUALへ戻す退行を、フィクスチャの型ではなく実際のズレで検出する）----
test('【QA指摘・B-1】conformWoodColumnEccentricity: 壁の同定・外側判定はAXIS（axisX/axisY）で行う——ACTUALでは一致しない', () => {
  const { graph, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 4000, clStart: y1, clEnd: y2, isVertical: true });
  // 事前に古い偏心{x:7.5,y:30}を持たせ、ACTUAL(=AXIS+この値)をAXISから意図的にズラす。
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x2, y1, {
    woodColumnWidthMm: 105, eccentricity: { x: 7.5, y: 30 },
  });
  assert.equal(column.axisX, 4000, '前提: AXISは通り芯位置（4000）');
  assert.equal(column.x, 4007.5, '前提: ACTUALは偏心ぶんズレる（4007.5）');
  // axisValue===4000（柱のAXIS.x）かつatCross===y1.value（柱のAXIS.y）のときだけ1を返すスタブ。
  // conform側がACTUAL（4007.5・30）を渡すと一致せず常に0になる。
  const outsideSign = (axisValue, isVertical, atCross) =>
    (isVertical && axisValue === 4000 && atCross === y1.value) ? 1 : 0;
  const updated = conformWoodColumnEccentricity(graph, PROJECT, { outsideSign });
  assert.deepEqual(updated, [column.id]);
  // outsideSignは「内側+1」規約（QA指摘・wallGate.jsの実際の符号）を模しているため、conform側の
  // 符号反転でs_face=-1になる: -1*(120-105)/2=-7.5。
  assert.equal(column.eccentricity.x, -7.5, 'AXISで一致すれば-7.5（ACTUALで渡すと一致せず0になる）');
  assert.equal(column.eccentricity.y, 0, 'Y軸に一致する壁が無い');
});

test('【QA指摘・B-1】autoFillWoodBeamDepths: 下階支持点はAXIS（axisX/axisY）で判定する——ACTUALがズレていても区分は変わらない', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x300', y0, false, x0, x1, { role: 'primary' });
  const below = new PlanGraph(new Plane('p0', -3000, '0階', 1, 1));
  const bx = below.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const by = below.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  // AXISはちょうど1820（B3と同じ支持位置）。ACTUALは偏心7.5でずらし1827.5にする——ACTUALで判定すると
  // 区間が1827.5/1812.5に分かれ、1827.5側が表の次区分(2730)へ上がり成が変わってしまう（回帰の固定）。
  below.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', bx, by, { eccentricity: { x: 7.5, y: 0 } });
  const belowColumn = below.columns[0];
  assert.equal(belowColumn.axisX, 1820, '前提: AXISは1820（B3と同じ支持位置）');
  assert.equal(belowColumn.x, 1827.5, '前提: ACTUALは偏心ぶんズレる（1827.5）');
  const updated = autoFillWoodBeamDepths(graph, PROJECT, below.columns);
  assert.deepEqual(updated, [beam.id]);
  assert.equal(beam.sectionDefId, 'WOOD-120x120', 'AXIS(1820)で2区間×1820・荷重なし＝成120のまま（B3と同じ）');
});

test('【QA指摘・B-1】autoFillWoodBeamDepths: 自階荷重点の区間判定もAXIS——区間端ちょうどに置いた自階柱はACTUALが区間外へズレても結果は変わらない（境界のため元々内部荷重に数えない）', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  // 自階柱をbeamの始端(lo=x0=0)ちょうどに置く。ACTUALは偏心-7.5で区間外(-7.5)へズレる。
  const selfColumn = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, { eccentricity: { x: -7.5, y: 0 } });
  assert.equal(selfColumn.axisX, 0, '前提: AXISは区間端ちょうど(0)');
  assert.equal(selfColumn.x, -7.5, '前提: ACTUALは区間外(-7.5)へズレる');
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  // 区間端は「区間内部」ではないため、AXIS(0=lo)扱いでも元々内部荷重に数えない——ACTUAL(-7.5)で
  // 区間外に落ちても結果は変わらない（B1と同じ荷重なし＝成300のまま）。この境界ケース自体は
  // woodBeamDepthForSpansのstrict interior判定（l>lo+tol）によりAXIS/ACTUALどちらでも荷重0になる
  // ため変異検出力を持たない（数学的に区別不能——下のテストが実際の検出役を担う）。
  assert.deepEqual(updated, [beam.id]);
  assert.equal(beam.sectionDefId, 'WOOD-120x300', '区間端の柱は内部荷重に数えない＝B1と同じ成300のまま');
});

test('【QA指摘・B-1・回帰検出用】autoFillWoodBeamDepths: 自階荷重点の区間判定はAXISが真——ACTUALだけを区間の外へ大きくズラすと荷重が消えて成が変わる（上のテストは境界ケースゆえ変異を検出できないため、区間内部のケースで固定する）', () => {
  const { graph, x0, x1, y0 } = makeBeamTestGraph();
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  // AXISはB2と同じ区間内部(x=1820)。ACTUALだけ偏心-3640で区間外(-1820)へ大きくズラす——
  // ACTUALで判定すると外側フィルタ(v>=lo&&v<=hi)で除外され荷重0（成300）になってしまう。
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const selfColumn = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, y0, { eccentricity: { x: -3640, y: 0 } });
  assert.equal(selfColumn.axisX, 1820, '前提: AXISは区間内部(1820。B2と同じ)');
  assert.equal(selfColumn.x, -1820, '前提: ACTUALは区間外(-1820)へ大きくズレる');
  const updated = autoFillWoodBeamDepths(graph, PROJECT);
  assert.deepEqual(updated, [beam.id]);
  assert.equal(beam.sectionDefId, 'WOOD-120x330', 'AXIS(1820)で内部荷重1か所＝成330（B2と同じ。ACTUALだと除外され成300になってしまう）');
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

test('autoFillWoodBeamDepths F1（QA2）: host候補が1本しかない端でも、その端が下階柱の位置なら荷重点にも伝播先にもしない（対照: belowColumns=[]なら受梁の成へ引き上がる＝C1と同じ）', () => {
  // C1と同じフィクスチャ（host=y0,x0..x1=3640の単一梁。分割されておらずhost候補は常に1本のみ）。
  // carrierが取りつく点(xMid=1820, y0=0)そのものに下階柱を置く——host候補のあいまい一致は起きない
  // 状況でも、F1「梁の端が下階柱なら受梁にしない」は端が下階柱の位置というだけで適用されることを固定する。
  const withBelow = makeCarrierTestGraph();
  const belowColumns = [{ x: withBelow.xMid.value, y: withBelow.y0.value, axisX: withBelow.xMid.value, axisY: withBelow.y0.value, role: 'standard' }];
  autoFillWoodBeamDepths(withBelow.graph, PROJECT, belowColumns);
  assert.equal(
    withBelow.host.sectionDefId, 'WOOD-120x120',
    '受梁(360)へは引き上がらず、host自身は下階柱で区切られた1820区間×2・荷重なしの表値(120)のまま',
  );
  assert.equal(withBelow.carrier.sectionDefId, 'WOOD-120x360', '受梁自身の成は区間内部の自階柱3本で360のまま（下階柱の有無と無関係）');

  const withoutBelow = makeCarrierTestGraph();
  autoFillWoodBeamDepths(withoutBelow.graph, PROJECT); // belowColumns省略＝[]（対照）
  assert.equal(withoutBelow.host.sectionDefId, 'WOOD-120x360', '対照: 下階柱が無ければ受梁の成(360)へ引き上がる（C1と同じ結果）');
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

// ---- F1（QA・2026-09-16）: 下階柱で分割された2本の半梁が共有端を持つとき、その端に取りつく受梁の
// host判定があいまいになり、`Array.find`の挿入順で片方だけに受梁の成が伝播していた不具合の回帰。
// ユーザー裁定「梁の端が下階柱なら受梁にしない」＝共有端が下階柱の位置ならどちらの半梁もhostにしない。
function buildSplitHalvesWithCarrier(reverseOrder) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y910 = graph.addCenterLine(CenterLineType.HORIZONTAL, 910,  { labeled: true, discipline: Discipline.STRUCT });
  const y1820 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y2730 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2730, { labeled: true, discipline: Discipline.STRUCT });
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  // 下階柱(1820)で分割済みの半梁2本（3c-2bの出力を模す。挿入順を引数で反転できるようにする）。
  let half1, half2;
  if (reverseOrder) {
    half2 = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, xMid, x2, { role: 'primary' });
    half1 = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, xMid, { role: 'primary' });
  } else {
    half1 = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, xMid, { role: 'primary' });
    half2 = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, xMid, x2, { role: 'primary' });
  }
  // 受梁: 縦梁 x=1820, y=0..3640。始端(y=0)＝下階柱の位置(1820,0)で半梁のどちらかにTで取りつく。
  // 区間内部の自階柱3本(y910/1820/2730)でcarrier自身の成は360まで上がる（makeCarrierTestGraphと同じ）。
  const carrier = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, true, y0, yFar, { role: 'secondary' });
  for (const y of [y910, y1820, y2730]) graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, y, {});
  const belowColumns = [{ x: 1820, y: 0, axisX: 1820, axisY: 0, role: 'standard' }]; // 半梁を分けた下階柱そのもの
  autoFillWoodBeamDepths(graph, PROJECT, belowColumns);
  return { half1, half2, carrier };
}

test('autoFillWoodBeamDepths F1: 共有端(下階柱位置)に取りつく受梁があっても、両側の半梁とも受梁の成(360)へ引き上がらず、挿入順を反転しても結果が同じ', () => {
  const forward = buildSplitHalvesWithCarrier(false);
  const reversed = buildSplitHalvesWithCarrier(true);
  assert.equal(forward.half1.sectionDefId, 'WOOD-120x120', '単一区間1820・荷重なしの表値のまま');
  assert.equal(forward.half2.sectionDefId, 'WOOD-120x120', '単一区間1820・荷重なしの表値のまま');
  assert.equal(reversed.half1.sectionDefId, 'WOOD-120x120', '追加順を反転しても結果は同じ（あいまい一致の解消）');
  assert.equal(reversed.half2.sectionDefId, 'WOOD-120x120', '追加順を反転しても結果は同じ（あいまい一致の解消）');
  assert.equal(forward.carrier.sectionDefId, 'WOOD-120x360', '受梁自身は区間内部の自階柱3本で成360のまま（伝播元は変わらない）');
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

// ---- 【統合・ステップD】recomputeStructuralForGraph: captureSnapshotsオプション（既定はbefore/after=null）----
function buildRoomGraphForSnapshotTest() {
  const project = new Project('proj-stepD', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const room = g2.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g2, room);
  const peekMap = { p1: g1, p2: g2 };
  return { project, g2, peekMap };
}

test('【統合・ステップD】recomputeStructuralForGraph: オプション省略時はbefore/afterがnullで、changedは従来どおり', async () => {
  const { project, g2, peekMap } = buildRoomGraphForSnapshotTest();
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const result = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    assert.equal(result.changed, true, '壁線上に柱・梁が生成されchangedになる（従来どおり）');
    assert.equal(result.before, null, 'captureSnapshots省略時はbeforeを取らない');
    assert.equal(result.after, null, 'captureSnapshots省略時はafterを取らない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【統合・ステップD】recomputeStructuralForGraph: captureSnapshots:trueは変化ありでbefore≠afterを返し、beforeへrestoreGraphすると再計算前の柱・梁本数へ戻る。変化なしはafter===before', async () => {
  const { project, g2, peekMap } = buildRoomGraphForSnapshotTest();
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const columnsBefore = g2.columns.length;
    const beamsBefore = g2.beams.length;

    const first = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE, undefined, { captureSnapshots: true });
    assert.equal(first.changed, true);
    assert.notEqual(first.before, null, 'captureSnapshots:trueならbeforeを取る');
    assert.notEqual(first.after, null, 'captureSnapshots:trueならafterを取る');
    assert.notDeepEqual(first.before, first.after, 'changed=trueならbefore≠after');
    assert.ok(g2.columns.length > columnsBefore, '前提: 柱が生成されている');
    assert.ok(g2.beams.length > beamsBefore, '前提: 壁線上の梁が生成されている');

    restoreGraph(g2, first.before);
    assert.equal(g2.columns.length, columnsBefore, 'restoreGraphで再計算前の柱本数に戻る');
    assert.equal(g2.beams.length, beamsBefore, 'restoreGraphで再計算前の梁本数に戻る');

    // 直前のrestoreGraphで再計算前の状態へ戻したため、再計算し直すと同じ結果になる（changed:true）。
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE, undefined, { captureSnapshots: true });
    // 収束済みの状態からもう一度呼ぶと差分なし（冪等）＝after===before（再シリアライズしない・同一参照）。
    const settled = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE, undefined, { captureSnapshots: true });
    assert.equal(settled.changed, false, '前提: 収束済みで変化なし');
    assert.equal(settled.after, settled.before, '変化なしはafterとbeforeが同一参照（再シリアライズしない）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 【統合・ステップC】recomputeStructuralForGraph: options.wallSourceCache（1回の再計算内での壁区間memo）----
test('【統合・ステップC】recomputeStructuralForGraph: options.wallSourceCacheを明示しても、省略時と同じ結果になる（壁交点柱・壁線上の通し梁とも）', async () => {
  // idは生成順で変わるため、位置・役割・断面の安定キーで比べる。
  const dump = (g) => ({
    columns: g.columns.map(c => `${c.role}:${Math.round(c.x)},${Math.round(c.y)}:${c.sectionDefId}`).sort(),
    beams: g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${Math.round(b.axisValue)}:`
      + `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..`
      + `${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}`).sort(),
  });
  const run = async (options) => {
    // フィクスチャは呼ぶたびに独立したProjectを作る＝cacheあり／なしを同じ入力から比べられる。
    const { project, g2, peekMap } = buildRoomGraphForSnapshotTest();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
    try {
      const result = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE, undefined, options);
      return { changed: result.changed, ...dump(g2) };
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  };
  // 対照は null（＝memoしない従来経路）。省略(undefined)だと既定のcacheが作られ、cache経路どうしの
  // 比較になってしまう（恒真）。
  const without = await run({ wallSourceCache: null });
  const withCache = await run({ wallSourceCache: createWallSourceCache() });
  const byDefault = await run(undefined);
  assert.ok(without.columns.length > 0 && without.beams.length > 0, '前提: 壁交点柱・壁線上の通し梁が生成される');
  assert.deepEqual(withCache, without, 'cache指定はcache無し（従来経路）と同一の解（柱・梁のダンプとchanged）を返す');
  assert.deepEqual(byDefault, without, '省略時（既定のcache）もcache無しと同一の解を返す');
});

// ---- 【統合・ステップA】recomputeStructuralForGraph: options.footprintCache（1回の再計算内でのフットプリント索引memo）----
test('【統合・ステップA】recomputeStructuralForGraph: options.footprintCacheを明示しても、省略時と同じ結果になる（壁交点柱・壁線上の通し梁とも）', async () => {
  // idは生成順で変わるため、位置・役割・断面の安定キーで比べる（ステップCの同名テストと同じダンプ形式）。
  const dump = (g) => ({
    columns: g.columns.map(c => `${c.role}:${Math.round(c.x)},${Math.round(c.y)}:${c.sectionDefId}`).sort(),
    beams: g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${Math.round(b.axisValue)}:`
      + `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..`
      + `${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}`).sort(),
  });
  const run = async (options) => {
    // フィクスチャは呼ぶたびに独立したProjectを作る＝cacheあり／なしを同じ入力から比べられる。
    const { project, g2, peekMap } = buildRoomGraphForSnapshotTest();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
    try {
      const result = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE, undefined, options);
      return { changed: result.changed, ...dump(g2) };
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  };
  // 対照は null（＝memoしない従来経路）。省略(undefined)だと既定のcacheが作られ、cache経路どうしの
  // 比較になってしまう（恒真）。
  const without = await run({ footprintCache: null });
  const withCache = await run({ footprintCache: createFootprintCache() });
  const byDefault = await run(undefined);
  assert.ok(without.columns.length > 0 && without.beams.length > 0, '前提: 壁交点柱・壁線上の通し梁が生成される');
  assert.deepEqual(withCache, without, 'cache指定はcache無し（従来経路）と同一の解（柱・梁のダンプとchanged）を返す');
  assert.deepEqual(byDefault, without, '省略時（既定のcache）もcache無しと同一の解を返す');
});

// ---- 【統合・ステップB-3】recomputeStructuralForGraph: options.ctx（構造再計算高速化・解決コンテキスト）----
// buildRoomGraphForSnapshotTest は g2（2階・アクティブ）の下に g1（1階・最下階）を持つ2階建て——
// g2自身の再計算は「1つ下の実体階」（peekBelowGraph・在来木造のwallBeamAxes）と「最下階」
// （resolveLowestGraph・柱芯の外面合わせ基準）の両方でp1を解決するため、ctx無し（従来経路）では
// 同じp1を2回peekする（別々のfloorSwapManager.peek呼び出し）。ctx指定時はこの2回目がキャッシュ
// ヒットになる（peekは1回だけ）ことを確認する。
test('【統合・ステップB-3】recomputeStructuralForGraph: options.ctxを渡すと内部のpeekがコンテキスト経由になり、同じ階(1つ下の実体階=最下階のp1)を2回読む経路でもpeekは1回だけになる。省略・ctx:null・ctx指定のいずれも同じ解になる', async () => {
  const dump = (g) => ({
    columns: g.columns.map(c => `${c.role}:${Math.round(c.x)},${Math.round(c.y)}:${c.sectionDefId}`).sort(),
    beams: g.beams.map(b => `${b.role}:${b.isVertical ? 'V' : 'H'}:${Math.round(b.axisValue)}:`
      + `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..`
      + `${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}:${b.sectionDefId}`).sort(),
  });
  const runWithoutCtx = async (options) => {
    const { project, g2, peekMap } = buildRoomGraphForSnapshotTest();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
    try {
      const result = await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE, undefined, options);
      return { changed: result.changed, ...dump(g2) };
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  };
  // 対照はctx:null（＝コンテキストを使わない従来経路。peekViaがfloorSwapManager.peek直呼びへ委ねる）。
  // 省略(undefined)も同じ経路になる（options.ctx省略時のデフォルトはundefinedでpeekVia(undefined,...)も
  // 同じくfloorSwapManager.peek直呼びのため）——恒真にならないよう対照はctx:null明示、省略との一致は
  // 別アサーションで確かめる。
  const withNullCtx = await runWithoutCtx({ ctx: null });
  const byDefault = await runWithoutCtx(undefined);
  assert.ok(withNullCtx.columns.length > 0 && withNullCtx.beams.length > 0, '前提: 壁交点柱・壁線上の通し梁が生成される');
  assert.deepEqual(byDefault, withNullCtx, '省略とctx:null明示は同じ経路（floorSwapManager.peek直呼び）で同じ解になる');

  // ctx指定時: 注入peekの呼び出し回数・ctx.statsで「同じ階を2回読む経路がpeek 1回に減っている」ことを確認する。
  const { project: projectWithCtx, g2: g2WithCtx, peekMap: peekMapWithCtx } = buildRoomGraphForSnapshotTest();
  let peekCalls = 0;
  const ctx = createStructuralResolveContext({
    peek: async (plane) => { peekCalls++; return peekMapWithCtx[plane.id] ?? null; },
  });
  const result = await recomputeStructuralForGraph(g2WithCtx, projectWithCtx, TRADITIONAL_WOOD_STRUCTURE, undefined, { ctx });
  assert.deepEqual({ changed: result.changed, ...dump(g2WithCtx) }, withNullCtx, 'ctx指定でもctx:null（従来経路）と同一の解になる');
  // 実測: p1はpeekBelowGraph・resolveLowestGraph以外にも解決地点があり、この経路では計3回解決される
  // （1回だけ実際にpeekし、残り2回はctxのキャッシュがヒットする）——正確な内訳（何箇所が解決するか）は
  // structuralRecompute.jsの実装詳細に依存するため固定値でアサートせず、「実peekは1回だけ・残りは
  // すべてhit」という不変条件だけを確認する（peekBelowGraph自体がctxを無視する変異には
  // 「実peekが1回に収まらなくなる＝peekCalls>1」で赤化する）。
  assert.equal(peekCalls, 1, '同じ階(p1)への複数の解決地点のうち、注入peekが実際に呼ばれるのは1回だけ');
  assert.equal(ctx.stats.peek, 1, 'ctx.stats.peekも1');
  assert.ok(ctx.stats.hit >= 1, 'ctx.stats.hitが1以上（2回目以降の解決地点がヒットしている）');
});

// ---- 不変条件: structuralRecompute.js が footprintCache を全消費点（wallGate/exterior/selfGate/columnAxisOffsets）へ配る ----
test('【不変条件】structuralRecompute.js: options.footprintCacheをbuildStructuralWallGate・buildSelfFootprintGate・buildExteriorSide・autoFillColumnAxisOffsetsへ配る（ステップA）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralRecompute.js'), 'utf8');
  assert.ok(/footprintCache = createFootprintCache\(\)/.test(src), 'footprintCacheの既定生成が無い');
  // ステップB-3でctx（解決コンテキスト。省略可・既定undefined）が5番目の引数として加わった。
  assert.ok(/buildStructuralWallGate\(targetGraph\.plane, project, targetGraph, footprintCache, ctx\)/.test(src),
    'buildStructuralWallGateへfootprintCache・ctxを渡していない');
  assert.ok(/buildSelfFootprintGate\(isRoof \? \(belowGraph \?\? targetGraph\) : targetGraph, footprintCache\)/.test(src),
    'buildSelfFootprintGateへfootprintCacheを渡していない');
  assert.ok(/buildExteriorSide\(targetGraph, footprintCache\)/.test(src),
    'buildExteriorSideへfootprintCacheを渡していない');
  assert.ok(/autoFillColumnAxisOffsets\(targetGraph, project, lowestGraph, exterior, footprintCache\)/.test(src),
    'autoFillColumnAxisOffsetsへfootprintCacheを渡していない');
});

// ---- 不変条件: structuralRecompute.js が wallRunSegments を autoFillStructuralGrid に渡し、removedBeams を changed に含める ----
test('【不変条件】structuralRecompute.js: wallRunSegments を autoFillStructuralGrid に渡し、removedBeams を changed に含める（ステップ3c-2）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralRecompute.js'), 'utf8');
  assert.ok(/wallRunSegments\(targetGraph,\s*belowGraph,\s*structure,\s*wallSourceCache\)/.test(src),
    'wallRunSegments(targetGraph, belowGraph, structure, wallSourceCache) の呼び出しが無い');
  // ステップ3c-2b（下階柱分割）でbelowColumnsが8番目の引数として加わった（belowGraph?.columns ?? []）。
  // ステップ3h-2で9番目の引数としてaboveBeamSegments（columnSeedBeamSegments(aboveGraph, ...)）が
  // 加わった（A-2で columnSeedBeamSegments へ改名・一般化）。小屋伏図にも梁・柱ルールを適用する計画の
  // ステップ3で10番目の引数としてselfGate（自階フットプリント単独ゲート。屋根専用平面のときだけ
  // 1つ下の実体階=最上階のgraphから計算する）が加わった。R-2（2026-09-19是正）で11番目の引数として
  // freeEndGraph（自由端の判定基準。屋根専用平面のときだけ1つ下の実体階=最上階のgraphを渡す）が加わった。
  // ステップCで12番目の引数としてwallSourceCache（1回の再計算内の壁区間memo。wallBeamAxes.js
  // createWallSourceCache）が加わった。
  assert.ok(/autoFillStructuralGrid\(targetGraph, project, mainStructure, wallGate, wallSources, wallSegments, aboveColumns, belowGraph\?\.columns \?\? \[\], aboveBeamSegments, selfGate, freeEndGraph, wallSourceCache\)/.test(src),
    'autoFillStructuralGrid へ wallSegments・aboveColumns・belowColumns・aboveBeamSegments・selfGate・freeEndGraph・wallSourceCache を渡していない');
  assert.ok(/removedBeams\.length > 0/.test(src), 'removedBeams が changed の判定に含まれていない');
});

// ---- 小屋伏図にも梁・柱ルールを適用する計画（ステップ3）: selfGate引数の受け渡し ----
test('【ステップ3】autoFillWoodWallBeams: selfGate引数（第6引数）を渡すと、内部計算のbuildSelfFootprintGate(graph)より優先して使われる', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  // wallGate引数（4番目、裁定1で無視される）と違い、selfGateは実際に使われる——全て弾くゲートを
  // 渡せば生成数が0になることで、内部で無視されず消費されていることを固定する。
  const gateAllOut = { spanInBuilding: () => false, spanPointInBuilding: () => false };
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs, null, [], gateAllOut);
  assert.equal(created.length, 0, 'selfGate引数がfalseを返せば壁線通し梁は1本も生成されない');
});

test('【ステップ3】autoFillWoodWallBeams: selfGate引数を省略すると従来どおりbuildSelfFootprintGate(graph)を自前計算する（実体階は不変）', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const withoutArg = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.ok(withoutArg.created.length > 0, '省略時は従来どおり自階フットプリント内に生成される');
});

test('【ステップ3】autoFillStructuralGrid: selfGate引数（第10引数）はautoFillWoodWallBeamsへそのまま素通しされる', () => {
  const graph = new PlanGraph(new Plane('p1', 3000, '2階', 2, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room);
  const project = { planes: [new Plane('p0', 0, '1階', 1, 1), graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  const segs = selfWallSegments(graph);
  const gateAllOut = { spanInBuilding: () => false, spanPointInBuilding: () => false };
  const r = autoFillStructuralGrid(graph, project, TRADITIONAL_WOOD_STRUCTURE, null, segs, segs, [], [], [], gateAllOut);
  assert.equal(r.newBeams.filter(b => b.role === 'primary').length, 0, 'selfGateがfalseを返せば壁線通し梁は生成されない');
});

test('【ステップ3・失敗系】recomputeStructuralForGraph: 屋根専用平面（isRoofPlane、1つ下の実体階が未解決＝peekBelowGraphがnull）でも例外を投げない', async () => {
  const project = new Project('proj-roof-selfgate', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  // 屋根専用平面はproject.addPlaneのisRoofPlane/roofForPlaneIdでproject.planeMapへは入るが、
  // project.planes（elevation昇順・採用フロアのみ）には含まれない（core/project.js参照）——
  // これによりpeekBelowGraph(roofGraph, project)は常にnullを返す（belowPlaneOfが見つけられない）。
  const { graph: roofGraph } = project.addPlane(3000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, 'p1');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  project.activePlaneId = 'roof1';
  // buildStructuralWallGate（屋根はroofForPlaneId=p1を基準階にする）が1階を非アクティブpeekするため、
  // 他の【統合】テストと同じ手法でfloorSwapManagerのシングルトンpeekを一時差し替える。
  const peekMap = { p1: g1 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await assert.doesNotReject(
      () => recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE),
      '屋根専用平面の再計算はbuildSelfFootprintGate(null)のクラッシュを起こさない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- R-6（2026-09-19是正）: 屋根の壁線梁は最上階のフットプリントで区間が切られる ----
// 屋根自身にはフットプリント（部屋）が無いため buildSelfFootprintGate(roofGraph) は常にnull
// （ゲートなし＝全通過）——selfGateを「1つ下の実体階＝最上階」のフットプリントで解決しないと、
// 建物フットプリントの外にある壁線候補（例: 部屋から離れた孤立壁）まで軒桁が通ってしまう
// （structuralRecompute.js の selfGate 分岐が buildSelfFootprintGate(targetGraph) に退行する変異で
// 赤くなることを確認済み）。
test('【R-6】recomputeStructuralForGraph: 屋根専用平面の壁線梁（軒桁）は最上階のフットプリントでゲートされる（屋根自身にフットプリントが無くてもゲートなしにならない）', async () => {
  const project = new Project('proj-r6-roof-selfgate', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // 唯一の実体階＝最上階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 建物本体（部屋。フットプリントを確立する）。
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  // 建物から遠く離れた孤立壁（どの部屋にも属さない＝フットプリントの外）。F-2（自由端）で両端が
  // runの端点になるため、フットプリント判定（selfGate）だけがこの壁の梁を止める唯一の関門になる。
  const fx0 = g1.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: true, discipline: Discipline.STRUCT });
  const fx1 = g1.addCenterLine(CenterLineType.VERTICAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  g1.addCenterLine(CenterLineType.HORIZONTAL, 8000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(g1, { axisValue: 8000, clStart: fx0, clEnd: fx1, isVertical: false });
  autoFillWallBeamAxes(g1, selfWallSegments(g1));

  const { graph: roofGraph } = project.addPlane(3000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, 'p1');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 屋根自身にも同じグリッド（本番はautoFillWallBeamAxesが壁由来梁芯CLとして先に生成する）。
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 8000, { labeled: true, discipline: Discipline.STRUCT });
  project.activePlaneId = 'p1';

  const peekMap = { p1: g1 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    const nearBeam = roofGraph.beams.find(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue) < 1);
    assert.ok(nearBeam, '前提: 建物本体(y=0)の軒桁は生成される');
    const farBeam = roofGraph.beams.find(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue - 8000) < 1);
    assert.ok(!farBeam, 'フットプリントの外（孤立壁y=8000）には軒桁を生成しない（selfGateが最上階のフットプリントで止める）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 小屋伏図にも梁・柱ルールを適用する計画（ステップ5）: 屋根専用平面の梁を壁線方式へ切り替え ----
// 屋根グラフ自身には壁が無いため、wallSegmentsは「1つ下の実体階（最上階）」の壁区間を模して渡す
// （本番はwallRunSegments(roofGraph, topGraph, structure)が同じ形で組み立てる。structuralRecompute.js参照）。
// アンカー解決に使う通り芯は屋根グラフ自身にも必要（本番はautoFillWallBeamAxesが壁由来梁芯CLとして
// 先に生成する。structuralAutoFill.jsのordering参照）——ここでは通り芯を直接roofGraphへ追加して代替する。
function makeRoofWallRunFixture() {
  const roofGraph = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 1, 1, false, null, 0, true, 'p_top'));
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = roofGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = roofGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  // 最上階の外壁（矩形4辺）を模したwallSegments。
  const wallSegments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 3640 },
    { isVertical: false, coord: 5460, lo: 0, hi: 3640 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 5460 },
    { isVertical: true,  coord: 3640, lo: 0, hi: 5460 },
  ];
  return { roofGraph, wallSegments, x0, x1, y0, y1 };
}

test('【ステップ5】autoFillWoodWallBeams: 屋根専用平面(isRoofPlane)から呼ばれると、role:primaryかつbeamType:軒桁の梁を生成する（記号EG→G）', () => {
  const { roofGraph, wallSegments } = makeRoofWallRunFixture();
  const { created } = autoFillWoodWallBeams(roofGraph, PROJECT, wallSegments);
  assert.ok(created.length > 0, '前提: 壁線方式の梁が生成される');
  assert.ok(created.every(b => b.role === 'primary'), '屋根専用平面でもroleは primary（アーキ裁定3）');
  assert.ok(created.every(b => b.beamType === '軒桁'), 'beamTypeは軒桁（大梁ではない）');
});

test('【失敗系・ステップ5】autoFillWoodWallBeams: 実体階（isRoofPlane=false）から呼ばれたときはbeamType:大梁のまま（屋根限定の変更が実体階へ波及しない）', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodWallBeams(graph, PROJECT, segs);
  assert.ok(created.length > 0);
  assert.ok(created.every(b => b.beamType === '大梁'), '実体階は従来どおり大梁のまま');
});

test('【ステップ5】autoFillWoodWallBeams: 屋根専用平面では旧方式(通り芯グリッド)のauto軒桁(role:eaves)を撤去する（占有物として道を空ける）', () => {
  const { roofGraph, wallSegments, x1, y0 } = makeRoofWallRunFixture();
  // 壁の無い位置（矩形の外）に旧方式の軒桁を1本残置——候補に無いため撤去されるはず。
  const x2 = roofGraph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT });
  const staleEaves = roofGraph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x1, x2, { role: 'eaves' });
  const { created, removed } = autoFillWoodWallBeams(roofGraph, PROJECT, wallSegments);
  assert.ok(created.length > 0);
  assert.ok(removed.includes(staleEaves.id), '壁の無い位置の旧方式軒桁(auto)は撤去される');
  assert.equal(roofGraph.beamMap.has(staleEaves.id), false);
});

test('【失敗系・ステップ5】autoFillWoodWallBeams: 手動固定(dimensionStatus!==auto)の軒桁(role:eaves)は屋根専用平面でも保全する', () => {
  const { roofGraph, wallSegments, x1, y0 } = makeRoofWallRunFixture();
  const x2 = roofGraph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT });
  const lockedEaves = roofGraph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x1, x2, { role: 'eaves' });
  lockedEaves.setDimensionStatus('locked');
  const { removed } = autoFillWoodWallBeams(roofGraph, PROJECT, wallSegments);
  assert.ok(!removed.includes(lockedEaves.id), '手動固定の軒桁は保全される');
  assert.ok(roofGraph.beamMap.has(lockedEaves.id));
});

// ---- M-1（QA裁定2026-09-19）: フェーズBの「頭つなぎ」は屋根でも自然に0件にはならない ----
// 「受梁」（自階柱＝graph.columnsが起因）は屋根が自階に柱を持たないため自然に0件のままだが、
// 「頭つなぎ」（下階柱＝belowColumnsが起因）はbelowColumnsに最上階の柱を渡せば通常どおり生成される
// （旧コメント「フェーズBは無改造——…自然に0件」は頭つなぎも0件になると誤って書いていた）。
test('【M-1】autoFillWoodWallBeams: 屋根専用平面で、梁の通っていない最上階の柱の上に頭つなぎが生成される', () => {
  const { roofGraph, wallSegments } = makeRoofWallRunFixture();
  // 矩形の中心(1820,2730)——どの壁線通し梁の上にも乗らない最上階の柱。アンカー解決用にy=2730の
  // 通り芯を張る（頭つなぎ自体はx方向＝短辺方向の総長3640<y方向5460で水平が選ばれる）。
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 2730, { labeled: true, discipline: Discipline.STRUCT });
  const belowColumns = [{ axisX: 1820, axisY: 2730, role: 'primary' }];
  const { created } = autoFillWoodWallBeams(roofGraph, PROJECT, wallSegments, null, belowColumns);
  const tieBeams = created.filter(b => b.beamType === '頭つなぎ');
  assert.ok(tieBeams.length > 0, '梁の通っていない最上階の柱の上に頭つなぎが生成される');
  assert.ok(tieBeams.every(b => b.role === 'primary'), '頭つなぎもrole:primary（アーキ裁定3）');
  // 対照: 自階柱（受梁の起因）は屋根に無いため受梁は生成されない。
  assert.equal(created.filter(b => b.beamType === '受梁').length, 0, '屋根自身に柱は無いため受梁は生成されない');
});

// ---- R-2（2026-09-19是正）: 屋根で自由端が効かない ----
// makeLShapeFreeEndGraph（最上階を模す）は交点(0,2000)しか持たないL字——F-2の自由端(0,0)まで
// 通し梁が伸びなければx=0線に軒桁が生成されない（.claude/structural-model.md「H y=-9100の0..910が
// 唯一の未被覆区間」の再現）。旧実装は`selfWallFreeEnds(graph, ...)`が屋根自身（壁0本）を見るため
// 常に空——freeEndGraph（7番目の引数）に最上階のgraphを渡すことで、その壁の自由端が屋根の
// フェーズAの通し梁run延長点源に加わることを直接固定する。
test('【R-2】autoFillWoodWallBeams: 屋根専用平面で、最上階の自由端で終わる壁線にも軒桁が生成される（freeEndGraph=最上階）', () => {
  const { graph: topGraph, x0, y0, y1 } = makeLShapeFreeEndGraph();
  const wallSegments = selfWallSegments(topGraph);
  const roofGraph = new PlanGraph(new Plane('roof1', 3000, '小屋伏図', 1, 1, false, null, 0, true, 'p1'));
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 屋根自身にもアンカー用の通り芯が要る（本番はautoFillWallBeamAxesが壁由来梁芯CLとして先に生成する）。
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const { created } = autoFillWoodWallBeams(roofGraph, PROJECT, wallSegments, null, [], undefined, topGraph);
  const vBeam = created.find(b => b.isVertical && Math.abs(b.axisValue - x0.value) < 1);
  assert.ok(vBeam, `x=0線に軒桁が自由端(0,0)まで生成されるはず（実際:${created.map(b => `${b.isVertical}:${b.axisValue}`)}）`);
  // clStart/clEndはroofGraph自身のCL（topGraphのy0/y1とはid・インスタンスが異なる）——値で照合する。
  assert.deepEqual([vBeam.clStart.effectiveValue, vBeam.clEnd.effectiveValue].sort((a, b) => a - b), [y0.value, y1.value].sort((a, b) => a - b),
    '自由端(y=0)から交点(y=2000)まで通し1本');
  assert.equal(vBeam.role, 'primary');
  assert.equal(vBeam.beamType, '軒桁', '屋根専用平面ではbeamTypeは軒桁');
});

test('【失敗系・R-2】autoFillWoodWallBeams: freeEndGraph省略時は自階（roofGraph自身）で判定するため、屋根では自由端が効かない（旧実装のまま）', () => {
  const { graph: topGraph, x0 } = makeLShapeFreeEndGraph();
  const wallSegments = selfWallSegments(topGraph);
  const roofGraph = new PlanGraph(new Plane('roof1', 3000, '小屋伏図', 1, 1, false, null, 0, true, 'p1'));
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const { created } = autoFillWoodWallBeams(roofGraph, PROJECT, wallSegments); // freeEndGraph省略
  const vBeam = created.find(b => b.isVertical && Math.abs(b.axisValue - x0.value) < 1);
  assert.ok(!vBeam, 'freeEndGraph省略時は屋根自身（壁0本）の自由端＝空のまま生成されない');
});

test('【統合・R-2】recomputeStructuralForGraph: 屋根専用平面の反映は、最上階の自由端で終わる壁線にも軒桁を生成する', async () => {
  const project = new Project('proj-r2-roof-freeend', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(g1, { axisValue: 0,    clStart: y0, clEnd: y1, isVertical: true });  // 縦壁 x=0（自由端(0,0)）
  addBackingWall(g1, { axisValue: 2000, clStart: x0, clEnd: x1, isVertical: false }); // 横壁 y=2000（自由端(2000,2000)）
  autoFillWallBeamAxes(g1, selfWallSegments(g1));
  const { graph: roofGraph } = project.addPlane(3000, '小屋伏図', 'roof1', 1, 1, false, null, 0, true, 'p1');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 屋根専用平面の作り直し時に最上階の通り芯グリッドが複製される想定を模す（本番の生成経路は範囲外。
  // ここでは自由端(0,0)の解決に要るY方向の基準線（y=0）を含め、最上階と同じグリッドを直接張る）。
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  project.activePlaneId = 'p1';
  const peekMap = { p1: g1 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    const vBeam = roofGraph.beams.find(b => b.isVertical && Math.abs(b.axisValue - 0) < 1 && b.role === 'primary');
    assert.ok(vBeam, `本番配線（belowGraph=g1をfreeEndGraphに使う）でも自由端(0,0)まで軒桁が生成されるはず（実際:${roofGraph.beams.map(b => `${b.isVertical}:${b.axisValue}:${b.role}`)}）`);
    assert.equal(vBeam.beamType, '軒桁');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【統合・ステップ5】autoFillStructuralGrid: 在来木造の屋根専用平面はautoFillRoofBeamsではなくautoFillWoodWallBeams（壁線方式）を通す', () => {
  const { roofGraph, wallSegments } = makeRoofWallRunFixture();
  const project = { planes: [new Plane('p_top', 3000, '最上階', 1, 1)], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  const r = autoFillStructuralGrid(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE, null, [], wallSegments, [], [], [], undefined);
  assert.ok(r.newBeams.length > 0);
  assert.ok(r.newBeams.every(b => b.role === 'primary' && b.beamType === '軒桁'));
  assert.equal(roofGraph.beams.filter(b => b.role === 'eaves').length, 0, '通り芯グリッド方式(role:eaves)は生成されない');
});

test('【不変条件・ステップ5】autoFillStructuralGrid: 非在来（S造。roofBeamPlacement:gridEaves）の屋根専用平面は従来どおりautoFillRoofBeams（role:eaves）のまま', () => {
  const roofGraph = new PlanGraph(new Plane('roof1', 6000, '屋根伏図', 1, 1, false, null, 0, true, 'p_top'));
  roofGraph.structureOverride = 'S造';
  roofGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  roofGraph.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  const project = { planes: [new Plane('p_top', 3000, '最上階', 1, 1)], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  const r = autoFillStructuralGrid(roofGraph, project, 'S造');
  assert.ok(r.newBeams.length > 0);
  assert.ok(r.newBeams.every(b => b.role === 'eaves'), '非在来は従来どおりrole:eavesのまま');
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
  assert.equal(created.length, 0);
  assert.deepEqual(removed, []);
});

test('【失敗系】autoFillWoodFloorBeams: セルが閉じない（1辺欠け）配置は床梁を生成しない', () => {
  const { graph, right } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  graph.beamMap.delete(right.id); // 4辺被覆を崩す
  const { created, removed } = autoFillWoodFloorBeams(graph, PROJECT);
  assert.equal(created.length, 0);
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

test('【旧データ限定・種別ベースへ統一】autoFillWoodFloorBeams: 既存の梁芯CL（fuse）が{labeled:true}（種別beam。通り芯として作図されない旧データ）でも再ブラケットする——移行前はaxisCL.labeled===falseを要求しスキップしていた', () => {
  const { graph, x0, x1 } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const pre = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, {
    labeled: true, discipline: Discipline.FUSE, extentLo: 500, extentHi: 800,
  });
  assert.equal(centerLineKindOf(pre), 'beam', '前提: discipline=FUSEなのでbeam種別（labeled:trueだが通り芯ではない旧データ）');
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  assert.equal(beam.axisCL.id, pre.id, '既存の梁芯CLを再利用する（前提）');
  assert.deepEqual(pre.extentLoRef, { clId: x0.id, offset: 0 },
    '種別ベース（!spansEntireAxis(centerLineKind)）はlabeledを問わず再ブラケットする（移行前はaxisCL.labeled===falseの条件が満たされず据え置かれていた＝500..800のまま）');
  assert.deepEqual(pre.extentHiRef, { clId: x1.id, offset: 0 });
  assert.equal(pre.extentLo, 0);
  assert.equal(pre.extentHi, 2730, '床梁スパン(0..2730)を覆う');
});

test('【旧データ限定・種別ベースへ統一】autoFillWoodFloorBeams: 床梁の軸位置に{labeled:true, discipline:ARCH}（種別center・旧データ）があるとき、移行後は再利用せず新規の梁芯CL(FUSE)を立てる——移行前はそのCLを床梁の軸に再利用していた', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const before = graph.centerLines.length;
  const legacy = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.ARCH });
  assert.equal(centerLineKindOf(legacy), 'center', '前提: discipline=ARCHなのでcenter種別（labeled:trueだが通り芯ではない旧データ）');
  assert.equal(graph.centerLines.length, before + 1);
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  assert.notEqual(beam.axisCL, legacy,
    '種別ベース（structuralAnchorAt tier:primary=[struct,beam]）は中心線を対象にしないため既存CLを再利用せず新規の梁芯CLを立てる（移行前はcl.labeledで一致し既存CLを再利用していた）');
  assert.equal(centerLineKindOf(beam.axisCL), 'beam');
  assert.equal(beam.axisCL.extentLo, 0, '新規CLのextentは床梁スパン(0..2730)をそのまま覆う');
  assert.equal(beam.axisCL.extentHi, 2730);
  assert.equal(legacy.extentLo, null, '旧データのCL自体はextentLo/Hi省略のまま触られない');
  assert.equal(graph.centerLines.length, before + 3, '2本の床梁(1820・3640)がいずれも新規梁芯CLを立てる（1820は再利用されない）');
});

test('【旧データ限定・種別ベースへ統一】autoFillWoodFloorBeams: 床梁の軸位置に{labeled:false, discipline:STRUCT}（種別struct・有限extent）があると、その線を軸に再利用し、extentは再ブラケットしない（全長扱いの種別のため）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const before = graph.centerLines.length;
  const legacy = graph.addCenterLine(CenterLineType.HORIZONTAL, 1820, {
    labeled: false, discipline: Discipline.STRUCT, extentLo: 500, extentHi: 800,
  });
  assert.equal(centerLineKindOf(legacy), 'struct', '前提: discipline=STRUCTなのでstruct種別（labeled:falseだが通り芯として作図されない旧データ）');
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  assert.equal(beam.axisCL, legacy,
    '種別ベース（tier:primaryはlabeledを問わずstruct種別を対象にする）は既存のstruct CLを再利用する（移行前はcl.labeled===falseのため見つからず新規FUSE CLを立てていた）');
  assert.equal(legacy.extentLo, 500, 'struct種別はspansEntireAxis=trueのため再ブラケット条件から外れ、extentは据え置かれる（移行前は新規CLのextentが床梁スパン0..2730になっていた）');
  assert.equal(legacy.extentHi, 800);
  assert.equal(graph.centerLines.length, before + 2, '1820は既存のlegacyを再利用し、3640だけ新規梁芯CLを立てる');
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
  assert.equal(second.created.length, 0);
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
  assert.equal(second.created.length, 0, '除外スロットには再生成しない（3640は既存のため再生成不要で0件）');
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
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.removed, [autoOnly.id], '候補に無いauto床梁は撤去される');
  assert.ok(graph.beamMap.has(locked.id), 'locked指定した床梁は候補が無くなっても残る');
  assert.equal(graph.beamMap.has(autoOnly.id), false);
});

test('autoFillWoodFloorBeams: 在来木造の床梁の端はhost（セルの両辺を作る大梁）の面まで伸びる（クリアランス0。ユーザー裁定2026-09-16「鉄骨造にあった隙間は不要」）（coord1/coord2）', () => {
  const { graph } = buildClosedCellGraph(TRADITIONAL_WOOD_STRUCTURE);
  const { created } = autoFillWoodFloorBeams(graph, PROJECT);
  const beam = created.find(b => Math.abs(b.axisValue - 1820) < 1);
  assert.equal(rulesFor(TRADITIONAL_WOOD_STRUCTURE).pinBeamEndClearanceMm, 0, '在来のクリアランスは0');
  assert.equal(beam.pinEndClearanceMm, 0, '床梁自身が在来ルールのクリアランス0を解決する');
  const half = 120 / 2; // WOOD-120x120の面（縁）まで＝クリアランス無し
  assert.deepEqual(beam.spanForColumns(graph.columns), { coord1: half, coord2: 2730 - half });
  // 鉄骨造の既定（50mm）と異なることを明示——ルール値を変えれば端が動く（SECONDARY_BEAM_CLEARANCE_MM は既定値）。
  assert.equal(SECONDARY_BEAM_CLEARANCE_MM, 50);
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

// ---- B-1回帰: 3c-2b分割点・3d支持点/荷重点はAXIS（axisX/axisY）で取る——下階柱に個別偏心が
// 付いていても（ACTUAL=x/yが動いても）分割本数・成が偏心0のときと同一であること（.claude/
// structural-model.md「AXISで一致・ACTUALで止める」の回帰の本丸）。----
test('【B-1回帰】autoFillWoodWallBeams×autoFillWoodBeamDepths: 下階柱に偏心（ACTUAL≠AXIS）があっても分割本数・成は偏心0のときと同一', () => {
  const baseline = makeTwoRoomGraph();
  const baselineSegs = selfWallSegments(baseline.graph);
  const baselineBelow = [{ x: 3640, y: 0, axisX: 3640, axisY: 0, role: 'standard' }]; // 偏心なし
  const { created: baseCreated } = autoFillWoodWallBeams(baseline.graph, PROJECT, baselineSegs, null, baselineBelow);
  autoFillWoodBeamDepths(baseline.graph, PROJECT, baselineBelow);
  const baseTop = baseCreated.filter(b => !b.isVertical && Math.abs(b.axisValue - baseline.y0.value) < 1);

  const eccentric = makeTwoRoomGraph();
  const eccentricSegs = selfWallSegments(eccentric.graph);
  // ACTUAL(x/y)は偏心で7.5ズレているが、AXIS(axisX/axisY)は同じ3640/0のまま。
  const eccentricBelow = [{ x: 3647.5, y: 7.5, axisX: 3640, axisY: 0, role: 'standard' }];
  const { created: eccCreated } = autoFillWoodWallBeams(eccentric.graph, PROJECT, eccentricSegs, null, eccentricBelow);
  autoFillWoodBeamDepths(eccentric.graph, PROJECT, eccentricBelow);
  const eccTop = eccCreated.filter(b => !b.isVertical && Math.abs(b.axisValue - eccentric.y0.value) < 1);

  assert.equal(eccTop.length, baseTop.length, '分割本数はACTUALの偏心に依存せずAXISだけで決まる');
  assert.equal(eccTop.length, 2, '前提: 下階柱1本で2本に分割される（3c-2b・1と同じ構成）');
  // 2つのgraphは別インスタンス（CL idは一致しない）のため、分割区間は座標（effectiveValue）で比較する。
  const sig = (top) => top.map(b => [b.clStart.effectiveValue, b.clEnd.effectiveValue].sort((a, b) => a - b).join(':')).sort();
  assert.deepEqual(sig(eccTop), sig(baseTop), '分割区間（端の座標）も偏心の有無で変わらない');
  assert.deepEqual(eccTop.map(b => b.sectionDefId).sort(), baseTop.map(b => b.sectionDefId).sort(), '成も偏心の有無で変わらない');
});

// ---- B-1: woodOffsetSideの永続化（graphSnapshot.js serializeGraph/restoreGraph往復）----
test('【B-1】woodOffsetSide: serializeGraph→restoreGraphの往復で保持される（キー欠落の軸は自動=undefinedのまま復元）', () => {
  const { graph, x1, y1 } = makeArchCLGraph();
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {
    woodColumnWidthMm: 105, woodOffsetSide: { x: -1, y: 0 }, eccentricity: { x: -7.5, y: 0 },
  });
  const onlyX = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, { woodOffsetSide: { x: 1 } }, 'only-x-col');
  const bytes = serializeGraph(graph);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, bytes);
  const restoredColumn = restored.columnMap.get(column.id);
  const restoredOnlyX = restored.columnMap.get(onlyX.id);
  assert.deepEqual(restoredColumn.woodOffsetSide, { x: -1, y: 0 });
  assert.deepEqual(restoredColumn.eccentricity, { x: -7.5, y: 0 });
  assert.deepEqual(restoredOnlyX.woodOffsetSide, { x: 1 }, 'キー欠落のy軸は復元後も存在しない（自動のまま）');
});

test('【失敗系・B-1】woodOffsetSide: null（未指定＝共通の初期値）の柱はserializeGraph→restoreGraph往復後もnullのまま', () => {
  const { graph, x1, y1 } = makeArchCLGraph();
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, y1, {});
  assert.equal(column.woodOffsetSide, null);
  const bytes = serializeGraph(graph);
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, bytes);
  assert.equal(restored.columnMap.get(column.id).woodOffsetSide, null);
});

// ---- B-1: recomputeStructuralForGraphへの配線（conformWoodColumnEccentricityがchangedに乗る・冪等）----
test('【統合・B-1】recomputeStructuralForGraph: 個別柱寸を持つ壁上の柱は偏心し、changedへ反映され、再計算は冪等', async () => {
  const { graph, x0, y0 } = makeTwoRoomGraph();
  const project = new Project('proj', 'test'); // memberGroupLedger/memberNumberIndex等が必要（conformToLedger）

  const first = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(first.changed, true, '初回は壁交点柱等の生成でchanged=true');
  const corner = graph.columns.find(c => Math.abs(c.axisX - x0.value) < 1 && Math.abs(c.axisY - y0.value) < 1);
  assert.ok(corner, '前提: (x0,y0)のコーナーに柱が立っている');
  assert.deepEqual(corner.eccentricity, { x: 0, y: 0 }, '前提: 共通柱は偏心ゼロ');

  const settled = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(settled.changed, false, '前提: 個別指定前の状態は既に収束している（冪等）');

  // 個別柱寸（105。階の値120と異なる）へ変更 → 壁の中で偏心するはず。
  corner.setField('woodColumnWidthMm', 105);
  const afterOverride = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(afterOverride.changed, true, '偏心の更新がchangedのORに反映されている（加算漏れがあると常にfalseになる）');
  assert.notDeepEqual({ ...corner.eccentricity }, { x: 0, y: 0 }, 'コーナー柱は外壁に接するため偏心する');

  const afterOverrideSettled = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(afterOverrideSettled.changed, false, '偏心が既にconform済みなら再計算は冪等（changed=false）');

  // 共通へ戻すと偏心ゼロへ戻る。
  corner.setField('woodColumnWidthMm', null);
  const afterRevert = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(afterRevert.changed, true);
  assert.deepEqual({ ...corner.eccentricity }, { x: 0, y: 0 }, '共通へ戻すと偏心ゼロへ正規化される');
});

// ---- autoFillWoodSillBeams（土台。role:'sill'、記号SL。基礎伏図＝最下階専用。2026-09-18仕様）----
// makeTwoRoomGraph（x0=0,x1=3640,x2=7280,y0=0,y1=3640）の壁線through-run（top:y0 x0..x2 等）が
// 候補源(a)。候補源(b)は既存の基礎梁（role:'foundation'）のスパンそのもの。

test('autoFillWoodSillBeams: 壁線through-runと基礎梁スパンの和集合を候補にする（基礎梁は壁の有無に依らない第2候補源）。両者は共存する', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  // 壁の無い位置（y=-2000）に基礎梁だけを置く（べた基礎の通り芯グリッド辺を模す）。
  const yGridOnly = graph.addCenterLine(CenterLineType.HORIZONTAL, -2000, { labeled: true, discipline: Discipline.STRUCT });
  const foundationOnly = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', yGridOnly, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);

  const fromWall = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(fromWall.length, 1, '壁線run由来の土台(y=0)');
  assert.equal(fromWall[0].role, 'sill');
  assert.equal(fromWall[0].beamType, '土台');

  const fromFoundation = created.filter(b => !b.isVertical && Math.abs(b.axisValue - yGridOnly.value) < 1);
  assert.equal(fromFoundation.length, 1, '基礎梁のみの位置(y=-2000)にも土台が生成される（壁が無くても）');
  assert.deepEqual([fromFoundation[0].clStart.id, fromFoundation[0].clEnd.id].sort(), [x0.id, x2.id].sort());
  assert.equal(graph.beamMap.has(foundationOnly.id), true, '基礎梁自体は撤去されず共存する');
});

test('autoFillWoodSillBeams: 基礎梁と同じ位置（同spanKey）に壁もあれば、候補はdedupeされ土台1本だけ生成される。基礎梁とは別部材として共存する', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const atY0 = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(atY0.length, 1, '同じ位置(spanKey)の候補は1本にdedupeされる');
  const membersAtY0 = graph.beams.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.deepEqual(membersAtY0.map(b => b.role).sort(), ['foundation', 'sill'], '土台と基礎梁は別部材として同じ位置に共存する');
});

// ---- 2026-09-18裁定「1階の土台が同軸で重複」修正: 候補源(a)壁線through-runを優先し、候補源(b)
// 基礎梁スパンは(a)のrunの和集合で覆われた分を差し引いた残りだけを候補にする ----

// 部屋Aだけ（x0..x1）を持つ1部屋フィクスチャ——y0の壁線through-runは[0,3640]止まりで、x2(7280)は
// 壁の無い裸のCLとして残る（基礎梁の遠端に使う）。makeTwoRoomGraphは常に2部屋（run全長[0,7280]）に
// なるため、部分被覆を作るには別フィクスチャが要る。
function makeOneRoomGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 7280, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const roomA = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, roomA);
  return { graph, x0, x1, x2, y0, y1 };
}

test('【裁定・完全被覆】autoFillWoodSillBeams: 壁線runが基礎梁スパン2本を覆うとき土台は通し1本だけ（重複しない）', () => {
  const { graph, x0, x1, x2, y0 } = makeTwoRoomGraph(); // y0のrunは全長[0,7280]
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x1, { role: 'foundation' }); // 基礎梁(b)を通り芯ごとに分割
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x1, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const atY0 = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(atY0.length, 1, '通し(a)の1本だけが土台になる（(b)の2本は完全に覆われ候補から外れる）');
  assert.deepEqual([atY0[0].clStart.id, atY0[0].clEnd.id].sort(), [x0.id, x2.id].sort(), '通しの全長[0,7280]');
});

test('【裁定・部分被覆】autoFillWoodSillBeams: 壁線runが基礎梁スパンの一部だけを覆うとき、残り区間だけが追加候補になる', () => {
  const { graph, x0, x1, x2, y0 } = makeOneRoomGraph(); // y0のrunは[0,3640]（部屋Aの分だけ）
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x2, { role: 'foundation' }); // 基礎梁(b)は全長[0,7280]
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const atY0 = created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1)
    .map(b => [b.clStart.id, b.clEnd.id].sort()).sort();
  assert.deepEqual(atY0, [[x0.id, x1.id].sort(), [x1.id, x2.id].sort()].sort(),
    '(a)の[0,3640]＋(b)の残り[3640,7280]の2本（重複せず、境界はx1で揃う）');
});

test('【裁定・被覆なし】autoFillWoodSillBeams: 同軸に壁線runが無ければ基礎梁スパンはそのまま候補になる（従来どおり）', () => {
  const { graph, x0, x2 } = makeTwoRoomGraph();
  const yGridOnly = graph.addCenterLine(CenterLineType.HORIZONTAL, -2000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', yGridOnly, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const atGrid = created.filter(b => !b.isVertical && Math.abs(b.axisValue - yGridOnly.value) < 1);
  assert.equal(atGrid.length, 1, '壁の無い通り芯辺の基礎梁上は従来どおり土台が1本出る');
  assert.deepEqual([atGrid[0].clStart.id, atGrid[0].clEnd.id].sort(), [x0.id, x2.id].sort());
});

test('【裁定・冪等】autoFillWoodSillBeams: 部分被覆の差し引き後も2回目はcreated0・removed0', () => {
  const { graph, x0, x2, y0 } = makeOneRoomGraph();
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs);
  const again = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.deepEqual([again.created.length, again.removed.length], [0, 0]);
});

test('【裁定・既存重複の解消】autoFillWoodSillBeams: 保存済みの重複auto土台（通しと分割の併存）は再計算で撤去される', () => {
  const { graph, x0, x1, x2, y0 } = makeTwoRoomGraph(); // y0のrunは全長[0,7280]
  // 旧実装が生成しうた重複状態を直接再現する: 通し[0,7280]＋分割済み[0,3640]・[3640,7280]の3本が併存。
  const section = rulesFor(TRADITIONAL_WOOD_STRUCTURE).defaultSections.beam;
  const through = graph.addBeam(StructuralMaterialType.WOOD, section, y0, false, x0, x2, { role: 'sill', beamType: '土台' });
  const dupA = graph.addBeam(StructuralMaterialType.WOOD, section, y0, false, x0, x1, { role: 'sill', beamType: '土台' });
  const dupB = graph.addBeam(StructuralMaterialType.WOOD, section, y0, false, x1, x2, { role: 'sill', beamType: '土台' });
  const segs = selfWallSegments(graph);
  const { removed } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.deepEqual(removed.sort(), [dupA.id, dupB.id].sort(), '分割済みの重複2本は撤去され、通し1本は残る');
  assert.equal(graph.beamMap.has(through.id), true, '通し(候補源aと同じ全長)は候補に残り続けるため撤去されない');
});

test('autoFillWoodSillBeams: 冪等（2回目はcreated0・removed0）', () => {
  const { graph, x0, x2 } = makeTwoRoomGraph();
  const yGridOnly = graph.addCenterLine(CenterLineType.HORIZONTAL, -2000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', yGridOnly, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs);
  const again = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.deepEqual([again.created.length, again.removed.length], [0, 0]);
});

test('autoFillWoodSillBeams: 壁が消えた（wallSegmentsから外れた）位置の土台は撤去されるが、基礎梁上に生成された土台は残る', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const yGridOnly = graph.addCenterLine(CenterLineType.HORIZONTAL, -2000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', yGridOnly, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.equal(graph.beams.filter(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1).length, 1, '前提: 壁由来の土台がある');

  const { removed, created } = autoFillWoodSillBeams(graph, PROJECT, []); // 壁が消えた想定（wallSegments空）
  assert.equal(created.length, 0, '基礎梁上の土台は既に存在するため再生成されない');
  assert.equal(graph.beams.filter(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1).length, 0, '壁由来の土台は撤去される');
  assert.equal(graph.beams.filter(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - yGridOnly.value) < 1).length, 1, '基礎梁上の土台は撤去されず残る');
  assert.ok(removed.length > 0, '壁由来の土台のidが撤去配列に含まれる');
});

test('【失敗系】autoFillWoodSillBeams: excludedBeamSlotsにあるスロットは生成しない（手動削除の尊重。撤去対象にも含める）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  graph.excludedBeamSlots.add(beamExclusionKey('sill', y0, x0, x2));
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.equal(created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1).length, 0, '除外スロットは生成しない');
});

test('【失敗系・Minor-2】autoFillWoodSillBeams: 候補源(b)（基礎梁由来）も除外キー（sill名前空間）を尊重する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x1, { role: 'foundation' });
  graph.excludedBeamSlots.add(beamExclusionKey('sill', y0, x0, x1)); // このスロットの土台は既に手動削除済みという想定
  const { created } = autoFillWoodSillBeams(graph, PROJECT); // wallSegments省略＝候補源(a)は0件、候補は(b)のみ
  assert.equal(created.length, 0, '候補源(b)由来でも除外キー（sill名前空間）があれば生成しない');
});

// ---- Major-1（QA裁定2026-09-18）: 除外キーの分離（土台と基礎梁は同一spanKeyを共有しうるため、
// bareのspanKeyで除外判定すると片方のremoveBeamがもう片方まで巻き込む事故になる） ----
test('【Major-1】autoFillWoodSillBeams: 基礎梁をremoveBeamで削除した後でも、壁があれば土台は生成される（除外キーの分離）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const foundationBeam = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs);
  const sill = graph.beams.find(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(sill, '前提: 壁由来の土台が生成されている');

  graph.removeBeam(foundationBeam.id); // 基礎梁をユーザーが削除（bareのspanKeyをexcludedBeamSlotsへ記録）
  graph.beamMap.delete(sill.id); // 土台自体は除外を記録せず直接消す（壁は残ったまま。再評価の準備）

  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const regenerated = created.find(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(regenerated, '基礎梁の除外キー（bareのspanKey）に巻き込まれず、壁由来の土台が再生成される（修正前は生成されなかった）');
});

test('【Major-1】autoFillWoodSillBeams: 土台をremoveBeamで削除しても、同位置に基礎梁を追加し直すのは妨げられない（除外キーの分離）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const foundationBeam = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs);
  const sill = graph.beams.find(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(sill, '前提: 土台がある');

  graph.removeBeam(sill.id); // 土台を削除（'sill:'名前空間の除外キーを記録）
  graph.removeBeam(foundationBeam.id); // 基礎梁も削除（bareのspanKeyの除外キーを記録）

  // 基礎梁を手動で追加し直す（構造リストの「＋追加」相当）。addBeamは自分のrole（'foundation'＝bare
  // spanKey）のexclusionKeyだけを削除するため、土台のremoveBeamで記録された'sill:'キーには影響されない。
  const recreated = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x2, { role: 'foundation' });
  assert.ok(recreated, '基礎梁は問題なく再追加できる（土台の除外に巻き込まれない）');
  assert.equal(graph.excludedBeamSlots.has(spanKey(y0, x0, x2)), false, '基礎梁自身の除外は解除される');
  assert.equal(graph.excludedBeamSlots.has(beamExclusionKey('sill', y0, x0, x2)), true, '土台の除外キーは基礎梁の追加とは独立に残る');
});

test('【Major-1】autoFillWoodSillBeams: 土台をremoveBeamすると、壁・基礎梁が残っていても土台だけが再生成されない（除外は効く）', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const foundationBeam = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x2, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs);
  const sill = graph.beams.find(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(sill);

  graph.removeBeam(sill.id); // 土台をユーザーが明示削除
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.equal(created.some(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1), false, '除外されたスロットには再生成しない');
  assert.equal(graph.beams.some(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1), false, '土台は復活しない');
  assert.equal(graph.beamMap.has(foundationBeam.id), true, '基礎梁自身は無事（土台の除外に巻き込まれない）');
});

test('【Major-1・QA実測】autoFillWoodSillBeams: 除外した壁線run（候補源a）の位置に、粒度の違う基礎梁（候補源b）が土台を生成し直さない', () => {
  // QA実測（moku1等）の再現: (a)は通し1本[0,7280]だが、(b)は同じ範囲を粒度違いの2本
  // [0,3640]・[3640,7280]で持つ——旧実装は(a)を除外するとcoveringが空になり、(b)の2本が
  // そのまま候補として復活し、ユーザーが消したはずの土台が別の分割で湧いていた（同軸重複の温床）。
  const { graph, x0, x1, x2, y0 } = makeTwoRoomGraph(); // y0のrunは全長[0,7280]
  const segs = selfWallSegments(graph);
  const first = autoFillWoodSillBeams(graph, PROJECT, segs);
  const sillFromWall = first.created.find(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(sillFromWall, '前提: (a)由来の通し土台が立っている');
  graph.removeBeam(sillFromWall.id); // 通し土台をユーザーが明示削除（除外集合に記録）

  // (a)とは異なる粒度の基礎梁を追加する（実データの「基礎梁自体が同軸で重複」に相当）。
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x1, { role: 'foundation' });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x1, x2, { role: 'foundation' });
  const second = autoFillWoodSillBeams(graph, PROJECT, segs);
  const atY0 = second.created.filter(b => !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  // 比較はlength（entityのdeepEqualは循環参照を持つMobXオブジェクトの差分表示でOOMする事故を避ける）。
  assert.equal(atY0.length, 0, '除外した位置に候補源(b)由来の土台が湧かない（ユーザーの削除が効き続ける）');
  const membersAtY0 = graph.beams.filter(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.equal(membersAtY0.length, 0, '同軸に土台が1本も残らない（重複の芽が無い）');
});

test('【Major-1】autoFillWoodSillBeams: (a)の無い軸で粒度の違う基礎梁が重なっていても、(b)どうしの差し引きで土台は重ならない', () => {
  const { graph, x0, x1 } = makeTwoRoomGraph();
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yGridOnly = graph.addCenterLine(CenterLineType.HORIZONTAL, -2000, { labeled: true, discipline: Discipline.STRUCT });
  // 通し[0,3640]と、分割済み[0,1820]+[1820,3640]の3本の基礎梁が同軸に存在する
  // （基礎梁自体の重複はこの関数の対象外の別ステップの事象——本関数はそれを重複させず土台へ写す）。
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', yGridOnly, false, x0, x1, { role: 'foundation' });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', yGridOnly, false, x0, xMid, { role: 'foundation' });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', yGridOnly, false, xMid, x1, { role: 'foundation' });
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const atGrid = created.filter(b => !b.isVertical && Math.abs(b.axisValue - yGridOnly.value) < 1);
  assert.equal(atGrid.length, 1, '通し[0,3640]が優先され、細かい2本は完全に覆われて候補から外れる（重ならない）');
  assert.deepEqual([atGrid[0].clStart.id, atGrid[0].clEnd.id].sort(), [x0.id, x1.id].sort());
});

// ---- Minor-2（QA裁定2026-09-18）: 自階フットプリント外の壁線runには生成しない ----
test('【Minor-2】autoFillWoodSillBeams: 自階フットプリント外の壁線runには土台を生成しない', () => {
  const { graph, y0, y1 } = makeTwoRoomGraph(); // 部屋があるためselfGateが立つ
  // 部屋から大きく離れた位置に、壁線runとして解決できる矩形（通り芯4本・壁区間4辺）だけを追加する。
  // フットプリント（部屋セル）が無い位置なので selfGate.spanInBuilding が false を返すはず。
  const farX0 = graph.addCenterLine(CenterLineType.VERTICAL, 20000, { labeled: true, discipline: Discipline.STRUCT });
  const farX1 = graph.addCenterLine(CenterLineType.VERTICAL, 22000, { labeled: true, discipline: Discipline.STRUCT });
  const farSegs = [
    { isVertical: false, coord: y0.value, lo: 20000, hi: 22000 },
    { isVertical: false, coord: y1.value, lo: 20000, hi: 22000 },
    { isVertical: true, coord: 20000, lo: y0.value, hi: y1.value },
    { isVertical: true, coord: 22000, lo: y0.value, hi: y1.value },
  ];
  void farX0; void farX1; // アンカーCLとして存在させるだけでよいので変数へは受けない
  const segs = [...selfWallSegments(graph), ...farSegs];
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const farCreated = created.filter(b =>
    (b.isVertical && (Math.abs(b.axisValue - 20000) < 1 || Math.abs(b.axisValue - 22000) < 1)) ||
    (!b.isVertical && Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue) >= 20000));
  assert.equal(farCreated.length, 0, '自階フットプリント外の壁線runには土台を生成しない');
});

test('【失敗系】autoFillWoodSillBeams: 撤去ループはrole:sillだけを対象にする（同じ階に居るrole:primaryのWOOD梁を誤って撤去しない）', () => {
  const { graph, x0, x2 } = makeTwoRoomGraph();
  const yOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  const primaryBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yOther, false, x0, x2, { role: 'primary' });
  const segs = selfWallSegments(graph);
  const { removed } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.equal(removed.includes(primaryBeam.id), false, 'role:primaryの梁は撤去対象に含めない（候補に無くてもrole:sillでなければ撤去ループの対象外）');
  assert.equal(graph.beamMap.has(primaryBeam.id), true);
});

test('【失敗系】autoFillWoodSillBeams: 手動固定（dimensionStatus!=="auto"）の土台は候補から外れても撤去されない', () => {
  const { graph, x0, x2 } = makeTwoRoomGraph();
  const yOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  const locked = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yOther, false, x0, x2, { role: 'sill', beamType: '土台' });
  locked.setDimensionStatus('locked');
  const segs = selfWallSegments(graph);
  const { removed } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.equal(removed.includes(locked.id), false, '手動固定は撤去されない');
  assert.equal(graph.beamMap.has(locked.id), true);
});

test('【失敗系】autoFillWoodSillBeams: wallSegments省略・nullはいずれも「壁の候補なし」として扱い、基礎梁由来の候補だけを見る（例外を投げない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x1, { role: 'foundation' });
  let result;
  assert.doesNotThrow(() => { result = autoFillWoodSillBeams(graph, PROJECT); }); // wallSegments省略
  assert.equal(result.created.length, 1, '基礎梁由来の土台が1本生成される');
  const again = autoFillWoodSillBeams(graph, PROJECT, null); // 明示的にnull
  assert.deepEqual([again.created.length, again.removed.length], [0, 0], '既存の土台と重複せず冪等');
});

test('【失敗系】autoFillWoodSillBeams: 非在来（framingを持たない主構造）で既存の土台が無ければ0/0のまま', () => {
  const { graph } = makeTwoRoomGraph();
  graph.structureOverride = 'S造';
  const segs = selfWallSegments(graph);
  const { created, removed } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.deepEqual([created.length, removed.length], [0, 0]);
});

// ---- Major-2（QA裁定2026-09-18）: 非在来では自動生成分の土台を撤去し、locked分は保持・材種不変 ----
test('【Major-2】autoFillWoodSillBeams: 非在来（framingを持たない主構造）は自動生成分のrole:sillを撤去する。locked分は保持され材種も変わらない', () => {
  const { graph, x0, x2, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs); // 在来木造として生成
  const autoSill = graph.beams.find(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(autoSill, '前提: 自動生成の土台がある');

  const yOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  const lockedSill = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', yOther, false, x0, x2, { role: 'sill', beamType: '土台' });
  lockedSill.setDimensionStatus('locked');

  graph.structureOverride = 'S造'; // 非在来へ切替え
  const { created, removed } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.equal(created.length, 0);
  assert.equal(removed.includes(autoSill.id), true, '自動生成分は撤去される');
  assert.equal(graph.beamMap.has(autoSill.id), false);
  assert.equal(graph.beamMap.has(lockedSill.id), true, 'lockedは保持される');
  assert.equal(lockedSill.materialType, StructuralMaterialType.WOOD, '材種はautoFillWoodSillBeams自体が変更しない');
});

test('【Major-2・統合】recomputeStructuralForGraph: 在来→S造へ切替えると自動生成の土台(role:sill)は0本になる。locked分は保持され材種も変換対象外', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階');
  const { graph: g2 } = project.addPlane(2400, '2階');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);

  // floorSwapManagerはIndexedDBに依存するため、テスト用に一時的に差し替える（他のrecomputeStructuralForGraph
  // 統合テストと同じパターン。3bの上階柱peek(peekAboveGraph)がg2を実IDB無しで読めるようにする）。
  const peekMap = { [g1.plane.id]: g1, [g2.plane.id]: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await recomputeStructuralForGraph(g1, project, TRADITIONAL_WOOD_STRUCTURE);
    const autoSills = g1.beams.filter(b => b.role === 'sill');
    assert.ok(autoSills.length > 0, '前提: 在来木造で土台が生成されている');
    const lockedSill = autoSills[0];
    lockedSill.setDimensionStatus('locked');
    const lockedId = lockedSill.id;
    const materialBefore = lockedSill.materialType;

    g1.structureOverride = 'S造';
    await recomputeStructuralForGraph(g1, project, 'S造');

    const remainingSills = g1.beams.filter(b => b.role === 'sill');
    assert.deepEqual(remainingSills.map(b => b.id), [lockedId], 'auto分の土台は撤去され、locked分だけが残る');
    assert.equal(remainingSills[0].dimensionStatus, 'locked');
    assert.equal(remainingSills[0].materialType, materialBefore, 'locked分の材種は変換対象外のため不変（convertMembersToEffectiveMaterialがrole:sillを触らない）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('【Major-2】convertMembersToEffectiveMaterial: role:sillの梁は材種変換の対象外', () => {
  const { graph, y0 } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  autoFillWoodSillBeams(graph, PROJECT, segs);
  const sill = graph.beams.find(b => b.role === 'sill' && !b.isVertical && Math.abs(b.axisValue - y0.value) < 1);
  assert.ok(sill);
  assert.equal(sill.materialType, StructuralMaterialType.WOOD);

  graph.structureOverride = 'S造';
  const { convertedBeams } = convertMembersToEffectiveMaterial(graph, PROJECT, 'S造');
  assert.equal(convertedBeams.includes(sill.id), false, '土台は変換対象に含まれない');
  assert.equal(sill.materialType, StructuralMaterialType.WOOD, '材種は変わらない');
});

test('autoFillWoodSillBeams: levelOffsetはsillTopLevelOffsetMm相当(-100)、beamTypeは土台固定、材種・roleとも一貫する', () => {
  const { graph } = makeTwoRoomGraph();
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.ok(created.length > 0);
  for (const b of created) {
    assert.equal(b.levelOffset, -100);
    assert.equal(b.beamType, '土台');
    assert.equal(b.role, 'sill');
    assert.equal(b.materialType, StructuralMaterialType.WOOD);
  }
});

test('autoFillWoodSillBeams: 断面は生成時rules.defaultSections.beam（120角）で作られ、conformWoodSectionsで階の柱寸（woodColumnWidthMm）へ揃う', () => {
  const { graph } = makeTwoRoomGraph();
  graph.setWoodColumnWidthMm(105); // 「各階柱寸法」欄の上書き相当
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  assert.ok(created.length > 0);
  assert.ok(created.every(b => b.sectionDefId === 'WOOD-120x120'), '生成直後はルール既定（120角）のまま');
  conformWoodSections(graph, PROJECT);
  assert.ok(created.every(b => b.sectionDefId === 'WOOD-105x105'), 'conformWoodSectionsで階の柱寸(105)へ揃う（他の梁と同じ経路）');
});

test('【Major-3】conformWoodSections: dimensionStatus="locked"の土台も柱寸（105設定時WOOD-105x105）へそろい、idがupdatedに載る。続けて呼ぶと[]', () => {
  const { graph } = makeTwoRoomGraph();
  graph.setWoodColumnWidthMm(105);
  const segs = selfWallSegments(graph);
  const { created } = autoFillWoodSillBeams(graph, PROJECT, segs);
  const sill = created[0];
  sill.setDimensionStatus('locked');
  assert.equal(sill.sectionDefId, 'WOOD-120x120', '前提: 生成直後はルール既定（120角）のまま');

  const updated = conformWoodSections(graph, PROJECT);
  assert.ok(updated.includes(sill.id), 'lockedの土台もconformWoodSectionsの対象になり、idがupdatedに載る');
  assert.equal(sill.sectionDefId, 'WOOD-105x105');

  const again = conformWoodSections(graph, PROJECT);
  assert.deepEqual(again, [], '続けて呼ぶと変化なし（冪等）');
});

// ---- autoFillStructuralGrid への配線（基礎伏図のみで呼ばれる）----
test('【統合】autoFillStructuralGrid: 基礎伏図（1階、rank0）はrole:foundationの生成直後にrole:sill（土台）も生成する', () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階');
  project.addPlane(2400, '2階');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  const segs = selfWallSegments(g1);
  autoFillStructuralGrid(g1, project, TRADITIONAL_WOOD_STRUCTURE, null, [], segs);
  const foundationBeams = g1.beams.filter(b => b.role === 'foundation');
  assert.ok(foundationBeams.length > 0, '前提: 基礎梁（通り芯グリッド辺）が生成される');
  const sills = g1.beams.filter(b => b.role === 'sill');
  assert.ok(sills.length > 0, '土台（role:sill）も生成される');
  assert.ok(sills.every(b => b.beamType === '土台' && b.materialType === StructuralMaterialType.WOOD));
});

test('【統合】autoFillStructuralGrid: 非基礎伏図（2階、rank1）ではautoFillWoodSillBeamsは呼ばれない（role:sillは生成されない）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階');
  const { graph: g2 } = project.addPlane(2400, '2階');
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const room = g2.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g2, room);
  const segs = selfWallSegments(g2);
  autoFillStructuralGrid(g2, project, TRADITIONAL_WOOD_STRUCTURE, null, [], segs);
  assert.equal(g2.beams.filter(b => b.role === 'sill').length, 0, '非基礎伏図（2階）ではrole:foundationを生成しないためautoFillWoodSillBeamsも呼ばれない');
});

// 【F2・changed加算漏れの直接固定】上のテストは個別柱寸を変えた瞬間に conformWoodSections（sectionDefId）
// も同時に変わるため、そちらのORだけでchanged=trueになってしまい「updatedColumnEccの加算漏れ」を
// 単独では検出できない（両者は常に同時に変化するため）。ここでは sectionDefId 側を意図的に先に
// 収束させたうえで eccentricity だけを人為的にズラし、conformWoodColumnEccentricity の更新“だけ”が
// changed へ寄与することを確認する（QA裁定: 保存・undoが加算漏れで空になる事故の直接固定）。
test('【統合・B-1・F2】recomputeStructuralForGraph: 断面(sectionDefId)は既に収束済みでeccentricityだけがズレている場合でも、その更新だけでchanged=trueになる', async () => {
  const { graph, x0, y0 } = makeTwoRoomGraph();
  const project = new Project('proj', 'test');
  await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  const corner = graph.columns.find(c => Math.abs(c.axisX - x0.value) < 1 && Math.abs(c.axisY - y0.value) < 1);
  corner.setField('woodColumnWidthMm', 105);
  await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE); // sectionDefId・eccentricityとも収束
  assert.equal(corner.sectionDefId, 'WOOD-105x105', '前提: 断面は既に個別柱寸へ収束済み');
  const converged = { ...corner.eccentricity };
  assert.notDeepEqual(converged, { x: 0, y: 0 }, '前提: 収束済みの偏心は非ゼロ');

  // sectionDefIdはそのまま・eccentricityだけを直接ズラす（conformWoodSectionsは変化させない状況を作る）。
  corner.setField('eccentricity', { x: 0, y: 0 });
  const { changed } = await recomputeStructuralForGraph(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(changed, true, 'eccentricityの再conformだけでchangedがtrueになる（加算漏れがあるとfalseのまま）');
  assert.deepEqual({ ...corner.eccentricity }, converged, '偏心は収束済みの値へ戻る');
});

// ================================================================
// 3i（梁の支持長1820ルール。ユーザー指示2026-09-19）: aboveBeamSegments（role:'primary'）の支持長が
// 1820を超え、自階に平行な壁があれば柱を追加する。フィクスチャ: 横壁 y=2000 が x=[0,span] を通しで走る
// （縦壁 x=0・x=span との交点で through-run が [0,span] になる）。
// ================================================================
function makeSupportSpanWallGraph({ span = 3640 } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, span, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const hWall = addBackingWall(graph, { axisValue: 2000, clStart: x0, clEnd: x1, isVertical: false });
  addBackingWall(graph, { axisValue: 0,    clStart: y0, clEnd: y1, isVertical: true });
  addBackingWall(graph, { axisValue: span, clStart: y0, clEnd: y1, isVertical: true });
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  const wallSegments = selfWallSegments(graph);
  const aboveBeamSegments = [{ isVertical: false, coord: 2000, lo: 0, hi: span, role: 'primary' }];
  return { graph, x0, x1, y0, y1, hWall, wallSegments, aboveBeamSegments };
}

// makeSupportSpanWallGraphはコの字（3辺）形状のため、3aの交点2本（(0,2000)・(3640,2000)＝
// hWallと縦壁の角）のほかにF-1の自由端2本（(0,0)・(3640,0)＝縦壁2本の開放端）が付随する。
const SUPPORT_SPAN_3A_TARGET = [[0, 2000], [3640, 2000]];

test('autoFillWoodColumns（3i・1）: 梁の支持長が1820を超え、下階に平行な壁があれば910グリッドへ柱を追加する（CLが無い場合）', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph();
  const base = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments); // aboveBeamSegments省略=3iなし
  assert.equal(splitFreeEndColumns(graph, base.created, SUPPORT_SPAN_3A_TARGET).length, 2, '前提: 3aの交点2本のみ（(0,2000)・(3640,2000)）');
  // baseの呼び出しで3a・自由端は既にgraphへ確定済みのため、ここでの新規created分は3i候補のみ。
  const { created, removed, iiPicks } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  assert.equal(created.length, 1, '3aの2本(既存)＋3i(1本、中央1820)');
  const col = created[0];
  assert.deepEqual([col.axisX, col.axisY], [1820, 2000], '3iの柱は梁と同じ軸(y=2000)・中央(x=1820)に立つ');
  assert.ok(col.woodAxisOffset, '走行方向に厳密一致するCLが無いためオフセットアンカー（910グリッド）');
  assert.deepEqual(removed, []);
  assert.equal(iiPicks.length, 1, 'iiPicks（診断用の由来内訳）にも1件積まれる');
  assert.equal(iiPicks[0].kind, 'grid', 'kindはgrid（走行方向に厳密一致するCLが無いため）');
  assert.deepEqual([iiPicks[0].x, iiPicks[0].y], [1820, 2000]);
});

test('autoFillWoodColumns（3i・2）: 走行方向に厳密一致する通り芯があればそれを使う（オフセットにしない）', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const { created, iiPicks } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  const col = created.find(c => Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY - 2000) < 1);
  assert.ok(col, '前提: 3iの柱が(1820,2000)に立つ');
  assert.equal(col.woodAxisOffset, null, '通り芯に厳密一致したのでオフセットではなく通常のCLペア');
  assert.equal(iiPicks.find(p => p.x === 1820 && p.y === 2000)?.kind, 'struct', 'iiPicksのkindはstruct（通り芯に厳密一致）');
});

test('autoFillWoodColumns（支持長超過）: 走行方向の追加柱の候補は通り芯・中心線のみで、採用窓の内側にある梁芯CLは候補にならない（910グリッドの位置がそのまま採用される）', () => {
  // span=3000にする（既定span=3640だとsupportSpanColumnPositions内部の採用窓が[1820,1820]の1点に
  // 退化し、梁芯の位置がその1点に無い限り「候補から除外されたから採用されない」のか「そもそも窓の外
  // だから採用されない」のか区別できない——2026-09-21一般化のQA実測: SUPPORT_SPAN_COLUMN_KINDSに'beam'
  // を足す変異でもこの穴のせいで本テストは緑のままだった）。span=3000は窓[1180,1820]（ideal=1500）に
  // 幅を持たせるため、梁芯を窓内・かつグリッド採用位置(1820)とは別の点(1400)に置いて区別できる。
  const span = 3000;
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph({ span });
  const target = [[0, 2000], [span, 2000]]; // makeSupportSpanWallGraphのコの字コーナー（3aの交点）
  // 走行方向(x)の1400（採用窓[1180,1820]内・910グリッドの採用位置1820とは異なる点）に梁芯CLだけを置く。
  // SUPPORT_SPAN_COLUMN_KINDS=['struct','center']は梁芯を候補にしないため、この梁芯は無視され、
  // 3i・2の通り芯版とは異なり3i・1と同じ910グリッド(1820)に柱が立つはず（梁芯の位置(1400)には立たない）。
  graph.addCenterLine(CenterLineType.VERTICAL, 1400, { labeled: false, discipline: Discipline.FUSE });
  const { created, iiPicks } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  const col = created.find(c => Math.abs(c.axisY - 2000) < 1
    && !target.some(([x, y]) => Math.abs(c.axisX - x) < 1 && Math.abs(c.axisY - y) < 1));
  assert.ok(col, '前提: 3iの柱が1本立つ');
  assert.equal(Math.round(col.axisX), 1820, '梁芯の位置(1400)ではなく910グリッド(1820)に立つ');
  assert.ok(col.woodAxisOffset, '梁芯は候補にならないため、走行方向に厳密一致するCLが無い扱い＝オフセットアンカー（910グリッド）のまま');
  assert.equal(iiPicks.find(p => Math.abs(p.x - 1820) < 1 && p.y === 2000)?.kind, 'grid',
    'iiPicksのkindはgrid（梁芯は候補に入らないため3i・1と同じ結果）');
});

test('【失敗系】autoFillWoodColumns（3i・3）: 自階に平行な壁が無ければ柱を追加しない', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph();
  // 梁の位置(y=2000)ではなく別の位置(y=3000)に壁があるかのように差し替える——「梁の真下に平行な壁が無い」を再現
  // （この位置にはCLも無いためaxisCL自体が解決できず見送られる。軸は解決できるが壁が無いケースは3i・3bで見る）。
  const noWallAbove = aboveBeamSegments.map(s => ({ ...s, coord: 3000 }));
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, noWallAbove);
  assert.equal(splitFreeEndColumns(graph, created, SUPPORT_SPAN_3A_TARGET).length, 2, '3aの2本のみ——3iは壁の無い位置には立てない（軸自体が解決できないため見送り）');
});

test('【失敗系】autoFillWoodColumns（3i・3b）: 軸のCLは解決できても、梁と平行な壁が無ければ柱を追加しない（直交する壁は誤って支持と扱わない）', () => {
  // x=0,x=3640に縦壁(y:0..2000)のみ置き、横壁は作らない。y=2000には通り芯を直接置いて
  // axisCL自体は解決できる状況を作る——「軸は解決できるが梁と平行な壁が無い」を独立して再現する
  // （縦壁との直交交点を誤って「平行な壁」と扱っていないかも同時に確認する。B-2実装時の実回帰）。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const yTop = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0,    clStart: y0, clEnd: yTop, isVertical: true });
  addBackingWall(graph, { axisValue: 3640, clStart: y0, clEnd: yTop, isVertical: true });
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  const wallSegments = selfWallSegments(graph);
  const aboveBeamSegments = [{ isVertical: false, coord: 2000, lo: 0, hi: 3640, role: 'primary' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  // 2本の縦壁は互いに交わらない（横壁が無い）ため3aの交点は0本——F-1の自由端4本
  // （各縦壁の上下端）だけが付随する。3i候補（対象）は0本のはず。
  assert.equal(splitFreeEndColumns(graph, created, []).length, 0, '縦壁は直交するだけで梁とは平行でないため、3iは柱を追加しない');
});

test('【失敗系】autoFillWoodColumns（3i・4）: 建具の開口区間の中には立てない（避けて隣の910位置へ）', () => {
  const { graph, wallSegments, hWall } = makeSupportSpanWallGraph();
  // 開口: 中心1820・幅900 → coord1=1370, coord2=2270（柱寸120/2+clearance5=65を広げた[1305,2335]が禁止区間）。
  // 【前提の注記】開口の袖柱（jamb）自体が両側とも生成される通常のケースでは、jamb柱2本
  // （1305・2335）がそのまま3iの支持点になり「span=1725/1305」でどちらも1820以下に収まるため、
  // 3iは何も追加しない（＝開口があるだけでは(b)の禁止区間ぶんは通らない。既存試験で確認済み）。
  // (b)の禁止区間ロジックを独立して検証するには、jamb柱の生成自体が別要因（他の柱との重なり）で
  // 両側とも見送られ、支持点が0..3640の全長のまま残る状況を作る必要がある——袖柱位置(1305・2335)に
  // 軸から50mmずれた（同一軸判定tol超だが柱の断面半幅60mmは重なる）手動固定の柱を先置きし、
  // jamb生成をoverlapで両方とも見送らせる（3i・5と同じ「重ならせて見送らせる」手法）。
  graph.addOpening(hWall.axisCL, 1, false, hWall.clStart, 1820, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  const yCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 1950, { labeled: false, discipline: Discipline.ARCH });
  for (const jx of [1305, 2335]) {
    const auxX = graph.addCenterLine(CenterLineType.VERTICAL, jx, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
    const blocker = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', auxX, yCL, {});
    blocker.setDimensionStatus('locked');
  }
  const aboveBeamSegments = [{ isVertical: false, coord: 2000, lo: 0, hi: 3640, role: 'primary' }];
  const { created, jambSkipped } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  assert.ok(jambSkipped.every(s => s.reason === 'overlap') && jambSkipped.length === 2, '前提: 袖柱は両側とも重なりで見送られる（jamb柱は0本）');
  // 3iの候補だけに絞る（woodAxisOffset非null＝910グリッド。手動固定のブロッカー自身は除く）。
  const spanCols = created.filter(c => c.woodAxisOffset && Math.abs(c.axisY - 2000) < 1);
  assert.equal(spanCols.length, 2, '禁止区間[1305,2335]を避けて2本（910・2730）に分割配置される');
  assert.deepEqual(spanCols.map(c => c.axisX).sort((a, b) => a - b), [910, 2730]);
  assert.ok(spanCols.every(c => c.axisX < 1305 || c.axisX > 2335), 'いずれも建具の禁止区間の外');
});

test('【失敗系】autoFillWoodColumns（3i・5）: 既存柱（手動固定）と重なる位置は見送り、別の分割へフォールバックする', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph();
  // 3iが中央(1820,2000)を選ぶ前提のところに、軸から50mmずれた(1820,1950)（＝支持点としては
  // 数えられない=同一軸判定tol0.5mm超だが、柱の断面（半幅60mm）は重なる）手動固定の柱を先置きする——
  // 「supportsに数えられて何もしなくて済む」経路と区別し、rectsOverlap自体の分岐を独立に検証する。
  const yCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 1950, { labeled: false, discipline: Discipline.ARCH });
  const auxX = graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const blocker = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', auxX, yCL, {});
  blocker.setDimensionStatus('locked');
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  assert.ok(!created.some(c => Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY - 2000) < 1),
    '手動固定の柱と重なる(1820,2000)には3iの柱を追加しない');
  const spanCols = created.filter(c => c.woodAxisOffset && Math.abs(c.axisY - 2000) < 1);
  assert.deepEqual(spanCols.map(c => c.axisX).sort((a, b) => a - b), [910, 2730],
    '中央が塞がっているため、支持長を1820以下に保てる910・2730の2本へフォールバックする');
});

test('autoFillWoodColumns（3i・6）: 冪等（2回目は created/removed とも空。撤去→再生成を繰り返さない）', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph();
  const first = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  assert.equal(splitFreeEndColumns(graph, first.created, [...SUPPORT_SPAN_3A_TARGET, [1820, 2000]]).length, 3, '前提: 3a(2)+3i(1)');
  // 冪等の本体: 2回目は自由端分も含めcreated/removedとも空（初回で全確定済み）。
  const second = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0], '2回目は追加も撤去も無い（冪等）');
});

test('【失敗系】autoFillWoodColumns（3i・7）: role:floor（床梁）は対象外——支持長が長くても柱を追加しない', () => {
  const { graph, wallSegments } = makeSupportSpanWallGraph();
  const floorSeg = [{ isVertical: false, coord: 2000, lo: 0, hi: 3640, role: 'floor' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, floorSeg);
  assert.equal(splitFreeEndColumns(graph, created, SUPPORT_SPAN_3A_TARGET).length, 2, '3aの2本のみ——role:floorは3iの対象外');
});

test('autoFillWoodColumns（3i・8）: removeColumnで撤去した3i柱は再計算しても復活せず、支持点にも数えない——立てられる位置があれば代替の3i柱が立つ（QA裁定2026-09-19）', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph();
  autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  const col = graph.columns.find(c => Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY - 2000) < 1);
  assert.ok(col, '前提: 3iの柱が立っている（中央1820・グリッド）');
  graph.removeColumn(col.id);
  const { created, removed } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  // 除外された1820は支持点として数えない（除外集合にあるslotは生成されないため「もう支持済み」と
  // 誤認してはならない）——結果、attemptが2→3へ増え、910・2730の2本が代替として立つ
  // （makeSupportSpanWallGraphの「一部不可でattempt増」と同型の分割。QA裁定「代替の3i柱が立つ」）。
  assert.equal(created.length, 2, '除外された1820の代わりに910・2730の2本が代替として立つ');
  assert.deepEqual(created.map(c => c.axisX).sort((a, b) => a - b), [910, 2730]);
  assert.deepEqual(removed, []);
  assert.ok(!graph.columns.some(c => Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY - 2000) < 1),
    '手動削除した1820の位置には復活しない');
});

// ---- R-1（2026-09-19是正）: 910グリッドの基準は「通り芯」（gridOriginMm）・近接ガード（2×柱寸未満は不可）----
// makeSupportSpanWallGraphのx0/x1（壁の物理端）はstruct（かつseg.loに一致）のため、そのまま使うと
// gridOriginMmは常にlo自身に一致してしまい区別できない——壁の物理端をARCH（struct扱いにしない）に
// した専用フィクスチャで、「lo自身とは異なる通り芯」が原点になることを確認する。
function makeGridOriginFixture({ span = 5460 } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, span, { labeled: true, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 2000, clStart: x0, clEnd: x1, isVertical: false });
  addBackingWall(graph, { axisValue: 0,    clStart: y0, clEnd: y1, isVertical: true });
  addBackingWall(graph, { axisValue: span, clStart: y0, clEnd: y1, isVertical: true });
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  const wallSegments = selfWallSegments(graph);
  const aboveBeamSegments = [{ isVertical: false, coord: 2000, lo: 0, hi: span, role: 'primary' }];
  return { graph, wallSegments, aboveBeamSegments };
}

test('autoFillWoodColumns（R-1・1）: 910グリッドの位相は通り芯（gridOriginMm）基準になる（支持点loがモジュール外でも他階の既存柱と揃う位置を選ぶ）', () => {
  // 壁の物理端(0,5460)はstructではない（=候補にならない）フィクスチャに、seg.loより手前の通り芯
  // x=-455を1本だけ置く——位相がlo基準(0)ではなく-455基準になることを直接確認する。
  const { graph, wallSegments, aboveBeamSegments } = makeGridOriginFixture({ span: 5460 });
  graph.addCenterLine(CenterLineType.VERTICAL, -455, { labeled: true, discipline: Discipline.STRUCT });
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  const spanCols = created.filter(c => Math.abs(c.axisY - 2000) < 1 && c.axisX > 1 && c.axisX < 5459);
  assert.deepEqual(spanCols.map(c => c.axisX).sort((a, b) => a - b), [1365, 2275, 4095],
    '通り芯x=-455基準の910グリッド(-455,455,1365,2275,3185,4095,...)上の3点が採用される（lo=0基準なら1820/3640になるはず）');
});

test('【対照・R-1】autoFillWoodColumns: 基準となる通り芯が無ければ従来どおりlo(0)基準の910グリッド(1820・3640)になる', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeGridOriginFixture({ span: 5460 });
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  const spanCols = created.filter(c => Math.abs(c.axisY - 2000) < 1 && c.axisX > 1 && c.axisX < 5459);
  assert.deepEqual(spanCols.map(c => c.axisX).sort((a, b) => a - b), [1820, 3640]);
});

test('autoFillWoodColumns（R-1・2・安全弁）: 同じ壁線上で既存柱（区間外）との中心間距離が2×柱寸未満になる候補は不可とし、代替位置へフォールバックする', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph({ span: 1900 });
  // struct候補x=1750（span=1900の窓[80,1820]内・唯一の候補）——ガード無しならideal(950)から遠くても
  // 唯一の候補として採用されてしまう。
  graph.addCenterLine(CenterLineType.VERTICAL, 1750, { labeled: true, discipline: Discipline.STRUCT });
  // 同じ壁線（y=2000）上、区間[0,1900]の外（1950）に既存柱（他の区間・他パス由来を模した手動固定）。
  // 1750との中心間距離は200mm（<2×120=240mm）——安全弁が無ければ(e)の断面重なり判定（120mm未満）は
  // すり抜けてしまう。
  const yBlocker = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const xBlocker = graph.addCenterLine(CenterLineType.VERTICAL, 1950, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const blocker = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xBlocker, yBlocker, {});
  blocker.setDimensionStatus('locked');
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  // 3aの交点柱（(0,2000)・(1900,2000)＝壁のコーナー）を除いた、3i由来の候補だけに絞る。
  const spanCols = created.filter(c => Math.abs(c.axisY - 2000) < 1
    && Math.abs(c.axisX) > 1 && Math.abs(c.axisX - 1900) > 1 && Math.abs(c.axisX - 1950) > 1);
  assert.ok(!spanCols.some(c => Math.abs(c.axisX - 1750) < 1), '安全弁により候補x=1750（既存柱から200mm）は不可');
  for (const c of spanCols) {
    assert.ok(Math.abs(c.axisX - 1950) >= 240, `全ての新規柱は既存柱(1950)から2×柱寸(240mm)以上離れる（実際:${c.axisX}）`);
  }
  assert.deepEqual(spanCols.map(c => c.axisX).sort((a, b) => a - b), [910], '910グリッドへフォールバックする');
});

// ---- 裁定（2026-09-19）: 3iの候補優先順に「下階の柱位置」（below）を追加 ----
// 優先順は 通り芯(struct) ＞ 意匠中心線(center) ＞ 下階の柱位置(below) ＞ 910グリッド
// （ユーザー裁定「最下階まで可能な限り同位置に柱を追加」）。
test('autoFillWoodColumns（裁定・below・1）: 下階に柱がある位置は910グリッドより優先される', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph({ span: 3640 });
  // 下階（1つ下の実体階）の柱が(1820,2000)にある——同じ壁線(y=2000)上・実行可能範囲[910,2730]内。
  const belowColumns = [{ axisX: 1820, axisY: 2000, role: 'primary' }];
  const { created, iiPicks } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments, belowColumns);
  const col = created.find(c => Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY - 2000) < 1);
  assert.ok(col, '下階柱の位置(1820,2000)に3iの柱が立つ');
  assert.equal(iiPicks.find(p => p.x === 1820 && p.y === 2000)?.kind, 'below', 'kindはbelow（通り芯・中心線が無いため従来はgridになるはずの位置）');
});

test('autoFillWoodColumns（裁定・below・2）: 通り芯・意匠中心線があればbelowより優先される（距離で横断比較しない）', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph({ span: 3640 });
  // 通り芯x=1820（理想位置ちょうど）と、下階柱x=1830（理想により近い）を同じ窓に置く。
  graph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const belowColumns = [{ axisX: 1830, axisY: 2000, role: 'primary' }];
  const { created, iiPicks } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments, belowColumns);
  assert.ok(created.some(c => Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY - 2000) < 1), '通り芯x=1820に柱が立つ（belowの1830ではない）');
  assert.ok(!created.some(c => Math.abs(c.axisX - 1830) < 1 && Math.abs(c.axisY - 2000) < 1), 'below(1830)には立たない');
  assert.equal(iiPicks.find(p => Math.abs(p.x - 1820) < 1 && p.y === 2000)?.kind, 'struct');
});

test('【失敗系】autoFillWoodColumns（裁定・below・3）: 下階柱が実行可能範囲外なら使わず、910グリッドへフォールバックする', () => {
  const { graph, wallSegments, aboveBeamSegments } = makeSupportSpanWallGraph({ span: 3640 });
  // 下階柱x=100は窓[910±455]=[455,1365]の外（実行可能範囲[910,2730]の中では入るが、グリッド窓の外）
  // ——実際には910グリッド窓[1365,2275]の外にも入らない位置(100)を使い、確実に候補から外れることを固定する。
  const belowColumns = [{ axisX: 100, axisY: 2000, role: 'primary' }];
  const { created, iiPicks } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments, belowColumns);
  assert.ok(!created.some(c => Math.abs(c.axisX - 100) < 1 && Math.abs(c.axisY - 2000) < 1), '範囲外のbelow候補(100)には立たない');
  const col = created.find(c => Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY - 2000) < 1);
  assert.ok(col, '910グリッド(1820)へフォールバックする');
  assert.equal(iiPicks.find(p => Math.abs(p.x - 1820) < 1 && p.y === 2000)?.kind, 'grid');
});

// ---- 裁定（2026-09-19）: 3b（上階柱直下）の近接ガード ----
// 自階の同じ壁線上に既存柱・候補柱が中心間距離2×柱寸未満（かつ同位置ではない）あれば、その既存柱が
// 支持を担うものとみなし新しい3b柱を立てない（3iの安全弁と同じ述語を共有）。
test('【失敗系】autoFillWoodColumns（裁定・3bガード・1a）: 走行方向のCLが解決できる場合（CL解決分）でも、126mm隣に既存柱があれば立てない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  // 走行方向アンカー用の通り芯x=2000（3b候補がCLペア解決＝slots.set直書きの経路を通る）。
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  // 既存柱（手動固定）を壁線(y=2000)上、x=1874に置く——3b候補の予定位置x=2000との中心間距離は126mm
  // （<2×120=240mm）。
  const yBlockerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const xBlockerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1874, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const blocker = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xBlockerCL, yBlockerCL, {});
  blocker.setDimensionStatus('locked');
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.ok(!created.some(c => Math.abs(c.axisX - 2000) < 1 && Math.abs(c.axisY - 2000) < 1),
    '既存柱(1874,2000)から126mmしか離れない3b候補(2000,2000)は立たない（CL解決分の経路）');
});

test('【失敗系】autoFillWoodColumns（裁定・3bガード・1b）: 走行方向のCLが無い場合（オフセットアンカー分）でも、126mm隣に既存柱があれば立てない', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  // 走行方向アンカー用の通り芯は置かない——3b候補はオフセットアンカー（nearestAnchorCL＋offset）の
  // 経路を通る（pendingOffsetCandidates→acceptedOffsetRectsの経路。CL解決分とは別の分岐）。
  const yBlockerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const xBlockerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1874, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const blocker = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xBlockerCL, yBlockerCL, {});
  blocker.setDimensionStatus('locked');
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.ok(!created.some(c => Math.abs(c.axisX - 2000) < 1 && Math.abs(c.axisY - 2000) < 1),
    '既存柱(1874,2000)から126mmしか離れない3b候補(2000,2000)は立たない（オフセットアンカー分の経路）');
});

test('autoFillWoodColumns（裁定・3bガード・2）: 上階柱直下が既存柱と同位置(tol内)なら、ガードに阻害されず従来どおり同一スロットへ畳まれる（冪等）', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const first = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  const col = first.created.find(c => Math.abs(c.axisX - 2000) < 1 && Math.abs(c.axisY - 2000) < 1);
  assert.ok(col, '前提: 初回は3b候補(2000,2000)が立つ（他はF-1自由端・3a交点由来で対象外）');
  // 2回目: 同じ上階柱位置を渡す——新設した柱自身と「同位置(tol内)」になるが、ガードは同位置
  // （d<tol）を対象外にしているため阻害されず、既存スロットへの重複判定（existing.has）で
  // created/removedとも0件のまま収束する（ガード追加前と同じ冪等性を保つ）。
  const second = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.deepEqual([second.created.length, second.removed.length], [0, 0],
    '同位置はガードに阻害されず既存スロットへ畳まれる（重複生成も誤撤去もされない）');
  assert.ok(graph.columnMap.has(col.id), '柱は保全される');
});

test('autoFillWoodColumns（裁定・3bガード・3）: 上階柱直下から十分離れていれば従来どおり立つ', () => {
  const { graph, wallSegments } = makeWoodLineWithRunGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  // 既存柱を壁線(y=2000)上、x=1500に置く——3b候補(2000,2000)との中心間距離500mm（>=240mm）。
  const yBlockerCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const xBlockerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const blocker = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xBlockerCL, yBlockerCL, {});
  blocker.setDimensionStatus('locked');
  const above = [{ x: 2000, y: 2000, axisX: 2000, axisY: 2000, role: 'standard' }];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, above, wallSegments);
  assert.ok(created.some(c => Math.abs(c.axisX - 2000) < 1 && Math.abs(c.axisY - 2000) < 1),
    '既存柱(1500,2000)から500mm離れているため3b候補(2000,2000)は通常どおり立つ');
});

// ================================================================
// Major-1（QA裁定2026-09-19）: 3iの収束先が階の処理順に依存する不具合の是正——上階の梁は前回パスで
// 下階柱によって分割済みで保存されるため、その分割点を「梁端」としてそのまま点源にすると、3i/3h-2の
// 出力（新しい下階柱）が次パスの入力（同じ梁の分割点）を変える自己参照ループになり、どちらの階を
// 先に処理したかで結果が変わっていた（実データmoku3: 昇順=通り芯Y4、降順=意匠中心線の別位置）。
// mergePrimaryBeamRuns（runへ束ね直す）で分割点を「梁端」から除くことで解消することを、1本のまま
// 渡した場合／異なる位置で2分割して渡した場合で結果が一致することにより固定する。
// ================================================================
function makeOrderInvarianceGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const yLo = graph.addCenterLine(CenterLineType.HORIZONTAL, -9884, { labeled: true, discipline: Discipline.STRUCT });
  const yHi = graph.addCenterLine(CenterLineType.HORIZONTAL, -7280, { labeled: true, discipline: Discipline.STRUCT });
  const xLo = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const xAxis = graph.addCenterLine(CenterLineType.VERTICAL, 9100, { labeled: true, discipline: Discipline.STRUCT });
  // 縦壁 x=9100 が y:[-9884,-7280] を通しで走る。through-runのために直交する横壁2本で挟む。
  addBackingWall(graph, { axisValue: 9100, clStart: yLo, clEnd: yHi, isVertical: true });
  addBackingWall(graph, { axisValue: -9884, clStart: xLo, clEnd: xAxis, isVertical: false });
  addBackingWall(graph, { axisValue: -7280, clStart: xLo, clEnd: xAxis, isVertical: false });
  graph.addCenterLine(CenterLineType.HORIZONTAL, -9100, { labeled: true, discipline: Discipline.STRUCT }); // 通り芯
  graph.addCenterLine(CenterLineType.HORIZONTAL, -8190, { labeled: false, discipline: Discipline.ARCH });  // 意匠中心線
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  return { graph, wallSegments: selfWallSegments(graph) };
}

test('autoFillWoodColumns（Major-1・順序不変）: 上階のprimary梁を1本のまま渡しても、下階柱で2分割して渡しても3iの結果が一致する', () => {
  const single = [{ isVertical: true, coord: 9100, lo: -9884, hi: -7280, role: 'primary' }];
  const splitAt9100 = [
    { isVertical: true, coord: 9100, lo: -9884, hi: -9100, role: 'primary' },
    { isVertical: true, coord: 9100, lo: -9100, hi: -7280, role: 'primary' },
  ];
  const splitAt8190 = [
    { isVertical: true, coord: 9100, lo: -9884, hi: -8190, role: 'primary' },
    { isVertical: true, coord: 9100, lo: -8190, hi: -7280, role: 'primary' },
  ];
  // makeOrderInvarianceGraphもコの字（3辺）形状——3aの交点2本（(9100,-9884)・(9100,-7280)＝
  // 縦壁x=9100と横壁2本の角）のほかにF-1の自由端2本（(0,-9884)・(0,-7280)＝横壁2本の開放端）が
  // 付随する。3iの結果（位置は各runで検証したい対象そのもの）はsplitFreeEndColumnsの対象外判定に
  // 巻き込まず、既知の自由端2本だけを機械的に除いて比較する。
  const run = (segs) => {
    const { graph, wallSegments } = makeOrderInvarianceGraph();
    const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, segs);
    const freeEndKeys = new Set(wallRunFreeEnds(selfWallSegments(graph)).map(fe => `${fe.x},${fe.y}`));
    return created.filter(c => !freeEndKeys.has(`${c.x},${c.y}`)).map(c => `${c.axisX},${c.axisY}`).sort();
  };
  const resultSingle = run(single);
  const resultSplit9100 = run(splitAt9100);
  const resultSplit8190 = run(splitAt8190);
  assert.deepEqual(resultSplit9100, resultSingle, '下階柱(9100)で分割済みの梁を渡しても1本のまま渡した場合と同じ結果');
  assert.deepEqual(resultSplit8190, resultSingle, '別の位置(8190)で分割済みの梁を渡しても1本のまま渡した場合と同じ結果');
  assert.equal(resultSingle.length, 3, '3aの2本(端)＋3iの1本');
  // 実行可能範囲の裁定（QA裁定2026-09-19）適用後は、等分位置(-8582)から784mm離れた通り芯Y4(-9100)
  // （実行可能範囲[-9100,-9037]の境界）が意匠中心線(-8190)より優先して選ばれる
  // （旧仕様では窓[-9037,-8127]の外だったため-8190が選ばれていた）。
  assert.ok(resultSingle.includes('9100,-9100'), `3iの柱は通り芯Y4(-9100)に立つはず（実際: ${resultSingle}）`);
});

test('【Minor・QA2026-09-19】autoFillWoodColumns（3i）: 別軸・別runの3i候補どうしが近接しても重ならない（累積した重なり判定）', () => {
  // x=0とx=90（90mm差。柱幅120の半幅60より近い）に、それぞれ独立に支持長3640の縦壁を置く——
  // 累積が無ければ両方とも中央(1820)を選び物理的に重なる。累積により後から処理される方（x=90）は
  // (0,1820)の矩形と重なるため見送り、attemptを増やして910・2730へ分割される。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  const x90 = graph.addCenterLine(CenterLineType.VERTICAL, 90, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0,    clStart: y0, clEnd: y1, isVertical: true });
  addBackingWall(graph, { axisValue: 90,   clStart: y0, clEnd: y1, isVertical: true });
  addBackingWall(graph, { axisValue: 0,    clStart: x0, clEnd: x90, isVertical: false });
  addBackingWall(graph, { axisValue: 3640, clStart: x0, clEnd: x90, isVertical: false });
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  const wallSegments = selfWallSegments(graph);
  const aboveBeamSegments = [
    { isVertical: true, coord: 0,  lo: 0, hi: 3640, role: 'primary' },
    { isVertical: true, coord: 90, lo: 0, hi: 3640, role: 'primary' },
  ];
  const { created } = autoFillWoodColumns(graph, PROJECT, null, [], wallSegments, aboveBeamSegments);
  const spanCols = created.filter(c => c.woodAxisOffset);
  assert.equal(spanCols.length, 3, '3i候補: x=0側1本＋x=90側2本（910・2730への分割）');
  assert.deepEqual(spanCols.filter(c => c.axisX === 0).map(c => c.axisY), [1820], 'x=0側は中央1本のまま');
  assert.deepEqual(spanCols.filter(c => c.axisX === 90).map(c => c.axisY).sort((a, b) => a - b), [910, 2730],
    'x=90側は(0,1820)と重なるため中央を避け910・2730へ分割される');
});
