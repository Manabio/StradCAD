// 見下げの床の穴（階段吹抜け）の基端側は、下階の木造 U 字階段の到達辺の面まで狭める（往路側＝面、復路側＝面＋蹴込。S3）。
// 床の縁は上階の床梁の外面＋壁仕上げで、梁は床の下に隠れて見えない。実物の PlanGraph で下階（U 字階段＋隔て壁）と上階（階段吹抜け＋梁）を組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, RoomFeature } from '@core';
import { planSolids, floorSolidOf } from './planSolids.js';
import { planSectionFigure } from './planSectionFigure.js';
import { makeGrid, addBeamH, fakeLayer, linesOf } from './planTestFixtures.js';
import { generateStairPartitionWalls } from '../finish/stair/stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

// 下階: 縦走行（up）。踊り場 y 0..1000、往路（x 0..1000）・復路（x 1000..2000）y 1000..4000。基端の通り芯 y=4000
function lowerFloor() {
  const graph = new PlanGraph(new Plane('p0', 0, '1階', 1, 1));
  const V = [0, 1000, 2000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const Hl = [0, 1000, 4000].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const keys = [];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) keys.push(`${V[i].id}:${Hl[j].id}:${V[i + 1].id}:${Hl[j + 1].id}`);
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(keys), sections: [6, 1, 6], flip: false, upDirection: 'up' });
  stair.structure = StructuralMaterialType.WOOD;
  graph.setStructureOverride('木造（在来）');
  for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5;
    w.endOffset = sign * 57.5;
  }
  return { graph, stair };
}
// 上階: 同じ足元に階段吹抜け。床の範囲は右の列（x 2000..3000）。withBeam なら到達辺の通り芯 y=4000 に幅 120 の木造梁
function upperFloor({ withBeam = true } = {}) {
  const g = makeGrid([0, 1000, 2000, 3000], [0, 1000, 4000], { id: 'p1', startFloor: 2 });
  g.feature([[0, 0], [1, 0], [0, 1], [1, 1]], RoomFeature.STAIR_VOID);
  g.interior([[2, 0], [2, 1]]);
  if (withBeam) addBeamH(g.graph, { axis: 4000, from: 0, to: 2000, sectionDefId: 'WOOD-120x120', material: StructuralMaterialType.WOOD });
  return g.graph;
}
const holesOf = (above, low, extra = {}) => floorSolidOf(fakeLayer({ graph: above, floorZMm: 3000 }), {
  belowGraphOf: g => (g === above ? low : null), riserOf: () => 200, ...extra,
}).footprint.holes;
const stairHoles = holes => holes.filter(h => h.y1 < 4000 && h.x1 < 2000);
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('床の穴の基端側: 往路側（隔て壁の帯まで）＝面 3927.5・復路側＝面＋蹴込 3907.5。復路の幅方向に 2 分割され、基端以外の辺は通り芯のまま', () => {
  const { graph: low } = lowerFloor();
  const holes = stairHoles(holesOf(upperFloor(), low));
  const base = holes.filter(h => h.y1 >= 1000 - 1e-6); // 往路・復路のセル行（踊り場の行を除く）
  const a = base.filter(h => h.x2 <= 1057.5 + 1e-6), b = base.filter(h => h.x1 >= 1057.5 - 1e-6);
  assert.ok(a.length >= 2 && a.every(h => near(h.y2, 4000 - 72.5)), `往路側（隔て壁の帯 1000..1057.5 を含む）は面 ${JSON.stringify(a)}`);
  assert.ok(b.length === 1 && near(b[0].y2, 4000 - 92.5) && near(b[0].x1, 1057.5) && near(b[0].x2, 2000), `復路側は面＋蹴込 ${JSON.stringify(b)}`);
  assert.ok(a.some(h => near(h.x1, 1000) && near(h.x2, 1057.5)), '復路のセルは sB で割れる');
  assert.ok(holes.every(h => near(h.y1, 0) || near(h.y1, 1000)), '奥側の辺は動かない');
});

