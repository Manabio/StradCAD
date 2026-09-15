// woodAutoFill.js（在来木造ステップ3a: 壁交点柱・既存断面そろえ）の単体テスト。
// wallBeamAxes.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType, columnSlotKey, centerLineKind as centerLineKindOf } from '../core.js';
import {
  wallIntersectionPoints, autoFillWoodColumns, conformWoodSections, conformWoodBacking, WALL_JUNCTION_TOL_MM,
  autoFillWoodBeamDepths,
} from './woodAutoFill.js';
import { WOOD_STUD_CODE_BY_SIZE } from '../finish/materials/backingClass.js';
import { autoFillColumnsForStructure, autoFillStructuralGrid } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
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

test('autoFillStructuralGrid: 在来木造では通り芯全辺の大梁は従来どおり、柱だけが壁交点へ移る（removedColumns を返す）', () => {
  const { graph, x1, x2, y1, y2 } = makeGridGraph();
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 1000, clStart: y1, clEnd: y2, isVertical: true });
  const gridAuto = graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', x1, y1, {});
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  // wallSources は本番では collectWallBeamSources（マージ済み・下階込み）。ここでは自階の壁だけを渡す。
  const r = autoFillStructuralGrid(graph, project, TRADITIONAL_WOOD_STRUCTURE, null, selfWallSegments(graph));
  assert.deepEqual(r.newColumns.map(c => `${c.x},${c.y}`), ['1000,2000']);
  assert.deepEqual(r.removedColumns, [gridAuto.id]);
  assert.ok(r.newBeams.length > 0, '大梁・壁由来の梁芯は従来どおり生成される（ステップ3cで置き換える）');
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
