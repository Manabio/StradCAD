// woodAutoFill.js（在来木造ステップ3a: 壁交点柱・既存断面そろえ）の単体テスト。
// wallBeamAxes.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType, columnSlotKey, centerLineKind as centerLineKindOf } from '../core.js';
import { wallIntersectionPoints, autoFillWoodColumns, conformWoodSections, conformWoodBacking, WALL_JUNCTION_TOL_MM } from './woodAutoFill.js';
import { WOOD_STUD_CODE_BY_SIZE } from '../finish/materials/backingClass.js';
import { autoFillColumnsForStructure, autoFillStructuralGrid } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { selfWallSegments, autoFillWallBeamAxes } from './wallBeamAxes.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';

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