test('対照: 梁なし・見上げ・U 字でない階段は穴が通り芯（4000）のまま', () => {
  const { graph: low, stair } = lowerFloor();
  assert.ok(stairHoles(holesOf(upperFloor({ withBeam: false }), low)).some(h => near(h.y2, 4000)), '梁なし');
  assert.ok(stairHoles(holesOf(upperFloor({ withBeam: false }), low)).every(h => h.y2 === 1000 || near(h.y2, 4000)), '梁なしは全部通り芯');
  const up = stairHoles(holesOf(upperFloor(), low, { lookUp: true }));
  assert.ok(up.every(h => h.y2 === 1000 || near(h.y2, 4000)), '見上げは足元全体');
  stair.type = StairType.STRAIGHT;
  assert.ok(stairHoles(holesOf(upperFloor(), low)).every(h => h.y2 === 1000 || near(h.y2, 4000)), 'U 字でない階段');
});

test('床の縁の外にある梁の面の線は出ない: 見下げ全体（planSolids→planSectionFigure）で梁の面（y=3940）の線が 0 本。狭めない対照では出る', () => {
  const { graph: low } = lowerFloor();
  const above = upperFloor();
  const layers = [{ graph: above, floorZMm: 3000, role: 'self' }, { graph: low, floorZMm: 0, role: 'below' }];
  const beamLinesAtFace = (belowGraphOf) => {
    const prims = planSectionFigure(planSolids(layers, { belowGraphOf, riserOf: () => 200 }), 4200);
    return linesOf(prims, null, 'beam').filter(p => near(p.points[1], 3940) && near(p.points[3], 3940));
  };
  assert.equal(beamLinesAtFace(g => (g === above ? low : null)).length, 0, '狭めた床の下に隠れる');
  // 対照: 下階が無ければ（破れ先の穴にも階段吹抜けの狭めにもならない）梁の面は見える
  assert.ok(beamLinesAtFace(() => null).length >= 1, '対照（belowGraphOf なし）では梁の面の線が出る');
});

// ---- 判定は構造上の述語（入口柱の通り芯に基端の辺がある穴。往路側は等長レーンのときだけ）
import { classifyStairArea } from '../finish/stair/stairClassify.js';

// eccentricity＝梁の偏芯（軸 = 通り芯 + eccentricity。通り芯は動かさない＝セルは割れない）
function upperWithBeamAt(axis, voidCells, grid = [[0, 1000, 2000, 3000], [0, 1000, 4000]], eccentricity = 0) {
  const g = makeGrid(grid[0], grid[1], { id: 'p1', startFloor: 2 });
  g.feature(voidCells, RoomFeature.STAIR_VOID);
  g.interior([[2, 0]]);
  const axisCL = g.graph.addCenterLine(CenterLineType.HORIZONTAL, axis, ARCH);
  const c0 = g.graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH), c1 = g.graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  g.graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', axisCL, false, c0, c1, { role: 'primary', eccentricity });
  return g.graph;
}
const ALL4 = [[0, 0], [1, 0], [0, 1], [1, 1]];

test('T1【偏芯した梁】幅 120 の梁が階段側へ 30 偏芯（面 102.5）でも穴は狭まる（往路側 3897.5・復路側 3877.5）', () => {
  const { graph: low } = lowerFloor();
  const holes = stairHoles(holesOf(upperWithBeamAt(4000, ALL4, undefined, -30), low)).filter(h => h.y1 >= 1000 - 1e-6);
  assert.ok(holes.some(h => near(h.y2, 4000 - 102.5)), JSON.stringify(holes));
  assert.ok(holes.some(h => near(h.y2, 4000 - 122.5) && near(h.x2, 2000)), JSON.stringify(holes));
});

test('T2【足元の外・通り芯に乗るだけの穴は狭めない】階段吹抜けが下階の階段の足元の外（x 2000..3000）にあれば、基端側の辺が通り芯 4000 でも不変', () => {
  const { graph: low } = lowerFloor();
  const g = makeGrid([0, 1000, 2000, 3000, 4000], [0, 1000, 4000], { id: 'p1', startFloor: 2 });
  g.feature(ALL4, RoomFeature.STAIR_VOID);
  g.feature([[2, 1]], RoomFeature.STAIR_VOID); // 足元の外（x 2000..3000, y 1000..4000）
  g.interior([[3, 0]]);
  addBeamH(g.graph, { axis: 4000, from: 0, to: 3000, sectionDefId: 'WOOD-120x120', material: StructuralMaterialType.WOOD });
  const holes = holesOf(g.graph, low);
  const outside = holes.find(h => near(h.x1, 2000) && near(h.x2, 3000) && h.y1 >= 1000 - 1e-6);
  assert.ok(outside && near(outside.y2, 4000), `足元の外の穴は不変 ${JSON.stringify(outside)}`);
  assert.ok(holes.some(h => near(h.x1, 1000) && h.y2 < 4000 && h.y1 >= 1000 - 1e-6), '足元の中の穴は狭まる（対照）');
});

test('T3【stairBeyond の穴】続きの階段（上階の階段が下階と足元一致）の破れ先の穴も狭まる。足元が一致しない階段なら不変', () => {
  const build = (shift) => {
    const g = makeGrid([0, 1000, 2000, 3000, 4000], [0, 1000, 4000], { id: 'p1', startFloor: 2 });
    const cells = (shift ? [[2, 0], [3, 0], [2, 1], [3, 1]] : ALL4).map(([i, j]) => g.cell(i, j));
    const stair = g.graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(cells), sections: [6, 1, 6], flip: false, upDirection: 'up' });
    stair.structure = StructuralMaterialType.WOOD;
    g.interior(shift ? [[0, 0]] : [[2, 0], [2, 1]]); // 床の範囲（階段の足元の外）
    addBeamH(g.graph, { axis: 4000, from: 0, to: 4000, sectionDefId: 'WOOD-120x120', material: StructuralMaterialType.WOOD });
    return g.graph;
  };
  const { graph: low } = lowerFloor();
  const narrowed = holesOf(build(false), low).filter(h => h.y1 < 4000 && h.x1 < 2000);
  assert.ok(narrowed.length > 0 && narrowed.every(h => h.y2 < 4000 - 72.5 + 1e-6), `破れ先の穴が狭まる ${JSON.stringify(narrowed)}`);
  const other = holesOf(build(true), low); // 足元が一致しない階段（x 2000..4000）は下階の階段に対応しない
  assert.ok(other.every(h => h.y2 === 1000 || near(h.y2, 4000) || h.y2 < 1000 || h.x1 >= 2000 - 1e-6), `不一致は不変 ${JSON.stringify(other)}`);
});

test('T4【張り出し】往路が長い配置: 復路の最終行のセルだけ面＋蹴込に狭まり、通り芯をまたぐ往路のセルは不変', () => {
  const graph = new PlanGraph(new Plane('p0', 0, '1階', 1, 1));
  const V = [0, 1000, 2000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const Hl = [0, 1000, 2000, 3000].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const k = (l, t, r, b) => `${V[l].id}:${Hl[t].id}:${V[r].id}:${Hl[b].id}`;
  const c = { d: k(0, 0, 1, 1), c: k(1, 0, 2, 1), a: k(0, 1, 1, 2), b: k(1, 1, 2, 2), f: k(1, 2, 2, 3) };
  const keys = ['f', 'b', 'c', 'd', 'a'].map(n => c[n]);
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, 2800, keys);
  const stair = graph.addStair({ type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections, entryTurnSteps: 0, arrivalTurnSteps: 0 });
  graph.setStructureOverride('木造（在来）');
  stair.structure = StructuralMaterialType.WOOD;
  for (const w of generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5; w.endOffset = sign * 57.5;
  }
  const above = upperWithBeamAt(2000, [[0, 0], [1, 0], [0, 1], [1, 1], [1, 2]], [[0, 1000, 2000, 3000], [0, 1000, 2000, 3000]]);
  const holes = holesOf(above, graph);
  const cellHole = (x1, y1, x2) => holes.filter(h => near(h.x1, x1) && near(h.x2, x2) && h.y1 >= y1 - 1e-6 && h.y1 <= y1 + 1e-6);
  const b = cellHole(1000, 1000, 2000), f = holes.filter(h => near(h.y1, 2000) && near(h.y2, 3000) && h.x1 >= 1000 - 1e-6);
  assert.ok(b.every(h => near(h.y2, 2000)) && f.every(h => near(h.y2, 3000)), `往路のセル b・f は不変 ${JSON.stringify([b, f])}`);
  const a = holes.filter(h => h.x2 <= 1000 + 1e-6 && h.y1 >= 1000 - 1e-6 && h.y1 < 1500); // 復路（左列）のセル a。sB=942.5 で割れる
  const lane = a.find(h => near(h.x1, 0)), band = a.find(h => near(h.x2, 1000));
  assert.ok(lane && near(lane.y2, 2000 - 92.5), `復路側は面＋蹴込 ${JSON.stringify(a)}`);
  assert.ok(band && near(band.y2, 2000), `往路側（隔て壁の帯）は張り出しでは狭めない ${JSON.stringify(a)}`);
});
